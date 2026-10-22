import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { jsonValue, sql } from '@yunshuo/db';
import type {
  ImportProviderBillInput,
  PriceCurrency,
  ProviderBillListResponse,
  ProviderBillModelComparison,
  ProviderBillModelStatus,
  ProviderBillReconciliationResponse,
  ProviderBillStatus,
  ProviderBillView,
  ReviewProviderBillInput,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { iso } from '../views.js';
import { assertCanManageBilling, assertCanViewBilling } from './billing-service.js';

type Executor = Sql<any> | TransactionSql<any>;

const MAX_BILL_LINES = 5000;
const MAX_BILL_AMOUNT = 1_000_000_000;
const MAX_PERIOD_DAYS = 366;
const AMOUNT_TOLERANCE = 1e-6;

interface BillRow {
  id: string;
  provider_id: string;
  provider_name: string;
  invoice_no: string;
  period_start: string;
  period_end: string;
  currency: string;
  declared_total: string | null;
  lines_total: string;
  line_count: number;
  status: string;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_by_email: string | null;
  reviewed_at: Date | string | null;
  imported_by: string | null;
  imported_by_name: string | null;
  imported_by_email: string | null;
  created_at: Date | string;
}

interface LocalUsageRow {
  model: string;
  local_calls: number;
  local_amount: string;
  local_input_tokens: string | null;
  local_output_tokens: string | null;
  unknown_calls: number;
  other_currency_calls: number;
  blocked_calls: number;
}

interface BillLineGroupRow {
  model: string;
  line_count: number;
  amount: string;
  input_tokens: string | null;
  output_tokens: string | null;
}

interface ParsedBillLine {
  lineNo: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  amount: number;
  note: string | null;
}

function decimal(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function currency(value: string): PriceCurrency {
  return value === 'USD' ? 'USD' : 'CNY';
}

function userSummary(
  id: string | null,
  name: string | null,
  email: string | null,
): { id: string; name: string; email: string } | null {
  return id && name && email ? { id, name, email } : null;
}

function mapBill(row: BillRow): ProviderBillView {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    invoiceNo: row.invoice_no,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: currency(row.currency),
    declaredTotal: decimal(row.declared_total),
    linesTotal: decimal(row.lines_total) ?? 0,
    lineCount: row.line_count,
    status: row.status as ProviderBillStatus,
    reviewNote: row.review_note,
    reviewedBy: userSummary(row.reviewed_by, row.reviewed_by_name, row.reviewed_by_email),
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    importedBy: userSummary(row.imported_by, row.imported_by_name, row.imported_by_email),
    createdAt: iso(row.created_at),
  };
}

const BILL_SELECT = sql`
  SELECT
    pb.id, pb.provider_id, pb.provider_name, pb.invoice_no,
    to_char(pb.period_start, 'YYYY-MM-DD') AS period_start,
    to_char(pb.period_end, 'YYYY-MM-DD') AS period_end,
    pb.currency, pb.declared_total::text AS declared_total,
    COALESCE((
      SELECT SUM(l.amount) FROM provider_bill_lines l WHERE l.bill_id = pb.id
    ), 0)::text AS lines_total,
    (
      SELECT count(*) FROM provider_bill_lines l WHERE l.bill_id = pb.id
    )::int AS line_count,
    pb.status, pb.review_note,
    pb.reviewed_by, ru.name AS reviewed_by_name, ru.email AS reviewed_by_email,
    pb.reviewed_at,
    pb.imported_by, iu.name AS imported_by_name, iu.email AS imported_by_email,
    pb.created_at
  FROM provider_bills pb
  LEFT JOIN users iu ON iu.id = pb.imported_by
  LEFT JOIN users ru ON ru.id = pb.reviewed_by
`;

async function loadBillRow(
  exec: Executor,
  workspaceId: string,
  billId: string,
): Promise<BillRow | null> {
  const rows = await exec<BillRow[]>`
    ${BILL_SELECT}
    WHERE pb.workspace_id = ${workspaceId} AND pb.id = ${billId}
  `;
  return rows[0] ?? null;
}

function parseDateOnly(value: string, label: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year!, month! - 1, day!);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day
  ) {
    throw badRequest('BILL_PERIOD_INVALID', `${label}不是有效日期：${value}`);
  }
  return date;
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const text = content.replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (inQuotes) {
    throw badRequest('BILL_CSV_INVALID', 'CSV 存在未闭合的引号');
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function parseAmount(raw: string, lineNo: number): number {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw badRequest(
      'BILL_CSV_INVALID',
      `第 ${lineNo} 行金额必须是非负数字，最多 6 位小数：${raw || '空'}`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value > MAX_BILL_AMOUNT) {
    throw badRequest('BILL_CSV_INVALID', `第 ${lineNo} 行金额超出允许范围`);
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseTokens(raw: string, lineNo: number, label: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    throw badRequest('BILL_CSV_INVALID', `第 ${lineNo} 行 ${label} 必须是非负整数或留空`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw badRequest('BILL_CSV_INVALID', `第 ${lineNo} 行 ${label} 超出允许范围`);
  }
  return value;
}

function parseBillCsv(content: string): { lines: ParsedBillLine[]; total: number } {
  const rows = parseCsvRows(content);
  if (rows.length < 2) {
    throw badRequest(
      'BILL_CSV_INVALID',
      'CSV 至少需要一行表头和一行明细；表头为 model,input_tokens,output_tokens,amount,note',
    );
  }
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const required = ['model', 'input_tokens', 'output_tokens', 'amount'];
  for (const column of required) {
    if (!header.includes(column)) {
      throw badRequest('BILL_CSV_INVALID', `CSV 缺少必需列 ${column}`);
    }
  }
  const allowed = new Set([...required, 'note']);
  if (new Set(header).size !== header.length) {
    throw badRequest('BILL_CSV_INVALID', 'CSV 表头存在重复列');
  }
  for (const column of header) {
    if (!allowed.has(column)) {
      throw badRequest('BILL_CSV_INVALID', `CSV 包含不支持的列 ${column}`);
    }
  }
  const indexOf = (name: string) => header.indexOf(name);
  if (rows.length - 1 > MAX_BILL_LINES) {
    throw badRequest('BILL_CSV_INVALID', `账单明细最多 ${MAX_BILL_LINES} 行`);
  }

  let totalMicros = 0;
  const lines: ParsedBillLine[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index]!;
    const lineNo = index + 1;
    if (cells.length !== header.length) {
      throw badRequest(
        'BILL_CSV_INVALID',
        `第 ${lineNo} 行列数为 ${cells.length}，与表头 ${header.length} 列不一致`,
      );
    }
    const model = cells[indexOf('model')]!.trim();
    if (!model || model.length > 200) {
      throw badRequest('BILL_CSV_INVALID', `第 ${lineNo} 行 model 必须为 1–200 个字符`);
    }
    const amount = parseAmount(cells[indexOf('amount')]!, lineNo);
    const noteIndex = indexOf('note');
    const note = noteIndex >= 0 ? cells[noteIndex]!.trim() : '';
    if (note.length > 500) {
      throw badRequest('BILL_CSV_INVALID', `第 ${lineNo} 行 note 最多 500 个字符`);
    }
    totalMicros += Math.round(amount * 1_000_000);
    lines.push({
      lineNo: index,
      model,
      inputTokens: parseTokens(cells[indexOf('input_tokens')]!, lineNo, 'input_tokens'),
      outputTokens: parseTokens(cells[indexOf('output_tokens')]!, lineNo, 'output_tokens'),
      amount,
      note: note || null,
    });
  }
  return { lines, total: totalMicros / 1_000_000 };
}

export async function listProviderBills(auth: AuthContext): Promise<ProviderBillListResponse> {
  assertCanViewBilling(auth.role);
  const rows = await sql<BillRow[]>`
    ${BILL_SELECT}
    WHERE pb.workspace_id = ${auth.workspace.id}
    ORDER BY pb.period_end DESC, pb.created_at DESC
    LIMIT 100
  `;
  return { bills: rows.map(mapBill) };
}

export async function importProviderBill(
  auth: AuthContext,
  input: ImportProviderBillInput,
): Promise<ProviderBillView> {
  assertCanManageBilling(auth.role);
  const providerRows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM model_providers
    WHERE id = ${input.providerId} AND workspace_id = ${auth.workspace.id}
  `;
  const provider = providerRows[0];
  if (!provider) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在或不属于当前工作区');

  const start = parseDateOnly(input.periodStart, '账期开始日期');
  const end = parseDateOnly(input.periodEnd, '账期结束日期');
  if (end.getTime() < start.getTime()) {
    throw badRequest('BILL_PERIOD_INVALID', '账期结束日期不能早于开始日期');
  }
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_PERIOD_DAYS) {
    throw badRequest('BILL_PERIOD_INVALID', `账期跨度不能超过 ${MAX_PERIOD_DAYS} 天`);
  }
  const parsed = parseBillCsv(input.csv);
  const declaredTotal =
    input.declaredTotal === undefined || input.declaredTotal === null
      ? null
      : round6(input.declaredTotal);
  const billId = randomUUID();

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO provider_bills (
          id, workspace_id, provider_id, provider_name, invoice_no,
          period_start, period_end, currency, declared_total, imported_by
        )
        VALUES (
          ${billId}, ${auth.workspace.id}, ${provider.id}, ${provider.name},
          ${input.invoiceNo}, ${input.periodStart}, ${input.periodEnd},
          ${input.currency}, ${declaredTotal}, ${auth.user.id}
        )
      `;
      for (const line of parsed.lines) {
        await tx`
          INSERT INTO provider_bill_lines (
            id, bill_id, line_no, model, input_tokens, output_tokens, amount, note
          )
          VALUES (
            ${randomUUID()}, ${billId}, ${line.lineNo}, ${line.model},
            ${line.inputTokens}, ${line.outputTokens}, ${line.amount}, ${line.note}
          )
        `;
      }
      await tx`
        INSERT INTO audit_log (
          workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
        )
        VALUES (
          ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
          'billing.bill.import', 'provider_bill', ${billId}, 'success',
          ${tx.json(jsonValue({
            providerId: provider.id,
            providerName: provider.name,
            invoiceNo: input.invoiceNo,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            currency: input.currency,
            declaredTotal,
            linesTotal: round6(parsed.total),
            lineCount: parsed.lines.length,
          }))}
        )
      `;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict(
        'BILL_ALREADY_IMPORTED',
        `该服务商的发票号 ${input.invoiceNo} 已导入过，不能重复导入`,
      );
    }
    throw error;
  }

  const row = await loadBillRow(sql, auth.workspace.id, billId);
  if (!row) throw new Error('账单导入后读取失败');
  return mapBill(row);
}

export async function reviewProviderBill(
  auth: AuthContext,
  billId: string,
  input: ReviewProviderBillInput,
): Promise<ProviderBillView> {
  assertCanManageBilling(auth.role);
  if (input.status === 'disputed' && !input.note) {
    throw badRequest('BILL_REVIEW_NOTE_REQUIRED', '标记为有争议时必须填写说明');
  }
  await sql.begin(async (tx) => {
    const rows = await tx<{
      id: string;
      invoice_no: string;
      provider_name: string;
      status: string;
      review_note: string | null;
    }[]>`
      SELECT id, invoice_no, provider_name, status, review_note
      FROM provider_bills
      WHERE id = ${billId} AND workspace_id = ${auth.workspace.id}
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw notFound('BILL_NOT_FOUND', '账单不存在或不属于当前工作区');
    await tx`
      UPDATE provider_bills SET
        status = ${input.status},
        review_note = ${input.note || null},
        reviewed_by = ${auth.user.id},
        reviewed_at = now(),
        updated_at = now()
      WHERE id = ${billId} AND workspace_id = ${auth.workspace.id}
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
        'billing.bill.review', 'provider_bill', ${billId}, 'success',
        ${tx.json(jsonValue({
          invoiceNo: current.invoice_no,
          providerName: current.provider_name,
          before: { status: current.status, note: current.review_note },
          after: { status: input.status, note: input.note || null },
        }))}
      )
    `;
  });
  const row = await loadBillRow(sql, auth.workspace.id, billId);
  if (!row) throw new Error('账单复核后读取失败');
  return mapBill(row);
}

function modelStatus(
  hasBill: boolean,
  localCalls: number,
  otherCurrencyCalls: number,
  unknownCalls: number,
  deltaAmount: number,
): ProviderBillModelStatus {
  if (hasBill && localCalls > 0) {
    return Math.abs(deltaAmount) <= AMOUNT_TOLERANCE ? 'match' : 'amount_mismatch';
  }
  if (hasBill) {
    if (otherCurrencyCalls > 0) return 'currency_mismatch';
    if (unknownCalls > 0) return 'local_unknown';
    return 'bill_only';
  }
  return 'local_only';
}

export async function loadProviderBillReconciliation(
  auth: AuthContext,
  billId: string,
): Promise<ProviderBillReconciliationResponse> {
  assertCanViewBilling(auth.role);
  const bill = await loadBillRow(sql, auth.workspace.id, billId);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在或不属于当前工作区');

  const start = parseDateOnly(bill.period_start, '账期开始日期');
  const end = parseDateOnly(bill.period_end, '账期结束日期');
  const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const billCurrency = currency(bill.currency);

  const [localRows, billLineRows] = await Promise.all([
    sql<LocalUsageRow[]>`
      SELECT
        mc.model,
        count(*) FILTER (
          WHERE mc.cost IS NOT NULL AND mc.cost_currency = ${billCurrency}
        )::int AS local_calls,
        COALESCE(SUM(mc.cost) FILTER (
          WHERE mc.cost IS NOT NULL AND mc.cost_currency = ${billCurrency}
        ), 0)::text AS local_amount,
        SUM(mc.prompt_tokens)::text AS local_input_tokens,
        SUM(mc.completion_tokens)::text AS local_output_tokens,
        count(*) FILTER (
          WHERE mc.cost IS NULL AND mc.status <> 'blocked' AND mc.status <> 'streaming'
        )::int AS unknown_calls,
        count(*) FILTER (
          WHERE mc.status <> 'blocked'
            AND mc.cost_currency IS NOT NULL
            AND mc.cost_currency <> ${billCurrency}
        )::int AS other_currency_calls,
        count(*) FILTER (WHERE mc.status = 'blocked')::int AS blocked_calls
      FROM model_calls mc
      WHERE mc.workspace_id = ${auth.workspace.id}
        AND mc.provider_id = ${bill.provider_id}
        AND mc.created_at >= ${start}
        AND mc.created_at < ${endExclusive}
      GROUP BY mc.model
    `,
    sql<BillLineGroupRow[]>`
      SELECT
        model,
        count(*)::int AS line_count,
        COALESCE(SUM(amount), 0)::text AS amount,
        SUM(input_tokens)::text AS input_tokens,
        SUM(output_tokens)::text AS output_tokens
      FROM provider_bill_lines
      WHERE bill_id = ${billId}
      GROUP BY model
    `,
  ]);

  interface ComparisonAccumulator {
    model: string;
    billLineCount: number;
    billAmount: number;
    billInputTokens: number | null;
    billOutputTokens: number | null;
    localCalls: number;
    localAmount: number;
    localInputTokens: number | null;
    localOutputTokens: number | null;
    unknownCalls: number;
    otherCurrencyCalls: number;
    blockedCalls: number;
  }

  const modelMap = new Map<string, ComparisonAccumulator>();
  const ensure = (model: string): ComparisonAccumulator => {
    const existing = modelMap.get(model);
    if (existing) return existing;
    const created: ComparisonAccumulator = {
      model,
      billLineCount: 0,
      billAmount: 0,
      billInputTokens: null,
      billOutputTokens: null,
      localCalls: 0,
      localAmount: 0,
      localInputTokens: null,
      localOutputTokens: null,
      unknownCalls: 0,
      otherCurrencyCalls: 0,
      blockedCalls: 0,
    };
    modelMap.set(model, created);
    return created;
  };

  for (const row of billLineRows) {
    const acc = ensure(row.model);
    acc.billLineCount = row.line_count;
    acc.billAmount = decimal(row.amount) ?? 0;
    acc.billInputTokens = integerOrNull(row.input_tokens);
    acc.billOutputTokens = integerOrNull(row.output_tokens);
  }
  for (const row of localRows) {
    const acc = ensure(row.model);
    acc.localCalls = row.local_calls;
    acc.localAmount = decimal(row.local_amount) ?? 0;
    acc.localInputTokens = integerOrNull(row.local_input_tokens);
    acc.localOutputTokens = integerOrNull(row.local_output_tokens);
    acc.unknownCalls = row.unknown_calls;
    acc.otherCurrencyCalls = row.other_currency_calls;
    acc.blockedCalls = row.blocked_calls;
  }

  let billLinesTotal = 0;
  let localKnownTotal = 0;
  let unknownCalls = 0;
  let otherCurrencyCalls = 0;
  let blockedCalls = 0;

  const comparedModels: ProviderBillModelComparison[] = [...modelMap.values()]
    .map((acc) => {
      const deltaAmount = round6(acc.billAmount - acc.localAmount);
      const status = modelStatus(
        acc.billLineCount > 0,
        acc.localCalls,
        acc.otherCurrencyCalls,
        acc.unknownCalls,
        deltaAmount,
      );
      const billHasTokens = acc.billInputTokens !== null || acc.billOutputTokens !== null;
      const localHasTokens = acc.localInputTokens !== null || acc.localOutputTokens !== null;
      let tokenStatus: ProviderBillModelComparison['tokenStatus'] = 'not_comparable';
      let inputTokenDelta: number | null = null;
      let outputTokenDelta: number | null = null;
      if (billHasTokens) {
        if (!localHasTokens) {
          tokenStatus = 'mismatch';
        } else {
          inputTokenDelta = (acc.billInputTokens ?? 0) - (acc.localInputTokens ?? 0);
          outputTokenDelta = (acc.billOutputTokens ?? 0) - (acc.localOutputTokens ?? 0);
          tokenStatus =
            inputTokenDelta === 0 && outputTokenDelta === 0 ? 'match' : 'mismatch';
        }
      }

      billLinesTotal += acc.billAmount;
      localKnownTotal += acc.localAmount;
      unknownCalls += acc.unknownCalls;
      otherCurrencyCalls += acc.otherCurrencyCalls;
      blockedCalls += acc.blockedCalls;

      return {
        model: acc.model,
        status,
        billLineCount: acc.billLineCount,
        billAmount: round6(acc.billAmount),
        billInputTokens: acc.billInputTokens,
        billOutputTokens: acc.billOutputTokens,
        localCalls: acc.localCalls,
        localAmount: round6(acc.localAmount),
        localInputTokens: acc.localInputTokens,
        localOutputTokens: acc.localOutputTokens,
        deltaAmount,
        inputTokenDelta,
        outputTokenDelta,
        tokenStatus,
        unknownCalls: acc.unknownCalls,
        otherCurrencyCalls: acc.otherCurrencyCalls,
      };
    })
    .sort(
      (a, b) =>
        b.billAmount + b.localAmount - (a.billAmount + a.localAmount) ||
        a.model.localeCompare(b.model, 'zh-CN'),
    );

  // 被预算阻断的调用没有发生上游用量，只有在同时存在账单或其他本地记录时才展示。
  const models = comparedModels.filter(
    (row) =>
      !(
        row.status === 'local_only' &&
        row.billLineCount === 0 &&
        row.localCalls === 0 &&
        row.unknownCalls === 0 &&
        row.otherCurrencyCalls === 0
      ),
  );
  const mismatchModels = models.filter((row) => row.status !== 'match').length;

  const declaredTotal = decimal(bill.declared_total);
  const linesTotal = round6(billLinesTotal);
  return {
    bill: mapBill(bill),
    rangeStart: start.toISOString(),
    rangeEnd: endExclusive.toISOString(),
    summary: {
      billLinesTotal: linesTotal,
      declaredTotal,
      declaredVsLines: declaredTotal === null ? null : round6(declaredTotal - linesTotal),
      localKnownTotal: round6(localKnownTotal),
      deltaTotal: round6(linesTotal - localKnownTotal),
      mismatchModels,
      unknownCalls,
      otherCurrencyCalls,
      blockedCalls,
    },
    models,
    note:
      '本地金额来自 model_calls 的价表与 token 用量估算，账单金额来自手工导入；差异不会自动改写调用记录、价表或预算。账期按服务器本地日期对照。',
  };
}
