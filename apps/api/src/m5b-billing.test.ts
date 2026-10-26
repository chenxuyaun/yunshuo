import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  BillingBudgetView,
  BillingProviderPriceView,
  BillingReportResponse,
  MeResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { AppError } from './errors.js';
import { buildServer } from './server.js';
import {
  currentMonthRange,
  reserveGenerationCall,
  updateWorkspaceBudget,
  workspaceBudgetPreflight,
} from './services/billing-service.js';

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
const EMAIL_SUFFIX = `@m5b-billing-${RUN_ID}.test`;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M5-B 计费集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M5-B 计费：归属报表、工作区预算、价表与角色边界', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let workId = '';
  let volumeId = '';
  let chapterId = '';
  let proposalId = '';
  let chatProviderId = '';
  let embeddingProviderId = '';
  let priceTestProviderId = '';
  let owner: Session;
  let lead: Session;
  let author: Session;
  let billing: Session;
  let viewer: Session;
  const userIds: string[] = [];

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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
    email: string,
    name: string,
    role: 'owner' | 'lead' | 'author' | 'billing' | 'viewer',
  ): Promise<Session> {
    const id = randomUUID();
    userIds.push(id);
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${name})`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return login(email);
  }

  async function createProvider(
    name: string,
    purpose: 'chat' | 'embedding',
    promptPrice: number | null,
    completionPrice: number | null,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency
      )
      VALUES (
        ${id}, ${workspaceId}, ${name}, 'http://127.0.0.1:9/v1', 'stub-model', ${purpose},
        true, 10, ${promptPrice}, ${completionPrice}, 'CNY'
      )
    `;
    return id;
  }

  async function setBudget(monthlyLimit: number | null, currency: 'CNY' | 'USD' = 'CNY') {
    const result = await call<BillingBudgetView | ErrorBody>('PUT', '/api/billing/budget', billing, {
      monthlyLimit,
      currency,
    });
    expect(result.status).toBe(200);
    return result.body as BillingBudgetView;
  }

  async function report(session: Session): Promise<BillingReportResponse> {
    const result = await call<BillingReportResponse>('GET', '/api/billing/report', session);
    expect(result.status).toBe(200);
    return result.body;
  }

  async function clearCalls(): Promise<void> {
    await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
  }

  async function insertCall(input: {
    purpose: 'chapter_proposal' | 'embedding' | 'embedding_query';
    status?: 'ok' | 'failed' | 'blocked';
    cost: number | null;
    currency?: 'CNY' | 'USD';
    actorId: string | null;
    providerId: string | null;
    chapterId: string | null;
    errorCode?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO model_calls (
        id, workspace_id, provider_id, chapter_id, model, status, actor_id,
        purpose, proposal_id, attempt_no, cost, cost_currency, error_code, completed_at
      )
      VALUES (
        ${id}, ${workspaceId}, ${input.providerId}, ${input.chapterId}, 'stub-model',
        ${input.status ?? 'ok'}, ${input.actorId}, ${input.purpose}, ${proposalId}, 1,
        ${input.cost}, ${input.cost === null ? null : (input.currency ?? 'CNY')},
        ${input.errorCode ?? null}, now()
      )
    `;
    return id;
  }

  function reserve(callId: string, promptTokensEstimate = 1000, requestedMaxTokens = 800) {
    return reserveGenerationCall({
      workspaceId,
      callId,
      provider: {
        id: chatProviderId,
        name: 'M5-B 生成服务商',
        promptPricePer1m: 1000,
        completionPricePer1m: 1000,
        priceCurrency: 'CNY',
      },
      promptTokensEstimate,
      requestedMaxTokens,
      chapterId,
      proposalId,
      suggestionId: null,
      purpose: 'chapter_proposal',
      jobId: null,
      actorId: author.me.user.id,
      attemptNo: 1,
      model: 'stub-model',
    });
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspaceId = await createWorkspace(`M5-B 计费工作区 ${RUN_ID}`);
    owner = await createUser(`owner${EMAIL_SUFFIX}`, '计费所有者', 'owner');
    lead = await createUser(`lead${EMAIL_SUFFIX}`, '计费主笔', 'lead');
    author = await createUser(`author${EMAIL_SUFFIX}`, '计费作者', 'author');
    billing = await createUser(`billing${EMAIL_SUFFIX}`, '计费管理员', 'billing');
    viewer = await createUser(`viewer${EMAIL_SUFFIX}`, '计费读者', 'viewer');

    chatProviderId = await createProvider('M5-B 生成服务商', 'chat', 1000, 1000);
    embeddingProviderId = await createProvider('M5-B 嵌入服务商', 'embedding', 20, null);
    priceTestProviderId = await createProvider('M5-B 价表测试商', 'chat', null, null);

    workId = randomUUID();
    volumeId = randomUUID();
    chapterId = randomUUID();
    proposalId = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${workId}, ${workspaceId}, 'M5-B 计费作品')`;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '第一卷')
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES (${chapterId}, ${workId}, ${volumeId}, 1, '计费第一章', 'writing')
    `;
    await sql`
      INSERT INTO ai_proposals (
        id, workspace_id, chapter_id, provider_id, provider_name, model, mode,
        instruction, target_words, context, content, status, created_by
      )
      VALUES (
        ${proposalId}, ${workspaceId}, ${chapterId}, ${chatProviderId}, 'M5-B 生成服务商',
        'stub-model', 'continue', '', 800, '{}'::jsonb, '', 'ready', ${author.me.user.id}
      )
    `;
  });

  afterAll(async () => {
    if (workspaceId) {
      await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ai_generation_locks WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ai_proposals WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM model_providers WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_budgets WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (app) await app.close();
    await closeDb();
  });

  it('计费角色只能查看报表，主笔只读，作者与读者无权访问', async () => {
    expectError(await call('GET', '/api/billing/report', author), 403, 'FORBIDDEN');
    expectError(await call('GET', '/api/billing/report', viewer), 403, 'FORBIDDEN');
    expect((await call('GET', '/api/billing/report', lead)).status).toBe(200);
    expect((await call('GET', '/api/billing/report', billing)).status).toBe(200);

    const date = new Date();
    const range = currentMonthRange(date);
    const body = await report(billing);
    expect(body.month).toBe(range.month);
    expect(body.rangeStart).toBe(range.start.toISOString());
    expect(body.rangeEnd).toBe(range.end.toISOString());
    expect(body.budget.monthlyLimit).toBeNull();
    expect(body.budgetUsage.state).toBe('not_configured');
  });

  it('只有所有者与计费管理员能修改预算，并写入审计', async () => {
    const deniedLead = await call<ErrorBody>('PUT', '/api/billing/budget', lead, {
      monthlyLimit: 10,
      currency: 'CNY',
    });
    expectError(deniedLead, 403, 'FORBIDDEN');
    const deniedAuthor = await call<ErrorBody>('PUT', '/api/billing/budget', author, {
      monthlyLimit: 10,
      currency: 'CNY',
    });
    expectError(deniedAuthor, 403, 'FORBIDDEN');

    const saved = await setBudget(100);
    expect(saved.monthlyLimit).toBe(100);
    expect(saved.currency).toBe('CNY');
    expect(saved.updatedBy?.name).toBe('计费管理员');

    const audits = await sql<
      { metadata: { previousMonthlyLimit: number | null; monthlyLimit: number } }[]
    >`
      SELECT metadata FROM audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'billing.budget.update'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(audits[0]?.metadata.previousMonthlyLimit).toBeNull();
    expect(audits[0]?.metadata.monthlyLimit).toBe(100);
  });

  it('会话指向的工作区已不存在时，改预算以 404 WORKSPACE_NOT_FOUND 收口且不落库', async () => {
    // 路由层解析 auth 时工作区必然存在；这条守的是会话存活期间工作区被删除的窗口：
    // 直接调用服务层，用真实工作区之外的 id 复现 SELECT ... FOR UPDATE 查不到行的分支。
    const before = await sql<{ monthly_limit: string; currency: string }[]>`
      SELECT monthly_limit, currency FROM workspace_budgets WHERE workspace_id = ${workspaceId}
    `;
    const auditBefore = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'billing.budget.update'
    `;
    const staleAuth: AuthContext = {
      ...billing.me,
      workspace: { ...billing.me.workspace, id: randomUUID() },
      sessionId: 'stale-workspace-session',
    };
    const attempt = updateWorkspaceBudget(staleAuth, { monthlyLimit: 5, currency: 'USD' });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      statusCode: 404,
      code: 'WORKSPACE_NOT_FOUND',
      message: '工作区不存在',
    });
    const after = await sql<{ monthly_limit: string; currency: string }[]>`
      SELECT monthly_limit, currency FROM workspace_budgets WHERE workspace_id = ${workspaceId}
    `;
    expect(after).toEqual(before);
    const auditAfter = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'billing.budget.update'
    `;
    expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);
  });

  it('计费管理员可改价表，但不能接触服务商端点与密钥', async () => {
    const deniedLead = await call<ErrorBody>(
      'PATCH',
      `/api/billing/prices/${chatProviderId}`,
      lead,
      { promptPricePer1m: 1, completionPricePer1m: 1 },
    );
    expectError(deniedLead, 403, 'FORBIDDEN');

    const incomplete = await call<ErrorBody>(
      'PATCH',
      `/api/billing/prices/${priceTestProviderId}`,
      billing,
      { promptPricePer1m: 5 },
    );
    expectError(incomplete, 400, 'PROVIDER_PRICING_INCOMPLETE');

    const embeddingMismatch = await call<ErrorBody>(
      'PATCH',
      `/api/billing/prices/${embeddingProviderId}`,
      billing,
      { completionPricePer1m: 1 },
    );
    expectError(embeddingMismatch, 400, 'PROVIDER_PRICING_UNSUPPORTED');

    const updated = await call<BillingProviderPriceView>(
      'PATCH',
      `/api/billing/prices/${priceTestProviderId}`,
      billing,
      { promptPricePer1m: 12.5, completionPricePer1m: 25, priceCurrency: 'CNY' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.promptPricePer1m).toBe(12.5);
    expect(updated.body.completionPricePer1m).toBe(25);
    expect(updated.body.pricingStatus).toBe('complete');
    expect(Object.keys(updated.body).sort()).toEqual(
      [
        'id',
        'name',
        'model',
        'purpose',
        'isEnabled',
        'priority',
        'promptPricePer1m',
        'completionPricePer1m',
        'priceCurrency',
        'pricingStatus',
        'updatedAt',
      ].sort(),
    );

    const full = await report(billing);
    const serialized = JSON.stringify(full);
    expect(serialized).not.toContain('127.0.0.1:9');
    expect(serialized).not.toContain('stub-model-secret');
    expect(serialized).not.toContain('api_key');
    expect(full.providers.find((provider) => provider.id === chatProviderId)?.pricingStatus).toBe(
      'complete',
    );

    const audits = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'billing.provider_price.update'
    `;
    expect(audits.length).toBe(1);
  });

  it('计费角色不能读取章节、AI 提案、检索、服务商配置或自动化授权', async () => {
    expectError(await call('GET', '/api/chapters', billing), 403, 'FORBIDDEN');
    expectError(await call('GET', `/api/chapters/${chapterId}`, billing), 403, 'FORBIDDEN');
    expectError(
      await call('GET', `/api/chapters/${chapterId}/ai/proposals`, billing),
      403,
      'FORBIDDEN',
    );
    expectError(await call('GET', '/api/search?q=林默', billing), 403, 'FORBIDDEN');
    expectError(await call('GET', '/api/model-providers', billing), 403, 'FORBIDDEN');
    expectError(await call('GET', '/api/automation/mandates', billing), 403, 'FORBIDDEN');

    const me = await call<MeResponse>('GET', '/api/me', billing);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('billing');

    const authorRead = await call('GET', '/api/chapters', author);
    expect(authorRead.status).toBe(200);
  });

  it('报表按用途、成员与章节归属，未知费用与阻断调用如实列出', async () => {
    await clearCalls();
    const chapterCall = await insertCall({
      purpose: 'chapter_proposal',
      cost: 1.25,
      actorId: author.me.user.id,
      providerId: chatProviderId,
      chapterId,
    });
    await insertCall({
      purpose: 'embedding',
      cost: 0.5,
      actorId: null,
      providerId: embeddingProviderId,
      chapterId: null,
    });
    await insertCall({
      purpose: 'embedding_query',
      cost: 0.25,
      actorId: author.me.user.id,
      providerId: embeddingProviderId,
      chapterId: null,
    });
    const unknownId = await insertCall({
      purpose: 'chapter_proposal',
      status: 'failed',
      cost: null,
      actorId: author.me.user.id,
      providerId: chatProviderId,
      chapterId,
      errorCode: 'UPSTREAM_NO_USAGE',
    });
    await insertCall({
      purpose: 'chapter_proposal',
      status: 'blocked',
      cost: 0,
      actorId: author.me.user.id,
      providerId: chatProviderId,
      chapterId,
      errorCode: 'BUDGET_INSUFFICIENT',
    });

    const body = await report(owner);
    const total = body.totals.find((item) => item.currency === 'CNY');
    expect(total?.knownCost).toBe(2);
    expect(total?.calls).toBe(3);
    expect(body.totalCalls).toBe(5);
    expect(body.unknownCallTotal).toBe(1);
    expect(body.blockedCallTotal).toBe(1);

    const proposalPurpose = body.byPurpose.find((item) => item.key === 'chapter_proposal');
    expect(proposalPurpose?.costs.find((cost) => cost.currency === 'CNY')?.knownCost).toBe(1.25);
    expect(proposalPurpose?.unknownCalls).toBe(1);
    const embeddingPurpose = body.byPurpose.find((item) => item.key === 'embedding');
    expect(embeddingPurpose?.costs.find((cost) => cost.currency === 'CNY')?.knownCost).toBe(0.5);

    const member = body.byMember.find((item) => item.key === author.me.user.id);
    expect(member?.costs.find((cost) => cost.currency === 'CNY')?.knownCost).toBe(1.5);
    expect(body.byMember.some((item) => item.label.includes('系统'))).toBe(true);

    const chapter = body.byChapter.find((item) => item.key === chapterId);
    expect(chapter?.costs.find((cost) => cost.currency === 'CNY')?.knownCost).toBe(1.25);
    expect(chapter?.unknownCalls).toBe(1);

    expect(body.unknownCalls.map((item) => item.id)).toEqual([unknownId]);
    expect(body.unknownCalls[0]?.chapterNumber).toBe(1);
    expect(body.unknownCalls[0]?.errorCode).toBe('UPSTREAM_NO_USAGE');

    expect(body.budgetUsage.knownSpent).toBe(1.25);
    expect(body.budgetUsage.unknownGenerationCalls).toBe(1);
    expect(body.budgetUsage.state).toBe('unpriced_calls');

    const chapterCallRow = await sql<{ cost: string; cost_currency: string }[]>`
      SELECT cost::text, cost_currency FROM model_calls WHERE id = ${chapterCall}
    `;
    expect(chapterCallRow[0]?.cost).toBe('1.2500');
  });

  it('并发生成只允许一笔通过预算预留；嵌入费用不计入生成预算', async () => {
    await clearCalls();
    await setBudget(2.5);

    const results = await Promise.all([
      reserve(randomUUID(), 1000, 800),
      reserve(randomUUID(), 1000, 800),
    ]);
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (!rejected[0] || rejected[0].ok) throw new Error('缺少预算拒绝结果');
    expect(rejected[0].code).toBe('BUDGET_INSUFFICIENT');
    expect(accepted[0]?.ok && accepted[0].reservedCost).toBe(1.8);

    const reserved = await sql<{ count: number; total: string }[]>`
      SELECT count(*)::int AS count, COALESCE(SUM(reserved_cost), 0)::text AS total
      FROM model_calls
      WHERE workspace_id = ${workspaceId} AND reserved_cost IS NOT NULL AND status = 'streaming'
    `;
    expect(reserved[0]?.count).toBe(1);
    expect(reserved[0]?.total).toBe('1.8000');

    const withReservation = await report(owner);
    expect(withReservation.budgetUsage.knownSpent).toBe(0);
    expect(withReservation.budgetUsage.reserved).toBe(1.8);
    expect(withReservation.budgetUsage.remaining).toBe(0.7);
    expect(withReservation.budgetUsage.state).toBe('ok');

    await insertCall({
      purpose: 'embedding',
      cost: 100,
      actorId: null,
      providerId: embeddingProviderId,
      chapterId: null,
    });
    const afterEmbedding = await report(owner);
    expect(afterEmbedding.budgetUsage.knownSpent).toBe(0);
    expect(afterEmbedding.budgetUsage.remaining).toBe(0.7);

    const smallReservation = await reserve(randomUUID(), 100, 128);
    expect(smallReservation.ok).toBe(true);
    if (smallReservation.ok) expect(smallReservation.reservedCost).toBe(0.228);

    const preflightPass = await workspaceBudgetPreflight(workspaceId);
    expect(preflightPass.status).not.toBe('fail');

    await setBudget(0.01);
    const exhausted = await report(owner);
    expect(exhausted.budgetUsage.state).toBe('exhausted');
    const overBudget = await reserve(randomUUID(), 1000, 128);
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) expect(overBudget.code).toBe('BUDGET_INSUFFICIENT');

    const preflightFail = await workspaceBudgetPreflight(workspaceId);
    expect(preflightFail.status).toBe('fail');
    expect(preflightFail.detail).toContain('已耗尽');
  });

  it('有在途预留时不能直接切换预算币种，阻断调用不计入其他币种费用', async () => {
    await clearCalls();
    await setBudget(100, 'CNY');
    await insertCall({
      purpose: 'chapter_proposal',
      status: 'blocked',
      cost: 0,
      currency: 'USD',
      actorId: author.me.user.id,
      providerId: chatProviderId,
      chapterId,
      errorCode: 'BUDGET_INSUFFICIENT',
    });

    const reservation = await reserve(randomUUID());
    expect(reservation.ok).toBe(true);
    const withReservation = await report(owner);
    expect(withReservation.budgetUsage.otherCurrencyGenerationCalls).toBe(0);
    expect(withReservation.budgetUsage.reserved).toBe(1.8);

    const sameCurrency = await setBudget(90, 'CNY');
    expect(sameCurrency.monthlyLimit).toBe(90);
    const rejected = await call<ErrorBody>('PUT', '/api/billing/budget', billing, {
      monthlyLimit: 100,
      currency: 'USD',
    });
    expectError(rejected, 409, 'BUDGET_CALLS_IN_PROGRESS');

    await clearCalls();
    await setBudget(null);
  });

  it('未设置预算时不阻断生成且不伪造预留成本', async () => {
    await clearCalls();
    await setBudget(null);
    const result = await reserve(randomUUID(), 1_000_000, 800);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maxTokens).toBe(800);
      expect(result.reservedCost).toBeNull();
    }

    const body = await report(owner);
    expect(body.budget.monthlyLimit).toBeNull();
    expect(body.budgetUsage.state).toBe('not_configured');
    expect(body.budgetUsage.remaining).toBeNull();
    const rows = await sql<{ reserved_cost: string | null; reserved_currency: string | null }[]>`
      SELECT reserved_cost::text, reserved_currency FROM model_calls
      WHERE workspace_id = ${workspaceId} AND status = 'streaming'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reserved_cost).toBeNull();
    expect(rows[0]?.reserved_currency).toBeNull();
  });

  it('未配置预算时也会清算超时未完成的调用，不让中断永远显示在途', async () => {
    await clearCalls();
    await setBudget(null);

    const staleId = randomUUID();
    await sql`
      INSERT INTO model_calls (
        id, workspace_id, provider_id, model, status, actor_id, purpose, attempt_no, created_at
      )
      VALUES (
        ${staleId}, ${workspaceId}, ${chatProviderId}, 'stub-model', 'streaming',
        ${author.me.user.id}, 'chapter_proposal', 1, now() - interval '20 minutes'
      )
    `;

    const body = await report(owner);
    expect(body.budgetUsage.state).toBe('not_configured');
    const stale = await sql<{ status: string; error_code: string | null; completed_at: Date | null }[]>`
      SELECT status, error_code, completed_at FROM model_calls WHERE id = ${staleId}
    `;
    expect(stale[0]?.status).toBe('failed');
    expect(stale[0]?.error_code).toBe('CALL_STALE');
    expect(stale[0]?.completed_at).not.toBeNull();

    // 清算只针对超时行：刚预留的在途调用不能被改成失败。
    const fresh = await reserve(randomUUID(), 1000, 800);
    expect(fresh.ok).toBe(true);
    await report(owner);
    const streaming = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_calls
      WHERE workspace_id = ${workspaceId} AND status = 'streaming'
    `;
    expect(streaming[0]?.count).toBe(1);

    await clearCalls();
  });
});
