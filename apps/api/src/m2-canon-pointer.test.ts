import { randomUUID } from 'node:crypto';
import type { MeResponse } from '@yunshuo/contracts';
import type { FastifyInstance } from 'fastify';
import { closeDb, sql } from '@yunshuo/db';
import { countWords, sha256 } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TARGET_TITLE = 'M2 正典指针测试章节';
const TARGET_NUMBER = 9905;
const SOURCE_TITLE = 'M2 正典来源测试章节';
const SOURCE_NUMBER = 9906;
const SOURCE_CONTENT = '这是另一章的正典正文，被错误地指向本章时不能拿来开修订。';

interface ErrorBody {
  error: { code: string; message: string };
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M2 正典指针测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('正典指针指向别章版本', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; me: MeResponse };
  let targetId: string;
  let sourceId: string;
  let sourceVersionId: string;

  async function cleanupChapter(id: string): Promise<void> {
    await sql`
      DELETE FROM draft_revisions
      WHERE branch_id IN (SELECT id FROM draft_branches WHERE chapter_id = ${id})
    `;
    await sql`DELETE FROM draft_branches WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM events WHERE aggregate_type = 'chapter' AND aggregate_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE object_id = ${id} OR metadata->>'chapterId' = ${id}`;
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${id}`;
    await sql`UPDATE chapters SET current_version_id = NULL WHERE id = ${id}`;
    await sql`DELETE FROM canon_versions WHERE chapter_id = ${id}`;
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
      SELECT id FROM chapters WHERE title IN (${TARGET_TITLE}, ${SOURCE_TITLE})
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

    // FK 只要求指针指向「某个」正典版本，不要求同章；跨章指针能合法落库，
    // 服务层按 chapter_id 过滤后查不到，才轮到 CANON_VERSION_MISSING。
    sourceId = randomUUID();
    targetId = randomUUID();
    sourceVersionId = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES (${sourceId}, ${location.work_id}, ${location.volume_id}, ${SOURCE_NUMBER}, ${SOURCE_TITLE}, 'canon')
    `;
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id
      )
      VALUES (
        ${sourceVersionId}, ${sourceId}, 1, ${SOURCE_CONTENT},
        ${sha256(SOURCE_CONTENT)}, ${countWords(SOURCE_CONTENT)},
        NULL, 'import', ${owner.me.user.id}
      )
    `;
    await sql`
      UPDATE chapters SET current_version_id = ${sourceVersionId} WHERE id = ${sourceId}
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, current_version_id)
      VALUES (
        ${targetId}, ${location.work_id}, ${location.volume_id}, ${TARGET_NUMBER},
        ${TARGET_TITLE}, 'canon', ${sourceVersionId}
      )
    `;
  });

  afterAll(async () => {
    if (targetId) await cleanupChapter(targetId);
    if (sourceId) await cleanupChapter(sourceId);
    await sql`DELETE FROM sessions WHERE user_id = ${owner.me.user.id}`;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login' AND actor_id = ${owner.me.user.id}
    `;
    if (app) await app.close();
    await closeDb();
  });

  it('本章指针指向别章正典版本：开始修订回 409 CANON_VERSION_MISSING，不留租约与草稿', async () => {
    const before = await sql<{ status: string; current_version_id: string | null }[]>`
      SELECT status, current_version_id FROM chapters WHERE id = ${targetId}
    `;
    expect(before).toEqual([{ status: 'canon', current_version_id: sourceVersionId }]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${targetId}/revision`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as ErrorBody;
    expect(body.error.code).toBe('CANON_VERSION_MISSING');
    expect(body.error.message).toBe('当前正典版本不存在');

    const after = await sql<{ status: string; current_version_id: string | null }[]>`
      SELECT status, current_version_id FROM chapters WHERE id = ${targetId}
    `;
    expect(after).toEqual([{ status: 'canon', current_version_id: sourceVersionId }]);

    const leases = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM chapter_leases WHERE chapter_id = ${targetId}
    `;
    expect(leases[0]!.n).toBe('0');
    const branches = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM draft_branches WHERE chapter_id = ${targetId}
    `;
    expect(branches[0]!.n).toBe('0');

    const source = await sql<{ status: string; current_version_id: string | null }[]>`
      SELECT status, current_version_id FROM chapters WHERE id = ${sourceId}
    `;
    expect(source).toEqual([{ status: 'canon', current_version_id: sourceVersionId }]);
  });
});
