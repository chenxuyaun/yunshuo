import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  AiProposalAttemptEvent,
  AiProposalView,
  MeResponse,
  ModelProviderListResponse,
  ModelProviderView,
} from '@yunshuo/contracts';
import type { ChapterPlan } from '@yunshuo/domain';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import {
  computeCost,
  executeProposal,
  prepareProposal,
  releaseGenerationLock,
} from './services/ai-service.js';
import {
  connectionFailureDetail,
  redactSecret,
  type GenerationProvider,
} from './services/provider-service.js';

const TEST_TITLE = 'M3 运行时测试章节';
const TEST_NUMBER = 9902;
// 本地桩服务不校验密钥，值只为区分"这一次运行用的是哪一把"，按运行期生成。
const STUB_KEY_PRIMARY = `primary-key-${randomUUID().slice(0, 8)}`;
const STUB_KEY_BACKUP = `backup-key-${randomUUID().slice(0, 8)}`;
const REDACT_SAMPLE = `sk-secret-${randomUUID().slice(0, 8)}`;

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
  | { kind: 'non-json'; raw: string }
  | { kind: 'upstream-error'; message: string; code: string }
  | { kind: 'sse-upstream-error'; message: string; code: string }
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

describe('端点错误摘要脱敏与底层原因提取', () => {
  it('脱敏替换所有出现，但不处理空密钥与过短密钥', () => {
    expect(redactSecret(`HTTP 500 · Bearer ${REDACT_SAMPLE} 与 ${REDACT_SAMPLE} 重复`, REDACT_SAMPLE)).toBe(
      'HTTP 500 · Bearer •••• 与 •••• 重复',
    );
    // 空密钥与 null 原样返回：没有可替换的对象时不能凭空打码
    expect(redactSecret('HTTP 500 · no auth', null)).toBe('HTTP 500 · no auth');
    expect(redactSecret('HTTP 500 · no auth', '')).toBe('HTTP 500 · no auth');
    // 短于 4 字符的密钥原样保留：这是实现里写死的下限，界面上的密钥最短长度比它长，
    // 真要放开这个下限必须同时改掉这条断言，否则等于默默取消脱敏。
    expect(redactSecret('HTTP 500 · key=ab', 'ab')).toBe('HTTP 500 · key=ab');
    expect(redactSecret('HTTP 500 · key=abc', 'abc')).toBe('HTTP 500 · key=abc');
    expect(redactSecret('HTTP 500 · key=abcd', 'abcd')).toBe('HTTP 500 · key=••••');
  });

  it('连接失败摘要优先取 cause.code，并把长文本截到 200 字符加省略号', () => {
    // Node 的 fetch 把底层错误挂在 cause 上，code 才是可诊断的原因码
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(connectionFailureDetail(wrapped)).toBe('ECONNREFUSED');
    // 没有 code 时退回 cause.message，再退回 error.message
    const messageOnly = Object.assign(new Error('fetch failed'), {
      cause: new Error('socket hang up'),
    });
    expect(connectionFailureDetail(messageOnly)).toBe('socket hang up');
    expect(connectionFailureDetail(new Error('read ECONNRESET'))).toBe('read ECONNRESET');
    // 非 Error 也要给出可读摘要，且三种截断口径一致
    expect(connectionFailureDetail('plain string')).toBe('plain string');
    expect(connectionFailureDetail('x'.repeat(300))).toBe(`${'x'.repeat(200)}…`);
    expect(connectionFailureDetail(new Error('y'.repeat(300)))).toBe(`${'y'.repeat(200)}…`);
    expect(connectionFailureDetail({})).toBe('[object Object]');
  });
});

const suite = dbAvailable ? describe : describe.skip;

interface ErrorResponseBody {
  error: { code: string; message: string };
}

function expectError(
  response: { status: number; body: ErrorResponseBody },
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
}

suite('M3 持久化锁 / 重试 / 故障转移 / 成本', () => {
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let owner: { cookie: string; me: MeResponse };
  let chapterId: string;
  let primaryId: string;
  let backupId: string;
  // 用例中途建的服务商也要登记在这里：删行不会带走它的 create/delete 审计。
  const tempProviderIds: string[] = [];
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
    // 草稿是 branch + revision 两张表；早先的清理没带它们，一旦有用例存过草稿就会漏行。
    await sql`
      DELETE FROM draft_revisions
      WHERE branch_id IN (SELECT id FROM draft_branches WHERE chapter_id = ${id})
    `;
    await sql`DELETE FROM draft_branches WHERE chapter_id = ${id}`;
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

        // 200 但不是 SSE 流：一句走「解析不出 JSON」，一句走「JSON 里是上游错误」。
        if (action.kind === 'non-json' || action.kind === 'upstream-error') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            action.kind === 'non-json'
              ? action.raw
              : JSON.stringify({ error: { code: action.code, message: action.message } }),
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
        // 真·流式中途报错：错误事件和正文事件混在同一条 SSE 里，走的是另一处判定分支。
        if (action.kind === 'sse-upstream-error') {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '前半段正文。' } }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ error: { code: action.code, message: action.message } })}\n\n`,
          );
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
      apiKey: STUB_KEY_PRIMARY,
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
      apiKey: STUB_KEY_BACKUP,
      isEnabled: true,
      priority: 2,
      promptPricePer1m: 3,
      completionPricePer1m: 9,
      priceCurrency: 'CNY',
    });
    expect(createdBackup.status).toBe(200);
    backupId = createdBackup.body.id;
    tempProviderIds.push(primaryId, backupId);

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
    // 删 model_providers 行不会带走它们的 create/delete 审计：这些服务商建在演示工作区里，
    // 不清就是每次全量运行给共享库留下永久增长、且指向已消失对象的审计。
    const leftoverProviderAudits: string[] = [];
    for (const id of tempProviderIds) {
      await sql`DELETE FROM model_providers WHERE id = ${id}`;
      await sql`
        DELETE FROM audit_log
        WHERE action IN ('model_provider.create', 'model_provider.delete')
          AND object_id = ${id}
      `;
      const counted = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM audit_log
        WHERE action IN ('model_provider.create', 'model_provider.delete')
          AND object_id = ${id}
      `;
      // 删完还数得到，说明清理的谓词没命中真实行（比如 object_id 根本不是服务商 id）。
      leftoverProviderAudits.push(counted[0]!.n);
    }
    // 先取值、最后断言：断言若放在这里失败，会跳过后面的服务商开关恢复和进程关闭。
    for (const provider of existingProviders) {
      await sql`
        UPDATE model_providers SET is_enabled = ${provider.is_enabled}
        WHERE id = ${provider.id}
      `;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (app) await app.close();
    await closeDb();
    expect(leftoverProviderAudits).toEqual(tempProviderIds.map(() => '0'));
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
    expect(requests[0]?.authorization).toBe(`Bearer ${STUB_KEY_PRIMARY}`);
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
    expect(requests[1]?.authorization).toBe(`Bearer ${STUB_KEY_BACKUP}`);
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

  it(
    '加厚模式的草稿前置排在服务商检查之前；一个可用服务商都没有时不发起任何请求',
    async () => {
      async function trace() {
        const rows = await sql<
          { drafts: string; proposals: string; calls: string; locks: string; audits: string }[]
        >`
          SELECT
            (SELECT count(*) FROM draft_revisions dr
               JOIN draft_branches db ON db.id = dr.branch_id
              WHERE db.chapter_id = ${chapterId})::text AS drafts,
            (SELECT count(*) FROM ai_proposals WHERE chapter_id = ${chapterId})::text AS proposals,
            (SELECT count(*) FROM model_calls WHERE chapter_id = ${chapterId})::text AS calls,
            (SELECT count(*) FROM ai_generation_locks WHERE chapter_id = ${chapterId})::text AS locks,
            (SELECT count(*) FROM audit_log
              WHERE object_id = ${chapterId} OR metadata->>'chapterId' = ${chapterId})::text AS audits
        `;
        return rows[0]!;
      }

      async function propose(mode: 'continue' | 'expand') {
        return call<ErrorResponseBody>('POST', `/api/chapters/${chapterId}/ai/proposals`, {
          mode,
          targetWords: 300,
        });
      }

      async function setChatEnabled(ids: string[], isEnabled: boolean): Promise<void> {
        // 夹具用 SQL 直改开关，不走 PATCH 端点：那会给共享库留下 model_provider.update 审计，
        // 把残留对账和「这次拒绝不留痕迹」的计数一起搞脏。
        for (const id of ids) {
          await sql`UPDATE model_providers SET is_enabled = ${isEnabled} WHERE id = ${id}`;
        }
      }

      setPlans({ p1: [{ kind: 'sse', content: '不应被调用。', promptTokens: 10, completionTokens: 5 }] });
      // 前面 6 条用例已经在这同一章上生成过，基线不是 0；这一族只问「这次拒绝多留了什么」。
      const start = await trace();
      const plus = (from: Awaited<ReturnType<typeof trace>>, key: 'drafts' | 'proposals' | 'calls' | 'locks' | 'audits', n: number): string =>
        String(Number(from[key]) + n);

      // ① 加厚没有草稿：服务商此刻是启用的，所以这一句只可能来自草稿前置。
      const noDraft = await propose('expand');
      expect(noDraft.status).toBe(409);
      expect(noDraft.body.error.code).toBe('NO_DRAFT_FOR_EXPAND');
      expect(noDraft.body.error.message).toBe('加厚模式需要先保存一份草稿');
      expect(await trace()).toEqual(start);

      await setChatEnabled([primaryId, backupId], false);

      // ② 同一个夹具状态换个 mode 就换一句答案，钉住「草稿前置 → 服务商装载」的先后。
      const noProvider = await propose('continue');
      expect(noProvider.status).toBe(409);
      expect(noProvider.body.error.code).toBe('NO_MODEL_PROVIDER');
      expect(noProvider.body.error.message).toContain('没有已启用的模型服务商');
      const stillNoDraft = await propose('expand');
      expect(stillNoDraft.body.error.code).toBe('NO_DRAFT_FOR_EXPAND');
      expect(await trace()).toEqual(start);

      // ③ 超长草稿：契约只管 min(1)、没有上限，所以 8001 字这一支从 HTTP 真能走到。
      const longDraft = '铜'.repeat(8001);
      const saved = await call<{ contentHash: string }>('PUT', `/api/chapters/${chapterId}/draft`, {
        content: longDraft,
      });
      expect(saved.status).toBe(200);
      const withDraft = await trace();
      expect(withDraft).toEqual({ ...start, drafts: plus(start, 'drafts', 1) });

      const tooLong = await propose('expand');
      expect(tooLong.status).toBe(409);
      expect(tooLong.body.error.code).toBe('DRAFT_TOO_LONG_FOR_EXPAND');
      expect(tooLong.body.error.message).toContain('8000 字以内');

      // 四次拒绝一个字节都不该多留：没建提案、没占锁、没花一次调用、没写一条审计，桩服务也没被请求。
      expect(await trace()).toEqual(withDraft);
      expect(requests).toHaveLength(0);

      // ④ 正控制：把主服务商打开，同一条 continue 请求就走通——上一句 409 是开关造成的，不是夹具坏了。
      await setChatEnabled([primaryId], true);
      const beforeRun = await trace();
      const ok = await generate();
      expect(ok.status).toBe(200);
      expect(ok.events.some((event) => event.event === 'done')).toBe(true);
      expect(requests.map((request) => request.provider)).toEqual(['p1']);

      // 走通的那一次只多一条提案、一次调用、一条审计，锁照旧释放。
      const afterRun = await trace();
      expect(afterRun).toEqual({
        ...beforeRun,
        proposals: plus(beforeRun, 'proposals', 1),
        calls: plus(beforeRun, 'calls', 1),
        audits: plus(beforeRun, 'audits', 1),
      });
    },
  );

  it(
    '有调用记录的服务商删不掉、没有密钥的服务商复用不了，两句都在归属检查之后',
    async () => {
      const ghost = randomUUID();
      const callsOfPrimary = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM model_calls WHERE provider_id = ${primaryId}
      `;
      expect(Number(callsOfPrimary[0]!.count)).toBeGreaterThan(0);

      const providerCount = async (): Promise<string> =>
        (await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM model_providers
          WHERE workspace_id = ${owner.me.workspace.id}
        `)[0]!.count;
      const deleteAudits = async (id: string): Promise<string> =>
        (await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM audit_log
          WHERE action = 'model_provider.delete' AND object_id = ${id}
        `)[0]!.count;

      // ① 幽灵 id 先撞归属闸，压根走不到「有没有调用记录」那一步。
      const missing = await call<ErrorResponseBody>('DELETE', `/api/model-providers/${ghost}`);
      expectError(missing, 404, 'PROVIDER_NOT_FOUND');

      // ② 真删不掉的才是这一句：FK 是 RESTRICT，摘掉守卫就变成 500 的外键崩溃，
      //    所以这条守的是「界面拿到能读的 409 + 请改为停用」，不是权限洞。
      const inUse = await call<ErrorResponseBody>('DELETE', `/api/model-providers/${primaryId}`);
      expectError(inUse, 409, 'PROVIDER_IN_USE');
      expect(inUse.body.error.message).toBe('该服务商已有调用记录，不能删除；请改为停用');
      const kept = await call<ModelProviderListResponse>('GET', '/api/model-providers');
      expect(kept.body.providers.some((provider) => provider.id === primaryId)).toBe(true);
      expect(await deleteAudits(primaryId)).toBe('0');

      // ③ 复用密钥：源服务商存在但没存过密钥，才轮到 PROVIDER_KEY_MISSING。
      const noKey = await call<ModelProviderView>('POST', '/api/model-providers', {
        name: 'M3 无密钥服务商',
        baseUrl: `http://127.0.0.1:${stubPort}/p1/v1`,
        model: 'stub-no-key',
        isEnabled: false,
        priority: 50,
      });
      expect(noKey.status).toBe(200);
      expect(noKey.body.hasKey).toBe(false);
      tempProviderIds.push(noKey.body.id);

      const beforeReuse = await providerCount();
      expectError(
        await call<ErrorResponseBody>('POST', '/api/model-providers', {
          name: 'M3 复用空密钥服务商',
          baseUrl: `http://127.0.0.1:${stubPort}/p1/v1`,
          model: 'stub-reuse',
          reuseKeyFromProviderId: noKey.body.id,
          isEnabled: false,
          priority: 51,
        }),
        400,
        'PROVIDER_KEY_MISSING',
      );
      expectError(
        await call<ErrorResponseBody>('POST', '/api/model-providers', {
          name: 'M3 复用不存在服务商',
          baseUrl: `http://127.0.0.1:${stubPort}/p1/v1`,
          model: 'stub-reuse',
          reuseKeyFromProviderId: ghost,
          isEnabled: false,
          priority: 51,
        }),
        404,
        'PROVIDER_NOT_FOUND',
      );
      // 两次被拒都在事务里回滚：既不落服务商行，也不留 create 审计。
      expect(await providerCount()).toBe(beforeReuse);

      // ④ 正控制：没有调用记录的服务商真能删掉，并且留下一条归因到人、带上被删名字的审计。
      const deleted = await call<{ ok: boolean }>('DELETE', `/api/model-providers/${noKey.body.id}`);
      expect(deleted.status).toBe(200);
      // 删成功要看得见：数量比复用尝试前少 1，且列表里查不到这一行。
      expect(Number(await providerCount())).toBe(Number(beforeReuse) - 1);
      const afterDelete = await call<ModelProviderListResponse>('GET', '/api/model-providers');
      expect(afterDelete.body.providers.some((provider) => provider.id === noKey.body.id)).toBe(false);
      expect(await deleteAudits(noKey.body.id)).toBe('1');
      const audit = await sql<{ actor_type: string; result: string; metadata: Record<string, unknown> }[]>`
        SELECT actor_type, result, metadata FROM audit_log
        WHERE action = 'model_provider.delete' AND object_id = ${noKey.body.id}
      `;
      expect(audit[0]?.actor_type).toBe('human');
      expect(audit[0]?.result).toBe('success');
      expect(audit[0]?.metadata?.name).toBe('M3 无密钥服务商');
    },
  );

  it(
    '坏响应族按成因分四个码：只有空正文原地重试，JSON 与 SSE 两条上游错误都先脱敏',
    async () => {
      // 备用服务商显式关掉：这一族问的是「同一份坏响应被怎样归因」，不是故障转移。
      // 上一条用例恰好也把它关了，但那是用例顺序的巧合，不能当夹具依赖。
      await sql`UPDATE model_providers SET is_enabled = false WHERE id = ${backupId}`;

      async function trace() {
        const rows = await sql<{ proposals: string; calls: string; locks: string; drafts: string }[]>`
          SELECT
            (SELECT count(*) FROM ai_proposals WHERE chapter_id = ${chapterId})::text AS proposals,
            (SELECT count(*) FROM model_calls WHERE chapter_id = ${chapterId})::text AS calls,
            (SELECT count(*) FROM ai_generation_locks WHERE chapter_id = ${chapterId})::text AS locks,
            (SELECT count(*) FROM draft_revisions dr
               JOIN draft_branches db ON db.id = dr.branch_id
              WHERE db.chapter_id = ${chapterId})::text AS drafts
        `;
        return rows[0]!;
      }

      interface Failure {
        code: string;
        message: string;
      }

      async function failWith(plan: StubAction, attempts: number): Promise<Failure> {
        const before = await trace();
        setPlans({ p1: [plan] });
        const result = await generate();
        expect(result.status).toBe(200);
        expect(result.proposal).toBeNull();
        const errorEvent = result.events.find((event) => event.event === 'error');
        if (!errorEvent) throw new Error('坏响应没有发出 error 事件');
        const failure = errorEvent.data as Failure;
        expect(requests.map((request) => request.provider)).toEqual(
          Array.from({ length: attempts }, () => 'p1'),
        );
        // 一次失败生成＝一条提案行；调用记录按实际尝试次数；锁释放、草稿不动。
        const after = await trace();
        expect(after).toEqual({
          ...before,
          proposals: String(Number(before.proposals) + 1),
          calls: String(Number(before.calls) + attempts),
        });
        const row = await sql<{ status: string; error_code: string | null; attempts: number }[]>`
          SELECT status, error_code, attempts FROM ai_proposals
          WHERE chapter_id = ${chapterId}
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `;
        // 界面读到的码与落库归因必须是同一个字面量，否则报表与提示各说各话。
        expect(row[0]).toEqual({ status: 'failed', error_code: failure.code, attempts });
        return failure;
      }

      const empty = await failWith({ kind: 'empty' }, 2);
      // 重试过的那一次，界面文案要带上尝试次数——这是「为什么等了这么久」唯一的凭据。
      expect(empty).toEqual({
        code: 'EMPTY_OUTPUT',
        message: '已尝试 2 次：模型返回空正文，未生成提案',
      });

      const tooLarge = await failWith(
        { kind: 'sse', content: '铜'.repeat(60_001), promptTokens: 10, completionTokens: 5 },
        1,
      );
      expect(tooLarge).toEqual({
        code: 'OUTPUT_TOO_LARGE',
        message: '模型输出超过 60000 字上限，已中止；提案未完成。',
      });

      const badBody = await failWith({ kind: 'non-json', raw: '这一句不是 JSON' }, 1);
      expect(badBody).toEqual({
        code: 'AI_BAD_RESPONSE',
        message: '模型服务返回的不是 JSON 或 SSE 流',
      });

      const upstream = await failWith(
        { kind: 'upstream-error', message: `内容策略拒绝：${STUB_KEY_PRIMARY} 无效`, code: 'content_policy' },
        1,
      );
      expect(upstream.code).toBe('AI_UPSTREAM_ERROR');
      expect(upstream.message).toContain('内容策略拒绝');
      expect(upstream.message).toContain('••••');
      expect(upstream.message).not.toContain(STUB_KEY_PRIMARY);

      // 同一条上游错误换成 SSE 里的一条 data 事件，走的是另一处判定分支：
      // 只有两处都断言，删掉任意一处的脱敏才不会悄悄漏过去。
      // 报文里的密钥必须是这一条真正被调用的 p1 的那把：备用服务商已关掉，
      // 换成备用那把脱敏函数就没有可替换的对象，那句 not.toContain 会变成永远成立的假阳性。
      const upstreamInStream = await failWith(
        { kind: 'sse-upstream-error', message: `内容策略拒绝：${STUB_KEY_PRIMARY} 无效`, code: 'content_policy' },
        1,
      );
      expect(upstreamInStream.code).toBe('AI_UPSTREAM_ERROR');
      expect(upstreamInStream.message).toContain('内容策略拒绝');
      expect(upstreamInStream.message).toContain('••••');
      expect(upstreamInStream.message).not.toContain(STUB_KEY_PRIMARY);
    },
  );

  it('截止时间已过时按 AI_TIMEOUT 收口，不真等 120 秒', async () => {
    // 截止是 run.startedAt + 120_000；把 startedAt 回拨 121 秒后，executeAttempt 的定时器只等
    // max(1, 负数) = 1ms 就中止。桩故意慢 800ms，保证是超时先到而不是桩先答完。
    // 这样钉的是真实的截止算术与 abort 归因，不是把替身的失败伪装成超时。
    await sql`UPDATE model_providers SET is_enabled = false WHERE id = ${backupId}`;
    setPlans({
      p1: [
        {
          kind: 'delayed-sse',
          content: '超时后不该收到的正文',
          promptTokens: 10,
          completionTokens: 5,
          delayMs: 800,
        },
      ],
    });
    const auth: AuthContext = { ...owner.me, sessionId: 'timeout-session' };
    const run = await prepareProposal(
      auth,
      chapterId,
      { mode: 'continue', instruction: '', targetWords: 300 },
      undefined,
      { budget: null },
    );
    try {
      const result = await executeProposal(
        { ...run, startedAt: Date.now() - 121_000 },
        { onDelta: () => {} },
        new AbortController().signal,
      );
      expect(result).toEqual({
        ok: false,
        code: 'AI_TIMEOUT',
        message: '模型生成超时（120 秒），提案未完成',
      });

      const row = await sql<
        { status: string; error_code: string | null; attempts: number; content: string }[]
      >`
        SELECT status, error_code, attempts, content FROM ai_proposals
        WHERE id = ${run.proposalId}
      `;
      expect(row[0]).toEqual({
        status: 'failed',
        error_code: 'AI_TIMEOUT',
        attempts: 1,
        content: '',
      });
      const audit = await sql<{ result: string; errorCode: string | null }[]>`
        SELECT result, metadata->>'errorCode' AS "errorCode"
        FROM audit_log
        WHERE action = 'ai.proposal.generate' AND object_id = ${chapterId}
          AND metadata->>'proposalId' = ${run.proposalId}
      `;
      expect(audit[0]).toEqual({ result: 'failure', errorCode: 'AI_TIMEOUT' });
    } finally {
      await releaseGenerationLock(chapterId, run.proposalId);
    }
  });

  it('客户端已中止时按 CLIENT_ABORTED 收口，且不产出任何正文', async () => {
    // 已中止的 signal 在 fetch 之前就传进 AbortController，走的是「客户端断开」而不是「超时」：
    // 两者的判定都读 clientSignal/timedOut，顺序写反会把这条归成 AI_TIMEOUT。
    setPlans({ p1: [{ kind: 'sse', content: '中止后不该收到的正文', promptTokens: 10, completionTokens: 5 }] });
    const auth: AuthContext = { ...owner.me, sessionId: 'abort-session' };
    const run = await prepareProposal(
      auth,
      chapterId,
      { mode: 'continue', instruction: '', targetWords: 300 },
      undefined,
      { budget: null },
    );
    const controller = new AbortController();
    controller.abort();
    const deltas: string[] = [];
    try {
      const result = await executeProposal(
        run,
        { onDelta: (text) => deltas.push(text) },
        controller.signal,
      );
      expect(result).toEqual({
        ok: false,
        code: 'CLIENT_ABORTED',
        message: '客户端已断开，生成已中止；提案未完成',
      });
      expect(deltas).toEqual([]);

      const row = await sql<
        { status: string; error_code: string | null; attempts: number; content: string }[]
      >`
        SELECT status, error_code, attempts, content FROM ai_proposals
        WHERE id = ${run.proposalId}
      `;
      expect(row[0]).toEqual({
        status: 'failed',
        error_code: 'CLIENT_ABORTED',
        attempts: 1,
        content: '',
      });
    } finally {
      await releaseGenerationLock(chapterId, run.proposalId);
    }
  });
});
