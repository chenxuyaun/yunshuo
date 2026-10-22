import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  AiProposalAttemptEvent,
  AiProposalView,
  MeResponse,
  ModelProviderView,
} from '@yunshuo/contracts';
import type { ChapterPlan } from '@yunshuo/domain';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeCost } from './services/ai-service.js';
import type { GenerationProvider } from './services/provider-service.js';

const TEST_TITLE = 'M3 运行时测试章节';
const TEST_NUMBER = 9902;

const plan: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

type StubAction =
  | { kind: 'sse'; content: string; promptTokens: number; completionTokens: number }
  | {
      kind: 'delayed-sse';
      content: string;
      promptTokens: number;
      completionTokens: number;
      delayMs: number;
    }
  | { kind: 'http'; status: number; message?: string }
  | { kind: 'partial'; content: string }
  | { kind: 'empty' };

interface StubRequest {
  provider: 'p1' | 'p2';
  authorization: string | null;
  body: { model?: string; messages?: unknown[]; stream_options?: unknown } | null;
}

interface ParsedEvent {
  event: string;
  data: unknown;
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M3 集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

describe('生成成本计算', () => {
  const base: GenerationProvider = {
    id: 'provider',
    name: '测试',
    baseUrl: 'http://127.0.0.1',
    model: 'model',
    apiKey: null,
    priority: 1,
    promptPricePer1m: 2,
    completionPricePer1m: 8,
    priceCurrency: 'CNY',
    lastTestStatus: null,
  };

  it('按每百万 token 价表计算并保留四位小数', () => {
    expect(computeCost(base, { promptTokens: 1000, completionTokens: 500 })).toEqual({
      cost: 0.006,
      currency: 'CNY',
    });
  });

  it('缺失价表或 token 用量时不伪造成本', () => {
    expect(
      computeCost({ ...base, promptPricePer1m: null }, { promptTokens: 1, completionTokens: 1 }),
    ).toBeNull();
    expect(computeCost(base, { promptTokens: null, completionTokens: 5 })).toBeNull();
    expect(computeCost(base, { promptTokens: 5, completionTokens: null })).toBeNull();
  });
});

const suite = dbAvailable ? describe : describe.skip;

suite('M3 持久化锁 / 重试 / 故障转移 / 成本', () => {
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;
  let primaryId: string;
  let backupId: string;
  let existingProviders: Array<{ id: string; is_enabled: boolean }> = [];

  const plans: Record<'p1' | 'p2', StubAction[]> = { p1: [], p2: [] };
  const counts: Record<'p1' | 'p2', number> = { p1: 0, p2: 0 };
  const requests: StubRequest[] = [];

  function setPlans(next: { p1: StubAction[]; p2?: StubAction[] }): void {
    plans.p1 = next.p1;
    plans.p2 = next.p2 ?? [];
    counts.p1 = 0;
    counts.p2 = 0;
    requests.length = 0;
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<{ status: number; body: T }> {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: owner.cookie },
      payload,
    });
    return { status: response.statusCode, body: response.json() as T };
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

  async function generate(): Promise<{
    status: number;
    events: ParsedEvent[];
    proposal: AiProposalView | null;
  }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapterId}/ai/proposals`,
      headers: { cookie: owner.cookie },
      payload: { mode: 'continue', targetWords: 300 },
    });
    const events = parseEvents(response.body);
    const done = events.find((event) => event.event === 'done');
    const proposal =
      done && done.data && typeof done.data === 'object'
        ? ((done.data as { proposal: AiProposalView }).proposal ?? null)
        : null;
    return { status: response.statusCode, events, proposal };
  }

  async function cleanupChapter(id: string): Promise<void> {
    await sql`DELETE FROM ai_generation_locks WHERE chapter_id = ${id}`;
    await sql`DELETE FROM model_calls WHERE chapter_id = ${id}`;
    await sql`DELETE FROM ai_proposals WHERE chapter_id = ${id}`;
    await sql`DELETE FROM commits WHERE chapter_id = ${id}`;
    await sql`DELETE FROM commit_intents WHERE chapter_id = ${id}`;
    await sql`DELETE FROM waivers WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_current WHERE chapter_id = ${id}`;
    await sql`UPDATE chapters SET current_version_id = NULL WHERE id = ${id}`;
    await sql`DELETE FROM index_status WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_metadata WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_versions WHERE chapter_id = ${id}`;
    await sql`DELETE FROM events WHERE aggregate_type = 'chapter' AND aggregate_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE object_id = ${id} OR metadata->>'chapterId' = ${id}`;
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${id}`;
    await sql`DELETE FROM chapters WHERE id = ${id}`;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    stub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const provider = (request.url ?? '').startsWith('/p1') ? 'p1' : 'p2';
        const index = counts[provider];
        counts[provider] = index + 1;
        requests.push({
          provider,
          authorization:
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : null,
          body: raw ? (JSON.parse(raw) as StubRequest['body']) : null,
        });

        const providerPlans = plans[provider];
        const action: StubAction =
          providerPlans[Math.min(index, providerPlans.length - 1)] ?? {
            kind: 'sse',
            content: '桩服务默认正文。',
            promptTokens: 10,
            completionTokens: 5,
          };

        if (action.kind === 'http') {
          response.writeHead(action.status, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { message: action.message ?? `stub ${action.status}` } }),
          );
          return;
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        if (action.kind === 'empty') {
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
        if (action.kind === 'partial') {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: action.content } }] })}\n\n`,
          );
          setTimeout(() => response.destroy(), 40);
          return;
        }
        if (action.kind === 'delayed-sse') {
          setTimeout(() => {
            if (response.destroyed) return;
            response.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: action.content } }] })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({
                choices: [],
                usage: {
                  prompt_tokens: action.promptTokens,
                  completion_tokens: action.completionTokens,
                },
              })}\n\n`,
            );
            response.write('data: [DONE]\n\n');
            response.end();
          }, action.delayMs);
          return;
        }
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: action.content } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: action.promptTokens,
              completion_tokens: action.completionTokens,
            },
          })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', resolve);
    });
    const address = stub.address();
    if (!address || typeof address === 'string') throw new Error('桩服务端口获取失败');
    stubPort = address.port;

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

    existingProviders = await sql<{ id: string; is_enabled: boolean }[]>`
      SELECT id, is_enabled FROM model_providers
      WHERE workspace_id = ${owner.me.workspace.id}
    `;
    await sql`
      UPDATE model_providers SET is_enabled = false
      WHERE workspace_id = ${owner.me.workspace.id}
    `;

    const createdPrimary = await call<ModelProviderView>('POST', '/api/model-providers', {
      name: 'M3 测试主服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/p1/v1`,
      model: 'stub-primary',
      apiKey: 'key-one',
      isEnabled: true,
      priority: 1,
      promptPricePer1m: 2,
      completionPricePer1m: 8,
      priceCurrency: 'CNY',
    });
    expect(createdPrimary.status).toBe(200);
    primaryId = createdPrimary.body.id;

    const createdBackup = await call<ModelProviderView>('POST', '/api/model-providers', {
      name: 'M3 测试备用服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/p2/v1`,
      model: 'stub-backup',
      apiKey: 'key-two',
      isEnabled: true,
      priority: 2,
      promptPricePer1m: 3,
      completionPricePer1m: 9,
      priceCurrency: 'CNY',
    });
    expect(createdBackup.status).toBe(200);
    backupId = createdBackup.body.id;

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
  });

  afterAll(async () => {
    if (chapterId) await cleanupChapter(chapterId);
    await sql`
      DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@demo.local')
    `;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login'
        AND actor_id IN (SELECT id FROM users WHERE email LIKE '%@demo.local')
    `;
    for (const id of [primaryId, backupId]) {
      if (id) await sql`DELETE FROM model_providers WHERE id = ${id}`;
    }
    for (const provider of existingProviders) {
      await sql`
        UPDATE model_providers SET is_enabled = ${provider.is_enabled}
        WHERE id = ${provider.id}
      `;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (app) await app.close();
    await closeDb();
  });

  it('同一服务商首次 500 后自动重试，并写入 token 成本', async () => {
    setPlans({
      p1: [
        { kind: 'http', status: 500 },
        { kind: 'sse', content: '雨声压低了长街，林默把最后一枚铜钉按进门槛。', promptTokens: 1000, completionTokens: 500 },
      ],
    });

    const result = await generate();
    expect(result.status).toBe(200);
    const retry = result.events.find((event) => event.event === 'attempt');
    expect(retry).toBeTruthy();
    const retryEvent = retry!.data as AiProposalAttemptEvent;
    expect(retryEvent.status).toBe('retrying');
    expect(retryEvent.nextProviderName).toBe('M3 测试主服务商');

    expect(result.proposal).not.toBeNull();
    const proposal = result.proposal!;
    expect(proposal.providerName).toBe('M3 测试主服务商');
    expect(proposal.attempts).toBe(2);
    expect(proposal.usage).toEqual({ promptTokens: 1000, completionTokens: 500 });
    expect(proposal.cost).toBe(0.006);
    expect(proposal.costCurrency).toBe('CNY');

    expect(requests.map((request) => request.provider)).toEqual(['p1', 'p1']);
    expect(requests[0]?.authorization).toBe('Bearer key-one');
    expect(requests[0]?.body?.model).toBe('stub-primary');
    expect(requests[0]?.body?.stream_options).toEqual({ include_usage: true });

    const calls = await sql<{ status: string; attempt_no: number; cost: string | null }[]>`
      SELECT status, attempt_no, cost FROM model_calls
      WHERE proposal_id = ${proposal.id}
      ORDER BY attempt_no ASC
    `;
    expect(calls.map((row) => row.status)).toEqual(['failed', 'ok']);
    expect(calls.map((row) => row.attempt_no)).toEqual([1, 2]);
    expect(calls[0]?.cost).toBeNull();
    expect(Number(calls[1]?.cost)).toBe(0.006);

    const locks = await sql`SELECT 1 FROM ai_generation_locks WHERE chapter_id = ${chapterId}`;
    expect(locks.length).toBe(0);

    const history = await call<AiProposalView[]>('GET', `/api/chapters/${chapterId}/ai/proposals`);
    expect(history.status).toBe(200);
    const saved = history.body.find((item) => item.id === proposal.id);
    expect(saved?.attempts).toBe(2);
    expect(saved?.cost).toBe(0.006);

    const generateAudit = await sql<{ actor_type: string; role: string; actor_id: string }[]>`
      SELECT actor_type, role, actor_id FROM audit_log
      WHERE action = 'ai.proposal.generate'
        AND metadata->>'proposalId' = ${proposal.id}
    `;
    expect(generateAudit).toHaveLength(1);
    expect(generateAudit[0]?.actor_type).toBe('human');
    expect(generateAudit[0]?.role).toBe(owner.me.role);
    expect(generateAudit[0]?.actor_id).toBe(owner.me.user.id);
  });

  it('服务商不支持 stream_options 时去掉该参数重试一次', async () => {
    setPlans({
      p1: [
        {
          kind: 'http',
          status: 400,
          message: 'Unrecognized request argument supplied: stream_options',
        },
        { kind: 'sse', content: '去掉用量参数后正常生成。', promptTokens: 1000, completionTokens: 500 },
      ],
    });

    const result = await generate();
    expect(result.status).toBe(200);
    const retry = result.events.find((event) => event.event === 'attempt');
    expect(retry).toBeTruthy();
    expect((retry!.data as AiProposalAttemptEvent).status).toBe('retrying');
    expect(requests.map((request) => request.provider)).toEqual(['p1', 'p1']);
    expect(requests[0]?.body?.stream_options).toEqual({ include_usage: true });
    expect(requests[1]?.body?.stream_options).toBeUndefined();
    expect(result.proposal?.attempts).toBe(2);
    expect(result.proposal?.cost).toBe(0.006);
  });

  it('主服务商 401 不原地重试，直接切换到备用服务商', async () => {
    setPlans({
      p1: [{ kind: 'http', status: 401 }],
      p2: [
        { kind: 'sse', content: '备用服务商接住了这一章，雨仍未停。', promptTokens: 2000, completionTokens: 400 },
      ],
    });

    const result = await generate();
    expect(result.status).toBe(200);
    const attempt = result.events.find((event) => event.event === 'attempt');
    const attemptEvent = attempt!.data as AiProposalAttemptEvent;
    expect(attemptEvent.status).toBe('failover');
    expect(attemptEvent.nextProviderName).toBe('M3 测试备用服务商');

    const proposal = result.proposal!;
    expect(proposal.providerName).toBe('M3 测试备用服务商');
    expect(proposal.model).toBe('stub-backup');
    expect(proposal.attempts).toBe(2);
    expect(proposal.cost).toBe(0.0096);
    expect(requests.map((request) => request.provider)).toEqual(['p1', 'p2']);
    expect(requests[1]?.authorization).toBe('Bearer key-two');
  });

  it('持久化锁阻止并发，并在结束后释放', async () => {
    setPlans({ p1: [] });
    await sql`
      INSERT INTO ai_generation_locks (
        chapter_id, workspace_id, user_id, proposal_id, acquired_at, expires_at
      )
      VALUES (
        ${chapterId}, ${owner.me.workspace.id}, ${owner.me.user.id}, NULL,
        now(), now() + interval '10 minutes'
      )
    `;
    try {
      const blocked = await call<{ error: { code: string; message: string } }>(
        'POST',
        `/api/chapters/${chapterId}/ai/proposals`,
        { mode: 'continue', targetWords: 300 },
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('AI_GENERATION_IN_PROGRESS');
      expect(blocked.body.error.message).toContain(owner.me.user.name);
      expect(requests.length).toBe(0);
    } finally {
      await sql`DELETE FROM ai_generation_locks WHERE chapter_id = ${chapterId}`;
    }

    setPlans({
      p1: [{ kind: 'sse', content: '锁释放后生成正常。', promptTokens: 100, completionTokens: 50 }],
    });
    const result = await generate();
    expect(result.proposal).not.toBeNull();
    const locks = await sql`SELECT 1 FROM ai_generation_locks WHERE chapter_id = ${chapterId}`;
    expect(locks.length).toBe(0);
  });

  it('并发生成请求只有一个取得锁', async () => {
    setPlans({
      p1: [
        {
          kind: 'delayed-sse',
          content: '并发请求中只有这一份正文被生成。',
          promptTokens: 120,
          completionTokens: 60,
          delayMs: 600,
        },
      ],
    });

    const firstPromise = generate();
    const waitUntil = Date.now() + 2000;
    while (requests.length === 0 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(requests.length).toBe(1);

    const second = await generate();
    expect(second.status).toBe(409);
    expect(second.proposal).toBeNull();

    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(first.proposal).not.toBeNull();
    expect(requests.length).toBe(1);

    const locks = await sql`SELECT 1 FROM ai_generation_locks WHERE chapter_id = ${chapterId}`;
    expect(locks.length).toBe(0);
  });

  it('过期锁回收旧提案，并允许新生成继续', async () => {
    const staleProposalId = randomUUID();
    const staleCallId = randomUUID();
    await sql`
      INSERT INTO ai_proposals (
        id, workspace_id, chapter_id, provider_name, model, mode, target_words,
        context, status, created_by
      )
      VALUES (
        ${staleProposalId}, ${owner.me.workspace.id}, ${chapterId},
        '已中断的服务商', 'stale-model', 'continue', 300, '{}'::jsonb, 'generating',
        ${owner.me.user.id}
      )
    `;
    await sql`
      INSERT INTO model_calls (
        id, workspace_id, provider_id, chapter_id, model, status, actor_id, purpose, proposal_id
      )
      VALUES (
        ${staleCallId}, ${owner.me.workspace.id}, NULL, ${chapterId}, 'stale-model',
        'streaming', ${owner.me.user.id}, 'chapter_proposal', ${staleProposalId}
      )
    `;
    await sql`
      INSERT INTO ai_generation_locks (
        chapter_id, workspace_id, user_id, proposal_id, acquired_at, expires_at
      )
      VALUES (
        ${chapterId}, ${owner.me.workspace.id}, ${owner.me.user.id}, ${staleProposalId},
        now() - interval '10 minutes', now() - interval '5 minutes'
      )
    `;

    setPlans({
      p1: [{ kind: 'sse', content: '新生成已经接管过期锁。', promptTokens: 200, completionTokens: 100 }],
    });
    const result = await generate();
    expect(result.proposal).not.toBeNull();

    const staleProposal = await sql<{ status: string; error_code: string | null }[]>`
      SELECT status, error_code FROM ai_proposals WHERE id = ${staleProposalId}
    `;
    expect(staleProposal[0]).toEqual({ status: 'failed', error_code: 'AI_ABANDONED' });
    const staleCall = await sql<{ status: string; error_code: string | null }[]>`
      SELECT status, error_code FROM model_calls WHERE id = ${staleCallId}
    `;
    expect(staleCall[0]).toEqual({ status: 'failed', error_code: 'AI_ABANDONED' });
  });

  it('已输出部分正文后失败不重试、不切换服务商', async () => {
    setPlans({
      p1: [{ kind: 'partial', content: '他只写到一半，' }],
      p2: [{ kind: 'sse', content: '备用服务商不应被调用。', promptTokens: 10, completionTokens: 5 }],
    });

    const result = await generate();
    expect(result.status).toBe(200);
    const attempt = result.events.find((event) => event.event === 'attempt');
    expect(attempt).toBeUndefined();
    const errorEvent = result.events.find((event) => event.event === 'error');
    expect(errorEvent).toBeTruthy();
    expect(result.proposal).toBeNull();
    expect(requests.map((request) => request.provider)).toEqual(['p1']);

    const proposals = await sql<
      { id: string; status: string; content: string; attempts: number; error_code: string | null }[]
    >`
      SELECT id, status, content, attempts, error_code FROM ai_proposals
      WHERE chapter_id = ${chapterId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    expect(proposals[0]?.status).toBe('failed');
    expect(proposals[0]?.content).toBe('他只写到一半，');
    expect(proposals[0]?.attempts).toBe(1);

    const failedAudit = await sql<{ actor_type: string; result: string }[]>`
      SELECT actor_type, result FROM audit_log
      WHERE action = 'ai.proposal.generate'
        AND metadata->>'proposalId' = ${proposals[0]!.id}
    `;
    expect(failedAudit).toHaveLength(1);
    expect(failedAudit[0]?.result).toBe('failure');
    expect(failedAudit[0]?.actor_type).toBe('human');
  });
});
