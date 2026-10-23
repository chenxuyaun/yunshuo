import { randomUUID } from 'node:crypto';
import type { ChapterPlan } from '@yunshuo/domain';
import type { MeResponse } from '@yunshuo/contracts';
import type { FastifyInstance } from 'fastify';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 门禁规则集是全局种子数据。真实删掉它会让所有依赖 seed 的用例一起红，
// 这里只把装载器替身为 null，模拟"新库尚未灌入规则集"的部署形态；
// 其余 chapter-data 函数（章节、租约、草稿）保持真实现。
vi.mock('./services/chapter-data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/chapter-data.js')>();
  return { ...actual, loadRuleset: async () => null };
});

const TEST_TITLE = 'M2 规则集缺失门禁测试';
const TEST_NUMBER = 9908;
const CONTENT = '夜色压下来的时候，林默还站在封印阵的边上，他没有退。';

const plan: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

interface ErrorBody {
  error: { code: string; message: string };
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M2 规则集缺失测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('没有可用门禁规则集时的评估入口', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;

  async function cleanupChapter(id: string): Promise<void> {
    await sql`DELETE FROM gate_evaluations WHERE chapter_id = ${id}`;
    await sql`DELETE FROM draft_branches WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM events WHERE aggregate_type = 'chapter' AND aggregate_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE object_id = ${id} OR metadata->>'chapterId' = ${id}`;
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${id}`;
    await sql`DELETE FROM chapters WHERE id = ${id}`;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
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

    const lease = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/lease`,
      headers: { cookie: owner.cookie },
    });
    expect(lease.statusCode).toBe(200);
    const draft = await app.inject({
      method: 'PUT',
      url: `/api/chapters/${chapterId}/draft`,
      headers: { cookie: owner.cookie },
      payload: { content: CONTENT },
    });
    expect(draft.statusCode).toBe(200);
  });

  afterAll(async () => {
    if (chapterId) await cleanupChapter(chapterId);
    await sql`DELETE FROM sessions WHERE user_id = ${owner.me.user.id}`;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login' AND actor_id = ${owner.me.user.id}
    `;
    if (app) await app.close();
    await closeDb();
  });

  it('规则集装载器返回 null：409 RULESET_MISSING，评估与提交流水都不落库', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/gates`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe('RULESET_MISSING');
    expect(body.error.message).toBe('没有可用的门禁规则集');

    const evaluations = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM gate_evaluations WHERE chapter_id = ${chapterId}
    `;
    expect(evaluations[0]!.n).toBe('0');
  });
});
