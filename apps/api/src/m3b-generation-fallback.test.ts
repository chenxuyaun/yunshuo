import { randomUUID } from 'node:crypto';
import type { ChapterPlan } from '@yunshuo/domain';
import type { MeResponse } from '@yunshuo/contracts';
import type { FastifyInstance } from 'fastify';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 只替换执行器：prepareProposal 与 releaseGenerationLock 仍是真实现，
// 这样兜底帧之外还能断言「异常后真锁被释放、提案行停在 generating」。
vi.mock('./services/ai-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/ai-service.js')>();
  return {
    ...actual,
    executeProposal: vi.fn(async () => {
      throw new Error('模拟生成器内部异常');
    }),
  };
});

import { executeProposal } from './services/ai-service.js';

const TEST_TITLE = 'M3 兜底帧测试章节';
const TEST_NUMBER = 9903;

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

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M3 兜底帧测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('AI 提案路由的兜底帧', () => {
  let app: FastifyInstance;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;
  let providerId: string;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    // runner 与路由共用 ai-service；执行器替身抛错时别让后台作业也领到它。
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

    // 上一轮中断可能把这个固定章号留在演示作品里，先按标题清掉再插入。
    const stale = await sql<{ id: string }[]>`
      SELECT id FROM chapters WHERE title = ${TEST_TITLE}
    `;
    for (const row of stale) await cleanupChapter(row.id);

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
    // 直接落一行启用中的 chat 服务商：执行器已换成替身，凭据与端点都不参与本次请求。
    providerId = randomUUID();
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, is_enabled, priority, purpose
      )
      VALUES (
        ${providerId}, ${owner.me.workspace.id}, '兜底帧测试服务商',
        'http://127.0.0.1:1/v1', 'stub-fallback', true, 1, 'chat'
      )
    `;
  });

  afterAll(async () => {
    if (chapterId) await cleanupChapter(chapterId);
    // beforeAll 中途失败时 providerId 可能没赋上，别再拿 undefined 去删。
    if (providerId) await sql`DELETE FROM model_providers WHERE id = ${providerId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${owner.me.user.id}`;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login' AND actor_id = ${owner.me.user.id}
    `;
    await closeDb();
  });

  it('执行器抛出非 AppError 时回兜底帧，锁已释放而提案行停在 generating', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/ai/proposals`,
      headers: { cookie: owner.cookie },
      payload: { mode: 'continue', targetWords: 300 },
    });

    // 路由先 hijack 再执行，异常只能降级成流内错误帧，HTTP 状态停在 200。
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const events = parseEvents(response.body);
    const meta = events.find((event) => event.event === 'meta');
    expect(meta).toBeDefined();
    const proposalId = (meta!.data as { proposalId: string }).proposalId;
    expect(proposalId).toMatch(/^[0-9a-f-]{36}$/);

    const error = events.find((event) => event.event === 'error');
    expect(error).toBeDefined();
    expect(error!.data).toEqual({
      code: 'AI_GENERATION_FAILED',
      message: '生成失败，提案未写入。',
    });
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.some((event) => event.event === 'delta')).toBe(false);

    // 执行器确实被调用过一次，且拿到的是本章与一个尚未中止的信号。
    const calls = vi.mocked(executeProposal).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].chapterId).toBe(chapterId);
    expect(calls[0]![0].proposalId).toBe(proposalId);
    expect(calls[0]![2]).toBeInstanceOf(AbortSignal);
    expect(calls[0]![2].aborted).toBe(false);

    // 兜底路径释放真锁：同一章可以立即再次发起生成。
    const locks = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ai_generation_locks WHERE chapter_id = ${chapterId}
    `;
    expect(locks[0]!.n).toBe('0');

    // 但提案行没有被收尾：当前实现只放锁、不改状态，后续生成会把它标成 AI_ABANDONED。
    const proposals = await sql<{ status: string; error_code: string | null }[]>`
      SELECT status, error_code FROM ai_proposals WHERE id = ${proposalId}
    `;
    expect(proposals).toEqual([{ status: 'generating', error_code: null }]);
  });
});
