import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  AutomationJobView,
  AutomationMandateView,
  AutomationPreflightView,
  MeResponse,
  ModelProviderView,
} from '@yunshuo/contracts';
import type { ChapterPlan } from '@yunshuo/domain';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automationRunnerId, runAutomationTick } from './services/automation-runner.js';
import { automationAgentEmail } from './services/automation-agent.js';

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

interface StubRequest {
  path: string;
  authorization: string | null;
  body: { model?: string; messages?: unknown[]; max_tokens?: number } | null;
}

const RUN_ID = randomUUID().slice(0, 8);
const TEST_EMAIL_SUFFIX = `@m4b-${RUN_ID}.test`;

const PLAN: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

const PASSING_CONTENT =
  '林默把封印符压进门框，追兵在巷口停下，雨声盖住了脚步。'.repeat(20) +
  '铜钉滚进水沟。他听见门后的声音，问：“你打算拿什么封？”';

const FAILING_CONTENT = '林默仿佛走了一步。';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M4-B 集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M4-B 自动化授权 / 预检 / 无人值守入库', () => {
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let stubContent = PASSING_CONTENT;
  let stubRequests: StubRequest[] = [];

  let workspaceId = '';
  let workId = '';
  let volumeId = '';
  let owner: Session;
  let lead: Session;
  let author: Session;
  const testUserIds: string[] = [];
  const chapterIds: Record<string, string> = {};
  let pricedProviderId = '';

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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    session: Session,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: session.cookie },
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
    role: 'owner' | 'lead' | 'author',
  ): Promise<Session> {
    const id = randomUUID();
    testUserIds.push(id);
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${name})`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return login(email);
  }

  async function createChapter(
    number: number,
    title: string,
    plan: ChapterPlan,
    status: 'planned' | 'writing' = 'planned',
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (${id}, ${workId}, ${volumeId}, ${number}, ${title}, ${status},
        ${sql.json(jsonValue(plan))})
    `;
    chapterIds[title] = id;
    return id;
  }

  function chapterId(title: string): string {
    const id = chapterIds[title];
    if (!id) throw new Error(`测试章节不存在：${title}`);
    return id;
  }

  async function createMandate(
    overrides: Partial<{
      name: string;
      chapterMin: number;
      chapterMax: number;
      maxChapters: number;
      targetWords: number;
      allowAutoCommit: boolean;
      allowRemoteModels: boolean;
      allowNonProductionGates: boolean;
      budgetLimit: number | null;
      budgetCurrency: 'CNY' | 'USD';
      expiresInHours: number;
    }> = {},
  ): Promise<AutomationMandateView> {
    const result = await call<AutomationMandateView>('POST', '/api/automation/mandates', owner, {
      workId,
      name: overrides.name ?? 'M4-B 测试授权',
      chapterMin: overrides.chapterMin ?? 1,
      chapterMax: overrides.chapterMax ?? 100,
      maxChapters: overrides.maxChapters ?? 10,
      targetWords: overrides.targetWords ?? 800,
      instruction: '延续既有风格',
      allowAutoCommit: overrides.allowAutoCommit ?? true,
      allowRemoteModels: overrides.allowRemoteModels ?? false,
      allowNonProductionGates: overrides.allowNonProductionGates ?? true,
      budgetLimit: overrides.budgetLimit ?? null,
      budgetCurrency: overrides.budgetCurrency ?? 'CNY',
      expiresInHours: overrides.expiresInHours ?? 2,
    });
    expect(result.status).toBe(200);
    return result.body;
  }

  async function preflight(
    mandateId: string,
    selected: string[],
  ): Promise<ApiResult<AutomationPreflightView>> {
    return call<AutomationPreflightView>('POST', '/api/automation/preflight', owner, {
      mandateId,
      chapterIds: selected,
    });
  }

  async function createJob(
    mandateId: string,
    selected: string[],
  ): Promise<ApiResult<AutomationJobView>> {
    return call<AutomationJobView>('POST', '/api/automation/jobs', owner, {
      mandateId,
      chapterIds: selected,
    });
  }

  async function stopIfActive(jobId: string): Promise<void> {
    await call('POST', `/api/automation/jobs/${jobId}/stop`, owner);
  }

  async function removeWorkspaceData(id: string): Promise<void> {
    await sql`DELETE FROM automation_jobs WHERE workspace_id = ${id}`;
    await sql`DELETE FROM automation_mandates WHERE workspace_id = ${id}`;
    await sql`DELETE FROM ai_generation_locks WHERE workspace_id = ${id}`;
    await sql`DELETE FROM ai_proposals WHERE workspace_id = ${id}`;
    await sql`DELETE FROM model_calls WHERE workspace_id = ${id}`;
    await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${id}`;
    await sql`
      DELETE FROM commits
      WHERE chapter_id IN (
        SELECT id FROM chapters WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${id})
      )
    `;
    await sql`
      DELETE FROM commit_intents
      WHERE chapter_id IN (
        SELECT id FROM chapters WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${id})
      )
    `;
    await sql`
      UPDATE chapters SET current_version_id = NULL
      WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${id})
    `;
    await sql`
      DELETE FROM canon_current
      WHERE chapter_id IN (
        SELECT id FROM chapters WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${id})
      )
    `;
    await sql`DELETE FROM works WHERE workspace_id = ${id}`;
    await sql`DELETE FROM model_providers WHERE workspace_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE workspace_id = ${id}`;
    await sql`DELETE FROM events WHERE workspace_id = ${id}`;
    await sql`DELETE FROM memberships WHERE workspace_id = ${id}`;
    await sql`DELETE FROM workspaces WHERE id = ${id}`;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';

    stub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        let body: StubRequest['body'] = null;
        try {
          body = raw ? (JSON.parse(raw) as StubRequest['body']) : null;
        } catch {
          body = null;
        }
        stubRequests.push({
          path: request.url ?? '',
          authorization:
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : null,
          body,
        });
        if (!(request.url ?? '').endsWith('/chat/completions')) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 未实现该接口' } }));
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: stubContent } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 1000, completion_tokens: 500 },
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

    workspaceId = await createWorkspace('M4-B 自动化测试工作区');
    owner = await createUser(`owner${TEST_EMAIL_SUFFIX}`, 'M4-B 所有者', 'owner');
    lead = await createUser(`lead${TEST_EMAIL_SUFFIX}`, 'M4-B 主笔', 'lead');
    author = await createUser(`author${TEST_EMAIL_SUFFIX}`, 'M4-B 作者', 'author');

    workId = randomUUID();
    volumeId = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${workId}, ${workspaceId}, 'M4-B 测试作品')`;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '第一卷')
    `;

    await createChapter(1, '自动第一章', PLAN);
    await createChapter(2, '自动第二章', PLAN);
    await createChapter(3, '门禁失败章', PLAN);
    await createChapter(4, '人工租约章', PLAN);
    await createChapter(5, '预算第一章', PLAN);
    await createChapter(6, '预算第二章', PLAN);
    await createChapter(7, '恢复章', PLAN);
    await createChapter(8, '预检失败章', {});
    await createChapter(9, '远程策略章', PLAN);
    await createChapter(10, '未定价章', PLAN);
    await createChapter(11, '并发第一章', PLAN);
    await createChapter(12, '并发第二章', PLAN);
    await createChapter(13, '预算硬限章', PLAN);
    await createChapter(14, '门禁确认章', PLAN);
    await createChapter(15, '门禁未确认章', PLAN);
    await createChapter(16, '暂停甲章', PLAN);
    await createChapter(17, '暂停乙章', PLAN);
    await createChapter(18, '暂停丙章', PLAN);

    const provider = await call<ModelProviderView>('POST', '/api/model-providers', owner, {
      name: 'M4-B 对话桩',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-chat',
      purpose: 'chat',
      apiKey: 'm4b-key',
      isEnabled: true,
      priority: 1,
      promptPricePer1m: 1,
      completionPricePer1m: 1,
      priceCurrency: 'CNY',
    });
    expect(provider.status).toBe(200);
    pricedProviderId = provider.body.id;
    stubRequests = [];
  });

  afterAll(async () => {
    if (workspaceId) await removeWorkspaceData(workspaceId);
    if (testUserIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(testUserIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(testUserIds)}`;
    }
    if (workspaceId) {
      await sql`DELETE FROM users WHERE email = ${automationAgentEmail(workspaceId)}`;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (app) await app.close();
    await closeDb();
  });

  it('作者不能创建或查看自动化授权', async () => {
    const list = await call<ErrorBody>('GET', '/api/automation/mandates', author);
    expectError(list, 403, 'FORBIDDEN');

    const create = await call<ErrorBody>('POST', '/api/automation/mandates', author, {
      workId,
      name: '越权授权',
      chapterMin: 1,
      chapterMax: 2,
      maxChapters: 1,
      targetWords: 800,
    });
    expectError(create, 403, 'FORBIDDEN');

    const preflightResult = await call<ErrorBody>('POST', '/api/automation/preflight', author, {
      mandateId: randomUUID(),
      chapterIds: [chapterId('自动第一章')],
    });
    expectError(preflightResult, 403, 'FORBIDDEN');
  });

  it('预检不发起任何模型调用，并识别门禁配置缺口', async () => {
    const mandate = await createMandate({ name: '预检零调用授权' });
    stubRequests = [];
    const ok = await preflight(mandate.id, [chapterId('自动第一章'), chapterId('自动第二章')]);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.providerNames).toContain('M4-B 对话桩');
    expect(stubRequests).toHaveLength(0);

    const bad = await preflight(mandate.id, [chapterId('预检失败章')]);
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    const failure = bad.body.checks.find((check) => check.key === 'gate_feasibility');
    expect(failure?.status).toBe('fail');
    expect(failure?.detail).toContain('核心实体');
    expect(stubRequests).toHaveLength(0);

    const rejected = await createJob(mandate.id, [chapterId('预检失败章')]);
    expectError(rejected, 409, 'AUTOMATION_PRECHECK_FAILED');
    const details = (rejected.body as unknown as ErrorBody).error.details as {
      preflight: AutomationPreflightView;
    };
    expect(details.preflight.ok).toBe(false);
    expect(stubRequests).toHaveLength(0);
  });

  it('无人值守完成两章并在全门禁通过后以 batch 来源入库', async () => {
    stubContent = PASSING_CONTENT;
    const mandate = await createMandate({
      name: '两章自动入库',
      allowAutoCommit: true,
      budgetLimit: null,
    });
    const created = await createJob(mandate.id, [
      chapterId('自动第一章'),
      chapterId('自动第二章'),
    ]);
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('queued');
    expect(created.body.totalChapters).toBe(2);

    await runAutomationTick();
    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.status).toBe(200);
    expect(job.body.status).toBe('completed');
    expect(job.body.committedChapters).toBe(2);
    expect(job.body.failedChapters).toBe(0);
    expect(job.body.chapters.every((chapter) => chapter.status === 'committed')).toBe(true);
    expect(job.body.spent).toBeGreaterThan(0);

    const agent = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${automationAgentEmail(workspaceId)}
    `;
    expect(agent[0]).toBeTruthy();
    const versions = await sql<
      { chapter_id: string; source: string; actor_id: string; version_no: number }[]
    >`
      SELECT chapter_id, source, actor_id, version_no
      FROM canon_versions
      WHERE chapter_id IN ${sql([chapterId('自动第一章'), chapterId('自动第二章')])}
      ORDER BY version_no
    `;
    expect(versions).toHaveLength(2);
    expect(versions.every((version) => version.source === 'batch')).toBe(true);
    expect(versions.every((version) => version.actor_id === agent[0]!.id)).toBe(true);

    const audits = await sql<{ actor_type: string; role: string; metadata: unknown }[]>`
      SELECT actor_type, role, metadata FROM audit_log
      WHERE action = 'chapter.commit' AND object_id IN ${sql([
        chapterId('自动第一章'),
        chapterId('自动第二章'),
      ])}
    `;
    expect(audits).toHaveLength(2);
    expect(audits.every((audit) => audit.actor_type === 'ai' && audit.role === 'ai')).toBe(true);
    expect(
      audits.every(
        (audit) => (audit.metadata as { jobId?: string }).jobId === created.body.id,
      ),
    ).toBe(true);

    const generationAudits = await sql<{ actor_type: string; role: string; actor_id: string }[]>`
      SELECT actor_type, role, actor_id FROM audit_log
      WHERE action = 'ai.proposal.generate' AND result = 'success'
        AND object_id IN ${sql([chapterId('自动第一章'), chapterId('自动第二章')])}
    `;
    expect(generationAudits).toHaveLength(2);
    // 无人值守的生成审计必须记 ai：这一段曾硬编码 'human'，导致同一次作业的
    // chapter.commit 是 ai、ai.proposal.generate 是 human，审计自相矛盾。
    expect(
      generationAudits.every(
        (audit) =>
          audit.actor_type === 'ai' &&
          audit.role === 'ai' &&
          audit.actor_id === agent[0]!.id,
      ),
    ).toBe(true);

    const leases = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM chapter_leases
      WHERE chapter_id IN ${sql([chapterId('自动第一章'), chapterId('自动第二章')])}
    `;
    expect(leases[0]!.count).toBe('0');

    const outbox = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM outbox
      WHERE payload->>'workspaceId' = ${workspaceId}
    `;
    expect(Number(outbox[0]!.count)).toBeGreaterThanOrEqual(2);
    expect(stubRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('AI 服务主体不能用开发登录进入系统', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: automationAgentEmail(workspaceId) },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as ErrorBody).error.code).toBe('LOGIN_FAILED');
  });

  it('门禁失败保留草稿与评估但不入库', async () => {
    stubContent = FAILING_CONTENT;
    const mandate = await createMandate({ name: '门禁失败授权' });
    const created = await createJob(mandate.id, [chapterId('门禁失败章')]);
    expect(created.status).toBe(200);

    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('completed');
    expect(job.body.failedChapters).toBe(1);
    expect(job.body.chapters[0]!.status).toBe('gate_failed');
    expect(job.body.chapters[0]!.reason).toContain('未入库');
    expect(job.body.chapters[0]!.evaluationId).toBeTruthy();

    const versions = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM canon_versions WHERE chapter_id = ${chapterId('门禁失败章')}
    `;
    expect(versions[0]!.count).toBe('0');
    const chapter = await sql<{ status: string }[]>`
      SELECT status FROM chapters WHERE id = ${chapterId('门禁失败章')}
    `;
    expect(chapter[0]!.status).toBe('writing');
    const lease = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM chapter_leases WHERE chapter_id = ${chapterId('门禁失败章')}
    `;
    expect(lease[0]!.count).toBe('0');
  });

  it('人工持有租约时 runner 让位并记录跳过原因', async () => {
    const lease = await call('POST', `/api/chapters/${chapterId('人工租约章')}/lease`, lead);
    expect(lease.status).toBe(200);

    const mandate = await createMandate({ name: '人工租约授权' });
    const created = await createJob(mandate.id, [chapterId('人工租约章')]);
    expect(created.status).toBe(200);

    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('completed');
    expect(job.body.skippedChapters).toBe(1);
    expect(job.body.chapters[0]!.status).toBe('skipped');
    expect(job.body.chapters[0]!.reason).toContain('lease_held');

    const versions = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM canon_versions WHERE chapter_id = ${chapterId('人工租约章')}
    `;
    expect(versions[0]!.count).toBe('0');

    await call('DELETE', `/api/chapters/${chapterId('人工租约章')}/lease`, lead);
  });

  it('预算在调用级限制 max_tokens，并在下一章调用前暂停', async () => {
    stubContent = PASSING_CONTENT;
    const mandate = await createMandate({
      name: '预算检查点授权',
      allowAutoCommit: true,
      budgetLimit: 0.0022,
    });
    const created = await createJob(mandate.id, [
      chapterId('预算第一章'),
      chapterId('预算第二章'),
    ]);
    expect(created.status).toBe(200);

    stubRequests = [];
    await runAutomationTick();

    expect(stubRequests).toHaveLength(1);
    const maxTokens = stubRequests[0]!.body?.max_tokens;
    expect(maxTokens).toBeGreaterThanOrEqual(128);
    expect(maxTokens!).toBeLessThan(1600);

    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('paused');
    expect(job.body.committedChapters).toBe(1);
    expect(job.body.lastError).toContain('预算');
    expect(job.body.chapters.find((chapter) => chapter.status === 'pending')).toBeTruthy();
    expect(stubRequests).toHaveLength(1);

    await stopIfActive(created.body.id);
  });

  it('剩余预算低于最低生成额度时不发起调用', async () => {
    stubContent = PASSING_CONTENT;
    const mandate = await createMandate({
      name: '预算硬限授权',
      allowAutoCommit: true,
      budgetLimit: 0.0005,
    });
    const created = await createJob(mandate.id, [chapterId('预算硬限章')]);
    expect(created.status).toBe(200);

    stubRequests = [];
    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('paused');
    expect(job.body.lastError).toContain('BUDGET_INSUFFICIENT');
    expect(job.body.committedChapters).toBe(0);
    expect(job.body.chapters[0]!.status).toBe('pending');
    expect(stubRequests).toHaveLength(0);

    await stopIfActive(created.body.id);
  });

  it('非生产门禁 + 自动入库未确认时预检阻止，仅暂存只提醒', async () => {
    const blocked = await createMandate({
      name: '非生产门禁未确认',
      allowAutoCommit: true,
      allowNonProductionGates: false,
    });
    stubRequests = [];
    const result = await preflight(blocked.id, [chapterId('门禁未确认章')]);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    const check = result.body.checks.find((item) => item.key === 'gate_feasibility');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('不是生产规则集');
    expect(stubRequests).toHaveLength(0);

    const rejected = await createJob(blocked.id, [chapterId('门禁未确认章')]);
    expectError(rejected, 409, 'AUTOMATION_PRECHECK_FAILED');

    const staging = await createMandate({
      name: '非生产门禁仅暂存',
      allowAutoCommit: false,
      allowNonProductionGates: false,
    });
    const allowed = await preflight(staging.id, [chapterId('门禁未确认章')]);
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
    const warning = allowed.body.checks.find((item) => item.key === 'gate_feasibility');
    expect(warning?.status).toBe('warn');
    expect(warning?.detail).toContain('不是生产规则集');
  });

  it('runner 在自动入库前复核非生产门禁确认', async () => {
    const mandate = await createMandate({
      name: '门禁复核授权',
      allowAutoCommit: true,
      allowNonProductionGates: true,
    });
    const created = await createJob(mandate.id, [chapterId('门禁确认章')]);
    expect(created.status).toBe(200);

    await sql`
      UPDATE automation_mandates SET allow_non_production_gates = false
      WHERE id = ${mandate.id}
    `;
    stubRequests = [];
    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('failed');
    expect(job.body.lastError).toContain('不是生产规则集');
    expect(job.body.chapters[0]!.status).toBe('pending');
    expect(stubRequests).toHaveLength(0);
  });

  it('撤销授权会停止排队作业', async () => {
    const mandate = await createMandate({ name: '撤销授权' });
    const created = await createJob(mandate.id, [chapterId('恢复章')]);
    expect(created.status).toBe(200);

    const revoked = await call<AutomationMandateView>(
      'POST',
      `/api/automation/mandates/${mandate.id}/revoke`,
      owner,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('stopped');

    const resume = await call<ErrorBody>(
      'POST',
      `/api/automation/jobs/${created.body.id}/resume`,
      owner,
    );
    expectError(resume, 409, 'MANDATE_REVOKED');
  });

  it('中断作业只能人工恢复，恢复后继续执行', async () => {
    stubContent = PASSING_CONTENT;
    const mandate = await createMandate({ name: '恢复授权' });
    const created = await createJob(mandate.id, [chapterId('恢复章')]);
    expect(created.status).toBe(200);

    await sql`
      UPDATE automation_jobs SET status = 'interrupted', last_error = '测试人工中断'
      WHERE id = ${created.body.id}
    `;
    await sql`
      UPDATE automation_job_chapters SET status = 'interrupted', reason = '测试人工中断'
      WHERE job_id = ${created.body.id} AND chapter_id = ${chapterId('恢复章')}
    `;

    const resumed = await call<AutomationJobView>(
      'POST',
      `/api/automation/jobs/${created.body.id}/resume`,
      owner,
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('queued');

    await runAutomationTick();

    const job = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${created.body.id}`,
      owner,
    );
    expect(job.body.status).toBe('completed');
    expect(job.body.committedChapters).toBe(1);
  });

  it('远程端点未获授权时预检失败且不发起请求', async () => {
    const remoteProvider = await call<ModelProviderView>('POST', '/api/model-providers', owner, {
      name: 'M4-B 远程未授权',
      baseUrl: 'http://192.0.2.10/v1',
      model: 'remote-chat',
      purpose: 'chat',
      apiKey: 'remote-key',
      isEnabled: true,
      priority: 2,
      promptPricePer1m: 1,
      completionPricePer1m: 1,
      priceCurrency: 'CNY',
    });
    expect(remoteProvider.status).toBe(200);
    try {
      const mandate = await createMandate({ name: '远程策略授权', allowRemoteModels: false });
      stubRequests = [];
      const result = await preflight(mandate.id, [chapterId('远程策略章')]);
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(false);
      const check = result.body.checks.find((item) => item.key === 'remote_policy');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('远程端点');
      expect(stubRequests).toHaveLength(0);
    } finally {
      await call('DELETE', `/api/model-providers/${remoteProvider.body.id}`, owner);
    }
  });

  it('设置预算但服务商未定价时预检失败', async () => {
    const unpriced = await call<ModelProviderView>('POST', '/api/model-providers', owner, {
      name: 'M4-B 未定价',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'unpriced-chat',
      purpose: 'chat',
      apiKey: 'unpriced-key',
      isEnabled: true,
      priority: 2,
      promptPricePer1m: null,
      completionPricePer1m: null,
      priceCurrency: 'CNY',
    });
    expect(unpriced.status).toBe(200);
    try {
      const mandate = await createMandate({ name: '未定价预算授权', budgetLimit: 1 });
      const result = await preflight(mandate.id, [chapterId('未定价章')]);
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(false);
      const check = result.body.checks.find((item) => item.key === 'budget');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('未填写完整价表');
    } finally {
      await call('DELETE', `/api/model-providers/${unpriced.body.id}`, owner);
    }
  });

  it('同一工作区不能同时存在两个活跃作业', async () => {
    const mandate = await createMandate({ name: '并发授权' });
    const first = await createJob(mandate.id, [chapterId('并发第一章')]);
    expect(first.status).toBe(200);
    const second = await createJob(mandate.id, [chapterId('并发第二章')]);
    expectError(second, 409, 'AUTOMATION_PRECHECK_FAILED');
    const details = (second.body as unknown as ErrorBody).error.details as {
      preflight: AutomationPreflightView;
    };
    const conflictCheck = details.preflight.checks.find(
      (check) => check.key === 'conflicting_job',
    );
    expect(conflictCheck?.status).toBe('fail');

    await stopIfActive(first.body.id);
  });

  it('暂停端点按作业状态分三种收口：排队立即停、运行中只举旗、终态拒绝', async () => {
    async function pauseTrail(jobId: string): Promise<{ audits: string; events: string }> {
      const rows = await sql<{ audits: string; events: string }[]>`
        SELECT
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${jobId} AND action = 'automation.job.pause') AS audits,
          (SELECT count(*)::text FROM events
             WHERE aggregate_id = ${jobId} AND event_type = 'automation.job.pause') AS events
      `;
      return rows[0]!;
    }

    type AttributionRow = { actorType: string; role: string; boundary: string };

    async function pauseAttribution(jobId: string): Promise<AttributionRow[]> {
      const rows = await sql<AttributionRow[]>`
        SELECT actor_type AS "actorType", role, metadata ->> 'boundary' AS boundary
        FROM audit_log
        WHERE object_id = ${jobId} AND action = 'automation.job.pause'
      `;
      return rows;
    }

    const mandate = await createMandate({ name: '暂停授权' });
    const queued = await createJob(mandate.id, [chapterId('暂停甲章')]);
    expect(queued.status).toBe(200);
    const pausePath = `/api/automation/jobs/${queued.body.id}/pause`;

    // 作者连暂停都发不起；幽灵 id 一律 404，不区分"存在但不可见"
    expectError(await call('POST', pausePath, author), 403, 'FORBIDDEN');
    expectError(
      await call('POST', `/api/automation/jobs/${randomUUID()}/pause`, owner),
      404,
      'JOB_NOT_FOUND',
    );

    // ① 排队中的作业还没开始，暂停立即落定为 paused
    const paused = await call<AutomationJobView>('POST', pausePath, owner);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    expect(paused.body.pauseRequested).toBe(true);
    expect(paused.body.stopRequested).toBe(false);
    expect(await pauseTrail(queued.body.id)).toEqual({ audits: '1', events: '1' });

    // 重复暂停幂等：返回同一状态，不再落第二份审计与事件
    const again = await call<AutomationJobView>('POST', pausePath, owner);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('paused');
    expect(await pauseTrail(queued.body.id)).toEqual({ audits: '1', events: '1' });

    // paused 的作业不会被 runner 领取，一次模型请求都不发
    stubRequests = [];
    await runAutomationTick();
    expect(stubRequests).toHaveLength(0);

    // ③ 终态作业不能暂停：409 说清当前状态，被拒的尝试一条审计都不留
    await stopIfActive(queued.body.id);
    const beforeRejection = await pauseTrail(queued.body.id);
    const rejected = await call<ErrorBody>('POST', pausePath, owner);
    expectError(rejected, 409, 'JOB_NOT_PAUSABLE');
    expect(rejected.body.error.message).toBe('作业当前状态 stopped，不能暂停');
    expect(await pauseTrail(queued.body.id)).toEqual(beforeRejection);

    // ② 运行中的作业不能在请求里被中断：端点只举旗，状态仍是 running
    const running = await createJob(mandate.id, [
      chapterId('暂停乙章'),
      chapterId('暂停丙章'),
    ]);
    expect(running.status).toBe(200);
    const runningPath = `/api/automation/jobs/${running.body.id}/pause`;
    await sql`
      UPDATE automation_jobs
      SET status = 'running', runner_id = ${automationRunnerId}, heartbeat_at = now(),
          started_at = now()
      WHERE id = ${running.body.id}
    `;
    const flagged = await call<AutomationJobView>('POST', runningPath, lead);
    expect(flagged.status).toBe(200);
    expect(flagged.body.status).toBe('running');
    expect(flagged.body.pauseRequested).toBe(true);
    expect(await pauseTrail(running.body.id)).toEqual({ audits: '1', events: '1' });

    // 旗子由 runner 在下一章开始前收口：零生成请求、零入库，两章仍是 pending
    stubRequests = [];
    await runAutomationTick();
    const settled = await call<AutomationJobView>(
      'GET',
      `/api/automation/jobs/${running.body.id}`,
      owner,
    );
    expect(settled.body.status).toBe('paused');
    expect(settled.body.lastError).toBe('用户请求在章节边界暂停');
    expect(settled.body.committedChapters).toBe(0);
    expect(settled.body.chapters.every((chapter) => chapter.status === 'pending')).toBe(true);
    expect(stubRequests).toHaveLength(0);

    // 审计归因到点暂停的那个人，两类收口边界分别留痕
    expect(await pauseAttribution(queued.body.id)).toEqual([
      { actorType: 'human', role: 'owner', boundary: 'before_start' },
    ]);
    expect(await pauseAttribution(running.body.id)).toEqual([
      { actorType: 'human', role: 'lead', boundary: 'chapter_end' },
    ]);

    await stopIfActive(running.body.id);
  });
});
