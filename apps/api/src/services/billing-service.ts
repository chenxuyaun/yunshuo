import type { Sql, TransactionSql } from 'postgres';
import { sql, jsonValue } from '@yunshuo/db';
import type {
  BillingBreakdownView,
  BillingBudgetUsageView,
  BillingBudgetView,
  BillingMoneyView,
  BillingProviderPriceView,
  BillingReportResponse,
  BillingUnknownCallView,
  PriceCurrency,
  UpdateBillingBudgetInput,
  UpdateBillingPriceInput,
} from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { iso } from '../views.js';

export const MIN_GENERATION_COMPLETION_TOKENS = 128;
// 占用生成预算的用途：章节正文提案与账本建议都是付费的大模型生成调用。
export const GENERATION_PURPOSES = ['chapter_proposal', 'ledger_suggestion'] as const;
export type GenerationPurpose = (typeof GENERATION_PURPOSES)[number];
const STALE_CALL_MINUTES = 15;
const UNKNOWN_CALL_LIMIT = 50;

type Executor = Sql<any> | TransactionSql<any>;

interface BudgetRow {
  workspace_id: string;
  monthly_limit: string | number;
  currency: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_by_email: string | null;
  updated_at: Date | string;
}

interface ReportCallRow {
  id: string;
  created_at: Date | string;
  purpose: string | null;
  status: string;
  model: string;
  cost: string | null;
  cost_currency: string | null;
  reserved_cost: string | null;
  reserved_currency: string | null;
  error_code: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_kind: string | null;
  chapter_id: string | null;
  chapter_number: number | null;
  chapter_title: string | null;
  job_id: string | null;
  job_status: string | null;
  job_work_title: string | null;
  provider_name: string | null;
}

export interface ProviderPriceRow {
  id: string;
  name: string;
  model: string;
  purpose: 'chat' | 'embedding';
  is_enabled: boolean;
  priority: number;
  prompt_price_per_1m: string | number | null;
  completion_price_per_1m: string | number | null;
  price_currency: string;
  updated_at: Date | string;
}

export interface GenerationCallReservationInput {
  workspaceId: string;
  callId: string;
  provider: {
    id: string;
    name: string;
    promptPricePer1m: number | null;
    completionPricePer1m: number | null;
    priceCurrency: PriceCurrency;
  };
  promptTokensEstimate: number;
  requestedMaxTokens: number;
  chapterId: string | null;
  proposalId: string | null;
  suggestionId: string | null;
  purpose: GenerationPurpose;
  jobId: string | null;
  actorId: string;
  attemptNo: number;
  model: string;
}

export type GenerationCallReservation =
  | { ok: true; maxTokens: number; reservedCost: number | null }
  | {
      ok: false;
      code: 'BUDGET_INSUFFICIENT' | 'BUDGET_GUARD_UNAVAILABLE';
      message: string;
    };

interface MoneyAccumulator {
  currency: PriceCurrency;
  knownCost: number;
  calls: number;
  reservedCost: number;
  activeCalls: number;
}

interface BreakdownAccumulator {
  key: string;
  label: string;
  detail: string | null;
  money: Map<PriceCurrency, MoneyAccumulator>;
  unknownCalls: number;
}

export interface MonthRange {
  month: string;
  start: Date;
  end: Date;
}

function decimal(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundUpReservation(value: number): number {
  return Math.ceil(value * 10_000 - 1e-9) / 10_000;
}

function priceCurrency(value: string): PriceCurrency {
  return value === 'USD' ? 'USD' : 'CNY';
}

function isPriceCurrency(value: string | null): value is PriceCurrency {
  return value === 'CNY' || value === 'USD';
}

export function currentMonthRange(now = new Date()): MonthRange {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { month, start, end };
}

export function assertCanViewBilling(role: Role): void {
  if (role !== 'owner' && role !== 'lead' && role !== 'billing') {
    throw forbidden('仅所有者、主笔与计费管理员可以查看计费报表');
  }
}

export function assertCanManageBilling(role: Role): void {
  if (role !== 'owner' && role !== 'billing') {
    throw forbidden('仅所有者与计费管理员可以修改工作区预算与价表');
  }
}

async function loadBudgetRow(
  exec: Executor,
  workspaceId: string,
  lock = false,
): Promise<BudgetRow | null> {
  const rows = lock
    ? await exec<BudgetRow[]>`
        SELECT
          b.*, u.name AS updated_by_name, u.email AS updated_by_email
        FROM workspace_budgets b
        LEFT JOIN users u ON u.id = b.updated_by
        WHERE b.workspace_id = ${workspaceId}
        FOR UPDATE OF b
      `
    : await exec<BudgetRow[]>`
        SELECT
          b.*, u.name AS updated_by_name, u.email AS updated_by_email
        FROM workspace_budgets b
        LEFT JOIN users u ON u.id = b.updated_by
        WHERE b.workspace_id = ${workspaceId}
      `;
  return rows[0] ?? null;
}

function mapBudget(row: BudgetRow | null): BillingBudgetView {
  if (!row) {
    return { monthlyLimit: null, currency: 'CNY', updatedAt: null, updatedBy: null };
  }
  return {
    monthlyLimit: decimal(row.monthly_limit),
    currency: priceCurrency(row.currency),
    updatedAt: iso(row.updated_at),
    updatedBy:
      row.updated_by && row.updated_by_name && row.updated_by_email
        ? { id: row.updated_by, name: row.updated_by_name, email: row.updated_by_email }
        : null,
  };
}

function mapProviderPrice(row: ProviderPriceRow): BillingProviderPriceView {
  const prompt = decimal(row.prompt_price_per_1m);
  const completion = decimal(row.completion_price_per_1m);
  const complete =
    row.purpose === 'embedding' ? prompt !== null : prompt !== null && completion !== null;
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    purpose: row.purpose,
    isEnabled: row.is_enabled,
    priority: row.priority,
    promptPricePer1m: prompt,
    completionPricePer1m: completion,
    priceCurrency: priceCurrency(row.price_currency),
    pricingStatus: complete ? 'complete' : 'incomplete',
    updatedAt: iso(row.updated_at),
  };
}

async function loadProviderPrices(
  exec: Executor,
  workspaceId: string,
): Promise<BillingProviderPriceView[]> {
  const rows = await exec<ProviderPriceRow[]>`
    SELECT
      id, name, model, purpose, is_enabled, priority,
      prompt_price_per_1m, completion_price_per_1m, price_currency, updated_at
    FROM model_providers
    WHERE workspace_id = ${workspaceId}
    ORDER BY priority ASC, created_at ASC
  `;
  return rows.map(mapProviderPrice);
}

async function expireStaleReservations(exec: Executor, workspaceId: string): Promise<void> {
  await exec`
    UPDATE model_calls SET
      status = 'failed',
      error_code = 'CALL_STALE',
      error_message = ${`调用超过 ${STALE_CALL_MINUTES} 分钟未完成，已标记为失效并释放预留；实际费用未知`},
      reserved_cost = NULL,
      reserved_currency = NULL,
      completed_at = now()
    WHERE workspace_id = ${workspaceId}
      AND status = 'streaming'
      AND created_at < now() - (${STALE_CALL_MINUTES} * interval '1 minute')
  `;
}

interface BudgetUsageInternal {
  view: BillingBudgetUsageView;
  monthlyLimit: number | null;
  currency: PriceCurrency;
  remaining: number | null;
}

async function loadBudgetUsage(
  exec: Executor,
  workspaceId: string,
  range: MonthRange,
): Promise<BudgetUsageInternal> {
  const budgetRow = await loadBudgetRow(exec, workspaceId);
  const budget = mapBudget(budgetRow);
  // 过期预留的清算与预算是否配置无关：否则未设预算的工作区里，进程中断留下的
  // `streaming` 调用会永远显示成在途。
  await expireStaleReservations(exec, workspaceId);
  if (budget.monthlyLimit === null) {
    return {
      view: {
        state: 'not_configured',
        currency: budget.currency,
        monthlyLimit: null,
        knownSpent: 0,
        reserved: 0,
        remaining: null,
        unknownGenerationCalls: 0,
        otherCurrencyGenerationCalls: 0,
        note: '未设置工作区月度预算；生成调用仍会记录估算费用，但不会在额度耗尽时阻断。',
      },
      monthlyLimit: null,
      currency: budget.currency,
      remaining: null,
    };
  }

  const currency = budget.currency;
  const spentRows = await exec<{ spent: string | null }[]>`
    SELECT COALESCE(SUM(cost), 0)::text AS spent
    FROM model_calls
    WHERE workspace_id = ${workspaceId}
      AND purpose IN ${sql(GENERATION_PURPOSES)}
      AND cost IS NOT NULL
      AND cost_currency = ${currency}
      AND created_at >= ${range.start}
      AND created_at < ${range.end}
  `;
  const reservedRows = await exec<{ reserved: string | null }[]>`
    SELECT COALESCE(SUM(reserved_cost), 0)::text AS reserved
    FROM model_calls
    WHERE workspace_id = ${workspaceId}
      AND purpose IN ${sql(GENERATION_PURPOSES)}
      AND reserved_cost IS NOT NULL
      AND reserved_currency = ${currency}
      AND status = 'streaming'
  `;
  const unknownRows = await exec<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM model_calls
    WHERE workspace_id = ${workspaceId}
      AND purpose IN ${sql(GENERATION_PURPOSES)}
      AND cost IS NULL
      AND reserved_cost IS NULL
      AND status <> 'streaming'
      AND status <> 'blocked'
      AND (error_code IS NULL OR error_code NOT LIKE 'BUDGET\\_%' ESCAPE '\\')
      AND created_at >= ${range.start}
      AND created_at < ${range.end}
  `;
  const otherCurrencyRows = await exec<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM model_calls
    WHERE workspace_id = ${workspaceId}
      AND purpose IN ${sql(GENERATION_PURPOSES)}
      AND status <> 'blocked'
      AND cost_currency IS NOT NULL
      AND cost_currency <> ${currency}
      AND created_at >= ${range.start}
      AND created_at < ${range.end}
  `;

  const knownSpent = round(decimal(spentRows[0]?.spent ?? '0') ?? 0);
  const reserved = round(decimal(reservedRows[0]?.reserved ?? '0') ?? 0);
  const unknownGenerationCalls = unknownRows[0]?.count ?? 0;
  const otherCurrencyGenerationCalls = otherCurrencyRows[0]?.count ?? 0;
  const remaining = round(budget.monthlyLimit - knownSpent - reserved);
  const state =
    remaining <= 0
      ? 'exhausted'
      : unknownGenerationCalls > 0
        ? 'unpriced_calls'
        : 'ok';
  const notes: string[] = [];
  if (state === 'exhausted') {
    notes.push(
      `本月生成预算 ${budget.monthlyLimit.toFixed(4)} ${currency} 已无可用额度（已计 ${knownSpent.toFixed(4)}，预留 ${reserved.toFixed(4)}）；手工与自动生成都会在发起前被阻断，嵌入检索不受影响。`,
    );
  } else {
    notes.push(
      `本月剩余 ${remaining.toFixed(4)} ${currency}（已计 ${knownSpent.toFixed(4)}，预留 ${reserved.toFixed(4)}）。预算按价表与上游 token 用量估算，并在每次生成调用前预留上限。`,
    );
  }
  if (unknownGenerationCalls > 0) {
    notes.push(
      `另有 ${unknownGenerationCalls} 次生成调用费用未知（上游未返回用量或价表缺失），预算无法覆盖这部分支出。`,
    );
  }
  if (otherCurrencyGenerationCalls > 0) {
    notes.push(
      `另有 ${otherCurrencyGenerationCalls} 次生成调用使用其他币种，未计入本预算。`,
    );
  }
  return {
    view: {
      state,
      currency,
      monthlyLimit: budget.monthlyLimit,
      knownSpent,
      reserved,
      remaining,
      unknownGenerationCalls,
      otherCurrencyGenerationCalls,
      note: notes.join(' '),
    },
    monthlyLimit: budget.monthlyLimit,
    currency,
    remaining,
  };
}

export async function updateWorkspaceBudget(
  auth: AuthContext,
  input: UpdateBillingBudgetInput,
): Promise<BillingBudgetView> {
  assertCanManageBilling(auth.role);
  await sql.begin(async (tx) => {
    const workspace = await tx<{ id: string }[]>`
      SELECT id FROM workspaces WHERE id = ${auth.workspace.id} FOR UPDATE
    `;
    if (!workspace[0]) throw notFound('WORKSPACE_NOT_FOUND', '工作区不存在');
    const current = await loadBudgetRow(tx, auth.workspace.id, true);
    if (input.monthlyLimit !== null) {
      const activeOtherCurrency = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM model_calls
        WHERE workspace_id = ${auth.workspace.id}
          AND purpose IN ${sql(GENERATION_PURPOSES)}
          AND status = 'streaming'
          AND reserved_cost IS NOT NULL
          AND reserved_currency IS NOT NULL
          AND reserved_currency <> ${input.currency}
      `;
      if ((activeOtherCurrency[0]?.count ?? 0) > 0) {
        throw conflict(
          'BUDGET_CALLS_IN_PROGRESS',
          '有进行中的生成调用使用其他币种计价，不能切换预算币种；请等待调用结束或中断后再修改。',
        );
      }
    }
    if (input.monthlyLimit === null) {
      await tx`DELETE FROM workspace_budgets WHERE workspace_id = ${auth.workspace.id}`;
    } else {
      await tx`
        INSERT INTO workspace_budgets (
          workspace_id, monthly_limit, currency, updated_by, updated_at
        )
        VALUES (${auth.workspace.id}, ${input.monthlyLimit}, ${input.currency}, ${auth.user.id}, now())
        ON CONFLICT (workspace_id) DO UPDATE SET
          monthly_limit = EXCLUDED.monthly_limit,
          currency = EXCLUDED.currency,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
      `;
    }
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
        'billing.budget.update', 'workspace', ${auth.workspace.id}, 'success',
        ${tx.json(jsonValue({
          previousMonthlyLimit: current ? decimal(current.monthly_limit) : null,
          previousCurrency: current ? priceCurrency(current.currency) : null,
          monthlyLimit: input.monthlyLimit,
          currency: input.currency,
        }))}
      )
    `;
  });
  return mapBudget(await loadBudgetRow(sql, auth.workspace.id));
}

export async function updateProviderPrices(
  auth: AuthContext,
  providerId: string,
  input: UpdateBillingPriceInput,
): Promise<BillingProviderPriceView> {
  assertCanManageBilling(auth.role);
  const row = await sql.begin(async (tx) => {
    const rows = await tx<ProviderPriceRow[]>`
      SELECT
        id, name, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency, updated_at
      FROM model_providers
      WHERE id = ${providerId} AND workspace_id = ${auth.workspace.id}
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在或不属于当前工作区');

    const nextPrompt =
      input.promptPricePer1m === undefined
        ? decimal(current.prompt_price_per_1m)
        : input.promptPricePer1m;
    const nextCompletion =
      input.completionPricePer1m === undefined
        ? decimal(current.completion_price_per_1m)
        : input.completionPricePer1m;
    const nextCurrency = input.priceCurrency ?? priceCurrency(current.price_currency);
    if (current.purpose === 'embedding') {
      if (nextCompletion !== null) {
        throw badRequest('PROVIDER_PRICING_UNSUPPORTED', '嵌入服务商只支持输入价，输出价必须留空');
      }
    } else if ((nextPrompt === null) !== (nextCompletion === null)) {
      throw badRequest(
        'PROVIDER_PRICING_INCOMPLETE',
        '生成服务商的输入价与输出价必须同时填写或同时留空',
      );
    }

    const updated = await tx<ProviderPriceRow[]>`
      UPDATE model_providers SET
        prompt_price_per_1m = ${nextPrompt},
        completion_price_per_1m = ${nextCompletion},
        price_currency = ${nextCurrency},
        updated_at = now()
      WHERE id = ${providerId} AND workspace_id = ${auth.workspace.id}
      RETURNING
        id, name, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency, updated_at
    `;
    const result = updated[0];
    if (!result) throw new Error('模型服务商价表更新失败');
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
        'billing.provider_price.update', 'model_provider', ${providerId}, 'success',
        ${tx.json(jsonValue({
          name: current.name,
          model: current.model,
          purpose: current.purpose,
          before: {
            promptPricePer1m: decimal(current.prompt_price_per_1m),
            completionPricePer1m: decimal(current.completion_price_per_1m),
            priceCurrency: priceCurrency(current.price_currency),
          },
          after: {
            promptPricePer1m: nextPrompt,
            completionPricePer1m: nextCompletion,
            priceCurrency: nextCurrency,
          },
        }))}
      )
    `;
    return result;
  });
  return mapProviderPrice(row);
}

export async function reserveGenerationCall(
  input: GenerationCallReservationInput,
): Promise<GenerationCallReservation> {
  return sql.begin(async (tx) => {
    const budgetRows = await tx<BudgetRow[]>`
      SELECT b.*, NULL::text AS updated_by_name, NULL::text AS updated_by_email
      FROM workspace_budgets b
      WHERE b.workspace_id = ${input.workspaceId}
      FOR UPDATE
    `;
    const budgetRow = budgetRows[0];
    // 先清算过期预留，再做任何提前返回：未配置预算的工作区同样不能让中断留下的
    // `streaming` 行永远挂在账上。
    await expireStaleReservations(tx, input.workspaceId);
    if (!budgetRow) {
      await tx`
        INSERT INTO model_calls (
          id, workspace_id, provider_id, chapter_id, job_id, model, status,
          actor_id, purpose, proposal_id, suggestion_id, attempt_no
        )
        VALUES (
          ${input.callId}, ${input.workspaceId}, ${input.provider.id}, ${input.chapterId},
          ${input.jobId}, ${input.model}, 'streaming', ${input.actorId}, ${input.purpose},
          ${input.proposalId}, ${input.suggestionId}, ${input.attemptNo}
        )
      `;
      return { ok: true as const, maxTokens: input.requestedMaxTokens, reservedCost: null };
    }

    const currency = priceCurrency(budgetRow.currency);
    if (
      input.provider.promptPricePer1m === null ||
      input.provider.completionPricePer1m === null
    ) {
      return {
        ok: false as const,
        code: 'BUDGET_GUARD_UNAVAILABLE' as const,
        message: `服务商「${input.provider.name}」价表不完整，无法按工作区预算限制输出；本次未发起调用。`,
      };
    }
    if (input.provider.priceCurrency !== currency) {
      return {
        ok: false as const,
        code: 'BUDGET_GUARD_UNAVAILABLE' as const,
        message: `服务商「${input.provider.name}」计价币种 ${input.provider.priceCurrency} 与工作区预算币种 ${currency} 不一致；本次未发起调用。`,
      };
    }

    const range = currentMonthRange();
    const spentRows = await tx<{ spent: string | null }[]>`
      SELECT COALESCE(SUM(cost), 0)::text AS spent
      FROM model_calls
      WHERE workspace_id = ${input.workspaceId}
        AND purpose IN ${sql(GENERATION_PURPOSES)}
        AND cost IS NOT NULL
        AND cost_currency = ${currency}
        AND created_at >= ${range.start}
        AND created_at < ${range.end}
    `;
    const reservedRows = await tx<{ reserved: string | null }[]>`
      SELECT COALESCE(SUM(reserved_cost), 0)::text AS reserved
      FROM model_calls
      WHERE workspace_id = ${input.workspaceId}
        AND purpose IN ${sql(GENERATION_PURPOSES)}
        AND reserved_cost IS NOT NULL
        AND reserved_currency = ${currency}
        AND status = 'streaming'
    `;
    const limit = decimal(budgetRow.monthly_limit) ?? 0;
    const spent = decimal(spentRows[0]?.spent ?? '0') ?? 0;
    const reserved = decimal(reservedRows[0]?.reserved ?? '0') ?? 0;
    const available = limit - spent - reserved;
    const promptCost =
      (input.promptTokensEstimate / 1_000_000) * input.provider.promptPricePer1m;
    const afterPrompt = available - promptCost;
    if (afterPrompt < 0) {
      return {
        ok: false as const,
        code: 'BUDGET_INSUFFICIENT' as const,
        message: `工作区本月剩余预算 ${round(available).toFixed(4)} ${currency} 不足以覆盖预估输入费用 ${round(promptCost).toFixed(4)}；本次未发起调用。`,
      };
    }
    const completionPrice = input.provider.completionPricePer1m;
    const cap =
      completionPrice === 0
        ? Number.POSITIVE_INFINITY
        : Math.floor((afterPrompt / completionPrice) * 1_000_000);
    if (cap < MIN_GENERATION_COMPLETION_TOKENS) {
      return {
        ok: false as const,
        code: 'BUDGET_INSUFFICIENT' as const,
        message: `工作区本月剩余预算 ${round(available).toFixed(4)} ${currency} 最多只够约 ${Math.max(0, cap)} tokens 输出，低于最低 ${MIN_GENERATION_COMPLETION_TOKENS}；本次未发起调用。`,
      };
    }

    const maxTokens = Math.min(input.requestedMaxTokens, cap);
    const reservedCost = roundUpReservation(
      promptCost + (maxTokens / 1_000_000) * completionPrice,
    );
    if (reservedCost > available + 1e-9) {
      return {
        ok: false as const,
        code: 'BUDGET_INSUFFICIENT' as const,
        message: `工作区本月剩余预算不足以覆盖本次调用预留 ${reservedCost.toFixed(4)} ${currency}；本次未发起调用。`,
      };
    }

    await tx`
      INSERT INTO model_calls (
        id, workspace_id, provider_id, chapter_id, job_id, model, status,
        actor_id, purpose, proposal_id, suggestion_id, attempt_no,
        reserved_cost, reserved_currency
      )
      VALUES (
        ${input.callId}, ${input.workspaceId}, ${input.provider.id}, ${input.chapterId},
        ${input.jobId}, ${input.model}, 'streaming', ${input.actorId}, ${input.purpose},
        ${input.proposalId}, ${input.suggestionId}, ${input.attemptNo},
        ${reservedCost}, ${currency}
      )
    `;
    return { ok: true as const, maxTokens, reservedCost };
  });
}

function purposeLabel(purpose: string | null): string {
  switch (purpose) {
    case 'chapter_proposal':
      return '章节生成';
    case 'ledger_suggestion':
      return '账本建议';
    case 'embedding':
      return '索引嵌入';
    case 'embedding_query':
      return '检索嵌入';
    default:
      return purpose ?? '未标注用途';
  }
}

function moneyAccumulator(
  money: Map<PriceCurrency, MoneyAccumulator>,
  currency: PriceCurrency,
): MoneyAccumulator {
  const current = money.get(currency);
  if (current) return current;
  const created: MoneyAccumulator = {
    currency,
    knownCost: 0,
    calls: 0,
    reservedCost: 0,
    activeCalls: 0,
  };
  money.set(currency, created);
  return created;
}

function breakdown(
  map: Map<string, BreakdownAccumulator>,
  key: string,
  label: string,
  detail: string | null,
): BreakdownAccumulator {
  const current = map.get(key);
  if (current) return current;
  const created: BreakdownAccumulator = {
    key,
    label,
    detail,
    money: new Map(),
    unknownCalls: 0,
  };
  map.set(key, created);
  return created;
}

function moneyView(acc: MoneyAccumulator): BillingMoneyView {
  return {
    currency: acc.currency,
    knownCost: round(acc.knownCost),
    calls: acc.calls,
    reservedCost: round(acc.reservedCost),
    activeCalls: acc.activeCalls,
  };
}

function breakdownView(acc: BreakdownAccumulator): BillingBreakdownView {
  return {
    key: acc.key,
    label: acc.label,
    detail: acc.detail,
    costs: [...acc.money.values()]
      .map(moneyView)
      .sort((a, b) => b.knownCost + b.reservedCost - (a.knownCost + a.reservedCost)),
    unknownCalls: acc.unknownCalls,
  };
}

function isUnknownCost(row: ReportCallRow): boolean {
  if (row.cost !== null) return false;
  if (row.reserved_cost !== null) return false;
  if (row.status === 'streaming' || row.status === 'blocked') return false;
  if (row.error_code?.startsWith('BUDGET_')) return false;
  return true;
}

export async function loadBillingReport(auth: AuthContext): Promise<BillingReportResponse> {
  assertCanViewBilling(auth.role);
  const range = currentMonthRange();
  const [rows, usage, providers] = await Promise.all([
    sql<ReportCallRow[]>`
      SELECT
        mc.id, mc.created_at, mc.purpose, mc.status, mc.model,
        mc.cost::text AS cost, mc.cost_currency,
        mc.reserved_cost::text AS reserved_cost, mc.reserved_currency,
        mc.error_code,
        mc.actor_id, u.name AS actor_name, u.kind AS actor_kind,
        mc.chapter_id, c.number AS chapter_number, c.title AS chapter_title,
        mc.job_id, j.status AS job_status, jw.title AS job_work_title,
        p.name AS provider_name
      FROM model_calls mc
      LEFT JOIN users u ON u.id = mc.actor_id
      LEFT JOIN chapters c ON c.id = mc.chapter_id
      LEFT JOIN automation_jobs j ON j.id = mc.job_id
      LEFT JOIN works jw ON jw.id = j.work_id
      LEFT JOIN model_providers p ON p.id = mc.provider_id
      WHERE mc.workspace_id = ${auth.workspace.id}
        AND mc.created_at >= ${range.start}
        AND mc.created_at < ${range.end}
      ORDER BY mc.created_at DESC
    `,
    loadBudgetUsage(sql, auth.workspace.id, range),
    loadProviderPrices(sql, auth.workspace.id),
  ]);

  const totals = new Map<PriceCurrency, MoneyAccumulator>();
  const byPurpose = new Map<string, BreakdownAccumulator>();
  const byMember = new Map<string, BreakdownAccumulator>();
  const byJob = new Map<string, BreakdownAccumulator>();
  const byChapter = new Map<string, BreakdownAccumulator>();
  const unknownCalls: BillingUnknownCallView[] = [];
  let unknownCallTotal = 0;
  let blockedCallTotal = 0;

  for (const row of rows) {
    if (row.status === 'blocked') {
      blockedCallTotal += 1;
      continue;
    }
    const cost = decimal(row.cost);
    const reservedCost = decimal(row.reserved_cost);
    const purposeKey = row.purpose ?? 'unknown';
    const purpose = breakdown(byPurpose, purposeKey, purposeLabel(row.purpose), null);
    const memberKey = row.actor_id ?? 'system';
    const member = breakdown(
      byMember,
      memberKey,
      row.actor_name ?? '系统 / 未绑定成员',
      row.actor_kind === 'ai' ? 'AI 主体' : null,
    );
    const job = row.job_id
      ? breakdown(
          byJob,
          row.job_id,
          `作业 ${row.job_id.slice(0, 8)}`,
          [row.job_work_title, row.job_status].filter(Boolean).join(' · ') || null,
        )
      : null;
    const chapter = row.chapter_id
      ? breakdown(
          byChapter,
          row.chapter_id,
          row.chapter_number !== null
            ? `第${row.chapter_number}章 · ${row.chapter_title ?? ''}`.trim()
            : (row.chapter_title ?? `章节 ${row.chapter_id.slice(0, 8)}`),
          null,
        )
      : null;

    if (cost !== null && isPriceCurrency(row.cost_currency)) {
      const currency = row.cost_currency;
      const total = moneyAccumulator(totals, currency);
      total.knownCost += cost;
      total.calls += 1;
      for (const target of [purpose, member, job, chapter]) {
        if (!target) continue;
        const acc = moneyAccumulator(target.money, currency);
        acc.knownCost += cost;
        acc.calls += 1;
      }
    }

    if (reservedCost !== null && isPriceCurrency(row.reserved_currency)) {
      const currency = row.reserved_currency;
      const total = moneyAccumulator(totals, currency);
      total.reservedCost += reservedCost;
      total.activeCalls += 1;
      for (const target of [purpose, member, job, chapter]) {
        if (!target) continue;
        const acc = moneyAccumulator(target.money, currency);
        acc.reservedCost += reservedCost;
        acc.activeCalls += 1;
      }
    }

    if (isUnknownCost(row)) {
      unknownCallTotal += 1;
      purpose.unknownCalls += 1;
      member.unknownCalls += 1;
      if (job) job.unknownCalls += 1;
      if (chapter) chapter.unknownCalls += 1;
      if (unknownCalls.length < UNKNOWN_CALL_LIMIT) {
        unknownCalls.push({
          id: row.id,
          createdAt: iso(row.created_at),
          purpose: purposeKey,
          purposeLabel: purposeLabel(row.purpose),
          providerName: row.provider_name,
          model: row.model,
          status: row.status,
          errorCode: row.error_code,
          actorName: row.actor_name,
          chapterId: row.chapter_id,
          chapterNumber: row.chapter_number,
          chapterTitle: row.chapter_title,
          jobId: row.job_id,
        });
      }
    }
  }

  const sortBreakdowns = (map: Map<string, BreakdownAccumulator>): BillingBreakdownView[] =>
    [...map.values()]
      .map(breakdownView)
      .sort(
        (a, b) =>
          b.costs.reduce((sum, item) => sum + item.knownCost + item.reservedCost, 0) -
            a.costs.reduce((sum, item) => sum + item.knownCost + item.reservedCost, 0) ||
          b.unknownCalls - a.unknownCalls ||
          a.label.localeCompare(b.label, 'zh-CN'),
      );

  return {
    workspaceId: auth.workspace.id,
    month: range.month,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    generatedAt: new Date().toISOString(),
    budget: mapBudget(await loadBudgetRow(sql, auth.workspace.id)),
    budgetUsage: usage.view,
    providers,
    totals: [...totals.values()]
      .map(moneyView)
      .sort((a, b) => b.knownCost + b.reservedCost - (a.knownCost + a.reservedCost)),
    totalCalls: rows.length,
    unknownCallTotal,
    blockedCallTotal,
    byPurpose: sortBreakdowns(byPurpose),
    byMember: sortBreakdowns(byMember),
    byJob: sortBreakdowns(byJob),
    byChapter: sortBreakdowns(byChapter),
    unknownCalls,
  };
}

export interface WorkspaceBudgetPreflight {
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export async function workspaceBudgetPreflight(
  workspaceId: string,
): Promise<WorkspaceBudgetPreflight> {
  const range = currentMonthRange();
  const usage = await loadBudgetUsage(sql, workspaceId, range);
  const providers = await loadProviderPrices(sql, workspaceId);
  if (usage.monthlyLimit === null) {
    return {
      status: 'warn',
      detail: '未设置工作区月度预算；生成调用会记录估算费用，但不会因额度耗尽被阻断。',
    };
  }
  const chatProviders = providers.filter((provider) => provider.purpose === 'chat' && provider.isEnabled);
  if (chatProviders.length === 0) {
    return { status: 'fail', detail: '已设置工作区预算，但没有启用的生成服务商。' };
  }
  const incomplete = chatProviders.filter((provider) => provider.pricingStatus === 'incomplete');
  if (incomplete.length > 0) {
    return {
      status: 'fail',
      detail: `工作区预算已启用，但服务商价表不完整：${incomplete
        .map((provider) => provider.name)
        .join('、')}。请由所有者或计费管理员补全。`,
    };
  }
  const mismatched = chatProviders.filter(
    (provider) => provider.priceCurrency !== usage.currency,
  );
  if (mismatched.length > 0) {
    return {
      status: 'fail',
      detail: `工作区预算币种为 ${usage.currency}，但服务商使用 ${[
        ...new Set(mismatched.map((provider) => provider.priceCurrency)),
      ].join('、')}；请求会在调用前被阻断。`,
    };
  }
  if (usage.remaining !== null && usage.remaining <= 0) {
    return {
      status: 'fail',
      detail: `工作区本月生成预算已耗尽：已计 ${usage.view.knownSpent.toFixed(4)} ${usage.currency}，预留 ${usage.view.reserved.toFixed(4)}。`,
    };
  }
  if (usage.view.unknownGenerationCalls > 0) {
    return {
      status: 'warn',
      detail: `本月有 ${usage.view.unknownGenerationCalls} 次生成调用费用未知；预算只能约束已知估算，实际支出可能高于上限。`,
    };
  }
  return {
    status: 'pass',
    detail: `工作区本月剩余 ${usage.remaining?.toFixed(4) ?? '0.0000'} ${usage.currency}；生成调用会按剩余额度预留并限制输出 tokens。`,
  };
}

export async function workspaceBudgetBlockReason(workspaceId: string): Promise<string | null> {
  const preflight = await workspaceBudgetPreflight(workspaceId);
  return preflight.status === 'fail' ? `工作区预算保护：${preflight.detail}` : null;
}
