import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { sql, jsonValue } from '@yunshuo/db';
import { checkGateFeasibility } from '@yunshuo/gates';
import type {
  AutomationJobInput,
  AutomationMandateInput,
  AutomationMandateView,
  AutomationJobView,
  AutomationPreflightCheck,
  AutomationPreflightView,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { loadRuleset } from './chapter-data.js';
import { ensureAutomationAgent } from './automation-agent.js';
import { loadGenerationProviders, isLocalBaseUrl } from './provider-service.js';
import { workspaceBudgetPreflight } from './billing-service.js';
import { iso } from '../views.js';

export type Executor = Sql<any> | TransactionSql<any>;

interface MandateRow {
  id: string;
  workspace_id: string;
  work_id: string;
  work_title: string;
  name: string;
  mode: 'continue';
  chapter_min: number;
  chapter_max: number;
  max_chapters: number;
  target_words: number;
  instruction: string;
  allow_auto_commit: boolean;
  allow_remote_models: boolean;
  allow_non_production_gates: boolean;
  budget_limit: string | null;
  budget_currency: 'CNY' | 'USD';
  status: 'active' | 'revoked' | 'expired';
  expires_at: Date | string;
  created_by: string;
  created_by_name: string;
  revoked_at: Date | string | null;
  revoked_by_name: string | null;
  created_at: Date | string;
}

interface ScopedChapterRow {
  id: string;
  work_id: string;
  number: number;
  title: string;
  status: string;
  plan: { requiredEntities?: string[]; goalKeywords?: string[]; obstacleKeywords?: string[] };
}

export function assertCanAutomate(role: AuthContext['role']): void {
  if (role !== 'owner' && role !== 'lead') {
    throw forbidden('仅所有者与主笔可以创建或管理自动化授权');
  }
}

function decimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapMandate(row: MandateRow): AutomationMandateView {
  return {
    id: row.id,
    workId: row.work_id,
    workTitle: row.work_title,
    name: row.name,
    mode: 'continue',
    chapterMin: row.chapter_min,
    chapterMax: row.chapter_max,
    maxChapters: row.max_chapters,
    targetWords: row.target_words,
    instruction: row.instruction,
    allowAutoCommit: row.allow_auto_commit,
    allowRemoteModels: row.allow_remote_models,
    allowNonProductionGates: row.allow_non_production_gates,
    budgetLimit: decimal(row.budget_limit),
    budgetCurrency: row.budget_currency,
    status: row.status,
    expiresAt: iso(row.expires_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    revokedByName: row.revoked_by_name,
    createdAt: iso(row.created_at),
  };
}

async function loadMandateRow(
  exec: Executor,
  workspaceId: string,
  mandateId: string,
  lock = false,
): Promise<MandateRow | null> {
  const rows = lock
    ? await exec<MandateRow[]>`
        SELECT
          m.*, w.title AS work_title,
          creator.name AS created_by_name, revoker.name AS revoked_by_name
        FROM automation_mandates m
        JOIN works w ON w.id = m.work_id
        JOIN users creator ON creator.id = m.created_by
        LEFT JOIN users revoker ON revoker.id = m.revoked_by
        WHERE m.id = ${mandateId} AND m.workspace_id = ${workspaceId}
        FOR UPDATE OF m
      `
    : await exec<MandateRow[]>`
        SELECT
          m.*, w.title AS work_title,
          creator.name AS created_by_name, revoker.name AS revoked_by_name
        FROM automation_mandates m
        JOIN works w ON w.id = m.work_id
        JOIN users creator ON creator.id = m.created_by
        LEFT JOIN users revoker ON revoker.id = m.revoked_by
        WHERE m.id = ${mandateId} AND m.workspace_id = ${workspaceId}
      `;
  return rows[0] ?? null;
}

async function assertActiveMandate(exec: Executor, mandate: MandateRow): Promise<void> {
  if (mandate.status === 'revoked') {
    throw conflict('MANDATE_REVOKED', '该自动化授权已撤销，不能创建或恢复作业');
  }
  if (mandate.status === 'expired' || new Date(mandate.expires_at).getTime() <= Date.now()) {
    await exec`UPDATE automation_mandates SET status = 'expired' WHERE id = ${mandate.id} AND status = 'active'`;
    throw conflict('MANDATE_EXPIRED', '该自动化授权已过期，请重新创建');
  }
}

export async function createMandate(
  auth: AuthContext,
  input: AutomationMandateInput,
): Promise<AutomationMandateView> {
  assertCanAutomate(auth.role);
  const works = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM works
    WHERE id = ${input.workId} AND workspace_id = ${auth.workspace.id}
  `;
  if (!works[0]) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO automation_mandates (
        id, workspace_id, work_id, name, mode, chapter_min, chapter_max, max_chapters,
        target_words, instruction, allow_auto_commit, allow_remote_models,
        allow_non_production_gates, budget_limit, budget_currency, status, expires_at, created_by
      )
      VALUES (
        ${id}, ${auth.workspace.id}, ${input.workId}, ${input.name}, ${input.mode},
        ${input.chapterMin}, ${input.chapterMax}, ${input.maxChapters}, ${input.targetWords},
        ${input.instruction}, ${input.allowAutoCommit}, ${input.allowRemoteModels},
        ${input.allowNonProductionGates}, ${input.budgetLimit}, ${input.budgetCurrency},
        'active', ${expiresAt}, ${auth.user.id}
      )
    `;
    const payload = {
      mandateId: id,
      workId: input.workId,
      chapterMin: input.chapterMin,
      chapterMax: input.chapterMax,
      maxChapters: input.maxChapters,
      allowAutoCommit: input.allowAutoCommit,
      allowRemoteModels: input.allowRemoteModels,
      allowNonProductionGates: input.allowNonProductionGates,
      budgetLimit: input.budgetLimit,
      budgetCurrency: input.budgetCurrency,
      expiresAt: expiresAt.toISOString(),
    };
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'automation_mandate', ${id}, 'automation.mandate.created',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'automation.mandate.create',
        'automation_mandate', ${id}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;
  });

  const row = await loadMandateRow(sql, auth.workspace.id, id);
  if (!row) throw new Error('授权创建后读取失败');
  return mapMandate(row);
}

export async function listMandates(
  auth: AuthContext,
  workId?: string,
): Promise<AutomationMandateView[]> {
  assertCanAutomate(auth.role);
  await sql`
    UPDATE automation_mandates SET status = 'expired'
    WHERE workspace_id = ${auth.workspace.id} AND status = 'active' AND expires_at <= now()
  `;
  const rows = workId
    ? await sql<MandateRow[]>`
        SELECT
          m.*, w.title AS work_title,
          creator.name AS created_by_name, revoker.name AS revoked_by_name
        FROM automation_mandates m
        JOIN works w ON w.id = m.work_id
        JOIN users creator ON creator.id = m.created_by
        LEFT JOIN users revoker ON revoker.id = m.revoked_by
        WHERE m.workspace_id = ${auth.workspace.id} AND m.work_id = ${workId}
        ORDER BY m.created_at DESC
      `
    : await sql<MandateRow[]>`
        SELECT
          m.*, w.title AS work_title,
          creator.name AS created_by_name, revoker.name AS revoked_by_name
        FROM automation_mandates m
        JOIN works w ON w.id = m.work_id
        JOIN users creator ON creator.id = m.created_by
        LEFT JOIN users revoker ON revoker.id = m.revoked_by
        WHERE m.workspace_id = ${auth.workspace.id}
        ORDER BY m.created_at DESC
      `;
  return rows.map(mapMandate);
}

export async function revokeMandate(
  auth: AuthContext,
  mandateId: string,
): Promise<AutomationMandateView> {
  assertCanAutomate(auth.role);
  await sql.begin(async (tx) => {
    const mandate = await loadMandateRow(tx, auth.workspace.id, mandateId, true);
    if (!mandate) throw notFound('MANDATE_NOT_FOUND', '自动化授权不存在');
    if (mandate.status !== 'revoked') {
      await tx`
        UPDATE automation_mandates
        SET status = 'revoked', revoked_by = ${auth.user.id}, revoked_at = now()
        WHERE id = ${mandateId}
      `;
    }
    await tx`
      UPDATE automation_jobs
      SET status = 'stopped', stop_requested = true, completed_at = now(), updated_at = now()
      WHERE mandate_id = ${mandateId} AND status IN ('queued', 'paused')
    `;
    await tx`
      UPDATE automation_jobs SET stop_requested = true, updated_at = now()
      WHERE mandate_id = ${mandateId} AND status = 'running'
    `;
    const payload = { mandateId };
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'automation_mandate', ${mandateId}, 'automation.mandate.revoked',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'automation.mandate.revoke',
        'automation_mandate', ${mandateId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;
  });
  const row = await loadMandateRow(sql, auth.workspace.id, mandateId);
  if (!row) throw notFound('MANDATE_NOT_FOUND', '自动化授权不存在');
  return mapMandate(row);
}

async function loadScopedChapters(
  exec: Executor,
  workspaceId: string,
  workId: string,
  chapterIds: string[],
): Promise<ScopedChapterRow[]> {
  if (chapterIds.length === 0) return [];
  return exec<ScopedChapterRow[]>`
    SELECT c.id, c.work_id, c.number, c.title, c.status, c.plan
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE w.workspace_id = ${workspaceId} AND c.work_id = ${workId}
      AND c.id IN ${sql(chapterIds)}
    ORDER BY c.number ASC
  `;
}

export interface PreflightResult {
  view: AutomationPreflightView;
  chapters: ScopedChapterRow[];
}

export async function runPreflight(
  auth: AuthContext,
  mandate: MandateRow,
  rawChapterIds: string[],
): Promise<PreflightResult> {
  const chapterIds = [...new Set(rawChapterIds)];
  const checks: AutomationPreflightCheck[] = [];
  const push = (
    key: string,
    label: string,
    status: AutomationPreflightCheck['status'],
    detail: string,
  ): void => {
    checks.push({ key, label, status, detail });
  };

  if (mandate.status === 'active' && new Date(mandate.expires_at).getTime() <= Date.now()) {
    await sql`
      UPDATE automation_mandates SET status = 'expired'
      WHERE id = ${mandate.id} AND status = 'active'
    `;
    mandate.status = 'expired';
  }
  if (mandate.status === 'revoked') {
    push('mandate', '授权状态', 'fail', '授权已撤销，不能启动作业。');
  } else if (mandate.status === 'expired' || new Date(mandate.expires_at).getTime() <= Date.now()) {
    push('mandate', '授权状态', 'fail', '授权已过期，请重新创建授权。');
  } else {
    push('mandate', '授权状态', 'pass', `授权有效，截止 ${iso(mandate.expires_at)}。`);
  }

  const chapters = await loadScopedChapters(sql, auth.workspace.id, mandate.work_id, chapterIds);
  const missing = chapterIds.length - chapters.length;
  if (chapterIds.length === 0) {
    push('chapter_scope', '章节范围', 'fail', '至少需要选择一个章节。');
  } else if (missing > 0) {
    push(
      'chapter_scope',
      '章节范围',
      'fail',
      `${missing} 个所选章节不存在或不属于该作品；请刷新章节列表后重选。`,
    );
  } else {
    const outsideRange = chapters.filter(
      (chapter) => chapter.number < mandate.chapter_min || chapter.number > mandate.chapter_max,
    );
    const overLimit = chapters.length > mandate.max_chapters;
    if (outsideRange.length > 0) {
      push(
        'chapter_scope',
        '章节范围',
        'fail',
        `所选章节超出授权范围（第 ${mandate.chapter_min}–${mandate.chapter_max} 章）：${outsideRange
          .map((chapter) => `第${chapter.number}章`)
          .join('、')}。`,
      );
    } else if (overLimit) {
      push(
        'chapter_scope',
        '章节范围',
        'fail',
        `本次选择 ${chapters.length} 章，超过授权上限 ${mandate.max_chapters} 章。`,
      );
    } else {
      push(
        'chapter_scope',
        '章节范围',
        'pass',
        `已选择 ${chapters.length} 章：${chapters.map((chapter) => `第${chapter.number}章`).join('、')}。`,
      );
    }
  }

  const notWritable = chapters.filter(
    (chapter) => chapter.status !== 'planned' && chapter.status !== 'writing',
  );
  if (chapters.length === 0) {
    push('chapter_status', '章节可写状态', 'fail', '没有可检查的章节。');
  } else if (notWritable.length > 0) {
    push(
      'chapter_status',
      '章节可写状态',
      'fail',
      `续写只处理「规划中 / 写作中」章节；${notWritable
        .map((chapter) => `第${chapter.number}章（${chapter.status}）`)
        .join('、')} 当前不可续写。`,
    );
  } else {
    push('chapter_status', '章节可写状态', 'pass', '所选章节均处于规划中或写作中。');
  }

  const activeJobs = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM automation_jobs
    WHERE workspace_id = ${auth.workspace.id} AND status IN ('queued', 'running', 'paused')
    LIMIT 1
  `;
  if (activeJobs[0]) {
    push(
      'conflicting_job',
      '并发作业',
      'fail',
      `当前工作区已有进行中的作业（${activeJobs[0].status}，${activeJobs[0].id}）。本版 runner 一次只执行一个作业。`,
    );
  } else {
    push('conflicting_job', '并发作业', 'pass', '当前没有其他排队、运行或暂停中的作业。');
  }

  const ruleset = await loadRuleset();
  if (!ruleset) {
    push('gate_feasibility', '门禁可行性', 'fail', '没有可用的门禁规则集。');
  } else if (chapters.length === 0) {
    push('gate_feasibility', '门禁可行性', 'fail', '没有可检查的章节计划。');
  } else {
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!ruleset.is_production) {
      const policy = `当前门禁规则集 ${ruleset.key} v${ruleset.version} 不是生产规则集${
        ruleset.description ? `（${ruleset.description}）` : ''
      }。`;
      if (mandate.allow_auto_commit && !mandate.allow_non_production_gates) {
        blockers.unshift(
          `${policy}自动入库必须由所有者显式接受非生产门禁；或关闭自动入库改为仅暂存。`,
        );
      } else if (mandate.allow_auto_commit) {
        warnings.unshift(`${policy}授权已显式接受非生产门禁，自动入库仍按该规则集判定。`);
      } else {
        warnings.unshift(`${policy}本次只暂存、不自动入库，仍需人工提交。`);
      }
    }
    for (const chapter of chapters) {
      const result = checkGateFeasibility({
        plan: chapter.plan ?? {},
        ruleset: ruleset.rules,
        targetWords: mandate.target_words,
      });
      for (const blocker of result.blockers) {
        blockers.push(`第${chapter.number}章：${blocker}`);
      }
      for (const warning of result.warnings) {
        warnings.push(`第${chapter.number}章：${warning}`);
      }
    }
    if (blockers.length > 0) {
      push('gate_feasibility', '门禁可行性', 'fail', blockers.join(' '));
    } else if (warnings.length > 0) {
      push('gate_feasibility', '门禁可行性', 'warn', warnings.join(' '));
    } else {
      push('gate_feasibility', '门禁可行性', 'pass', '规则集与章节计划可以让五门禁全部判定。');
    }
  }

  const spentRows = await sql<{ spent: string | null }[]>`
    SELECT COALESCE(SUM(spent), 0)::text AS spent
    FROM automation_jobs
    WHERE mandate_id = ${mandate.id}
  `;
  const totalSpent = decimal(spentRows[0]?.spent) ?? 0;

  let providers: Awaited<ReturnType<typeof loadGenerationProviders>> | null = null;
  let providerError: string | null = null;
  try {
    providers = await loadGenerationProviders(auth.workspace.id);
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error);
  }
  if (!providers) {
    push('providers', '模型服务商', 'fail', providerError ?? '没有可用的对话模型服务商。');
    push('remote_policy', '远程数据策略', 'fail', '没有服务商可检查远程策略。');
    push('budget', '预算', 'fail', '没有服务商价表，无法检查预算。');
  } else {
    const names = providers.providers.map((provider) => `${provider.name}（${provider.model}）`);
    if (providers.skipped.length > 0) {
      push(
        'providers',
        '模型服务商',
        'warn',
        `可用：${names.join('、')}。跳过：${providers.skipped
          .map((item) => `${item.name}（${item.reason}）`)
          .join('、')}。`,
      );
    } else {
      push('providers', '模型服务商', 'pass', `可用：${names.join('、')}。`);
    }

    const remote = providers.providers.filter(
      (provider) => !isLocalBaseUrl(provider.baseUrl),
    );
    if (mandate.allow_remote_models) {
      push(
        'remote_policy',
        '远程数据策略',
        'pass',
        remote.length > 0
          ? `授权允许远程模型；正文会发送到：${remote.map((item) => item.name).join('、')}。`
          : '授权允许远程模型，但当前候选服务商都是本机端点。',
      );
    } else if (remote.length > 0) {
      push(
        'remote_policy',
        '远程数据策略',
        'fail',
        `授权未允许远程模型，但候选服务商包含远程端点：${remote
          .map((item) => `${item.name}（${item.baseUrl}）`)
          .join('、')}。请启用本机服务商或在授权中明确允许远程。`,
      );
    } else {
      push('remote_policy', '远程数据策略', 'pass', '候选服务商均为本机端点。');
    }

    const incomplete = providers.providers.filter(
      (provider) =>
        provider.promptPricePer1m === null || provider.completionPricePer1m === null,
    );
    const currencyMismatch = providers.providers.filter(
      (provider) => provider.priceCurrency !== mandate.budget_currency,
    );
    const spent = totalSpent;
    const limit = decimal(mandate.budget_limit);
    if (limit === null) {
      push(
        'budget',
        '预算',
        'warn',
        `授权未设置预算上限；没有调用级 max_tokens 硬上限，只在章节检查点累计已知费用（已花费 ${spent.toFixed(4)} ${mandate.budget_currency}）。`,
      );
    } else if (incomplete.length > 0) {
      push(
        'budget',
        '预算',
        'fail',
        `授权设置了预算，但服务商未填写完整价表：${incomplete
          .map((item) => item.name)
          .join('、')}。无法估算费用，请补齐价格或清空预算上限。`,
      );
    } else if (currencyMismatch.length > 0) {
      push(
        'budget',
        '预算',
        'fail',
        `预算币种为 ${mandate.budget_currency}，但服务商使用 ${[
          ...new Set(currencyMismatch.map((item) => item.priceCurrency)),
        ].join('、')}。请统一币种后再启用预算。`,
      );
    } else {
      const remaining = Math.round((limit - spent) * 10_000) / 10_000;
      if (remaining <= 0) {
        push(
          'budget',
          '预算',
          'fail',
          `该授权累计费用已达上限 ${limit} ${mandate.budget_currency}，不能继续。`,
        );
      } else {
        push(
          'budget',
          '预算',
          'pass',
          `上限 ${limit} ${mandate.budget_currency}，历史已花费 ${spent.toFixed(4)}，剩余 ${remaining.toFixed(4)}。每次调用按剩余预算与服务商价表限制 max_tokens，并在章节检查点累计；费用仍是按价表与 token 用量的估算，不是供应商账单。`,
        );
      }
    }
  }

  const workspaceBudget = await workspaceBudgetPreflight(auth.workspace.id);
  push('workspace_budget', '工作区预算', workspaceBudget.status, workspaceBudget.detail);

  if (chapters.length > 0) {
    const leases = await sql<{ number: number; user_name: string }[]>`
      SELECT c.number, u.name AS user_name
      FROM chapter_leases cl
      JOIN chapters c ON c.id = cl.chapter_id
      JOIN users u ON u.id = cl.user_id
      WHERE cl.chapter_id IN ${sql(chapters.map((chapter) => chapter.id))}
        AND cl.expires_at > now() AND u.kind = 'human'
      ORDER BY c.number
    `;
    if (leases.length > 0) {
      push(
        'human_lease',
        '人工租约',
        'warn',
        `${leases
          .map((lease) => `第${lease.number}章（${lease.user_name}）`)
          .join('、')} 正由人工持有租约；runner 会跳过这些章节，避免抢占。`,
      );
    } else {
      push('human_lease', '人工租约', 'pass', '所选章节当前没有人工持有的有效租约。');
    }
  }

  if (mandate.allow_auto_commit) {
    push(
      'auto_commit',
      '入库策略',
      'pass',
      '五门禁全部通过后自动提交正典，提交来源记为 batch；任一门禁失败都不会入库。',
    );
  } else {
    push(
      'auto_commit',
      '入库策略',
      'warn',
      '授权未开启自动入库；门禁通过后只暂存并释放租约，等待人工提交。',
    );
  }

  push(
    'waiver_policy',
    '豁免权限',
    'pass',
    'AI 不申请、不批准豁免；自动作业没有绕过门禁的路径。',
  );
  push(
    'backup',
    '备份',
    'warn',
    '自动备份/快照尚未接入；请先运行 scripts/backup-db.sh 手动备份并验证可恢复，再启动自动入库。',
  );
  push(
    'connectivity',
    '模型连通性',
    'warn',
    '预检不发起任何模型调用；连通性会在生成时验证，失败时该章标记为 failed。',
  );

  const view: AutomationPreflightView = {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      status: chapter.status as AutomationPreflightView['chapters'][number]['status'],
    })),
    providerNames: providers?.providers.map((provider) => provider.name) ?? [],
    unknownCost: providers
      ? providers.providers.some(
          (provider) =>
            provider.promptPricePer1m === null || provider.completionPricePer1m === null,
        )
      : true,
    budgetRemaining:
      decimal(mandate.budget_limit) === null
        ? null
        : Math.round(((decimal(mandate.budget_limit) ?? 0) - totalSpent) * 10_000) / 10_000,
    budgetCurrency: mandate.budget_currency,
    generatedAt: new Date().toISOString(),
  };

  return { view, chapters };
}

export async function preflightAutomation(
  auth: AuthContext,
  input: AutomationJobInput,
): Promise<AutomationPreflightView> {
  assertCanAutomate(auth.role);
  const mandate = await loadMandateRow(sql, auth.workspace.id, input.mandateId);
  if (!mandate) throw notFound('MANDATE_NOT_FOUND', '自动化授权不存在');
  const result = await runPreflight(auth, mandate, input.chapterIds);
  return result.view;
}

interface JobRow {
  id: string;
  workspace_id: string;
  work_id: string;
  work_title: string;
  mandate_id: string;
  mandate_name: string;
  status: AutomationJobView['status'];
  preflight: AutomationPreflightView;
  total_chapters: number;
  committed_chapters: number;
  staged_chapters: number;
  failed_chapters: number;
  skipped_chapters: number;
  spent: string;
  cost_currency: 'CNY' | 'USD';
  cost_unknown: boolean;
  runner_id: string | null;
  heartbeat_at: Date | string | null;
  current_chapter_id: string | null;
  pause_requested: boolean;
  stop_requested: boolean;
  last_error: string | null;
  created_by: string;
  created_by_name: string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface JobChapterRow {
  chapter_id: string;
  chapter_number: number;
  chapter_title: string;
  status: AutomationJobView['chapters'][number]['status'];
  proposal_id: string | null;
  version_id: string | null;
  evaluation_id: string | null;
  reason: string | null;
  cost: string | null;
  cost_currency: 'CNY' | 'USD' | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

async function loadJobView(exec: Executor, workspaceId: string, jobId: string): Promise<AutomationJobView> {
  const rows = await exec<JobRow[]>`
    SELECT
      j.*, w.title AS work_title, m.name AS mandate_name, u.name AS created_by_name
    FROM automation_jobs j
    JOIN works w ON w.id = j.work_id
    JOIN automation_mandates m ON m.id = j.mandate_id
    JOIN users u ON u.id = j.created_by
    WHERE j.id = ${jobId} AND j.workspace_id = ${workspaceId}
  `;
  const job = rows[0];
  if (!job) throw notFound('JOB_NOT_FOUND', '自动化作业不存在');
  const chapters = await exec<JobChapterRow[]>`
    SELECT
      jc.chapter_id, jc.chapter_number, c.title AS chapter_title, jc.status,
      jc.proposal_id, jc.version_id, jc.evaluation_id, jc.reason,
      jc.cost, jc.cost_currency, jc.started_at, jc.completed_at
    FROM automation_job_chapters jc
    JOIN chapters c ON c.id = jc.chapter_id
    WHERE jc.job_id = ${jobId}
    ORDER BY jc.chapter_number ASC
  `;
  return {
    id: job.id,
    workspaceId: job.workspace_id,
    workId: job.work_id,
    workTitle: job.work_title,
    mandateId: job.mandate_id,
    mandateName: job.mandate_name,
    status: job.status,
    preflight: job.preflight,
    totalChapters: job.total_chapters,
    committedChapters: job.committed_chapters,
    stagedChapters: job.staged_chapters,
    failedChapters: job.failed_chapters,
    skippedChapters: job.skipped_chapters,
    spent: decimal(job.spent) ?? 0,
    costCurrency: job.cost_currency,
    costUnknown: job.cost_unknown,
    runnerId: job.runner_id,
    heartbeatAt: job.heartbeat_at ? iso(job.heartbeat_at) : null,
    currentChapterId: job.current_chapter_id,
    pauseRequested: job.pause_requested,
    stopRequested: job.stop_requested,
    lastError: job.last_error,
    createdBy: job.created_by,
    createdByName: job.created_by_name,
    startedAt: job.started_at ? iso(job.started_at) : null,
    completedAt: job.completed_at ? iso(job.completed_at) : null,
    createdAt: iso(job.created_at),
    updatedAt: iso(job.updated_at),
    chapters: chapters.map((chapter) => ({
      chapterId: chapter.chapter_id,
      chapterNumber: chapter.chapter_number,
      chapterTitle: chapter.chapter_title,
      status: chapter.status,
      proposalId: chapter.proposal_id,
      versionId: chapter.version_id,
      evaluationId: chapter.evaluation_id,
      reason: chapter.reason,
      cost: decimal(chapter.cost),
      costCurrency: chapter.cost_currency,
      startedAt: chapter.started_at ? iso(chapter.started_at) : null,
      completedAt: chapter.completed_at ? iso(chapter.completed_at) : null,
    })),
  };
}

export async function getJob(auth: AuthContext, jobId: string): Promise<AutomationJobView> {
  assertCanAutomate(auth.role);
  return loadJobView(sql, auth.workspace.id, jobId);
}

export async function listJobs(
  auth: AuthContext,
  workId?: string,
): Promise<AutomationJobView[]> {
  assertCanAutomate(auth.role);
  const ids = workId
    ? await sql<{ id: string }[]>`
        SELECT id FROM automation_jobs
        WHERE workspace_id = ${auth.workspace.id} AND work_id = ${workId}
        ORDER BY created_at DESC LIMIT 20
      `
    : await sql<{ id: string }[]>`
        SELECT id FROM automation_jobs
        WHERE workspace_id = ${auth.workspace.id}
        ORDER BY created_at DESC LIMIT 20
      `;
  const jobs: AutomationJobView[] = [];
  for (const row of ids) {
    jobs.push(await loadJobView(sql, auth.workspace.id, row.id));
  }
  return jobs;
}

export async function createJob(
  auth: AuthContext,
  input: AutomationJobInput,
): Promise<AutomationJobView> {
  assertCanAutomate(auth.role);
  const mandate = await loadMandateRow(sql, auth.workspace.id, input.mandateId);
  if (!mandate) throw notFound('MANDATE_NOT_FOUND', '自动化授权不存在');
  await assertActiveMandate(sql, mandate);

  const preflight = await runPreflight(auth, mandate, input.chapterIds);
  if (!preflight.view.ok) {
    const failures = preflight.view.checks.filter((check) => check.status === 'fail');
    throw conflict(
      'AUTOMATION_PRECHECK_FAILED',
      `预检未通过：${failures.map((check) => check.detail).join(' ')}`,
      { preflight: preflight.view },
    );
  }

  const jobId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`automation:${auth.workspace.id}`}, 0))`;
    const active = await tx<{ id: string }[]>`
      SELECT id FROM automation_jobs
      WHERE workspace_id = ${auth.workspace.id} AND status IN ('queued', 'running', 'paused')
      LIMIT 1
    `;
    if (active[0]) {
      throw conflict('AUTOMATION_JOB_CONFLICT', '当前工作区已有进行中的自动化作业');
    }
    await ensureAutomationAgent(tx, auth.workspace.id);
    await tx`
      INSERT INTO automation_jobs (
        id, workspace_id, work_id, mandate_id, status, preflight, total_chapters,
        cost_currency, created_by
      )
      VALUES (
        ${jobId}, ${auth.workspace.id}, ${mandate.work_id}, ${mandate.id}, 'queued',
        ${tx.json(jsonValue(preflight.view))}, ${preflight.chapters.length},
        ${mandate.budget_currency}, ${auth.user.id}
      )
    `;
    for (const chapter of preflight.chapters) {
      await tx`
        INSERT INTO automation_job_chapters (job_id, chapter_id, chapter_number, status)
        VALUES (${jobId}, ${chapter.id}, ${chapter.number}, 'pending')
      `;
    }
    const payload = {
      jobId,
      mandateId: mandate.id,
      workId: mandate.work_id,
      chapterIds: preflight.chapters.map((chapter) => chapter.id),
      allowAutoCommit: mandate.allow_auto_commit,
      allowRemoteModels: mandate.allow_remote_models,
    };
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'automation_job', ${jobId}, 'automation.job.queued',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'automation.job.create',
        'automation_job', ${jobId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;
  });

  return loadJobView(sql, auth.workspace.id, jobId);
}

async function recordJobAction(
  auth: AuthContext,
  jobId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'automation_job', ${jobId}, ${`automation.job.${action}`},
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, ${`automation.job.${action}`},
        'automation_job', ${jobId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;
  });
}

export async function pauseJob(auth: AuthContext, jobId: string): Promise<AutomationJobView> {
  assertCanAutomate(auth.role);
  const job = await loadJobView(sql, auth.workspace.id, jobId);
  if (job.status === 'paused') return job;
  if (job.status === 'queued') {
    await sql`
      UPDATE automation_jobs
      SET status = 'paused', pause_requested = true, updated_at = now()
      WHERE id = ${jobId} AND status = 'queued'
    `;
    await recordJobAction(auth, jobId, 'pause', { jobId, boundary: 'before_start' });
  } else if (job.status === 'running') {
    await sql`
      UPDATE automation_jobs SET pause_requested = true, updated_at = now()
      WHERE id = ${jobId} AND status = 'running'
    `;
    await recordJobAction(auth, jobId, 'pause', { jobId, boundary: 'chapter_end' });
  } else {
    throw conflict('JOB_NOT_PAUSABLE', `作业当前状态 ${job.status}，不能暂停`);
  }
  return loadJobView(sql, auth.workspace.id, jobId);
}

export async function stopJob(auth: AuthContext, jobId: string): Promise<AutomationJobView> {
  assertCanAutomate(auth.role);
  const job = await loadJobView(sql, auth.workspace.id, jobId);
  if (job.status === 'stopped') return job;
  if (job.status === 'queued' || job.status === 'paused' || job.status === 'interrupted') {
    await sql`
      UPDATE automation_jobs
      SET status = 'stopped', stop_requested = true, completed_at = now(), updated_at = now()
      WHERE id = ${jobId}
    `;
    await recordJobAction(auth, jobId, 'stop', { jobId, boundary: 'before_start' });
  } else if (job.status === 'running') {
    await sql`
      UPDATE automation_jobs SET stop_requested = true, updated_at = now()
      WHERE id = ${jobId} AND status = 'running'
    `;
    await recordJobAction(auth, jobId, 'stop', { jobId, boundary: 'chapter_end' });
  } else {
    throw conflict('JOB_NOT_STOPPABLE', `作业当前状态 ${job.status}，不能停止`);
  }
  return loadJobView(sql, auth.workspace.id, jobId);
}

export async function resumeJob(auth: AuthContext, jobId: string): Promise<AutomationJobView> {
  assertCanAutomate(auth.role);
  const job = await loadJobView(sql, auth.workspace.id, jobId);
  const mandate = await loadMandateRow(sql, auth.workspace.id, job.mandateId);
  if (!mandate) throw notFound('MANDATE_NOT_FOUND', '自动化授权不存在');
  await assertActiveMandate(sql, mandate);
  if (job.status !== 'paused' && job.status !== 'interrupted') {
    throw conflict('JOB_NOT_RESUMABLE', `作业当前状态 ${job.status}，只有暂停或中断的作业可以恢复`);
  }
  await sql`
    UPDATE automation_jobs
    SET status = 'queued', pause_requested = false, stop_requested = false,
        runner_id = NULL, heartbeat_at = NULL, completed_at = NULL,
        last_error = NULL, updated_at = now()
    WHERE id = ${jobId}
  `;
  await recordJobAction(auth, jobId, 'resume', { jobId, mandateId: mandate.id });
  return loadJobView(sql, auth.workspace.id, jobId);
}
