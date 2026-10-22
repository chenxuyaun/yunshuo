import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  MeResponse,
  ProviderBillListResponse,
  ProviderBillReconciliationResponse,
  ProviderBillView,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@m5b-reconcile-${RUN_ID}.test`;
const PERIOD_START = '2026-09-01';
const PERIOD_END = '2026-09-30';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M5-B 账单对账集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M5-B 账单对账：CSV 导入、逐模型对照、复核与权限', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let providerId = '';
  let otherProviderId = '';
  let billId = '';
  let owner: Session;
  let lead: Session;
  let author: Session;
  let billing: Session;
  let otherOwner: Session;
  const userIds: string[] = [];

  const CSV = [
    'model,input_tokens,output_tokens,amount,note',
    'alpha-model,3000,1200,3.500000,"10月, 生成"',
    'beta-model,300,100,4.000000,',
    'gamma-model,,,0.500000,',
    'epsilon-model,100,50,0.250000,仅账单',
  ].join('\n');

  async function login(email: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!rawCookie) throw new Error('登录未返回会话 Cookie');
    return { cookie: rawCookie.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    session: Session | null,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      ...(session ? { headers: { cookie: session.cookie } } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() as T };
  }

  function expectError(result: ApiResult<unknown>, status: number, code: string): void {
    expect(result.status).toBe(status);
    expect((result.body as ErrorBody).error.code).toBe(code);
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(
    workspace: string,
    email: string,
    name: string,
    role: 'owner' | 'lead' | 'author' | 'billing',
  ): Promise<Session> {
    const id = randomUUID();
    userIds.push(id);
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${name})`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspace}, ${id}, ${role})
    `;
    return login(email);
  }

  async function createProvider(
    workspace: string,
    name: string,
    promptPrice: number,
    completionPrice: number,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency
      )
      VALUES (
        ${id}, ${workspace}, ${name}, 'http://127.0.0.1:9/v1', 'stub-model', 'chat',
        true, 10, ${promptPrice}, ${completionPrice}, 'CNY'
      )
    `;
    return id;
  }

  async function insertCall(input: {
    model: string;
    status?: 'ok' | 'failed' | 'blocked';
    cost: number | null;
    currency?: 'CNY' | 'USD' | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    errorCode?: string | null;
  }): Promise<void> {
    await sql`
      INSERT INTO model_calls (
        id, workspace_id, provider_id, model, status, purpose, attempt_no,
        cost, cost_currency, prompt_tokens, completion_tokens, error_code,
        created_at, completed_at
      )
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${providerId}, ${input.model},
        ${input.status ?? 'ok'}, 'chapter_proposal', 1,
        ${input.cost},
        ${input.currency === null ? null : (input.currency ?? 'CNY')},
        ${input.promptTokens ?? null}, ${input.completionTokens ?? null},
        ${input.errorCode ?? null},
        ${new Date(2026, 8, 15, 12, 0, 0)}, now()
      )
    `;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspaceId = await createWorkspace(`M5-B 对账工作区 ${RUN_ID}`);
    otherWorkspaceId = await createWorkspace(`M5-B 对账隔离工作区 ${RUN_ID}`);
    owner = await createUser(workspaceId, `owner${EMAIL_SUFFIX}`, '对账所有者', 'owner');
    lead = await createUser(workspaceId, `lead${EMAIL_SUFFIX}`, '对账主笔', 'lead');
    author = await createUser(workspaceId, `author${EMAIL_SUFFIX}`, '对账作者', 'author');
    billing = await createUser(workspaceId, `billing${EMAIL_SUFFIX}`, '对账计费员', 'billing');
    otherOwner = await createUser(
      otherWorkspaceId,
      `other${EMAIL_SUFFIX}`,
      '隔离工作区所有者',
      'owner',
    );

    providerId = await createProvider(workspaceId, '对账服务商', 1000, 1000);
    otherProviderId = await createProvider(otherWorkspaceId, '隔离服务商', 500, 500);

    await insertCall({ model: 'alpha-model', cost: 1.5, promptTokens: 1000, completionTokens: 500 });
    await insertCall({ model: 'alpha-model', cost: 2, promptTokens: 2000, completionTokens: 700 });
    await insertCall({ model: 'alpha-model', cost: 1, currency: 'USD' });
    await insertCall({ model: 'beta-model', cost: 5, promptTokens: 300, completionTokens: 100 });
    await insertCall({
      model: 'gamma-model',
      status: 'failed',
      cost: null,
      currency: null,
      errorCode: 'UPSTREAM_ERROR',
    });
    await insertCall({
      model: 'delta-model',
      status: 'blocked',
      cost: null,
      currency: null,
      errorCode: 'BUDGET_INSUFFICIENT',
    });
  });

  afterAll(async () => {
    if (workspaceId && otherWorkspaceId) {
      const ids = [workspaceId, otherWorkspaceId];
      await sql`DELETE FROM provider_bills WHERE workspace_id IN ${sql(ids)}`;
      await sql`DELETE FROM model_calls WHERE workspace_id IN ${sql(ids)}`;
      await sql`DELETE FROM model_providers WHERE workspace_id IN ${sql(ids)}`;
      await sql`DELETE FROM audit_log WHERE workspace_id IN ${sql(ids)}`;
      await sql`DELETE FROM memberships WHERE workspace_id IN ${sql(ids)}`;
      await sql`DELETE FROM workspaces WHERE id IN ${sql(ids)}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (app) await app.close();
    await closeDb();
  });

  it('账单列表与导入受角色限制：作者不可见，主笔只读，计费管理员可导入', async () => {
    expectError(await call('GET', '/api/billing/bills', author), 403, 'FORBIDDEN');
    const leadList = await call<ProviderBillListResponse>('GET', '/api/billing/bills', lead);
    expect(leadList.status).toBe(200);
    expect(leadList.body.bills).toHaveLength(0);
    expect((await call('GET', '/api/billing/bills', owner)).status).toBe(200);

    expectError(
      await call('POST', '/api/billing/bills/import', lead, {
        providerId,
        invoiceNo: 'LEAD-001',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        currency: 'CNY',
        csv: CSV,
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('计费管理员可导入 CSV，账单元数据与明细合计如实返回并写审计', async () => {
    const result = await call<ProviderBillView>('POST', '/api/billing/bills/import', billing, {
      providerId,
      invoiceNo: `INV-${RUN_ID}`,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      currency: 'CNY',
      declaredTotal: 8.3,
      csv: CSV,
    });
    expect(result.status).toBe(200);
    const bill = result.body;
    billId = bill.id;
    expect(bill.providerId).toBe(providerId);
    expect(bill.providerName).toBe('对账服务商');
    expect(bill.invoiceNo).toBe(`INV-${RUN_ID}`);
    expect(bill.periodStart).toBe(PERIOD_START);
    expect(bill.periodEnd).toBe(PERIOD_END);
    expect(bill.currency).toBe('CNY');
    expect(bill.status).toBe('imported');
    expect(bill.declaredTotal).toBe(8.3);
    expect(bill.linesTotal).toBe(8.25);
    expect(bill.lineCount).toBe(4);
    expect(bill.importedBy?.id).toBe(billing.me.user.id);
    expect(bill.reviewedBy).toBeNull();

    const auditRows = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log
      WHERE workspace_id = ${workspaceId}
        AND action = 'billing.bill.import'
        AND object_id = ${billId}
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.metadata).toMatchObject({
      invoiceNo: `INV-${RUN_ID}`,
      providerName: '对账服务商',
      currency: 'CNY',
      declaredTotal: 8.3,
      linesTotal: 8.25,
      lineCount: 4,
    });
  });

  it('同一服务商同一发票号不能重复导入', async () => {
    const result = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      providerId,
      invoiceNo: `INV-${RUN_ID}`,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      currency: 'CNY',
      csv: CSV,
    });
    expectError(result, 409, 'BILL_ALREADY_IMPORTED');
  });

  it('逐模型对照区分一致、金额差、仅账单、仅本地、本地未知与其他币种', async () => {
    const result = await call<ProviderBillReconciliationResponse>(
      'GET',
      `/api/billing/bills/${billId}/reconciliation`,
      lead,
    );
    expect(result.status).toBe(200);
    const body = result.body;
    expect(body.rangeStart).toBe(new Date(2026, 8, 1).toISOString());
    expect(body.rangeEnd).toBe(new Date(2026, 9, 1).toISOString());
    expect(body.summary.billLinesTotal).toBe(8.25);
    expect(body.summary.declaredTotal).toBe(8.3);
    expect(body.summary.declaredVsLines).toBe(0.05);
    expect(body.summary.localKnownTotal).toBe(8.5);
    expect(body.summary.deltaTotal).toBe(-0.25);
    expect(body.summary.mismatchModels).toBe(3);
    expect(body.summary.unknownCalls).toBe(1);
    expect(body.summary.otherCurrencyCalls).toBe(1);
    expect(body.summary.blockedCalls).toBe(1);

    const rows = new Map(body.models.map((row) => [row.model, row]));
    expect(rows.has('delta-model')).toBe(false);

    const alpha = rows.get('alpha-model')!;
    expect(alpha.status).toBe('match');
    expect(alpha.billAmount).toBe(3.5);
    expect(alpha.localAmount).toBe(3.5);
    expect(alpha.deltaAmount).toBe(0);
    expect(alpha.tokenStatus).toBe('match');
    expect(alpha.localInputTokens).toBe(3000);
    expect(alpha.localOutputTokens).toBe(1200);
    expect(alpha.otherCurrencyCalls).toBe(1);

    const beta = rows.get('beta-model')!;
    expect(beta.status).toBe('amount_mismatch');
    expect(beta.deltaAmount).toBe(-1);
    expect(beta.tokenStatus).toBe('match');

    const gamma = rows.get('gamma-model')!;
    expect(gamma.status).toBe('local_unknown');
    expect(gamma.localCalls).toBe(0);
    expect(gamma.unknownCalls).toBe(1);
    expect(gamma.tokenStatus).toBe('not_comparable');

    const epsilon = rows.get('epsilon-model')!;
    expect(epsilon.status).toBe('bill_only');
    expect(epsilon.billAmount).toBe(0.25);
    expect(epsilon.localCalls).toBe(0);
    expect(epsilon.tokenStatus).toBe('mismatch');
  });

  it('CSV 格式、日期与账期非法时返回明确错误，不落账单', async () => {
    const base = {
      providerId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      currency: 'CNY',
    };
    const badHeader = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      invoiceNo: `BAD-HEADER-${RUN_ID}`,
      csv: 'model,amount\nalpha-model,1',
    });
    expectError(badHeader, 400, 'BILL_CSV_INVALID');

    const negative = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      invoiceNo: `BAD-AMOUNT-${RUN_ID}`,
      csv: 'model,input_tokens,output_tokens,amount\nalpha-model,1,1,-1',
    });
    expectError(negative, 400, 'BILL_CSV_INVALID');

    const precision = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      invoiceNo: `BAD-PRECISION-${RUN_ID}`,
      csv: 'model,input_tokens,output_tokens,amount\nalpha-model,1,1,0.1234567',
    });
    expectError(precision, 400, 'BILL_CSV_INVALID');

    const columns = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      invoiceNo: `BAD-COLUMNS-${RUN_ID}`,
      csv: 'model,input_tokens,output_tokens,amount\nalpha-model,1,1',
    });
    expectError(columns, 400, 'BILL_CSV_INVALID');

    const tokens = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      invoiceNo: `BAD-TOKENS-${RUN_ID}`,
      csv: 'model,input_tokens,output_tokens,amount\nalpha-model,1.5,1,1',
    });
    expectError(tokens, 400, 'BILL_CSV_INVALID');

    const date = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      periodStart: '2026-02-31',
      invoiceNo: `BAD-DATE-${RUN_ID}`,
      csv: CSV,
    });
    expectError(date, 400, 'BILL_PERIOD_INVALID');

    const reversed = await call<ErrorBody>('POST', '/api/billing/bills/import', billing, {
      ...base,
      periodStart: PERIOD_END,
      periodEnd: PERIOD_START,
      invoiceNo: `BAD-REVERSED-${RUN_ID}`,
      csv: CSV,
    });
    expectError(reversed, 400, 'BILL_PERIOD_INVALID');

    const leftovers = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM provider_bills
      WHERE workspace_id = ${workspaceId} AND invoice_no LIKE ${`BAD-%${RUN_ID}`}
    `;
    expect(leftovers[0]!.count).toBe(0);
  });

  it('复核只有所有者/计费管理员可操作，有争议必须写说明并留审计', async () => {
    expectError(
      await call('PATCH', `/api/billing/bills/${billId}`, lead, {
        status: 'reviewed',
        note: '主笔不能复核',
      }),
      403,
      'FORBIDDEN',
    );

    const missingNote = await call<ErrorBody>(
      'PATCH',
      `/api/billing/bills/${billId}`,
      billing,
      { status: 'disputed', note: '' },
    );
    expectError(missingNote, 400, 'BILL_REVIEW_NOTE_REQUIRED');

    const disputed = await call<ProviderBillView>(
      'PATCH',
      `/api/billing/bills/${billId}`,
      billing,
      { status: 'disputed', note: 'beta 模型账单金额高于估算 1.0 CNY，待供应商确认。' },
    );
    expect(disputed.status).toBe(200);
    expect(disputed.body.status).toBe('disputed');
    expect(disputed.body.reviewNote).toBe('beta 模型账单金额高于估算 1.0 CNY，待供应商确认。');
    expect(disputed.body.reviewedBy?.id).toBe(billing.me.user.id);
    expect(disputed.body.reviewedAt).not.toBeNull();

    const auditRows = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log
      WHERE workspace_id = ${workspaceId}
        AND action = 'billing.bill.review'
        AND object_id = ${billId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(auditRows[0]!.metadata).toMatchObject({
      invoiceNo: `INV-${RUN_ID}`,
      before: { status: 'imported', note: null },
      after: { status: 'disputed' },
    });

    const reviewed = await call<ProviderBillView>(
      'PATCH',
      `/api/billing/bills/${billId}`,
      owner,
      { status: 'reviewed', note: '已人工核对并保留差异记录。' },
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe('reviewed');

    const list = await call<ProviderBillListResponse>('GET', '/api/billing/bills', billing);
    expect(list.body.bills.find((bill) => bill.id === billId)?.status).toBe('reviewed');
  });

  it('账单与对账按工作区隔离，不能借其他工作区的服务商导入', async () => {
    expectError(
      await call('GET', `/api/billing/bills/${billId}/reconciliation`, otherOwner),
      404,
      'BILL_NOT_FOUND',
    );

    const otherList = await call<ProviderBillListResponse>(
      'GET',
      '/api/billing/bills',
      otherOwner,
    );
    expect(otherList.body.bills).toHaveLength(0);

    const crossImport = await call<ErrorBody>(
      'POST',
      '/api/billing/bills/import',
      otherOwner,
      {
        providerId,
        invoiceNo: `CROSS-${RUN_ID}`,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        currency: 'CNY',
        csv: CSV,
      },
    );
    expectError(crossImport, 404, 'PROVIDER_NOT_FOUND');

    const otherImport = await call<ProviderBillView>(
      'POST',
      '/api/billing/bills/import',
      otherOwner,
      {
        providerId: otherProviderId,
        invoiceNo: `OTHER-${RUN_ID}`,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        currency: 'CNY',
        csv: 'model,input_tokens,output_tokens,amount\nother-model,10,10,0.01',
      },
    );
    expect(otherImport.status).toBe(200);
    expect(otherImport.body.providerId).toBe(otherProviderId);
  });
});
