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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  // 用例中途失败也会走到 afterAll：临时工作区一律登记在这里，由 afterAll 统一拆，
  // 不靠用例自己记得清理（§十八 的教训：清理路径不能挂在被测流程成功之后）。
  const extraWorkspaceIds: string[] = [];
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

  // 一个工作区同时只许一份活跃作业（automation-service.ts:835 把 queued/running/paused 都算进去），
  // 而 running 只能举旗不能强收。前面某条用例如果因为产品被改动而留下 running，
  // 后面每条 createJob 都会 409 —— 一枪的红就会伪装成七八条用例的红。
  // 需要在同一次跑里连续建作业的用例，起手先把本工作区还活跃的行收掉（只收自己夹具的行，不碰别的用例的断言）。
  async function settleWorkspaceJobs(): Promise<void> {
    await sql`
      UPDATE automation_jobs SET status = 'stopped', runner_id = NULL, heartbeat_at = NULL
      WHERE workspace_id = ${workspaceId} AND status IN ('queued', 'running', 'paused')
    `;
  }

  // 收尾统一收掉本夹具留下的活跃作业：产品被改动时，中途红掉的用例会留下一份 queued/running，
  // 于是后面每条 createJob 都 409 —— 一枪真红会伪装成十条用例的红，失败就再也归因不到它自己那一行。
  afterEach(async () => {
    await settleWorkspaceJobs();
  });

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
    await createChapter(19, '互斥甲章', PLAN);
    await createChapter(20, '互斥乙章', PLAN);
    await createChapter(21, '互斥丙章', PLAN);
    await createChapter(22, '竞态甲章', PLAN);
    await createChapter(23, '策略漂移章', PLAN);
    await createChapter(24, '策略恢复章', PLAN);
    await createChapter(25, '费用未知甲章', PLAN);
    await createChapter(26, '费用未知乙章', PLAN);
    await createChapter(27, '无预算甲章', PLAN);
    await createChapter(28, '无预算乙章', PLAN);
    await createChapter(29, '末章费用未知章', PLAN);
    await createChapter(30, '上限触发甲章', PLAN);
    await createChapter(31, '上限触发乙章', PLAN);

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
    for (const id of extraWorkspaceIds) await removeWorkspaceData(id);
    if (testUserIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(testUserIds)}`;
      await sql`DELETE FROM memberships WHERE user_id IN ${sql(testUserIds)}`;
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
    // 停在哪儿，得说得出是哪道闸答的：这句带"调用前暂停"，说明答案是 runChapter 之前的预算闸
    // （automation-runner.ts:777-784），不是章末/章首那两处预算检查点——它们的句子是"章节检查点暂停"。
    expect(job.body.lastError?.split(':')[0]).toBe('BUDGET_INSUFFICIENT');
    expect(job.body.lastError).toContain('；作业在调用前暂停，章节保持待办。');
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
    expect(job.body.lastError).toContain('；作业在调用前暂停，章节保持待办。');
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

  it('过期授权先落库再拒绝、幽灵与跨区授权共用一句 404、终态作业既不能停也不能恢复', async () => {
    stubRequests = [];

    async function jobTrail(
      jobId: string,
      action: string,
    ): Promise<{ audits: string; events: string }> {
      const rows = await sql<{ audits: string; events: string }[]>`
        SELECT
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${jobId} AND action = ${`automation.job.${action}`}) AS audits,
          (SELECT count(*)::text FROM events
             WHERE aggregate_id = ${jobId} AND event_type = ${`automation.job.${action}`}) AS events
      `;
      return rows[0]!;
    }

    async function mandateRow(mandateId: string): Promise<{ status: string; future: boolean }> {
      const rows = await sql<{ status: string; future: boolean }[]>`
        SELECT status, expires_at > now() AS future
        FROM automation_mandates WHERE id = ${mandateId}
      `;
      return rows[0]!;
    }

    async function jobCountFor(mandateId: string): Promise<string> {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM automation_jobs WHERE mandate_id = ${mandateId}
      `;
      return rows[0]!.n;
    }

    async function activeJobCount(): Promise<string> {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM automation_jobs
        WHERE workspace_id = ${workspaceId} AND status IN ('queued', 'running', 'paused')
      `;
      return rows[0]!.n;
    }

    async function jobStatus(jobId: string): Promise<string> {
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM automation_jobs WHERE id = ${jobId}
      `;
      return rows[0]!.status;
    }

    // ① 同一个 404 同时回答"不存在"和"是别人区的"：loadMandateRow 把工作区写在 WHERE 里
    //    （automation-service.ts:112/:123），三个入口各打一次，撤销那次还不能改动隔离区的授权。
    const otherWorkspace = await createWorkspace('M4-B 互斥隔离工作区');
    extraWorkspaceIds.push(otherWorkspace);
    const otherOwnerId = randomUUID();
    testUserIds.push(otherOwnerId);
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${otherOwnerId}, ${`isolation${TEST_EMAIL_SUFFIX}`}, 'M4-B 隔离区所有者')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${otherWorkspace}, ${otherOwnerId}, 'owner')
    `;
    const otherOwner = await login(`isolation${TEST_EMAIL_SUFFIX}`);
    const otherWork = randomUUID();
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${otherWork}, ${otherWorkspace}, 'M4-B 隔离区作品')
    `;
    const foreign = await call<AutomationMandateView>(
      'POST',
      '/api/automation/mandates',
      otherOwner,
      {
        workId: otherWork,
        name: '隔离区授权',
        chapterMin: 1,
        chapterMax: 100,
        maxChapters: 10,
        targetWords: 800,
        expiresInHours: 2,
      },
    );
    expect(foreign.status).toBe(200);

    const ghost = randomUUID();
    for (const mandateId of [ghost, foreign.body.id]) {
      expectError(
        await call('POST', `/api/automation/mandates/${mandateId}/revoke`, owner),
        404,
        'MANDATE_NOT_FOUND',
      );
      expectError(await preflight(mandateId, [chapterId('互斥甲章')]), 404, 'MANDATE_NOT_FOUND');
      expectError(await createJob(mandateId, [chapterId('互斥甲章')]), 404, 'MANDATE_NOT_FOUND');
    }
    expect(await mandateRow(foreign.body.id)).toEqual({ status: 'active', future: true });
    const ownList = await call<{ mandates: AutomationMandateView[] }>(
      'GET',
      '/api/automation/mandates',
      owner,
    );
    expect(ownList.status).toBe(200);
    expect(ownList.body.mandates.some((mandate) => mandate.id === foreign.body.id)).toBe(false);
    await removeWorkspaceData(otherWorkspace);

    // ② 过期在三个入口给出三种答案：createJob 是 409，preflight 是 200 + 失败检查项，
    //    列表这个"读"操作会把到期授权顺手落定成 expired。
    const expiring = await createMandate({ name: '过期授权' });
    expect(await mandateRow(expiring.id)).toEqual({ status: 'active', future: true });
    await sql`
      UPDATE automation_mandates SET expires_at = now() - interval '1 minute'
      WHERE id = ${expiring.id}
    `;
    const refusedCreate = await createJob(expiring.id, [chapterId('互斥甲章')]);
    expectError(refusedCreate, 409, 'MANDATE_EXPIRED');
    const refusedCreateError = (refusedCreate.body as unknown as ErrorBody).error;
    expect(refusedCreateError.message).toBe('该自动化授权已过期，请重新创建');
    // 这道守卫排在预检之前（:818 对 :820）：若先跑预检，回答会是 AUTOMATION_PRECHECK_FAILED。
    expect(refusedCreateError.code).toBe('MANDATE_EXPIRED');
    expect(await jobCountFor(expiring.id)).toBe('0');
    // 但拒绝并没有把状态写回滚：授权已被这条 409 落定为 expired。
    expect(await mandateRow(expiring.id)).toEqual({ status: 'expired', future: false });

    const expiredPreflight = await preflight(expiring.id, [chapterId('互斥甲章')]);
    expect(expiredPreflight.status).toBe(200);
    expect(expiredPreflight.body.ok).toBe(false);
    expect(
      expiredPreflight.body.checks.find((check) => check.key === 'mandate')?.detail,
    ).toBe('授权已过期，请重新创建授权。');

    // 时间戳改回未来也照样拒：一旦落定为 expired，权威的是状态而不是 expires_at（:132 前半）。
    await sql`
      UPDATE automation_mandates SET expires_at = now() + interval '1 hour'
      WHERE id = ${expiring.id}
    `;
    expectError(await createJob(expiring.id, [chapterId('互斥甲章')]), 409, 'MANDATE_EXPIRED');
    expect(await mandateRow(expiring.id)).toEqual({ status: 'expired', future: true });

    const listed = await createMandate({ name: '列表里到期' });
    await sql`
      UPDATE automation_mandates SET expires_at = now() - interval '1 second'
      WHERE id = ${listed.id}
    `;
    expect(await mandateRow(listed.id)).toEqual({ status: 'active', future: false });
    const listAfterExpiry = await call<{ mandates: AutomationMandateView[] }>(
      'GET',
      `/api/automation/mandates?workId=${workId}`,
      owner,
    );
    expect(listAfterExpiry.status).toBe(200);
    expect(
      listAfterExpiry.body.mandates.find((mandate) => mandate.id === listed.id)?.status,
    ).toBe('expired');
    expect(await mandateRow(listed.id)).toEqual({ status: 'expired', future: false });

    // ③ 恢复只认 paused / interrupted，停止只认非终态；两条闸的先后见 ⑤ 之后那条。
    const mandate = await createMandate({ name: '终态收口授权' });
    const first = await createJob(mandate.id, [chapterId('互斥乙章')]);
    expect(first.status).toBe(200);
    const firstPath = `/api/automation/jobs/${first.body.id}`;

    const notResumable = await call<ErrorBody>('POST', `${firstPath}/resume`, owner);
    expectError(notResumable, 409, 'JOB_NOT_RESUMABLE');
    expect(notResumable.body.error.message).toBe(
      '作业当前状态 queued，只有暂停或中断的作业可以恢复',
    );
    expect(await jobTrail(first.body.id, 'resume')).toEqual({ audits: '0', events: '0' });
    expect(await activeJobCount()).toBe('1');

    // 恢复的正控制：先把 runner 游标与错误 stamp 上去，恢复必须一次清干净。
    await sql`
      UPDATE automation_jobs
      SET runner_id = 'stale-runner', heartbeat_at = now(), started_at = now(),
          last_error = '测试遗留错误'
      WHERE id = ${first.body.id}
    `;
    await call('POST', `${firstPath}/pause`, owner);
    const resumed = await call<AutomationJobView>('POST', `${firstPath}/resume`, lead);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('queued');
    expect(resumed.body).toMatchObject({
      runnerId: null,
      heartbeatAt: null,
      lastError: null,
      pauseRequested: false,
      stopRequested: false,
      completedAt: null,
    });
    expect(await jobTrail(first.body.id, 'resume')).toEqual({ audits: '1', events: '1' });

    // 运行中的停止只举旗：状态仍是 running，审计记的是章节边界。
    await sql`
      UPDATE automation_jobs SET status = 'running', runner_id = ${automationRunnerId}
      WHERE id = ${first.body.id}
    `;
    const flaggedStop = await call<AutomationJobView>('POST', `${firstPath}/stop`, owner);
    expect(flaggedStop.status).toBe(200);
    expect(flaggedStop.body.status).toBe('running');
    expect(flaggedStop.body.stopRequested).toBe(true);
    expect(await jobTrail(first.body.id, 'stop')).toEqual({ audits: '1', events: '1' });
    const stopAttribution = await sql<{ actorType: string; boundary: string }[]>`
      SELECT actor_type AS "actorType", metadata ->> 'boundary' AS boundary
      FROM audit_log
      WHERE object_id = ${first.body.id} AND action = 'automation.job.stop'
    `;
    expect(stopAttribution).toEqual([{ actorType: 'human', boundary: 'chapter_end' }]);

    // ④ 终态既不能停也不能恢复，两次拒绝一条痕迹都不留。
    const stopTrailBefore = await jobTrail(first.body.id, 'stop');
    await sql`
      UPDATE automation_jobs SET status = 'completed', completed_at = now()
      WHERE id = ${first.body.id}
    `;
    const stoppedAgain = await call<ErrorBody>('POST', `${firstPath}/stop`, owner);
    expectError(stoppedAgain, 409, 'JOB_NOT_STOPPABLE');
    expect(stoppedAgain.body.error.message).toBe('作业当前状态 completed，不能停止');
    const resumeTrailBefore = await jobTrail(first.body.id, 'resume');
    const resumeCompleted = await call<ErrorBody>('POST', `${firstPath}/resume`, owner);
    expectError(resumeCompleted, 409, 'JOB_NOT_RESUMABLE');
    expect(resumeCompleted.body.error.message).toBe(
      '作业当前状态 completed，只有暂停或中断的作业可以恢复',
    );
    expect(await jobTrail(first.body.id, 'stop')).toEqual(stopTrailBefore);
    expect(await jobTrail(first.body.id, 'resume')).toEqual(resumeTrailBefore);

    await sql`UPDATE automation_jobs SET status = 'failed' WHERE id = ${first.body.id}`;
    const failedStop = await call<ErrorBody>('POST', `${firstPath}/stop`, owner);
    expectError(failedStop, 409, 'JOB_NOT_STOPPABLE');
    expect(failedStop.body.error.message).toBe('作业当前状态 failed，不能停止');
    expect(await jobTrail(first.body.id, 'stop')).toEqual(stopTrailBefore);

    // ⑤ 第一份作业已是终态，同一授权还能再建一份：闸拦的是状态，不是作业条数。
    const second = await createJob(mandate.id, [chapterId('互斥丙章')]);
    expect(second.status).toBe(200);
    const secondPath = `/api/automation/jobs/${second.body.id}`;

    // ⑤ 恢复的两道检查里授权先响：过期授权 + 排队作业同时命中，回答是 MANDATE_EXPIRED
    //    而不是 JOB_NOT_RESUMABLE（:965 排在 :967 之前）；被拒的这次不改作业状态。
    await sql`
      UPDATE automation_mandates SET expires_at = now() - interval '1 minute'
      WHERE id = ${mandate.id}
    `;
    const expiredResume = await call<ErrorBody>('POST', `${secondPath}/resume`, owner);
    expectError(expiredResume, 409, 'MANDATE_EXPIRED');
    expect(await jobStatus(second.body.id)).toBe('queued');
    expect(await mandateRow(mandate.id)).toEqual({ status: 'expired', future: false });
    expect(await jobTrail(second.body.id, 'resume')).toEqual({ audits: '0', events: '0' });

    // ⑥ stopped 是幂等收口：第二次停止返回同一状态，不再落第二份痕迹。
    const stopped = await call<AutomationJobView>('POST', `${secondPath}/stop`, owner);
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe('stopped');
    expect(stopped.body.stopRequested).toBe(true);
    expect(stopped.body.completedAt).toBeTruthy();
    expect(await jobTrail(second.body.id, 'stop')).toEqual({ audits: '1', events: '1' });
    const stoppedTwice = await call<AutomationJobView>('POST', `${secondPath}/stop`, owner);
    expect(stoppedTwice.status).toBe(200);
    expect(stoppedTwice.body.status).toBe('stopped');
    expect(await jobTrail(second.body.id, 'stop')).toEqual({ audits: '1', events: '1' });
    expect(stubRequests).toHaveLength(0);

    // ⑦ 这一族收口后工作区不留活跃作业，下一枪的并发前提是干净的。
    expect(await activeJobCount()).toBe('0');
  });

  it('预检之后、抢锁之前冒出来的并发作业，被事务内的第二道闸挡在 409', async () => {
    stubRequests = [];
    const mandate = await createMandate({ name: '竞态授权' });
    const ownerId = (
      await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${`owner${TEST_EMAIL_SUFFIX}`}`
    )[0]!.id;

    async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await predicate()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    async function advisoryLocks(granted: boolean): Promise<boolean> {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted = ${granted}
          AND a.datname = current_database()
      `;
      return Number(rows[0]!.n) > 0;
    }

    async function conflictTrail(): Promise<{ audits: string; events: string; jobs: string }> {
      const rows = await sql<{ audits: string; events: string; jobs: string }[]>`
        SELECT
          (SELECT count(*)::text FROM audit_log WHERE action = 'automation.job.create'
             AND object_id IN (SELECT id FROM automation_jobs WHERE mandate_id = ${mandate.id})) AS audits,
          (SELECT count(*)::text FROM events WHERE event_type = 'automation.job.queued'
             AND aggregate_id IN (SELECT id FROM automation_jobs WHERE mandate_id = ${mandate.id})) AS events,
          (SELECT count(*)::text FROM automation_jobs WHERE mandate_id = ${mandate.id}) AS jobs
      `;
      return rows[0]!;
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<ApiResult<AutomationJobView>> | null = null;
    try {
      // 先在事务里占住这把工作区级咨询锁，让被测请求必然卡在 :832，
      // 于是"预检已读过、事务还没进"这段窗口被稳定拉开。
      const blocker = sql.begin(async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(hashtextextended(${`automation:${workspaceId}`}, 0))
        `;
        await gate;
      });
      expect(await waitUntil(() => advisoryLocks(true), 3_000)).toBe(true);

      pending = createJob(mandate.id, [chapterId('竞态甲章')]);
      // granted=false 的那一行就是被测事务：它存在，说明预检（:820）已经读过"没有活跃作业"。
      expect(await waitUntil(() => advisoryLocks(false), 3_000)).toBe(true);

      // 预检读完之后才把竞争作业提交：事务里那道同谓词检查（:833）现在必须看见它。
      await sql`
        INSERT INTO automation_jobs (
          id, workspace_id, work_id, mandate_id, status, total_chapters, cost_currency, created_by
        )
        VALUES (${randomUUID()}, ${workspaceId}, ${workId}, ${mandate.id}, 'queued', 1, 'CNY', ${ownerId})
      `;
      release();
      const raced = await pending;
      pending = null;

      expectError(raced, 409, 'AUTOMATION_JOB_CONFLICT');
      expect((raced.body as unknown as ErrorBody).error.message).toBe(
        '当前工作区已有进行中的自动化作业',
      );
      // 拒绝发生在 INSERT 之前：这个授权下只有那条手工插入的竞争作业，零审计零事件。
      expect(await conflictTrail()).toEqual({ audits: '0', events: '0', jobs: '1' });
      expect(stubRequests).toHaveLength(0);

      // 正控制：竞争作业收口之后，同一授权照样能建作业——这道闸拦的是"活跃作业"，
      // 不是"这个授权的第二份作业"。
      await sql`
        UPDATE automation_jobs SET status = 'stopped', completed_at = now()
        WHERE mandate_id = ${mandate.id} AND status IN ('queued', 'running', 'paused')
      `;
      const after = await createJob(mandate.id, [chapterId('竞态甲章')]);
      expect(after.status).toBe(200);
      expect(after.body.status).toBe('queued');
      expect(await conflictTrail()).toEqual({ audits: '1', events: '1', jobs: '2' });
      await stopIfActive(after.body.id);
    } finally {
      release();
      if (pending) await pending;
      await sql`
        UPDATE automation_jobs SET status = 'stopped', completed_at = now()
        WHERE mandate_id = ${mandate.id} AND status IN ('queued', 'running', 'paused')
      `;
    }
  }, 25_000);

  it('作业建好之后服务商端点被改成远程：策略闸在发出任何请求之前挡住这一章', async () => {
    // 远程端点用 RFC 2606 保留的 .invalid：它永远解析不到，所以摘掉守卫的那一枪只会留下
    // "试图出境"的证据（失败原因从策略码变成连接错），而不会把正文真发到某个可路由地址上。
    const REMOTE_BASE_URL = 'http://m4b-policy-drift.invalid/v1';
    const LOCAL_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
    const driftChapter = chapterId('策略漂移章');
    const restoreChapter = chapterId('策略恢复章');

    async function chapterTrail(id: string): Promise<{
      proposals: string;
      calls: string;
      locks: string;
      drafts: string;
      versions: string;
      leases: string;
      status: string;
    }> {
      const rows = await sql<
        {
          proposals: string;
          calls: string;
          locks: string;
          drafts: string;
          versions: string;
          leases: string;
          status: string;
        }[]
      >`
        SELECT
          (SELECT count(*) FROM ai_proposals WHERE chapter_id = ${id})::text AS proposals,
          (SELECT count(*) FROM model_calls WHERE chapter_id = ${id})::text AS calls,
          (SELECT count(*) FROM ai_generation_locks WHERE chapter_id = ${id})::text AS locks,
          (SELECT count(*) FROM draft_revisions dr
             JOIN draft_branches db ON db.id = dr.branch_id
            WHERE db.chapter_id = ${id})::text AS drafts,
          (SELECT count(*) FROM canon_versions WHERE chapter_id = ${id})::text AS versions,
          (SELECT count(*) FROM chapter_leases WHERE chapter_id = ${id})::text AS leases,
          (SELECT status FROM chapters WHERE id = ${id}) AS status
      `;
      return rows[0]!;
    }

    async function workspaceTrail(): Promise<{ audits: string; events: string }> {
      const rows = await sql<{ audits: string; events: string }[]>`
        SELECT
          (SELECT count(*)::text FROM audit_log WHERE workspace_id = ${workspaceId}) AS audits,
          (SELECT count(*)::text FROM events WHERE workspace_id = ${workspaceId}) AS events
      `;
      return rows[0]!;
    }

    // 前一条用例改过桩正文，正控制必须知道自己拿到的是能过门禁的内容，
    // 否则"策略闸挡住"与"门禁挡住"两种红会混在一起。
    stubContent = PASSING_CONTENT;
    stubRequests = [];
    const mandate = await createMandate({ name: '策略漂移授权', allowRemoteModels: false });

    // ① 端点还是本机时同一份授权能建成作业：预检放行，运行时那道闸此刻没东西可拦。
    const job = await createJob(mandate.id, [driftChapter]);
    expect(job.status).toBe(200);
    expect(job.body.status).toBe('queued');
    expect(job.body.preflight.checks.find((check) => check.key === 'remote_policy')?.status).toBe(
      'pass',
    );

    // ② 配置漂移：PATCH 只改 baseUrl，不重新探测、不动密钥。
    const drifted = await call<ModelProviderView>(
      'PATCH',
      `/api/model-providers/${pricedProviderId}`,
      owner,
      { baseUrl: REMOTE_BASE_URL },
    );
    expect(drifted.status).toBe(200);
    expect(drifted.body.baseUrl).toBe(REMOTE_BASE_URL);
    expect(drifted.body.hasKey).toBe(true);

    try {
      // ③ 同一份配置在两个入口给两种答案：预检能"看出来"（remote_policy 直接 fail），
      //    但已经建好的作业不会因为预检而停下——这正是运行时那道 providerFilter 存在的理由。
      const recheck = await preflight(mandate.id, [driftChapter]);
      const policyCheck = recheck.body.checks.find((check) => check.key === 'remote_policy');
      expect(policyCheck?.status).toBe('fail');
      expect(policyCheck?.detail).toContain('远程端点');
      expect(stubRequests).toHaveLength(0);

      const before = await chapterTrail(driftChapter);
      expect(before).toEqual({
        proposals: '0',
        calls: '0',
        locks: '0',
        drafts: '0',
        versions: '0',
        leases: '0',
        status: 'planned',
      });
      const beforeWorkspace = await workspaceTrail();

      await runAutomationTick();

      const blocked = await call<AutomationJobView>(
        'GET',
        `/api/automation/jobs/${job.body.id}`,
        owner,
      );
      expect(blocked.body.status).toBe('completed');
      expect(blocked.body.committedChapters).toBe(0);
      expect(blocked.body.failedChapters).toBe(1);
      expect(blocked.body.spent).toBe(0);
      // 失败章没有费用，recomputeJob 把整份作业标成"费用未知"（那一列的 status 列表含 failed）。
      expect(blocked.body.costUnknown).toBe(true);
      const outcome = blocked.body.chapters.find((item) => item.chapterId === driftChapter);
      expect(outcome?.status).toBe('failed');
      // 归因钉成引号里的码名，而不是只塞进正则：覆盖筛子只认独立带引号的字面量，
      // 把码写成 /^MODEL_POLICY_BLOCKED:/ 会像 §二十一 那样在筛子里假装没测过。
      expect(outcome?.reason?.split(':')[0]).toBe('MODEL_POLICY_BLOCKED');
      expect(outcome?.reason).toContain('没有可用的模型服务商');
      expect(outcome?.proposalId).toBeNull();
      expect(outcome?.versionId).toBeNull();
      expect(outcome?.evaluationId).toBeNull();
      expect(outcome?.cost).toBeNull();

      // ④ 这一章什么都没留下：零提案、零调用、零生成锁、零草稿、零版本、租约已释放，
      //    工作区的审计与事件计数也逐项相等（抛错在提案行与锁的 INSERT 之前）。
      expect(await chapterTrail(driftChapter)).toEqual(before);
      expect(await workspaceTrail()).toEqual(beforeWorkspace);
      expect(stubRequests).toHaveLength(0);

      // ⑤ 正控制：端点改回本机，同一授权的第二份作业照常跑完。
      //    这一枪证明上面那次失败来自策略，而不是夹具坏了。
      const restored = await call<ModelProviderView>(
        'PATCH',
        `/api/model-providers/${pricedProviderId}`,
        owner,
        { baseUrl: LOCAL_BASE_URL },
      );
      expect(restored.status).toBe(200);
      const second = await createJob(mandate.id, [restoreChapter]);
      expect(second.status).toBe(200);
      await runAutomationTick();
      const done = await call<AutomationJobView>(
        'GET',
        `/api/automation/jobs/${second.body.id}`,
        owner,
      );
      expect(done.body.status).toBe('completed');
      expect(done.body.committedChapters).toBe(1);
      expect(done.body.failedChapters).toBe(0);
      expect(done.body.costUnknown).toBe(false);
      expect(stubRequests).toHaveLength(1);
      expect(stubRequests[0]?.body?.model).toBe('stub-chat');
      const runTrail = await chapterTrail(restoreChapter);
      expect(runTrail.proposals).toBe('1');
      expect(runTrail.calls).toBe('1');
      expect(runTrail.versions).toBe('1');
      // 生成锁在收口时释放，租约也不留给下一个持有者。
      expect(runTrail.locks).toBe('0');
      expect(runTrail.leases).toBe('0');
      expect(Number(runTrail.drafts)).toBeGreaterThan(0);
      expect(runTrail.status).toBe('canon');
    } finally {
      // 服务商是整个套件共用的，端点必须还回本机：留给后面的用例一个能跑的夹具。
      await call('PATCH', `/api/model-providers/${pricedProviderId}`, owner, {
        baseUrl: LOCAL_BASE_URL,
      });
    }
  }, 30_000);

  it('预算检查点在两个入口说两句话，末章短路时根本不问预算', async () => {
    // 把 :312 那条 cost_unknown 分支喂饱的最便宜的办法：让端点漂到 RFC 2606 的 .invalid，
    // 章节被运行时策略闸挡下（零调用、零出境），失败章的 cost 为空 → recomputeJob 把整份作业标成费用未知。
    const REMOTE_BASE_URL = 'http://m4b-budget-drift.invalid/v1';
    const LOCAL_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
    // 同一条"费用未知就不许继续"的规则有两处实现，句子并不一样：
    // settleJob（章末检查点）说"；已按预算保护暂停。"，settleBudgetReason + 章首检查点说"，作业在章节检查点暂停。"
    const PAUSE_AT_CHAPTER_END = '有章节费用未知，无法确认是否仍在预算内；已按预算保护暂停。';
    const PAUSE_BEFORE_NEXT_CHAPTER = '有章节费用未知，无法确认是否仍在预算内，作业在章节检查点暂停。';

    stubContent = PASSING_CONTENT;
    stubRequests = [];
    await settleWorkspaceJobs();

    async function jobView(jobId: string): Promise<AutomationJobView> {
      const result = await call<AutomationJobView>('GET', `/api/automation/jobs/${jobId}`, owner);
      expect(result.status).toBe(200);
      return result.body;
    }

    async function drift(baseUrl: string): Promise<void> {
      const result = await call<ModelProviderView>(
        'PATCH',
        `/api/model-providers/${pricedProviderId}`,
        owner,
        { baseUrl },
      );
      expect(result.status).toBe(200);
      expect(result.body.baseUrl).toBe(baseUrl);
    }

    // 中途红掉时也要把作业从 queued/running/paused 里收掉：一份留在"活跃"里的作业
    // 会让同一个工作区下一次 createJob 直接 409（automation-service.ts:835），把一枪的红传染给下一条用例。
    const stopInFinally: string[] = [];

    try {
      // ① 挂了预算、还剩下一章：章末检查点作答。
      const budgeted = await createMandate({ name: '费用未知预算授权', budgetLimit: 1 });
      const first = await createJob(budgeted.id, [
        chapterId('费用未知甲章'),
        chapterId('费用未知乙章'),
      ]);
      expect(first.status).toBe(200);
      stopInFinally.push(first.body.id);
      await drift(REMOTE_BASE_URL);

      await runAutomationTick();

      const paused = await jobView(first.body.id);
      expect(paused.status).toBe('paused');
      expect(paused.lastError).toBe(PAUSE_AT_CHAPTER_END);
      expect(paused.committedChapters).toBe(0);
      expect(paused.failedChapters).toBe(1);
      expect(paused.spent).toBe(0);
      expect(paused.costUnknown).toBe(true);
      const pendingAfterEnd = paused.chapters.find(
        (item) => item.chapterId === chapterId('费用未知乙章'),
      );
      expect(pendingAfterEnd?.status).toBe('pending');
      expect(stubRequests).toHaveLength(0);

      // ② 人工恢复不会让费用变得已知：同一条规则换另一处实现作答，句子也就换了。
      const resumed = await call<AutomationJobView>(
        'POST',
        `/api/automation/jobs/${first.body.id}/resume`,
        owner,
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.status).toBe('queued');

      await runAutomationTick();

      const repaused = await jobView(first.body.id);
      expect(repaused.status).toBe('paused');
      expect(repaused.lastError).toBe(PAUSE_BEFORE_NEXT_CHAPTER);
      expect(repaused.lastError).not.toBe(PAUSE_AT_CHAPTER_END);
      // 章首检查点在下一章开工之前就答"停"，所以甲章仍是唯一有痕迹的一章、桩依旧一枪未开。
      expect(repaused.failedChapters).toBe(1);
      expect(repaused.spent).toBe(0);
      expect(
        repaused.chapters.find((item) => item.chapterId === chapterId('费用未知乙章'))?.status,
      ).toBe('pending');
      expect(stubRequests).toHaveLength(0);

      // 预算保护留下的 paused 仍算"活跃作业"（automation-service.ts:835 把 paused 也算进去），
      // 不先收口就再也建不出下一份作业 —— 本用例的四段共用一个工作区，只能一段一段收。
      await stopIfActive(first.body.id);

      // ③ 挂了预算但只剩这一章：remaining===0 先短路成 completed，预算那条 if 根本没机会问。
      //    所以"挂了 budget_limit 就一定在检查点停"是错的，§二十三 那句话说得太满。
      //    这一段排在正控制之前是有意的：摘掉 :289 短路的反向验证枪只会让这里红，
      //    若先跑正控制，那份留在 running 的作业会被"一个工作区只许一份活跃作业"的闸门传染到下一段。
      await drift(LOCAL_BASE_URL);
      const single = await createMandate({ name: '末章费用未知授权', budgetLimit: 1 });
      const shortJob = await createJob(single.id, [chapterId('末章费用未知章')]);
      expect(shortJob.status).toBe(200);
      stopInFinally.push(shortJob.body.id);
      await drift(REMOTE_BASE_URL);

      await runAutomationTick();

      const ended = await jobView(shortJob.body.id);
      expect(ended.status).toBe('completed');
      expect(ended.lastError).toBeNull();
      expect(ended.costUnknown).toBe(true);
      expect(ended.failedChapters).toBe(1);
      expect(stubRequests).toHaveLength(0);

      // ④ 正控制：同样漂远程、同样两章，唯一变量是不挂预算 —— 费用未知本身拦不住作业，
      //    两章都失败后 remaining===0 收口成 completed。①里停下它的确实是 budget_limit。
      await drift(LOCAL_BASE_URL);
      const free = await createMandate({ name: '费用未知无预算授权', budgetLimit: null });
      const control = await createJob(free.id, [
        chapterId('无预算甲章'),
        chapterId('无预算乙章'),
      ]);
      expect(control.status).toBe(200);
      stopInFinally.push(control.body.id);
      await drift(REMOTE_BASE_URL);

      await runAutomationTick();
      expect((await jobView(control.body.id)).status).toBe('running');

      await runAutomationTick();
      const drained = await jobView(control.body.id);
      expect(drained.status).toBe('completed');
      expect(drained.costUnknown).toBe(true);
      expect(drained.failedChapters).toBe(2);
      expect(drained.lastError).toBeNull();
      expect(stubRequests).toHaveLength(0);
    } finally {
      for (const jobId of stopInFinally) {
        // HTTP 的 stop 对 running 只会举旗（「运行中只举旗」那条用例钉的就是它），
        // 摘掉守卫的那一枪会把作业留在 running，光靠端点收不掉 → 直接把还活跃的行收口，
        // 免得一条用例的红传染成下一条用例的 409。
        await sql`
          UPDATE automation_jobs SET status = 'stopped', runner_id = NULL, heartbeat_at = NULL
          WHERE id = ${jobId} AND status IN ('queued', 'running', 'paused')
        `;
      }
      await call('PATCH', `/api/model-providers/${pricedProviderId}`, owner, {
        baseUrl: LOCAL_BASE_URL,
      });
    }
  }, 60_000);

  it('累计费用冲过预算上限：章末检查点报 0.02，恢复后那一处报 0.0200', async () => {
    // :320 那条"累计费用已达上限"从 HTTP 很难走到：预算闸先按预估输入费扣，
    // 1/1 的价表下每章真实费用 0.0015，而预估输入费就占掉大半，末章总是先撞上调用前的 BUDGET_INSUFFICIENT。
    // 把输出价抬到 100/百万 token（桩固定回报 usage 1000/500），单次真实费用 0.051 ≫ 预算 0.02，
    // 而 0.02 仍够发起这一次调用（预估输入费 ≪ 0.02），检查点这才有的答。价表只在本用例内改，finally 还原。
    const PAUSE_LIMIT_AT_END = '该授权累计费用已达预算上限 0.02，作业在章节检查点暂停。';
    const PAUSE_LIMIT_BEFORE_NEXT = '该授权累计费用已达预算上限 0.0200，作业在章节检查点暂停。';

    stubContent = PASSING_CONTENT;
    stubRequests = [];
    await settleWorkspaceJobs();

    async function jobView(jobId: string): Promise<AutomationJobView> {
      const result = await call<AutomationJobView>('GET', `/api/automation/jobs/${jobId}`, owner);
      expect(result.status).toBe(200);
      return result.body;
    }

    // 中途红掉时也要把作业从 queued/running/paused 里收掉：一份留在"活跃"里的作业
    // 会让同一个工作区下一次 createJob 直接 409（automation-service.ts:835）。
    const stopInFinally: string[] = [];

    try {
      const repriced = await call<ModelProviderView>(
        'PATCH',
        `/api/model-providers/${pricedProviderId}`,
        owner,
        { promptPricePer1m: 1, completionPricePer1m: 100, priceCurrency: 'CNY' },
      );
      expect(repriced.status).toBe(200);
      expect(repriced.body.completionPricePer1m).toBe(100);

      const mandate = await createMandate({ name: '累计达上限授权', budgetLimit: 0.02 });
      const created = await createJob(mandate.id, [
        chapterId('上限触发甲章'),
        chapterId('上限触发乙章'),
      ]);
      expect(created.status).toBe(200);
      stopInFinally.push(created.body.id);

      await runAutomationTick();

      const stopped = await jobView(created.body.id);
      expect(stopped.status).toBe('paused');
      expect(stopped.lastError).toBe(PAUSE_LIMIT_AT_END);
      expect(stopped.committedChapters).toBe(1);
      expect(stopped.failedChapters).toBe(0);
      expect(stopped.costUnknown).toBe(false);
      // 0.051 = 1000/1M×1 + 500/1M×100，computeCost 再按四位小数收口。
      expect(stopped.spent).toBe(0.051);
      expect(stubRequests).toHaveLength(1);
      const maxTokens = stubRequests[0]!.body?.max_tokens;
      // 预算 0.02 扣掉预估输入费后只够约 180-193 tokens 输出：既过得了最低 128，也远小于默认的 1600。
      expect(maxTokens).toBeGreaterThanOrEqual(128);
      expect(maxTokens!).toBeLessThan(500);
      expect(
        stopped.chapters.find((item) => item.chapterId === chapterId('上限触发乙章'))?.status,
      ).toBe('pending');

      // 恢复后同一条规则由章首那处作答：上限取的是库里的 numeric(12,4) 原始串，
      // 于是同一份预算在两句里分别长成 0.02 与 0.0200 —— 记录现状，不改口径。
      const resumed = await call<AutomationJobView>(
        'POST',
        `/api/automation/jobs/${created.body.id}/resume`,
        owner,
      );
      expect(resumed.status).toBe(200);

      await runAutomationTick();

      const repaused = await jobView(created.body.id);
      expect(repaused.status).toBe('paused');
      expect(repaused.lastError).toBe(PAUSE_LIMIT_BEFORE_NEXT);
      expect(repaused.lastError).not.toBe(PAUSE_LIMIT_AT_END);
      expect(repaused.committedChapters).toBe(1);
      expect(repaused.spent).toBe(0.051);
      // 章首检查点在开工前就答"停"：恢复没有多烧一次调用。
      expect(stubRequests).toHaveLength(1);
      expect(
        repaused.chapters.find((item) => item.chapterId === chapterId('上限触发乙章'))?.status,
      ).toBe('pending');
    } finally {
      for (const jobId of stopInFinally) {
        await sql`
          UPDATE automation_jobs SET status = 'stopped', runner_id = NULL, heartbeat_at = NULL
          WHERE id = ${jobId} AND status IN ('queued', 'running', 'paused')
        `;
      }
      await call('PATCH', `/api/model-providers/${pricedProviderId}`, owner, {
        promptPricePer1m: 1,
        completionPricePer1m: 1,
        priceCurrency: 'CNY',
      });
    }
  }, 60_000);
});
