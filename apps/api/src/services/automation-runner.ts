import { randomUUID } from 'node:crypto';
import { sql } from '@yunshuo/db';
import type { AuthContext } from '../auth.js';
import { AppError, conflict } from '../errors.js';
import {
  loadLease,
  isLeaseActive,
  loadChapter,
  loadLatestDraft,
  loadRuleset,
} from './chapter-data.js';
import {
  acquireLease,
  evaluateChapterGates,
  releaseLease,
  saveDraft,
  stageDraft,
} from './chapter-service.js';
import { commitChapter } from './commit-service.js';
import {
  executeProposal,
  prepareProposal,
  releaseGenerationLock,
  type ProposalBudget,
  type ProposalRunResult,
} from './ai-service.js';
import { ensureAutomationAgent } from './automation-agent.js';
import { isLocalBaseUrl } from './provider-service.js';
import { workspaceBudgetBlockReason } from './billing-service.js';

const STALE_AFTER_MS = 5 * 60_000;
const HEARTBEAT_MS = 20_000;

export const automationRunnerId = `runner-${process.pid}-${randomUUID().slice(0, 8)}`;

interface RunningJobRow {
  id: string;
  workspace_id: string;
  work_id: string;
  mandate_id: string;
  status: string;
  cost_currency: 'CNY' | 'USD';
  cost_unknown: boolean;
  pause_requested: boolean;
  stop_requested: boolean;
  runner_id: string | null;
}

interface MandateRuntimeRow {
  id: string;
  status: 'active' | 'revoked' | 'expired';
  expires_at: Date | string;
  allow_auto_commit: boolean;
  allow_remote_models: boolean;
  allow_non_production_gates: boolean;
  instruction: string;
  target_words: number;
  budget_limit: string | null;
  budget_currency: 'CNY' | 'USD';
}

interface NextChapterRow {
  chapter_id: string;
  chapter_number: number;
  chapter_title: string;
  chapter_status: string;
}

interface StagedAdoptionRow {
  id: string;
  evaluation_id: string;
  staged_by: string;
}

type ChapterOutcomeStatus =
  | 'committed'
  | 'staged'
  | 'gate_failed'
  | 'no_output'
  | 'failed'
  | 'skipped'
  | 'interrupted'
  | 'budget_guard';

interface ChapterOutcome {
  status: ChapterOutcomeStatus;
  reason: string | null;
  proposalId?: string | null;
  versionId?: string | null;
  evaluationId?: string | null;
  cost?: number | null;
  costCurrency?: 'CNY' | 'USD' | null;
}

let tickInFlight = false;
let timer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let activeAbort: AbortController | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appCode(error: unknown): string | null {
  return error instanceof AppError ? error.code : null;
}

function truncate(value: string, max = 1000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function loadMandateRuntime(job: RunningJobRow): Promise<MandateRuntimeRow | null> {
  const rows = await sql<MandateRuntimeRow[]>`
    SELECT id, status, expires_at, allow_auto_commit, allow_remote_models,
           allow_non_production_gates, instruction, target_words, budget_limit, budget_currency
    FROM automation_mandates
    WHERE id = ${job.mandate_id} AND workspace_id = ${job.workspace_id}
  `;
  return rows[0] ?? null;
}

function mandateInactiveReason(mandate: MandateRuntimeRow): string | null {
  if (mandate.status === 'revoked') return '授权已撤销';
  if (mandate.status === 'expired' || new Date(mandate.expires_at).getTime() <= Date.now()) {
    return '授权已过期';
  }
  return null;
}

async function buildAgentAuth(job: RunningJobRow): Promise<AuthContext> {
  const agent = await ensureAutomationAgent(sql, job.workspace_id);
  const workspaceRows = await sql<
    { id: string; name: string; settings_version: number; ledger_version: number }[]
  >`
    SELECT id, name, settings_version, ledger_version FROM workspaces WHERE id = ${job.workspace_id}
  `;
  const workspace = workspaceRows[0];
  if (!workspace) throw new Error('自动化作业所属工作区不存在');
  return {
    user: agent,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      settingsVersion: workspace.settings_version,
      ledgerVersion: workspace.ledger_version,
    },
    role: 'ai',
    sessionId: `automation:${job.id}`,
    automation: { jobId: job.id, mandateId: job.mandate_id },
  };
}

async function heartbeat(jobId: string): Promise<void> {
  await sql`
    UPDATE automation_jobs SET heartbeat_at = now(), updated_at = now()
    WHERE id = ${jobId} AND status = 'running'
  `;
}

async function releaseChapterArtifacts(
  aiAuth: AuthContext,
  chapterId: string,
  proposalId: string | null,
): Promise<void> {
  if (proposalId) {
    await releaseGenerationLock(chapterId, proposalId).catch(() => undefined);
  }
  await releaseLease(aiAuth, chapterId).catch(() => undefined);
}

async function markJobChapter(
  job: RunningJobRow,
  chapterId: string,
  outcome: ChapterOutcome,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE automation_job_chapters SET
        status = ${outcome.status},
        reason = ${outcome.reason},
        proposal_id = ${outcome.proposalId ?? null},
        version_id = ${outcome.versionId ?? null},
        evaluation_id = ${outcome.evaluationId ?? null},
        cost = ${outcome.cost ?? null},
        cost_currency = ${outcome.costCurrency ?? null},
        completed_at = now()
      WHERE job_id = ${job.id} AND chapter_id = ${chapterId}
    `;
    await tx`
      UPDATE automation_jobs SET current_chapter_id = NULL, updated_at = now()
      WHERE id = ${job.id}
    `;
  });
}

async function markChapterRunning(jobId: string, chapterId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE automation_job_chapters SET
        status = 'running',
        started_at = COALESCE(started_at, now()),
        reason = NULL,
        completed_at = NULL
      WHERE job_id = ${jobId} AND chapter_id = ${chapterId}
    `;
    await tx`
      UPDATE automation_jobs SET current_chapter_id = ${chapterId}, updated_at = now()
      WHERE id = ${jobId}
    `;
  });
}

async function recomputeJob(jobId: string): Promise<void> {
  await sql`
    UPDATE automation_jobs j SET
      total_chapters = (SELECT count(*) FROM automation_job_chapters c WHERE c.job_id = j.id),
      committed_chapters = (
        SELECT count(*) FROM automation_job_chapters c WHERE c.job_id = j.id AND c.status = 'committed'
      ),
      staged_chapters = (
        SELECT count(*) FROM automation_job_chapters c WHERE c.job_id = j.id AND c.status = 'staged'
      ),
      failed_chapters = (
        SELECT count(*) FROM automation_job_chapters c
        WHERE c.job_id = j.id AND c.status IN ('failed', 'gate_failed', 'no_output')
      ),
      skipped_chapters = (
        SELECT count(*) FROM automation_job_chapters c WHERE c.job_id = j.id AND c.status = 'skipped'
      ),
      spent = (
        SELECT COALESCE(SUM(c.cost), 0) FROM automation_job_chapters c
        WHERE c.job_id = j.id AND c.cost IS NOT NULL
      ),
      cost_unknown = EXISTS (
        SELECT 1 FROM automation_job_chapters c
        WHERE c.job_id = j.id
          AND c.status IN ('committed', 'staged', 'gate_failed', 'no_output', 'failed')
          AND c.cost IS NULL
      ),
      updated_at = now()
    WHERE j.id = ${jobId}
  `;
}

async function finishJob(
  jobId: string,
  status: 'paused' | 'stopped' | 'completed' | 'failed' | 'interrupted',
  reason: string | null,
): Promise<void> {
  await sql`
    UPDATE automation_jobs SET
      status = ${status},
      runner_id = NULL,
      heartbeat_at = NULL,
      current_chapter_id = NULL,
      completed_at = CASE WHEN ${status} = 'paused' THEN NULL ELSE now() END,
      last_error = ${reason},
      updated_at = now()
    WHERE id = ${jobId} AND status IN ('running', 'queued')
  `;
}

async function settleJob(jobId: string): Promise<void> {
  await recomputeJob(jobId);
  const rows = await sql<
    {
      id: string;
      mandate_id: string;
      workspace_id: string;
      status: string;
      pause_requested: boolean;
      stop_requested: boolean;
      cost_unknown: boolean;
      spent: string;
    }[]
  >`
    SELECT id, mandate_id, workspace_id, status, pause_requested, stop_requested, cost_unknown,
           spent::text AS spent
    FROM automation_jobs WHERE id = ${jobId}
  `;
  const job = rows[0];
  if (!job || job.status !== 'running') return;

  const remainingRows = await sql<{ remaining: string }[]>`
    SELECT count(*)::text AS remaining FROM automation_job_chapters
    WHERE job_id = ${jobId} AND status IN ('pending', 'interrupted', 'running')
  `;
  const remaining = Number(remainingRows[0]?.remaining ?? '0');
  if (remaining === 0) {
    await finishJob(jobId, 'completed', null);
    return;
  }
  if (job.stop_requested) {
    await finishJob(jobId, 'stopped', '用户请求停止');
    return;
  }
  if (job.pause_requested) {
    await finishJob(jobId, 'paused', '用户请求在章节边界暂停');
    return;
  }

  const budgetRows = await sql<{ budget_limit: string | null; mandate_spent: string }[]>`
    SELECT m.budget_limit::text AS budget_limit, COALESCE(SUM(j.spent), 0)::text AS mandate_spent
    FROM automation_mandates m
    LEFT JOIN automation_jobs j ON j.mandate_id = m.id
    WHERE m.id = ${job.mandate_id}
    GROUP BY m.budget_limit
  `;
  const budget = budgetRows[0];
  if (budget && budget.budget_limit !== null) {
    const limit = Number(budget.budget_limit);
    if (job.cost_unknown) {
      await finishJob(
        jobId,
        'paused',
        '有章节费用未知，无法确认是否仍在预算内；已按预算保护暂停。',
      );
      return;
    }
    if (Number(budget.mandate_spent) >= limit) {
      await finishJob(
        jobId,
        'paused',
        `该授权累计费用已达预算上限 ${limit}，作业在章节检查点暂停。`,
      );
      return;
    }
  }

  const workspaceReason = await workspaceBudgetBlockReason(job.workspace_id);
  if (workspaceReason) {
    await finishJob(jobId, 'paused', `${workspaceReason}；作业在章节检查点暂停。`);
    return;
  }

  await sql`
    UPDATE automation_jobs SET heartbeat_at = now(), updated_at = now()
    WHERE id = ${jobId} AND status = 'running'
  `;
}

async function nextChapter(jobId: string): Promise<NextChapterRow | null> {
  const rows = await sql<NextChapterRow[]>`
    SELECT jc.chapter_id, jc.chapter_number, c.title AS chapter_title, c.status AS chapter_status
    FROM automation_job_chapters jc
    JOIN chapters c ON c.id = jc.chapter_id
    WHERE jc.job_id = ${jobId} AND jc.status IN ('pending', 'interrupted')
    ORDER BY jc.chapter_number ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function latestStaged(chapterId: string): Promise<StagedAdoptionRow | null> {
  const rows = await sql<StagedAdoptionRow[]>`
    SELECT id, evaluation_id, staged_by
    FROM staged_drafts
    WHERE chapter_id = ${chapterId}
    ORDER BY staged_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function commitFromStage(
  aiAuth: AuthContext,
  job: RunningJobRow,
  chapterId: string,
  stagedId: string,
  expectedVersionId: string | null,
): Promise<{ ok: true; versionId: string } | { ok: false; reason: string; committedByJob: boolean }> {
  try {
    const commit = await commitChapter(aiAuth, chapterId, {
      idempotencyKey: `job:${job.id}:${chapterId}:commit`,
      targetChapterId: chapterId,
      expectedCurrentVersionId: expectedVersionId,
      stagedDraftId: stagedId,
    });
    return { ok: true, versionId: commit.versionId };
  } catch (error) {
    const intents = await sql<{ version_id: string }[]>`
      SELECT c.version_id
      FROM commit_intents ci
      JOIN commits c ON c.intent_id = ci.id
      WHERE ci.idempotency_key = ${`job:${job.id}:${chapterId}:commit`}
    `;
    if (intents[0]) return { ok: true, versionId: intents[0].version_id };
    return {
      ok: false,
      reason: `${appCode(error) ?? 'COMMIT_FAILED'}: ${errorMessage(error)}`,
      committedByJob: false,
    };
  }
}

async function budgetForJob(
  job: RunningJobRow,
  mandate: MandateRuntimeRow,
): Promise<ProposalBudget | null> {
  if (mandate.budget_limit === null) return null;
  const rows = await sql<{ spent: string }[]>`
    SELECT COALESCE(SUM(spent), 0)::text AS spent FROM automation_jobs WHERE mandate_id = ${job.mandate_id}
  `;
  const remaining = Number(mandate.budget_limit) - Number(rows[0]?.spent ?? '0');
  return {
    remaining: Math.round(remaining * 10_000) / 10_000,
    currency: mandate.budget_currency,
  };
}

async function releaseChapterToPending(
  jobId: string,
  chapterId: string,
  reason: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE automation_job_chapters SET
        status = 'pending', reason = ${reason}, started_at = NULL, completed_at = NULL
      WHERE job_id = ${jobId} AND chapter_id = ${chapterId}
    `;
    await tx`
      UPDATE automation_jobs SET current_chapter_id = NULL, updated_at = now()
      WHERE id = ${jobId}
    `;
  });
}

async function settleBudgetReason(job: RunningJobRow): Promise<string | null> {
  const mandate = await loadMandateRuntime(job);
  if (mandate && mandate.budget_limit !== null) {
    if (job.cost_unknown) return '有章节费用未知，无法确认是否仍在预算内';
    const rows = await sql<{ spent: string }[]>`
      SELECT COALESCE(SUM(spent), 0)::text AS spent FROM automation_jobs WHERE mandate_id = ${job.mandate_id}
    `;
    if (Number(rows[0]?.spent ?? '0') >= Number(mandate.budget_limit)) {
      return `该授权累计费用已达预算上限 ${mandate.budget_limit}`;
    }
  }
  return workspaceBudgetBlockReason(job.workspace_id);
}

async function processStagedChapter(
  aiAuth: AuthContext,
  job: RunningJobRow,
  mandate: MandateRuntimeRow,
  chapter: NextChapterRow,
): Promise<ChapterOutcome | null> {
  const staged = await latestStaged(chapter.chapter_id);
  if (!staged || staged.staged_by !== aiAuth.user.id) {
    return { status: 'skipped', reason: 'external_state：章节已有他人暂存，runner 不覆盖' };
  }
  if (!mandate.allow_auto_commit) {
    await releaseChapterArtifacts(aiAuth, chapter.chapter_id, null);
    return { status: 'staged', reason: '门禁已通过，等待人工提交', evaluationId: staged.evaluation_id };
  }

  await markChapterRunning(job.id, chapter.chapter_id);
  try {
    await acquireLease(aiAuth, chapter.chapter_id);
  } catch (error) {
    if (appCode(error) === 'LEASE_HELD') {
      return { status: 'skipped', reason: `lease_held：${errorMessage(error)}` };
    }
    return { status: 'failed', reason: `${appCode(error) ?? 'LEASE_FAILED'}: ${errorMessage(error)}` };
  }

  const current = await loadChapter(sql, job.workspace_id, chapter.chapter_id);
  if (!current) return { status: 'failed', reason: '章节不存在' };
  const committed = await commitFromStage(
    aiAuth,
    job,
    chapter.chapter_id,
    staged.id,
    current.current_version_id,
  );
  if (!committed.ok) {
    await releaseChapterArtifacts(aiAuth, chapter.chapter_id, null);
    return { status: 'failed', reason: committed.reason, evaluationId: staged.evaluation_id };
  }
  return {
    status: 'committed',
    reason: null,
    versionId: committed.versionId,
    evaluationId: staged.evaluation_id,
  };
}

async function runChapter(
  aiAuth: AuthContext,
  job: RunningJobRow,
  mandate: MandateRuntimeRow,
  chapter: NextChapterRow,
): Promise<ChapterOutcome> {
  let proposalId: string | null = null;
  try {
    await acquireLease(aiAuth, chapter.chapter_id);
  } catch (error) {
    if (appCode(error) === 'LEASE_HELD' || appCode(error) === 'CHAPTER_READ_ONLY') {
      return { status: 'skipped', reason: `external_state：${errorMessage(error)}` };
    }
    return { status: 'failed', reason: `${appCode(error) ?? 'LEASE_FAILED'}: ${errorMessage(error)}` };
  }

  await markChapterRunning(job.id, chapter.chapter_id);
  const current = await loadChapter(sql, job.workspace_id, chapter.chapter_id);
  if (!current) return { status: 'failed', reason: '章节不存在' };

  try {
    const budget = await budgetForJob(job, mandate);
    const run = await prepareProposal(
      aiAuth,
      chapter.chapter_id,
      {
        mode: 'continue',
        instruction: mandate.instruction,
        targetWords: mandate.target_words,
      },
      (provider) => mandate.allow_remote_models || isLocalBaseUrl(provider.baseUrl),
      { budget, jobId: job.id },
    );
    proposalId = run.proposalId;
    activeAbort = new AbortController();
    const result: ProposalRunResult = await executeProposal(
      run,
      { onDelta: () => undefined },
      activeAbort.signal,
    );
    activeAbort = null;

    if (!result.ok) {
      if (shuttingDown) {
        return { status: 'interrupted', reason: '服务关闭，章节中断', proposalId };
      }
      if (result.code === 'BUDGET_INSUFFICIENT' || result.code === 'BUDGET_GUARD_UNAVAILABLE') {
        return {
          status: 'budget_guard',
          reason: `${result.code}: ${result.message}`,
          proposalId,
        };
      }
      return {
        status: 'failed',
        reason: `${result.code}: ${result.message}`,
        proposalId,
      };
    }

    const proposal = result.proposal;
    proposalId = proposal.id;
    const cost = proposal.cost;
    const costCurrency = proposal.costCurrency as 'CNY' | 'USD' | null;
    if (!proposal.content.trim()) {
      return { status: 'no_output', reason: '模型返回空正文', proposalId, cost, costCurrency };
    }

    try {
      await saveDraft(aiAuth, chapter.chapter_id, proposal.content);
    } catch (error) {
      if (appCode(error) === 'EMPTY_DRAFT') {
        return { status: 'no_output', reason: '模型返回空正文', proposalId, cost, costCurrency };
      }
      throw error;
    }

    const evaluation = await evaluateChapterGates(aiAuth, chapter.chapter_id);
    if (evaluation.status !== 'passed') {
      const failures = evaluation.results
        .filter((item) => item.status !== 'passed')
        .map((item) => `${item.label}：${item.message}`)
        .join('；');
      return {
        status: 'gate_failed',
        reason: truncate(`门禁未通过，未入库。${failures}`),
        proposalId,
        evaluationId: evaluation.id,
        cost,
        costCurrency,
      };
    }

    const draft = await loadLatestDraft(sql, chapter.chapter_id, aiAuth.user.id);
    if (!draft) {
      return {
        status: 'failed',
        reason: '门禁通过后找不到 AI 草稿',
        proposalId,
        evaluationId: evaluation.id,
        cost,
        costCurrency,
      };
    }
    const staged = await stageDraft(
      aiAuth,
      chapter.chapter_id,
      evaluation.id,
      draft.content_hash,
    );

    if (!mandate.allow_auto_commit) {
      return {
        status: 'staged',
        reason: '门禁已通过，等待人工提交',
        proposalId,
        evaluationId: evaluation.id,
        cost,
        costCurrency,
      };
    }

    const committed = await commitFromStage(
      aiAuth,
      job,
      chapter.chapter_id,
      staged.stagedDraft.id,
      current.current_version_id,
    );
    if (!committed.ok) {
      return {
        status: 'failed',
        reason: committed.reason,
        proposalId,
        evaluationId: evaluation.id,
        cost,
        costCurrency,
      };
    }
    return {
      status: 'committed',
      reason: null,
      proposalId,
      versionId: committed.versionId,
      evaluationId: evaluation.id,
      cost,
      costCurrency,
    };
  } catch (error) {
    if (shuttingDown) {
      return { status: 'interrupted', reason: '服务关闭，章节中断', proposalId };
    }
    const code = appCode(error);
    if (code === 'LEASE_HELD' || code === 'CHAPTER_NOT_EDITABLE') {
      return { status: 'skipped', reason: `external_state：${errorMessage(error)}`, proposalId };
    }
    if (code === 'AI_GENERATION_IN_PROGRESS') {
      return { status: 'skipped', reason: `ai_lock：${errorMessage(error)}`, proposalId };
    }
    return {
      status: 'failed',
      reason: truncate(`${code ?? 'CHAPTER_FAILED'}: ${errorMessage(error)}`),
      proposalId,
    };
  } finally {
    activeAbort = null;
    await releaseChapterArtifacts(aiAuth, chapter.chapter_id, proposalId);
  }
}

async function processJob(job: RunningJobRow): Promise<void> {
  const heartbeatTimer = setInterval(() => {
    void heartbeat(job.id).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  try {
    const mandate = await loadMandateRuntime(job);
    if (!mandate) {
      await finishJob(job.id, 'failed', '自动化授权不存在');
      return;
    }
    const inactive = mandateInactiveReason(mandate);
    if (inactive) {
      await sql`
        UPDATE automation_mandates SET status = 'expired'
        WHERE id = ${mandate.id} AND status = 'active' AND expires_at <= now()
      `;
      await finishJob(job.id, 'stopped', inactive);
      return;
    }

    // 预检通过后规则集或授权确认仍可能被改动，提交链入口再做一次防御。
    const ruleset = await loadRuleset();
    if (!ruleset) {
      await finishJob(job.id, 'failed', '没有可用的门禁规则集，作业已停止');
      return;
    }
    if (
      mandate.allow_auto_commit &&
      !ruleset.is_production &&
      !mandate.allow_non_production_gates
    ) {
      await finishJob(
        job.id,
        'failed',
        `门禁策略不满足：规则集 ${ruleset.key} v${ruleset.version} 不是生产规则集，授权未显式接受非生产门禁，不能自动入库。`,
      );
      return;
    }

    const flags = await sql<
      {
        pause_requested: boolean;
        stop_requested: boolean;
        status: string;
        cost_unknown: boolean;
      }[]
    >`
      SELECT pause_requested, stop_requested, status, cost_unknown
      FROM automation_jobs WHERE id = ${job.id}
    `;
    const current = flags[0];
    if (!current || current.status !== 'running') return;
    if (current.stop_requested) {
      await finishJob(job.id, 'stopped', '用户请求停止');
      return;
    }
    if (current.pause_requested) {
      await finishJob(job.id, 'paused', '用户请求在章节边界暂停');
      return;
    }

    const chapter = await nextChapter(job.id);
    if (!chapter) {
      await settleJob(job.id);
      return;
    }

    const budgetReason = await settleBudgetReason({
      ...job,
      cost_unknown: current.cost_unknown,
    });
    if (budgetReason) {
      await finishJob(job.id, 'paused', `${budgetReason}，作业在章节检查点暂停。`);
      return;
    }

    const aiAuth = await buildAgentAuth(job);
    const lease = await loadLease(sql, chapter.chapter_id);
    if (isLeaseActive(lease) && lease!.user_id !== aiAuth.user.id) {
      await markJobChapter(job, chapter.chapter_id, {
        status: 'skipped',
        reason: `lease_held：章节租约由 ${lease!.user_name} 持有`,
      });
      await settleJob(job.id);
      return;
    }

    if (chapter.chapter_status === 'canon') {
      await markJobChapter(job, chapter.chapter_id, {
        status: 'skipped',
        reason: 'already_canon：章节已入正典，runner 不重复生成',
      });
      await settleJob(job.id);
      return;
    }
    if (chapter.chapter_status === 'staged' || chapter.chapter_status === 'commit_failed') {
      const outcome = await processStagedChapter(aiAuth, job, mandate, chapter);
      if (outcome) {
        if (outcome.status === 'failed' || outcome.status === 'interrupted') {
          await releaseChapterArtifacts(aiAuth, chapter.chapter_id, null);
        }
        await markJobChapter(job, chapter.chapter_id, outcome);
        await settleJob(job.id);
        return;
      }
    }
    if (chapter.chapter_status !== 'planned' && chapter.chapter_status !== 'writing') {
      await markJobChapter(job, chapter.chapter_id, {
        status: 'skipped',
        reason: `external_state：章节状态 ${chapter.chapter_status} 不允许无人值守续写`,
      });
      await settleJob(job.id);
      return;
    }

    const outcome = await runChapter(aiAuth, job, mandate, chapter);
    if (outcome.status === 'budget_guard') {
      await releaseChapterToPending(job.id, chapter.chapter_id, outcome.reason);
      await finishJob(
        job.id,
        'paused',
        `${outcome.reason ?? '预算保护'}；作业在调用前暂停，章节保持待办。`,
      );
      return;
    }
    await markJobChapter(job, chapter.chapter_id, outcome);
    await settleJob(job.id);
  } catch (error) {
    if (shuttingDown) {
      await interruptRunningJob(job.id, '服务关闭，作业中断');
    } else {
      await sql`
        UPDATE automation_jobs SET last_error = ${truncate(errorMessage(error))}, updated_at = now()
        WHERE id = ${job.id}
      `;
      await interruptRunningJob(job.id, `runner 异常：${truncate(errorMessage(error))}`);
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function interruptRunningJob(jobId: string, reason: string): Promise<void> {
  const rows = await sql<{ workspace_id: string; current_chapter_id: string | null }[]>`
    UPDATE automation_jobs SET
      status = 'interrupted',
      runner_id = NULL,
      heartbeat_at = NULL,
      current_chapter_id = NULL,
      last_error = ${reason},
      updated_at = now()
    WHERE id = ${jobId} AND status = 'running'
    RETURNING workspace_id, current_chapter_id
  `;
  const job = rows[0];
  if (!job) return;
  const chapters = await sql<{ chapter_id: string }[]>`
    UPDATE automation_job_chapters SET
      status = 'interrupted',
      reason = ${reason},
      completed_at = now()
    WHERE job_id = ${jobId} AND status = 'running'
    RETURNING chapter_id
  `;
  if (chapters.length === 0) return;
  const agent = await ensureAutomationAgent(sql, job.workspace_id);
  const ids = chapters.map((chapter) => chapter.chapter_id);
  await sql`
    UPDATE ai_proposals SET
      status = 'failed',
      error_code = 'AI_ABANDONED',
      error_message = ${reason},
      completed_at = now()
    WHERE chapter_id IN ${sql(ids)} AND status = 'generating'
  `;
  await sql`DELETE FROM ai_generation_locks WHERE chapter_id IN ${sql(ids)}`;
  await sql`
    DELETE FROM chapter_leases
    WHERE chapter_id IN ${sql(ids)} AND user_id = ${agent.id}
  `;
}

async function recoverStaleJobs(): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM automation_jobs
    WHERE status = 'running'
      AND (heartbeat_at IS NULL OR heartbeat_at < now() - ${`${STALE_AFTER_MS / 1000} seconds`}::interval)
  `;
  for (const row of rows) {
    await interruptRunningJob(row.id, 'runner 心跳超时，作业已中断；请人工确认后恢复');
  }
}

async function findOwnedRunningJob(): Promise<RunningJobRow | null> {
  const rows = await sql<RunningJobRow[]>`
    SELECT id, workspace_id, work_id, mandate_id, status, cost_currency, cost_unknown,
           pause_requested, stop_requested, runner_id
    FROM automation_jobs
    WHERE status = 'running' AND runner_id = ${automationRunnerId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function claimQueuedJob(): Promise<RunningJobRow | null> {
  const rows = await sql<RunningJobRow[]>`
    UPDATE automation_jobs SET
      status = 'running',
      runner_id = ${automationRunnerId},
      heartbeat_at = now(),
      started_at = COALESCE(started_at, now()),
      last_error = NULL,
      updated_at = now()
    WHERE id = (
      SELECT id FROM automation_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    AND status = 'queued'
    RETURNING id, workspace_id, work_id, mandate_id, status, cost_currency, cost_unknown,
              pause_requested, stop_requested, runner_id
  `;
  return rows[0] ?? null;
}

export async function runAutomationTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await recoverStaleJobs();
    const job = (await findOwnedRunningJob()) ?? (await claimQueuedJob());
    if (!job) return;
    await processJob(job);
  } finally {
    tickInFlight = false;
  }
}

export function startAutomationRunner(pollMs = 2000): void {
  if (timer) return;
  shuttingDown = false;
  timer = setInterval(() => {
    void runAutomationTick().catch((error) => {
      console.error('自动化 runner 轮询失败', error);
    });
  }, pollMs);
  timer.unref?.();
  void runAutomationTick().catch((error) => {
    console.error('自动化 runner 首次轮询失败', error);
  });
}

export async function stopAutomationRunner(): Promise<void> {
  shuttingDown = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  activeAbort?.abort();
  const owned = await sql<{ id: string }[]>`
    SELECT id FROM automation_jobs WHERE status = 'running' AND runner_id = ${automationRunnerId}
  `;
  for (const row of owned) {
    await interruptRunningJob(row.id, '服务关闭，作业已中断；重启后可人工恢复');
  }
}
