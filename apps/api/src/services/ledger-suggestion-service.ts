import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { jsonValue, sql } from '@yunshuo/db';
import {
  ledgerCharacterPayloadSchema,
  ledgerCharacterStateSuggestionSchema,
  ledgerForeshadowingPayloadSchema,
  ledgerForeshadowingStateSuggestionSchema,
  ledgerSuggestionProposalSchema,
  type AiProposalUsageView,
  type CreateLedgerSuggestionInput,
  type DecideLedgerSuggestionInput,
  type LedgerEntryDetail,
  type LedgerEntryKind,
  type LedgerEntrySnapshot,
  type LedgerEntryStatus,
  type LedgerSuggestionEvidenceView,
  type LedgerSuggestionKind,
  type LedgerSuggestionListResponse,
  type LedgerSuggestionProposal,
  type LedgerSuggestionView,
  type PriceCurrency,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { assertCanReadLedger, assertCanWriteLedger } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import { iso } from '../views.js';
import { computeCost } from './ai-service.js';
import { reserveGenerationCall } from './billing-service.js';
import { FORESHADOWING_STATE_LABELS, saveLedgerDraft } from './ledger-service.js';
import {
  connectionFailureDetail,
  loadGenerationProviders,
  redactSecret,
  type GenerationProvider,
} from './provider-service.js';

const SUGGESTION_PROMPT_VERSION = 'm6s-v1';
const GENERATION_TIMEOUT_MS = 45_000;
const MAX_TOTAL_ATTEMPTS = 2;
const CHAPTER_TEXT_LIMIT = 6000;
const SNAPSHOT_TEXT_LIMIT = 800;
const LIST_LIMIT = 20;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// 请求中断或进程退出后这些行不会自己结束；读取时按超时释放，避免界面永久停在“生成中/采纳中”。
const STALE_GENERATING_MINUTES = 10;
const STALE_APPLYING_MINUTES = 5;
const PROMPT_TOKENS_PER_CHAR = 2;
const PROMPT_TOKEN_OVERHEAD = 64;
const DEFAULT_MAX_TOKENS = 700;

const SUGGESTION_NOTE =
  '建议由模型基于已提交正典生成，只作提示：采纳只会写入草稿，仍需人工发布；草稿不改变已发布账本、检索结果与门禁结论。';

type Executor = Sql<any> | TransactionSql<any>;

const rawCharacterSchema = z.object({
  life: z.enum(['alive', 'dead', 'unknown']),
  location: z.string().trim().max(200).default(''),
  knowledge: z.string().trim().max(5000).default(''),
  possessions: z.string().trim().max(2000).default(''),
  relationshipChanges: z.string().trim().max(2000).default(''),
  rationale: z.string().trim().max(1000).default(''),
});

const rawForeshadowingSchema = z.object({
  state: z.enum(['reinforced', 'paid_off', 'abandoned']),
  resolutionNote: z.string().trim().max(5000).default(''),
  rationale: z.string().trim().max(1000).default(''),
});

const evidenceArraySchema = z.array(
  z.object({
    type: z.enum(['chapter', 'ledger_version']),
    label: z.string(),
    detail: z.string().nullable(),
    truncated: z.boolean(),
  }),
);

interface SuggestionTarget {
  entryId: string;
  kind: LedgerEntryKind;
  name: string;
  aliases: string[];
  summary: string;
  status: LedgerEntryStatus;
  workId: string | null;
  currentVersionId: string | null;
  currentVersionNo: number | null;
  draftVersionId: string | null;
  snapshot: LedgerEntrySnapshot | null;
}

interface BasisChapter {
  id: string;
  number: number;
  title: string;
  content: string;
}

interface SuggestionRow {
  id: string;
  entry_id: string;
  entry_name: string;
  entry_kind: LedgerEntryKind;
  kind: LedgerSuggestionKind;
  base_version_id: string | null;
  base_version_no: number | null;
  basis_chapter_id: string | null;
  basis_chapter_number: number | null;
  basis_chapter_title: string | null;
  instruction: string;
  provider_name: string;
  model: string;
  prompt_version: string;
  proposal: unknown;
  rationale: string;
  evidence: unknown;
  attempts: number;
  status: string;
  error_code: string | null;
  error_message: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: string | null;
  cost_currency: string | null;
  latency_ms: number | null;
  created_by_name: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  decided_by_name: string | null;
  decided_at: Date | string | null;
  decision_note: string;
  result_draft_version_no: number | null;
}

function clip(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}…`, truncated: true };
}

function fieldValue(value: string): string {
  const clipped = clip(value ?? '', SNAPSHOT_TEXT_LIMIT);
  return clipped.text === '' ? '（空）' : clipped.text;
}

function amount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currency(value: string | null): PriceCurrency | null {
  return value === 'CNY' || value === 'USD' ? value : null;
}

function statusOf(value: string): LedgerSuggestionView['status'] {
  const statuses = ['generating', 'ready', 'failed', 'applying', 'accepted', 'rejected'] as const;
  return (statuses as readonly string[]).includes(value)
    ? (value as LedgerSuggestionView['status'])
    : 'failed';
}

const SUGGESTION_SELECT = sql`
  SELECT
    s.id, s.entry_id, e.name AS entry_name, e.kind AS entry_kind, s.kind,
    s.base_version_id, bv.version_no AS base_version_no,
    s.basis_chapter_id, c.number AS basis_chapter_number, c.title AS basis_chapter_title,
    s.instruction, s.provider_name, s.model, s.prompt_version,
    s.proposal, s.rationale, s.evidence, s.attempts, s.status,
    s.error_code, s.error_message, s.prompt_tokens, s.completion_tokens,
    s.cost, s.cost_currency, s.latency_ms,
    creator.name AS created_by_name, s.created_at, s.completed_at,
    decider.name AS decided_by_name, s.decided_at, s.decision_note,
    rv.version_no AS result_draft_version_no
  FROM ledger_suggestions s
  JOIN ledger_entries e ON e.id = s.entry_id
  LEFT JOIN ledger_entry_versions bv ON bv.id = s.base_version_id
  LEFT JOIN ledger_entry_versions rv ON rv.id = s.result_draft_version_id
  LEFT JOIN chapters c ON c.id = s.basis_chapter_id
  JOIN users creator ON creator.id = s.created_by
  LEFT JOIN users decider ON decider.id = s.decided_by
`;

async function loadSuggestionRow(
  exec: Executor,
  workspaceId: string,
  suggestionId: string,
  lock: boolean,
): Promise<SuggestionRow | null> {
  const rows = lock
    ? await exec<SuggestionRow[]>`${SUGGESTION_SELECT}
        WHERE s.workspace_id = ${workspaceId} AND s.id = ${suggestionId}
        FOR UPDATE OF s
      `
    : await exec<SuggestionRow[]>`${SUGGESTION_SELECT}
        WHERE s.workspace_id = ${workspaceId} AND s.id = ${suggestionId}
      `;
  return rows[0] ?? null;
}

function mapSuggestion(row: SuggestionRow): LedgerSuggestionView {
  const proposal = ledgerSuggestionProposalSchema.safeParse(row.proposal);
  const evidence = evidenceArraySchema.safeParse(row.evidence);
  return {
    id: row.id,
    entryId: row.entry_id,
    entryName: row.entry_name,
    entryKind: row.entry_kind,
    kind: row.kind,
    status: statusOf(row.status),
    baseVersionNo: row.base_version_no,
    basisChapter:
      row.basis_chapter_id && row.basis_chapter_number !== null
        ? {
            id: row.basis_chapter_id,
            number: row.basis_chapter_number,
            title: row.basis_chapter_title ?? '',
          }
        : null,
    instruction: row.instruction,
    providerName: row.provider_name,
    model: row.model,
    promptVersion: row.prompt_version,
    proposal: proposal.success ? proposal.data : null,
    rationale: row.rationale,
    evidence: evidence.success ? evidence.data : [],
    usage: { promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens },
    cost: amount(row.cost),
    costCurrency: currency(row.cost_currency),
    latencyMs: row.latency_ms,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decisionNote: row.decision_note,
    resultDraftVersionNo: row.result_draft_version_no,
  };
}

async function loadSuggestionTarget(
  exec: Executor,
  workspaceId: string,
  entryId: string,
): Promise<SuggestionTarget | null> {
  const rows = await exec<
    {
      id: string;
      kind: LedgerEntryKind;
      name: string;
      aliases: string[] | null;
      summary: string;
      status: LedgerEntryStatus;
      work_id: string | null;
      current_version_id: string | null;
      draft_version_id: string | null;
      version_no: number | null;
      snapshot: unknown;
    }[]
  >`
    SELECT
      e.id, e.kind, e.name, e.aliases, e.summary, e.status, e.work_id,
      e.current_version_id, e.draft_version_id, v.version_no, v.snapshot
    FROM ledger_entries e
    LEFT JOIN ledger_entry_versions v ON v.id = e.current_version_id
    WHERE e.workspace_id = ${workspaceId} AND e.id = ${entryId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    entryId: row.id,
    kind: row.kind,
    name: row.name,
    aliases: row.aliases ?? [],
    summary: row.summary,
    status: row.status,
    workId: row.work_id,
    currentVersionId: row.current_version_id,
    currentVersionNo: row.version_no,
    draftVersionId: row.draft_version_id,
    snapshot: (row.snapshot as LedgerEntrySnapshot | null) ?? null,
  };
}

async function loadBasisChapter(
  exec: Executor,
  workspaceId: string,
  workId: string,
  chapterId: string,
): Promise<BasisChapter | null> {
  const rows = await exec<{ id: string; number: number; title: string; content: string | null }[]>`
    SELECT c.id, c.number, c.title, cv.content
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    LEFT JOIN canon_current cc ON cc.chapter_id = c.id
    LEFT JOIN canon_versions cv ON cv.id = cc.version_id
    WHERE c.id = ${chapterId}
      AND c.work_id = ${workId}
      AND w.workspace_id = ${workspaceId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !row.content) return null;
  return { id: row.id, number: row.number, title: row.title, content: row.content };
}

async function chapterNumberMap(
  exec: Executor,
  workspaceId: string,
  chapterIds: string[],
): Promise<Map<string, number>> {
  if (chapterIds.length === 0) return new Map();
  const rows = await exec<{ id: string; number: number }[]>`
    SELECT c.id, c.number
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE w.workspace_id = ${workspaceId} AND c.id IN ${sql(chapterIds)}
  `;
  return new Map(rows.map((row) => [row.id, row.number]));
}

async function basisChapterRef(
  exec: Executor,
  workspaceId: string,
  workId: string,
  chapterId: string,
): Promise<{ id: string; number: number } | null> {
  const rows = await exec<{ id: string; number: number }[]>`
    SELECT c.id, c.number
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE c.id = ${chapterId}
      AND c.work_id = ${workId}
      AND w.workspace_id = ${workspaceId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function chapterNumbersOfWork(
  exec: Executor,
  workId: string,
): Promise<Map<string, number>> {
  const rows = await exec<{ id: string; number: number }[]>`
    SELECT id, number FROM chapters WHERE work_id = ${workId}
  `;
  return new Map(rows.map((row) => [row.id, row.number]));
}

// 状态时间线以章节号为准：payload 里的数组顺序只是写入顺序，不保证等于剧情顺序。
function orderStatesByChapter<T extends { asOfChapterId: string }>(
  states: T[],
  numbers: Map<string, number>,
): T[] {
  const rank = (state: T): number =>
    numbers.get(state.asOfChapterId) ?? Number.MAX_SAFE_INTEGER;
  return states
    .map((state, index) => ({ state, index }))
    .sort((left, right) => rank(left.state) - rank(right.state) || left.index - right.index)
    .map((entry) => entry.state);
}

async function describeTarget(
  workspaceId: string,
  target: SuggestionTarget,
): Promise<{ text: string; evidenceDetail: string }> {
  if (target.kind === 'character') {
    const payload = ledgerCharacterPayloadSchema.parse(target.snapshot?.payload ?? {});
    const numbers = await chapterNumberMap(
      sql,
      workspaceId,
      payload.states.map((state) => state.asOfChapterId),
    );
    const tail = orderStatesByChapter(payload.states, numbers).slice(-3);
    const lines: string[] = [
      `身份：${fieldValue(payload.role)}`,
      `阵营：${fieldValue(payload.faction)}`,
      `能力：${fieldValue(payload.abilities)}`,
      `目标：${fieldValue(payload.goals)}`,
    ];
    if (tail.length === 0) {
      lines.push('已记录状态：（时间线为空）');
    } else {
      for (const state of tail) {
        lines.push(
          [
            `已记录状态（截至第 ${numbers.get(state.asOfChapterId) ?? '?'} 章）`,
            `  生死：${state.life}`,
            `  位置：${fieldValue(state.location)}`,
            `  知道：${fieldValue(state.knowledge)}`,
            `  持有：${fieldValue(state.possessions)}`,
            `  关系变化：${fieldValue(state.relationshipChanges)}`,
          ].join('\n'),
        );
      }
    }
    return {
      text: lines.join('\n'),
      evidenceDetail: `角色档案与状态时间线最后 ${tail.length} 条`,
    };
  }
  if (target.kind === 'foreshadowing') {
    const payload = ledgerForeshadowingPayloadSchema.parse(target.snapshot?.payload ?? {});
    const numbers = await chapterNumberMap(
      sql,
      workspaceId,
      [payload.seedChapterId, payload.payoffChapterId].filter(
        (id): id is string => Boolean(id),
      ),
    );
    return {
      text: [
        `当前状态：${payload.state}`,
        `重要度：${payload.importance}`,
        `埋设章节：第 ${numbers.get(payload.seedChapterId) ?? '?'} 章`,
        `计划回收窗口：${windowText(payload.payoffChapterMin, payload.payoffChapterMax)}`,
        `回收章节：${
          payload.payoffChapterId
            ? `第 ${numbers.get(payload.payoffChapterId) ?? '?'} 章`
            : '未绑定'
        }`,
        `说明：${fieldValue(payload.note)}`,
        `已有回收/放弃说明：${fieldValue(payload.resolutionNote)}`,
      ].join('\n'),
      evidenceDetail: '伏笔当前状态、埋设章节与计划回收窗口',
    };
  }
  return { text: `摘要：${fieldValue(target.summary)}`, evidenceDetail: '设定条目摘要' };
}

function windowText(min: number | null, max: number | null): string {
  if (min === null) return '未设定';
  if (max === null) return `第 ${min} 章起`;
  return `第 ${min}–${max} 章`;
}

const SYSTEM_PROMPT = `你是长篇中文小说的连续性账本维护助手。你只提出建议，没有任何写入权限，建议必须由人类确认。
要求：
1. 只输出一个 JSON 对象，不要输出解释、前后缀、Markdown 或代码块。
2. 只能依据“本章正典正文”里确实写到的事实判断；正文没有写到的字段一律填空字符串，不要凭常识补齐或编造。
3. 不要改写章节编号、条目名称或已记录的历史状态。
4. rationale 用一句中文说明依据出自正文哪一处；正文不足时写明“依据不足”。`;

function buildUserPrompt(
  kind: LedgerSuggestionKind,
  target: SuggestionTarget,
  described: string,
  basis: BasisChapter,
  chapterText: string,
  truncated: boolean,
  instruction: string,
): string {
  const header =
    kind === 'character_state'
      ? [
          '【任务】根据本章正典正文，提出该角色在本章结束时的最新状态建议。',
          '【输出格式】',
          '{"life":"alive|dead|unknown","location":"","knowledge":"","possessions":"","relationshipChanges":"","rationale":""}',
          '含义：location 为本章结束时的位置；knowledge 为该角色此时已知道的关键信息；possessions 为持有物变化；relationshipChanges 为关系变化。未涉及填空字符串。',
        ]
      : [
          '【任务】判断本章正典对该伏笔的作用，给出状态建议。',
          '【判定规则】',
          '- 本章再次提到或强化但仍未解答 → "reinforced"。',
          '- 本章明确解答或兑现 → "paid_off"，并在 resolutionNote 写清如何兑现（至少 4 字）。',
          '- 正文可确认这条线索不会再使用 → "abandoned"，并在 resolutionNote 说明原因（至少 4 字）。',
          '- 无法从正文判断时选 "reinforced"，并在 rationale 写明“依据不足”。',
          '【输出格式】',
          '{"state":"reinforced|paid_off|abandoned","resolutionNote":"","rationale":""}',
        ];
  return [
    ...header,
    `【账本条目（生效版本 v${target.currentVersionNo ?? 0}）】名称：${target.name}`,
    `别名：${target.aliases.join('、') || '无'}`,
    `摘要：${fieldValue(target.summary)}`,
    described,
    `【本章正典】第 ${basis.number} 章《${basis.title}》${truncated ? '（已截断）' : ''}`,
    '"""',
    chapterText,
    '"""',
    instruction ? `【人工补充说明】${instruction}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}

function extractJsonObject(raw: string): string | null {
  const unfenced = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  if (unfenced.startsWith('{') && unfenced.endsWith('}')) return unfenced;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) return unfenced.slice(start, end + 1);
  return null;
}

interface ModelAttempt {
  content: string;
  usage: AiProposalUsageView;
  failure: { code: string; message: string; retryable: boolean } | null;
}

async function callModel(
  provider: GenerationProvider,
  messages: { role: 'system' | 'user'; content: string }[],
  maxTokens: number,
): Promise<ModelAttempt> {
  const emptyUsage: AiProposalUsageView = { promptTokens: null, completionTokens: null };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      content: '',
      usage: emptyUsage,
      failure: {
        code: timedOut ? 'AI_TIMEOUT' : 'AI_CONNECTION_FAILED',
        message: timedOut
          ? `模型服务在 ${Math.round(GENERATION_TIMEOUT_MS / 1000)} 秒内没有响应`
          : `无法连接模型服务：${redactSecret(connectionFailureDetail(error), provider.apiKey)}`,
        retryable: true,
      },
    };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = clip(await response.text(), 300).text;
    } catch {
      detail = '';
    }
    return {
      content: '',
      usage: emptyUsage,
      failure: {
        code: 'AI_HTTP_ERROR',
        message: `模型服务返回 HTTP ${response.status}${detail ? ` · ${redactSecret(detail, provider.apiKey)}` : ''}`,
        retryable: RETRYABLE_HTTP_STATUS.has(response.status),
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      content: '',
      usage: emptyUsage,
      failure: { code: 'AI_BAD_RESPONSE', message: '模型服务返回的不是 JSON', retryable: false },
    };
  }

  const record = payload as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = record.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return {
      content: '',
      usage: emptyUsage,
      failure: {
        code: 'AI_BAD_RESPONSE',
        message: '模型服务没有返回可用内容',
        retryable: false,
      },
    };
  }
  return {
    content,
    usage: {
      promptTokens: tokenCount(record.usage?.prompt_tokens),
      completionTokens: tokenCount(record.usage?.completion_tokens),
    },
    failure: null,
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function estimatePromptTokens(messages: { role: string; content: string }[]): number {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(chars * PROMPT_TOKENS_PER_CHAR) + PROMPT_TOKEN_OVERHEAD;
}

async function writeAudit(
  exec: Executor,
  auth: AuthContext,
  action: string,
  suggestionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, ${action},
      'ledger_suggestion', ${suggestionId}, 'success',
      ${exec.json(jsonValue(metadata))}
    )
  `;
}

async function writeEvent(
  exec: Executor,
  auth: AuthContext,
  entryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO events (
      workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
    )
    VALUES (
      ${auth.workspace.id}, 'ledger_entry', ${entryId}, ${eventType},
      ${exec.json(jsonValue(payload))}, ${auth.user.id}
    )
  `;
}

async function finalizeCall(
  exec: Executor,
  callId: string,
  usage: AiProposalUsageView,
  provider: GenerationProvider,
  latencyMs: number,
): Promise<void> {
  const computed = computeCost(provider, usage);
  await exec`
    UPDATE model_calls
    SET status = 'ok',
        prompt_tokens = ${usage.promptTokens},
        completion_tokens = ${usage.completionTokens},
        cost = ${computed?.cost ?? null},
        cost_currency = ${computed?.currency ?? null},
        reserved_cost = NULL,
        reserved_currency = NULL,
        latency_ms = ${latencyMs},
        completed_at = now()
    WHERE id = ${callId}
  `;
}

async function markCallFailed(
  callId: string,
  code: string,
  message: string,
  latencyMs: number,
): Promise<void> {
  await sql`
    UPDATE model_calls
    SET status = 'failed',
        error_code = ${code},
        error_message = ${clip(message, 500).text},
        reserved_cost = NULL,
        reserved_currency = NULL,
        latency_ms = ${latencyMs},
        completed_at = now()
    WHERE id = ${callId}
  `;
}

async function markCallBlocked(input: {
  callId: string;
  workspaceId: string;
  providerId: string;
  chapterId: string;
  model: string;
  actorId: string;
  suggestionId: string;
  attemptNo: number;
  priceCurrency: string;
  code: string;
  message: string;
}): Promise<void> {
  await sql`
    INSERT INTO model_calls (
      id, workspace_id, provider_id, chapter_id, model, status, error_code, error_message,
      actor_id, purpose, suggestion_id, attempt_no, cost, cost_currency, completed_at
    )
    VALUES (
      ${input.callId}, ${input.workspaceId}, ${input.providerId}, ${input.chapterId},
      ${input.model}, 'blocked', ${input.code}, ${clip(input.message, 500).text},
      ${input.actorId}, 'ledger_suggestion', ${input.suggestionId}, ${input.attemptNo},
      ${0}, ${input.priceCurrency}, now()
    )
  `;
}

async function failSuggestion(
  suggestionId: string,
  code: string,
  message: string,
  attempts: number,
  spent?: {
    promptTokens: number | null;
    completionTokens: number | null;
    cost: number | null;
    costCurrency: string | null;
    latencyMs: number;
  },
): Promise<void> {
  await sql`
    UPDATE ledger_suggestions
    SET status = 'failed',
        error_code = ${code},
        error_message = ${clip(message, 1000).text},
        attempts = ${attempts},
        prompt_tokens = ${spent?.promptTokens ?? null},
        completion_tokens = ${spent?.completionTokens ?? null},
        cost = ${spent?.cost ?? null},
        cost_currency = ${spent?.costCurrency ?? null},
        latency_ms = ${spent?.latencyMs ?? null},
        completed_at = now()
    WHERE id = ${suggestionId}
  `;
}

async function loadView(workspaceId: string, suggestionId: string): Promise<LedgerSuggestionView> {
  const row = await loadSuggestionRow(sql, workspaceId, suggestionId, false);
  if (!row) throw notFound('LEDGER_SUGGESTION_NOT_FOUND', '建议不存在或不属于当前工作区');
  return mapSuggestion(row);
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

export async function createLedgerSuggestion(
  auth: AuthContext,
  entryId: string,
  input: CreateLedgerSuggestionInput,
): Promise<LedgerSuggestionView> {
  assertCanWriteLedger(auth.role);
  const workspaceId = auth.workspace.id;

  const target = await loadSuggestionTarget(sql, workspaceId, entryId);
  if (!target) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
  if (target.kind === 'setting') {
    throw conflict(
      'LEDGER_SUGGESTION_KIND_UNSUPPORTED',
      '设定条目没有状态时间线；只有角色档案与伏笔台账可以生成建议',
    );
  }
  if (target.status === 'archived') {
    throw conflict(
      'LEDGER_ENTRY_ARCHIVED',
      '已归档条目不能生成建议；归档不可撤销，请新建条目重新登记',
    );
  }
  if (!target.currentVersionId || !target.snapshot) {
    throw conflict(
      'LEDGER_SUGGESTION_NO_PUBLISHED_VERSION',
      '条目还没有生效版本；建议必须基于已发布的账本事实生成，请先发布',
    );
  }
  if (target.draftVersionId) {
    throw conflict(
      'LEDGER_SUGGESTION_DRAFT_EXISTS',
      '条目已有未发布草稿；请先发布或放弃草稿，否则采纳建议会覆盖草稿里的其他修改',
    );
  }
  if (!target.workId) {
    throw conflict('LEDGER_WORK_REQUIRED', '角色档案与伏笔台账必须属于一个作品才能生成建议');
  }
  const basis = await loadBasisChapter(sql, workspaceId, target.workId, input.basisChapterId);
  if (!basis) {
    throw conflict(
      'LEDGER_SUGGESTION_NO_CANON',
      '依据章节必须属于该条目所在作品且已有提交的正典正文；建议不会基于草稿或计划生成',
    );
  }

  await reclaimStaleSuggestions(workspaceId, entryId);

  const routing = await loadGenerationProviders(workspaceId);
  const kind: LedgerSuggestionKind =
    target.kind === 'character' ? 'character_state' : 'foreshadowing_state';
  const described = await describeTarget(workspaceId, target);
  const clippedChapter = clip(basis.content, CHAPTER_TEXT_LIMIT);
  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserPrompt(
        kind,
        target,
        described.text,
        basis,
        clippedChapter.text,
        clippedChapter.truncated,
        input.instruction,
      ),
    },
  ];
  const evidence: LedgerSuggestionEvidenceView[] = [
    {
      type: 'chapter',
      label: `第 ${basis.number} 章《${basis.title}》正典`,
      detail: `送入提示词 ${clippedChapter.text.length} 字 / 正文 ${basis.content.length} 字`,
      truncated: clippedChapter.truncated,
    },
    {
      type: 'ledger_version',
      label: `生效版本 v${target.currentVersionNo ?? 0}`,
      detail: described.evidenceDetail,
      truncated: false,
    },
  ];

  const suggestionId = randomUUID();
  const first = routing.providers[0]!;
  try {
    await sql`
      INSERT INTO ledger_suggestions (
        id, workspace_id, entry_id, kind, base_version_id, basis_chapter_id, instruction,
        provider_id, provider_name, model, prompt_version, evidence, status, created_by
      )
      VALUES (
        ${suggestionId}, ${workspaceId}, ${entryId}, ${kind}, ${target.currentVersionId},
        ${basis.id}, ${input.instruction}, ${first.id}, ${first.name}, ${first.model},
        ${SUGGESTION_PROMPT_VERSION}, ${sql.json(jsonValue(evidence) as never)}, 'generating',
        ${auth.user.id}
      )
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        'LEDGER_SUGGESTION_IN_PROGRESS',
        '该条目已有正在生成的建议；同一条目同时只发起一次模型调用，请等待完成或刷新列表',
      );
    }
    throw error;
  }

  const startedAt = Date.now();
  let attempts = 0;

  for (const provider of routing.providers) {
    attempts += 1;
    const callId = randomUUID();
    const attemptStartedAt = Date.now();
    await sql`
      UPDATE ledger_suggestions
      SET provider_id = ${provider.id}, provider_name = ${provider.name}, model = ${provider.model}
      WHERE id = ${suggestionId}
    `;

    const reservation = await reserveGenerationCall({
      workspaceId,
      callId,
      provider: {
        id: provider.id,
        name: provider.name,
        promptPricePer1m: provider.promptPricePer1m,
        completionPricePer1m: provider.completionPricePer1m,
        priceCurrency: provider.priceCurrency,
      },
      promptTokensEstimate: estimatePromptTokens(messages),
      requestedMaxTokens: DEFAULT_MAX_TOKENS,
      chapterId: basis.id,
      proposalId: null,
      suggestionId,
      purpose: 'ledger_suggestion',
      jobId: null,
      actorId: auth.user.id,
      attemptNo: attempts,
      model: provider.model,
    });

    if (!reservation.ok) {
      await markCallBlocked({
        callId,
        workspaceId,
        providerId: provider.id,
        chapterId: basis.id,
        model: provider.model,
        actorId: auth.user.id,
        suggestionId,
        attemptNo: attempts,
        priceCurrency: provider.priceCurrency,
        code: reservation.code,
        message: reservation.message,
      });
      await failSuggestion(suggestionId, reservation.code, reservation.message, attempts);
      return loadView(workspaceId, suggestionId);
    }

    const attempt = await callModel(provider, messages, reservation.maxTokens);
    if (attempt.failure) {
      await markCallFailed(
        callId,
        attempt.failure.code,
        attempt.failure.message,
        Date.now() - attemptStartedAt,
      );
      const canRetry =
        attempt.failure.retryable &&
        attempts < MAX_TOTAL_ATTEMPTS &&
        attempts < routing.providers.length;
      if (canRetry) continue;
      await failSuggestion(suggestionId, attempt.failure.code, attempt.failure.message, attempts);
      return loadView(workspaceId, suggestionId);
    }

    const json = extractJsonObject(attempt.content);
    const built = json ? buildProposal(kind, json, basis.number) : null;
    await finalizeCall(sql, callId, attempt.usage, provider, Date.now() - attemptStartedAt);
    if (built?.ok) {
      const latencyMs = Date.now() - startedAt;
      const computed = computeCost(provider, attempt.usage);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ledger_suggestions
          SET proposal = ${tx.json(jsonValue(built.proposal))},
              rationale = ${built.rationale},
              attempts = ${attempts},
              status = 'ready',
              error_code = NULL,
              error_message = NULL,
              prompt_tokens = ${attempt.usage.promptTokens},
              completion_tokens = ${attempt.usage.completionTokens},
              cost = ${computed?.cost ?? null},
              cost_currency = ${computed?.currency ?? null},
              latency_ms = ${latencyMs},
              completed_at = now()
          WHERE id = ${suggestionId}
        `;
        await writeAudit(tx, auth, 'ledger.suggestion.generate', suggestionId, {
          entryId,
          entryName: target.name,
          kind,
          baseVersionNo: target.currentVersionNo,
          basisChapterNumber: basis.number,
          providerName: provider.name,
          model: provider.model,
          promptVersion: SUGGESTION_PROMPT_VERSION,
          attempts,
          promptTokens: attempt.usage.promptTokens,
          completionTokens: attempt.usage.completionTokens,
          cost: computed?.cost ?? null,
          costCurrency: computed?.currency ?? null,
          promptChars: messages.reduce((total, message) => total + message.content.length, 0),
          chapterTextTruncated: clippedChapter.truncated,
          skippedProviders: routing.skipped,
        });
        await writeEvent(tx, auth, entryId, 'ledger.suggestion.created', {
          suggestionId,
          kind,
          baseVersionNo: target.currentVersionNo,
          basisChapterNumber: basis.number,
          providerName: provider.name,
        });
      });
      return loadView(workspaceId, suggestionId);
    }

    const failure = built
      ? { code: built.code, message: built.message }
      : { code: 'LEDGER_SUGGESTION_NOT_JSON', message: '模型没有按 JSON 格式返回，建议未写入。' };
    // 这一条已经真的调用过模型：用量与费用必须留在建议上，否则面板会显示“用量未上报”，
    // 而 model_calls 里其实记着这次花掉的 token。
    const computed = computeCost(provider, attempt.usage);
    await failSuggestion(
      suggestionId,
      failure.code,
      `${failure.message}（本次已发起调用，用量与费用已按实际记录）`,
      attempts,
      {
        promptTokens: attempt.usage.promptTokens,
        completionTokens: attempt.usage.completionTokens,
        cost: computed?.cost ?? null,
        costCurrency: computed?.currency ?? null,
        latencyMs: Date.now() - startedAt,
      },
    );
    return loadView(workspaceId, suggestionId);
  }

  await failSuggestion(
    suggestionId,
    'AI_NO_ATTEMPT',
    '服务商列表在生成前发生变化，没有发起任何调用。',
    attempts,
  );
  return loadView(workspaceId, suggestionId);
}

function buildProposal(
  kind: LedgerSuggestionKind,
  json: string,
  basisChapterNumber: number,
):
  | { ok: true; proposal: LedgerSuggestionProposal; rationale: string }
  | { ok: false; code: string; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return {
      ok: false,
      code: 'LEDGER_SUGGESTION_NOT_JSON',
      message: '模型返回的 JSON 无法解析，建议未写入。',
    };
  }

  if (kind === 'character_state') {
    const parsed = rawCharacterSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidOutput('角色状态', parsed.error.issues.map((issue) => issue.path.join('.')));
    }
    return {
      ok: true,
      rationale: parsed.data.rationale,
      proposal: ledgerCharacterStateSuggestionSchema.parse({
        kind: 'character_state',
        asOfChapterNumber: basisChapterNumber,
        life: parsed.data.life,
        location: parsed.data.location,
        knowledge: parsed.data.knowledge,
        possessions: parsed.data.possessions,
        relationshipChanges: parsed.data.relationshipChanges,
      }),
    };
  }

  const parsed = rawForeshadowingSchema.safeParse(raw);
  if (!parsed.success) {
    return invalidOutput('伏笔状态', parsed.error.issues.map((issue) => issue.path.join('.')));
  }
  const validated = ledgerForeshadowingStateSuggestionSchema.safeParse({
    kind: 'foreshadowing_state',
    state: parsed.data.state,
    payoffChapterNumber: parsed.data.state === 'paid_off' ? basisChapterNumber : null,
    resolutionNote: parsed.data.resolutionNote,
  });
  if (!validated.success) {
    return {
      ok: false,
      code: 'LEDGER_SUGGESTION_OUTPUT_INVALID',
      message: `模型建议的伏笔状态缺少必要说明：${validated.error.issues
        .map((issue) => issue.path.join('.'))
        .join('、')}`,
    };
  }
  return { ok: true, rationale: parsed.data.rationale, proposal: validated.data };
}

function invalidOutput(
  label: string,
  paths: string[],
): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'LEDGER_SUGGESTION_OUTPUT_INVALID',
    message: `模型返回的字段不符合${label}格式：${paths.join('、') || '未知字段'}`,
  };
}

export async function listLedgerSuggestions(
  auth: AuthContext,
  entryId: string,
): Promise<LedgerSuggestionListResponse> {
  assertCanReadLedger(auth.role);
  const workspaceId = auth.workspace.id;
  const target = await loadSuggestionTarget(sql, workspaceId, entryId);
  if (!target) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');

  await reclaimStaleSuggestions(workspaceId, entryId);

  const rows = await sql<SuggestionRow[]>`${SUGGESTION_SELECT}
    WHERE s.workspace_id = ${workspaceId} AND s.entry_id = ${entryId}
    ORDER BY s.created_at DESC
    LIMIT ${LIST_LIMIT}
  `;
  return { suggestions: rows.map(mapSuggestion), note: SUGGESTION_NOTE };
}

async function reclaimStaleSuggestions(workspaceId: string, entryId: string): Promise<void> {
  await sql`
    UPDATE ledger_suggestions
    SET status = 'failed',
        error_code = 'AI_ABANDONED',
        error_message = '生成未正常结束（请求中断或进程退出），建议标记为失败',
        completed_at = now()
    WHERE workspace_id = ${workspaceId}
      AND entry_id = ${entryId}
      AND status = 'generating'
      AND created_at < now() - (${STALE_GENERATING_MINUTES} * interval '1 minute')
  `;
  await sql`
    UPDATE ledger_suggestions s
    SET status = 'ready',
        decided_by = NULL,
        decided_at = NULL,
        decision_note = '',
        error_code = 'SUGGESTION_APPLY_INTERRUPTED',
        error_message = CASE
          WHEN e.draft_version_id IS NOT NULL
            THEN '上一次采纳没有正常结束，且条目现在带有未发布草稿——草稿可能是那次采纳写入的，请先在版本历史确认后再决定是否重新采纳。'
            ELSE '上一次采纳没有正常结束，条目也没有留下草稿，判定为草稿未写入；建议已退回可再次采纳。'
        END
    FROM ledger_entries e
    WHERE e.id = s.entry_id
      AND s.workspace_id = ${workspaceId}
      AND s.entry_id = ${entryId}
      AND s.status = 'applying'
      AND s.decided_at < now() - (${STALE_APPLYING_MINUTES} * interval '1 minute')
  `;
}

async function buildAcceptedPayload(
  exec: Executor,
  workspaceId: string,
  target: SuggestionTarget,
  proposal: LedgerSuggestionProposal,
  workId: string,
  basisChapterId: string | null,
): Promise<{ payload: unknown; changeSummary: string }> {
  const expectedNumber =
    proposal.kind === 'character_state'
      ? proposal.asOfChapterNumber
      : proposal.state === 'paid_off'
        ? proposal.payoffChapterNumber
        : null;

  if (!basisChapterId) {
    throw conflict('LEDGER_SUGGESTION_CHAPTER_UNRESOLVED', '建议没有登记依据章节，无法写入草稿');
  }
  const basis = await basisChapterRef(exec, workspaceId, workId, basisChapterId);
  if (!basis) {
    throw conflict(
      'LEDGER_SUGGESTION_CHAPTER_UNRESOLVED',
      '建议依据的章节已不属于该作品，无法写入草稿',
    );
  }
  if (expectedNumber !== null && basis.number !== expectedNumber) {
    throw conflict(
      'LEDGER_SUGGESTION_CHAPTER_UNRESOLVED',
      `建议登记的依据章节编号已变化：原为第 ${expectedNumber} 章，现为第 ${basis.number} 章；请重新生成建议`,
    );
  }

  if (proposal.kind === 'character_state') {
    const payload = ledgerCharacterPayloadSchema.parse(target.snapshot?.payload ?? {});
    const states = payload.states.filter((state) => state.asOfChapterId !== basis.id);
    states.push({
      asOfChapterId: basis.id,
      life: proposal.life,
      location: proposal.location,
      knowledge: proposal.knowledge,
      possessions: proposal.possessions,
      relationshipChanges: proposal.relationshipChanges,
    });
    const numbers = await chapterNumbersOfWork(exec, workId);
    return {
      payload: { ...payload, states: orderStatesByChapter(states, numbers) },
      changeSummary: `采纳 AI 角色状态建议（第 ${basis.number} 章）`,
    };
  }

  const payoffChapterId = proposal.state === 'paid_off' ? basis.id : null;
  const payload = ledgerForeshadowingPayloadSchema.parse(target.snapshot?.payload ?? {});
  const stateLabel = FORESHADOWING_STATE_LABELS[proposal.state];
  return {
    payload: {
      ...payload,
      state: proposal.state,
      payoffChapterId,
      resolutionNote:
        proposal.state === 'reinforced' ? payload.resolutionNote : proposal.resolutionNote,
    },
    changeSummary: `采纳 AI 伏笔状态建议（第 ${basis.number} 章 · ${stateLabel}）`,
  };
}

function assertDecidable(status: string): void {
  if (status === 'accepted' || status === 'rejected') {
    throw conflict('LEDGER_SUGGESTION_ALREADY_DECIDED', '该建议已经完成人工确认，不能重复处理');
  }
  if (status !== 'ready') {
    throw conflict(
      'LEDGER_SUGGESTION_NOT_DECIDABLE',
      `只有生成成功且待确认的建议可以采纳；当前状态 ${status}`,
    );
  }
}

export async function acceptLedgerSuggestion(
  auth: AuthContext,
  suggestionId: string,
  input: DecideLedgerSuggestionInput,
): Promise<{ suggestion: LedgerSuggestionView; entry: LedgerEntryDetail }> {
  assertCanWriteLedger(auth.role);
  const workspaceId = auth.workspace.id;

  const claim = await sql.begin(async (tx) => {
    const row = await loadSuggestionRow(tx, workspaceId, suggestionId, true);
    if (!row) throw notFound('LEDGER_SUGGESTION_NOT_FOUND', '建议不存在或不属于当前工作区');
    assertDecidable(row.status);

    const target = await loadSuggestionTarget(tx, workspaceId, row.entry_id);
    if (!target) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (target.status === 'archived') {
      throw conflict(
        'LEDGER_ENTRY_ARCHIVED',
        '条目已归档，不能采纳建议；归档不可撤销，请新建条目重新登记',
      );
    }
    if (row.base_version_id !== target.currentVersionId) {
      throw conflict(
        'LEDGER_SUGGESTION_STALE',
        `建议基于 v${row.base_version_no ?? '?'}，条目已发布 v${target.currentVersionNo ?? '?'}；请基于新版本重新生成建议`,
        { currentVersionNo: target.currentVersionNo },
      );
    }
    if (target.draftVersionId) {
      throw conflict(
        'LEDGER_SUGGESTION_DRAFT_EXISTS',
        '条目已有未发布草稿；请先处理草稿，再采纳建议',
        { currentDraftVersionId: target.draftVersionId },
      );
    }
    if (!target.workId) {
      throw conflict('LEDGER_WORK_REQUIRED', '条目没有所属作品，无法采纳建议');
    }
    const parsed = ledgerSuggestionProposalSchema.safeParse(row.proposal);
    if (!parsed.success) {
      throw conflict('LEDGER_SUGGESTION_OUTPUT_INVALID', '建议内容不完整，无法写入草稿');
    }

    const merged = await buildAcceptedPayload(
      tx,
      workspaceId,
      target,
      parsed.data,
      target.workId,
      row.basis_chapter_id,
    );
    await tx`
      UPDATE ledger_suggestions
      SET status = 'applying',
          decided_by = ${auth.user.id},
          decided_at = now(),
          decision_note = ${input.note},
          error_code = NULL,
          error_message = NULL
      WHERE id = ${suggestionId}
    `;
    return {
      entryId: row.entry_id,
      entryName: target.name,
      baseVersionId: row.base_version_id,
      baseVersionNo: row.base_version_no,
      kind: parsed.data.kind,
      proposal: parsed.data,
      merged,
    };
  });

  let entry: LedgerEntryDetail;
  try {
    entry = await saveLedgerDraft(
      auth,
      claim.entryId,
      {
        expectedDraftVersionId: null,
        payload: claim.merged.payload,
        changeSummary: claim.merged.changeSummary,
      },
      { expectedCurrentVersionId: claim.baseVersionId },
    );
  } catch (error) {
    await sql`
      UPDATE ledger_suggestions
      SET status = 'ready',
          decided_by = NULL,
          decided_at = NULL,
          decision_note = '',
          error_code = 'LEDGER_SUGGESTION_APPLY_FAILED',
          error_message = ${clip(errorMessageOf(error), 1000).text}
      WHERE id = ${suggestionId}
    `;
    throw error;
  }

  const draftVersionId = entry.draftVersion?.id ?? null;
  await sql.begin(async (tx) => {
    const updated = await tx<{ id: string }[]>`
      UPDATE ledger_suggestions
      SET status = 'accepted',
          result_draft_version_id = ${draftVersionId},
          error_code = NULL,
          error_message = NULL
      WHERE id = ${suggestionId} AND status = 'applying'
      RETURNING id
    `;
    if (!updated[0]) {
      throw conflict(
        'LEDGER_SUGGESTION_NOT_DECIDABLE',
        '建议状态已变化：草稿已写入，但建议未标记为已采纳；请在账本版本历史中确认草稿版本，不要重复采纳',
        { draftVersionNo: entry.draftVersion?.versionNo ?? null },
      );
    }
    await writeAudit(tx, auth, 'ledger.suggestion.accept', suggestionId, {
      entryId: claim.entryId,
      entryName: claim.entryName,
      kind: claim.kind,
      baseVersionNo: claim.baseVersionNo,
      draftVersionNo: entry.draftVersion?.versionNo ?? null,
      note: input.note,
      proposal: claim.proposal,
    });
    await writeEvent(tx, auth, claim.entryId, 'ledger.suggestion.accepted', {
      suggestionId,
      kind: claim.kind,
      draftVersionNo: entry.draftVersion?.versionNo ?? null,
      decidedByName: auth.user.name,
    });
  });

  return { suggestion: await loadView(workspaceId, suggestionId), entry };
}

export async function rejectLedgerSuggestion(
  auth: AuthContext,
  suggestionId: string,
  input: DecideLedgerSuggestionInput,
): Promise<LedgerSuggestionView> {
  assertCanWriteLedger(auth.role);
  const workspaceId = auth.workspace.id;

  await sql.begin(async (tx) => {
    const row = await loadSuggestionRow(tx, workspaceId, suggestionId, true);
    if (!row) throw notFound('LEDGER_SUGGESTION_NOT_FOUND', '建议不存在或不属于当前工作区');
    if (row.status === 'accepted' || row.status === 'rejected') {
      throw conflict('LEDGER_SUGGESTION_ALREADY_DECIDED', '该建议已经完成人工确认，不能重复处理');
    }
    if (row.status !== 'ready') {
      throw conflict(
        'LEDGER_SUGGESTION_NOT_DECIDABLE',
        `只有生成成功且待确认的建议可以拒绝；当前状态 ${row.status}`,
      );
    }
    await tx`
      UPDATE ledger_suggestions
      SET status = 'rejected',
          decided_by = ${auth.user.id},
          decided_at = now(),
          decision_note = ${input.note}
      WHERE id = ${suggestionId}
    `;
    await writeAudit(tx, auth, 'ledger.suggestion.reject', suggestionId, {
      entryId: row.entry_id,
      entryName: row.entry_name,
      kind: row.kind,
      baseVersionNo: row.base_version_no,
      note: input.note,
    });
    await writeEvent(tx, auth, row.entry_id, 'ledger.suggestion.rejected', {
      suggestionId,
      kind: row.kind,
      decidedByName: auth.user.name,
    });
  });

  return loadView(workspaceId, suggestionId);
}
