import { randomUUID } from 'node:crypto';
import type { ChapterPlan } from '@yunshuo/domain';
import type { MeResponse } from '@yunshuo/contracts';
import type { FastifyInstance } from 'fastify';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TITLE = 'M3 预算币种守卫测试章节';
const TEST_NUMBER = 9907;
const PROVIDER_NAME = 'M3 预算币种测试服务商';
const CODE = 'BUDGET_GUARD_UNAVAILABLE';
const MESSAGE = `服务商「${PROVIDER_NAME}」计价币种 CNY 与工作区预算币种 USD 不一致；本次未发起调用。`;

const plan: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

interface ParsedEvent {
  event: string;
  data: unknown;
}

function parseEvents(body: string): ParsedEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      let event = 'message';
      const data: string[] = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length === 0) return null;
      try {
        return { event, data: JSON.parse(data.join('\n')) as unknown };
      } catch {
        return null;
      }
    })
    .filter((item): item is ParsedEvent => item !== null);
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M3 预算守卫测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('生成前置的工作区预算币种守卫', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;
  let providerId: string;

  async function cleanupChapter(id: string): Promise<void> {
    await sql`DELETE FROM ai_generation_locks WHERE chapter_id = ${id}`;
    await sql`DELETE FROM model_calls WHERE chapter_id = ${id}`;
    await sql`DELETE FROM ai_proposals WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM events WHERE aggregate_type = 'chapter' AND aggregate_id = ${id}`;
    await sql`
      DELETE FROM audit_log
      WHERE object_id = ${id} OR metadata->>'chapterId' = ${id}
    `;
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${id}`;
    await sql`DELETE FROM chapters WHERE id = ${id}`;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    // runner 与路由共用服务层；本章只测手动生成，不要让后台作业也领走这类服务商。
    process.env.AUTOMATION_RUNNER = '0';
    const { buildServer } = await import('./server.js');
    app = await buildServer();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@demo.local' },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!rawCookie) throw new Error('登录未返回会话 Cookie');
    owner = {
      cookie: rawCookie.split(';')[0]!,
      me: login.json() as MeResponse,
    };

    const stale = await sql<{ id: string }[]>`
      SELECT id FROM chapters WHERE title = ${TEST_TITLE}
    `;
    for (const row of stale) await cleanupChapter(row.id);
    // 每轮自己造预算再删掉：测试库其余用例都假定演示工作区没有预算行。
    await sql`DELETE FROM workspace_budgets WHERE workspace_id = ${owner.me.workspace.id}`;

    const locationRows = await sql<{ work_id: string; volume_id: string }[]>`
      SELECT wo.id AS work_id, v.id AS volume_id
      FROM works wo
      JOIN volumes v ON v.work_id = wo.id
      JOIN workspaces ws ON ws.id = wo.workspace_id
      JOIN memberships m ON m.workspace_id = ws.id
      JOIN users u ON u.id = m.user_id
      WHERE u.email = 'owner@demo.local'
      ORDER BY v.number ASC
      LIMIT 1
    `;
    const location = locationRows[0];
    if (!location) throw new Error('找不到演示作品/卷，请先执行 pnpm db:seed');

    chapterId = randomUUID();
    await sql`
      INSERT INTO chapters (
        id, work_id, volume_id, number, title, status, plan
      )
      VALUES (
        ${chapterId}, ${location.work_id}, ${location.volume_id}, ${TEST_NUMBER},
        ${TEST_TITLE}, 'writing', ${sql.json(jsonValue(plan))}
      )
    `;
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, expires_at)
      VALUES (${chapterId}, ${owner.me.user.id}, ${new Date(Date.now() + 60 * 60_000)})
    `;

    // 服务商与预算都直接落库：它们的 CRUD 已有独立用例，这条只关心两者币种冲突时的生成前置。
    providerId = randomUUID();
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, is_enabled, priority, purpose,
        prompt_price_per_1m, completion_price_per_1m, price_currency
      )
      VALUES (
        ${providerId}, ${owner.me.workspace.id}, ${PROVIDER_NAME},
        'http://127.0.0.1:1/v1', 'stub-budget', true, 1, 'chat', 2, 8, 'CNY'
      )
    `;
    await sql`
      INSERT INTO workspace_budgets (workspace_id, monthly_limit, currency, updated_by)
      VALUES (${owner.me.workspace.id}, 100, 'USD', ${owner.me.user.id})
    `;
  });

  afterAll(async () => {
    if (chapterId) await cleanupChapter(chapterId);
    await sql`DELETE FROM workspace_budgets WHERE workspace_id = ${owner.me.workspace.id}`;
    await sql`DELETE FROM model_providers WHERE id = ${providerId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${owner.me.user.id}`;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login' AND actor_id = ${owner.me.user.id}
    `;
    await closeAppAndDb();
  });

  async function closeAppAndDb(): Promise<void> {
    if (app) await app.close();
    await closeDb();
  }

  it('预算币种与服务商价表不一致：生成在调用前被阻断，SSE 归因该码且一行费用都不记', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/ai/proposals`,
      headers: { cookie: owner.cookie },
      payload: { mode: 'continue', targetWords: 300 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const events = parseEvents(response.body);
    const meta = events.find((event) => event.event === 'meta');
    expect(meta).toBeDefined();
    const proposalId = (meta!.data as { proposalId: string }).proposalId;
    expect(proposalId).toMatch(/^[0-9a-f-]{36}$/);

    const error = events.find((event) => event.event === 'error');
    expect(error).toBeDefined();
    expect(error!.data).toEqual({ code: CODE, message: MESSAGE });
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.some((event) => event.event === 'delta')).toBe(false);

    const proposals = await sql<
      {
        status: string;
        error_code: string | null;
        error_message: string | null;
        attempts: number;
        provider_id: string | null;
      }[]
    >`
      SELECT status, error_code, error_message, attempts, provider_id
      FROM ai_proposals WHERE id = ${proposalId}
    `;
    expect(proposals).toEqual([
      {
        status: 'failed',
        error_code: CODE,
        error_message: MESSAGE,
        attempts: 1,
        provider_id: providerId,
      },
    ]);

    // 阻断行状态是 blocked 而不是 failed：它没有真的发过请求，也没有任何 token 用量。
    const calls = await sql<
      {
        status: string;
        error_code: string | null;
        cost: string | null;
        cost_currency: string | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        attempt_no: number;
      }[]
    >`
      SELECT status, error_code, cost, cost_currency, prompt_tokens, completion_tokens, attempt_no
      FROM model_calls WHERE chapter_id = ${chapterId}
      ORDER BY attempt_no ASC
    `;
    expect(calls).toEqual([
      {
        status: 'blocked',
        error_code: CODE,
        cost: '0.0000',
        cost_currency: 'CNY',
        prompt_tokens: null,
        completion_tokens: null,
        attempt_no: 1,
      },
    ]);

    const locks = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ai_generation_locks WHERE chapter_id = ${chapterId}
    `;
    expect(locks[0]!.n).toBe('0');

    // 预算本身一分未动：阻断发生在预扣之前，不该留下 reserved 或已花费。
    const budgets = await sql<{ monthly_limit: string; currency: string }[]>`
      SELECT monthly_limit::text, currency FROM workspace_budgets
      WHERE workspace_id = ${owner.me.workspace.id}
    `;
    expect(budgets).toEqual([{ monthly_limit: '100.0000', currency: 'USD' }]);

    const audits = await sql<{ result: string; metadata: { errorCode?: string } }[]>`
      SELECT result, metadata FROM audit_log
      WHERE action = 'ai.proposal.generate' AND object_id = ${chapterId}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toBe('failure');
    expect(audits[0]!.metadata.errorCode).toBe(CODE);
  });

  it('服务商价表不完整：同样在调用前阻断，文案指出价表而不是币种', async () => {
    const incompleteMessage = `服务商「${PROVIDER_NAME}」价表不完整，无法按工作区预算限制输出；本次未发起调用。`;
    await sql`
      UPDATE model_providers
      SET prompt_price_per_1m = NULL, completion_price_per_1m = NULL
      WHERE id = ${providerId}
    `;

    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/ai/proposals`,
      headers: { cookie: owner.cookie },
      payload: { mode: 'continue', targetWords: 300 },
    });
    expect(response.statusCode).toBe(200);
    const events = parseEvents(response.body);
    const error = events.find((event) => event.event === 'error');
    expect(error).toBeDefined();
    expect(error!.data).toEqual({ code: CODE, message: incompleteMessage });
    expect(events.some((event) => event.event === 'done')).toBe(false);

    const proposalId = (events.find((event) => event.event === 'meta')!.data as {
      proposalId: string;
    }).proposalId;
    const calls = await sql<
      { status: string; error_code: string | null; cost: string | null }[]
    >`
      SELECT status, error_code, cost
      FROM model_calls WHERE proposal_id = ${proposalId}
    `;
    expect(calls).toEqual([{ status: 'blocked', error_code: CODE, cost: '0.0000' }]);

    // 价表检查排在币种检查之前：同一个 USD 预算下先把"价表不完整"说出来。
    const proposals = await sql<{ error_message: string | null }[]>`
      SELECT error_message FROM ai_proposals WHERE id = ${proposalId}
    `;
    expect(proposals[0]!.error_message).toBe(incompleteMessage);
  });
});
