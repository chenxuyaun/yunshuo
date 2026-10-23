import { randomUUID } from 'node:crypto';
import type { ChapterPlan } from '@yunshuo/domain';
import type { MeResponse } from '@yunshuo/contracts';
import type { FastifyInstance } from 'fastify';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TITLE = 'M2 归档章节租约测试';
const TEST_NUMBER = 9904;

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
    console.warn('M2 归档章节测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('归档章节的租约申请', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;

  async function cleanupChapter(id: string): Promise<void> {
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

    // 没有归档章节的 HTTP 入口：这条状态只能由历史数据或运维直接改库留下，
    // 所以用 SQL 造出 archived 行，测的就是界面之外那类行撞上租约申请时的回答。
    chapterId = randomUUID();
    await sql`
      INSERT INTO chapters (
        id, work_id, volume_id, number, title, status, plan
      )
      VALUES (
        ${chapterId}, ${location.work_id}, ${location.volume_id}, ${TEST_NUMBER},
        ${TEST_TITLE}, 'archived', ${sql.json(jsonValue(plan))}
      )
    `;
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

  it('已归档章节申请租约：409 CHAPTER_ARCHIVED，且不写租约行', async () => {
    const status = await sql<{ status: string }[]>`
      SELECT status FROM chapters WHERE id = ${chapterId}
    `;
    expect(status).toEqual([{ status: 'archived' }]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/lease`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe('CHAPTER_ARCHIVED');
    expect(body.error.message).toBe('已归档章节不能编辑');

    const leases = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM chapter_leases WHERE chapter_id = ${chapterId}
    `;
    expect(leases[0]!.n).toBe('0');
  });
});
