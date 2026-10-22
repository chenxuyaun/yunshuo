import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  ChapterDetail,
  ChapterListItem,
  ImportChaptersInput,
  ImportChaptersResponse,
  MeResponse,
  VersionDetail,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { countWords } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from './passwords.js';
import { buildServer } from './server.js';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@chapter-import-${RUN_ID}.test`;
const PASSWORD = 'correct-horse-battery-staple';
const WORK_TITLE = `验收长篇 ${RUN_ID}`;
const OTHER_WORK_TITLE = `隔离长篇 ${RUN_ID}`;

const CONTENT_ONE = '旧城雨夜，灯火在雨里碎成一片。\n\n他握紧伞柄，听见远处有人叫他的名字。';
const CONTENT_TWO = '封印之前，祠堂里只剩一盏油灯。\n\n族老把钥匙交到他手里，说天亮前不要回头。';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('章节导入集成测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;
const passwordHash = dbAvailable ? await hashPassword(PASSWORD) : '';

suite('旧章导入：迁移版本、权限与冲突边界', () => {
  let app: FastifyInstance;
  let primaryWorkspaceId = '';
  let otherWorkspaceId = '';
  let owner: Session;
  let author: Session;
  let reviewer: Session;
  let billing: Session;
  let otherOwner: Session;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  async function login(email: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof rawCookie !== 'string') throw new Error('登录未返回会话 Cookie');
    return { cookie: rawCookie.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(
    workspaceId: string,
    email: string,
    name: string,
    role: string,
  ): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await sql`
      INSERT INTO users (id, email, name, password_hash, password_updated_at)
      VALUES (${id}, ${email}, ${name}, ${passwordHash}, now())
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return id;
  }

  async function call<T>(
    method: 'GET' | 'POST',
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

  async function importAs(
    session: Session,
    input: ImportChaptersInput,
  ): Promise<ApiResult<ImportChaptersResponse | ErrorBody>> {
    return call<ImportChaptersResponse | ErrorBody>(
      'POST',
      '/api/chapters/import',
      session,
      input,
    );
  }

  function expectError(result: ApiResult<unknown>, status: number, code: string): void {
    expect(result.status).toBe(status);
    expect((result.body as ErrorBody).error.code).toBe(code);
  }

  async function chapterIdsByNumber(
    workTitle: string,
    workspaceId = primaryWorkspaceId,
  ): Promise<Map<number, string>> {
    const rows = await sql<{ number: number; id: string }[]>`
      SELECT c.number, c.id
      FROM chapters c
      JOIN works w ON w.id = c.work_id
      WHERE w.workspace_id = ${workspaceId} AND w.title = ${workTitle}
      ORDER BY c.number
    `;
    return new Map(rows.map((row) => [row.number, row.id]));
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    primaryWorkspaceId = await createWorkspace(`章节导入验收 ${RUN_ID}`);
    otherWorkspaceId = await createWorkspace(`章节导入隔离 ${RUN_ID}`);

    await createUser(primaryWorkspaceId, `owner${EMAIL_SUFFIX}`, '导入所有者', 'owner');
    await createUser(primaryWorkspaceId, `author${EMAIL_SUFFIX}`, '导入主笔', 'author');
    await createUser(primaryWorkspaceId, `reviewer${EMAIL_SUFFIX}`, '导入审阅', 'reviewer');
    await createUser(primaryWorkspaceId, `billing${EMAIL_SUFFIX}`, '导入计费', 'billing');
    await createUser(otherWorkspaceId, `other${EMAIL_SUFFIX}`, '隔离所有者', 'owner');

    owner = await login(`owner${EMAIL_SUFFIX}`);
    author = await login(`author${EMAIL_SUFFIX}`);
    reviewer = await login(`reviewer${EMAIL_SUFFIX}`);
    billing = await login(`billing${EMAIL_SUFFIX}`);
    otherOwner = await login(`other${EMAIL_SUFFIX}`);
    expect(owner.me.workspace.id).toBe(primaryWorkspaceId);
    expect(otherOwner.me.workspace.id).toBe(otherWorkspaceId);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!dbAvailable) {
      await closeDb();
      return;
    }
    for (const id of userIds) {
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      await sql`DELETE FROM memberships WHERE user_id = ${id}`;
    }
    for (const id of workspaceIds) {
      await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${id}`;
      await sql`DELETE FROM workspaces WHERE id = ${id}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    await closeDb();
  });

  it('所有者导入两章：写入 canon 版本、未评估与未配置索引，并留下审计与事件', async () => {
    const result = await importAs(owner, {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: '第一卷 · 旧城',
      chapters: [
        { number: 1, title: '旧城雨夜', content: CONTENT_ONE },
        { number: 2, title: '封印之前', content: CONTENT_TWO },
      ],
    });
    expect(result.status).toBe(200);
    const body = result.body as ImportChaptersResponse;
    expect(body.workTitle).toBe(WORK_TITLE);
    expect(body.volumeTitle).toBe('第一卷 · 旧城');
    expect(body.imported.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(body.imported[0]?.wordCount).toBe(countWords(CONTENT_ONE));

    const versionRows = await sql<
      {
        version_id: string;
        source: string;
        evaluation_id: string | null;
        content: string;
        word_count: number;
        current_version_id: string;
        status: string;
      }[]
    >`
      SELECT
        v.id AS version_id, v.source, v.evaluation_id, v.content, v.word_count,
        c.current_version_id, c.status
      FROM chapters c
      JOIN canon_versions v ON v.chapter_id = c.id
      WHERE c.id = ${body.imported[0]!.id}
    `;
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]).toMatchObject({
      source: 'import',
      evaluation_id: null,
      content: CONTENT_ONE,
      status: 'canon',
      word_count: countWords(CONTENT_ONE),
    });
    expect(versionRows[0]?.current_version_id).toBe(versionRows[0]?.version_id);

    const indexRows = await sql<{ status: string; detail: string | null }[]>`
      SELECT status, detail FROM index_status WHERE chapter_id = ${body.imported[0]!.id}
    `;
    expect(indexRows[0]?.status).toBe('not_configured');
    expect(indexRows[0]?.detail).toContain('迁移导入');

    const auditRows = await sql<
      { action: string; result: string; metadata: { evidence?: string; versionId?: string } }[]
    >`
      SELECT action, result, metadata FROM audit_log
      WHERE workspace_id = ${primaryWorkspaceId}
        AND object_id = ${body.imported[0]!.id}
        AND action = 'chapter.import'
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.result).toBe('success');
    expect(auditRows[0]?.metadata.evidence).toBe('not_evaluated');

    const eventRows = await sql<{ event_type: string; payload: { source?: string } }[]>`
      SELECT event_type, payload FROM events
      WHERE workspace_id = ${primaryWorkspaceId}
        AND aggregate_id = ${body.imported[0]!.id}
    `;
    expect(eventRows.map((row) => row.event_type)).toContain('chapter.imported');
    expect(eventRows[0]?.payload.source).toBe('import');

    const detail = await call<ChapterDetail>(
      'GET',
      `/api/chapters/${body.imported[0]!.id}`,
      owner,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('canon');
    expect(detail.body.currentVersion?.source).toBe('import');
    expect(detail.body.currentVersion?.gateStatus).toBe('not_evaluated');
    expect(detail.body.currentVersion?.evaluationId).toBeNull();
    expect(detail.body.latestEvaluation).toBeNull();
    expect(detail.body.indexStatus?.status).toBe('not_configured');
    expect(detail.body.canEdit).toBe(false);

    const list = await call<ChapterListItem[]>('GET', '/api/chapters', owner);
    expect(list.status).toBe(200);
    expect(list.body.filter((chapter) => chapter.workTitle === WORK_TITLE)).toHaveLength(2);
  });

  it('主笔可导入并复用作品与卷；章节号在工作区内查重', async () => {
    const result = await importAs(author, {
      workTitle: WORK_TITLE,
      volumeNumber: 2,
      volumeTitle: '第二卷 · 封印',
      chapters: [{ number: 3, title: '钥匙', content: '天亮前不要回头。' }],
    });
    expect(result.status).toBe(200);
    const body = result.body as ImportChaptersResponse;
    const firstRows = await sql<{ work_id: string; volume_id: string }[]>`
      SELECT work_id, volume_id FROM chapters
      WHERE id = ${body.imported[0]!.id}
    `;
    const volumeOneRows = await sql<{ id: string }[]>`
      SELECT c.volume_id AS id FROM chapters c WHERE c.number = 1 AND c.work_id = ${firstRows[0]!.work_id}
    `;
    expect(firstRows[0]?.work_id).toBe(body.workId);
    expect(firstRows[0]?.volume_id).toBe(body.volumeId);
    expect(firstRows[0]?.volume_id).not.toBe(volumeOneRows[0]?.id);

    const conflict = await importAs(owner, {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: '第一卷 · 旧城',
      chapters: [
        { number: 3, title: '重复钥匙', content: '不应写入。' },
        { number: 4, title: '未写入', content: '也不应写入。' },
      ],
    });
    expectError(conflict, 409, 'CHAPTER_NUMBER_EXISTS');
    const numbers = await chapterIdsByNumber(WORK_TITLE);
    expect([...numbers.keys()]).toEqual([1, 2, 3]);
  });

  it('同一作品中新增章节会复用已有作品与卷', async () => {
    const result = await importAs(owner, {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: '第一卷 · 旧城',
      chapters: [{ number: 4, title: '归途', content: '雨停在渡口。' }],
    });
    expect(result.status).toBe(200);
    const body = result.body as ImportChaptersResponse;
    expect(body.workId).toBeTruthy();
    expect(body.volumeId).toBeTruthy();
    const volumeRows = await sql<{ id: string }[]>`
      SELECT id FROM volumes WHERE work_id = ${body.workId} AND number = 1
    `;
    expect(volumeRows).toHaveLength(1);
    expect(volumeRows[0]?.id).toBe(body.volumeId);
    expect((await chapterIdsByNumber(WORK_TITLE)).size).toBe(4);

    const mismatch = await importAs(owner, {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: '第一卷 · 错名',
      chapters: [{ number: 6, title: '不应写入', content: '卷名不一致时整批拒绝。' }],
    });
    expectError(mismatch, 409, 'VOLUME_TITLE_MISMATCH');
    expect((await chapterIdsByNumber(WORK_TITLE)).size).toBe(4);
  });

  it('同一作品并发导入相同章节号时串行处理，只写入一份', async () => {
    const title = `并发导入 ${RUN_ID}`;
    const input: ImportChaptersInput = {
      workTitle: title,
      volumeNumber: 1,
      volumeTitle: '并发卷',
      chapters: [{ number: 1, title: '并发第一章', content: '同时到达的两份导入。' }],
    };
    const [left, right] = await Promise.all([importAs(owner, input), importAs(author, input)]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);

    const works = await sql<{ id: string }[]>`
      SELECT id FROM works WHERE workspace_id = ${primaryWorkspaceId} AND title = ${title}
    `;
    expect(works).toHaveLength(1);
    const chapters = await sql<{ id: string }[]>`
      SELECT id FROM chapters WHERE work_id = ${works[0]!.id}
    `;
    expect(chapters).toHaveLength(1);
    const volumes = await sql<{ id: string }[]>`
      SELECT id FROM volumes WHERE work_id = ${works[0]!.id}
    `;
    expect(volumes).toHaveLength(1);
  });

  it('已配置启用的嵌入服务时，导入章节排队索引并写入 outbox', async () => {
    const indexWorkspaceId = await createWorkspace(`章节导入索引 ${RUN_ID}`);
    await createUser(indexWorkspaceId, `index${EMAIL_SUFFIX}`, '索引所有者', 'owner');
    const indexOwner = await login(`index${EMAIL_SUFFIX}`);
    expect(indexOwner.me.workspace.id).toBe(indexWorkspaceId);

    const providerId = randomUUID();
    await sql`
      INSERT INTO model_providers (id, workspace_id, name, base_url, model, purpose, is_enabled)
      VALUES (
        ${providerId}, ${indexWorkspaceId}, '导入测试嵌入',
        'http://127.0.0.1:9', 'test-embedding', 'embedding', true
      )
    `;

    const title = `索引长篇 ${RUN_ID}`;
    const result = await importAs(indexOwner, {
      workTitle: title,
      volumeNumber: 1,
      volumeTitle: '索引卷',
      chapters: [{ number: 1, title: '待索引', content: '导入后应排队等待 worker。' }],
    });
    expect(result.status).toBe(200);
    const body = result.body as ImportChaptersResponse;
    const chapterId = body.imported[0]!.id;

    const indexRows = await sql<{ status: string; detail: string | null; version_id: string }[]>`
      SELECT status, detail, version_id FROM index_status WHERE chapter_id = ${chapterId}
    `;
    expect(indexRows[0]?.status).toBe('pending');
    expect(indexRows[0]?.detail).toContain('排队');
    const versionId = indexRows[0]!.version_id;

    const outboxRows = await sql<
      { event_type: string; dedupe_key: string; status: string; payload: { workspaceId?: string } }[]
    >`
      SELECT event_type, dedupe_key, status, payload FROM outbox
      WHERE dedupe_key = ${`index:${versionId}:reindex`}
    `;
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.event_type).toBe('index.chapter');
    expect(outboxRows[0]?.status).toBe('pending');
    expect(outboxRows[0]?.payload.workspaceId).toBe(indexWorkspaceId);
  });

  it('请求内章节号重复时拒绝，且不创建作品、卷或章节', async () => {
    const duplicateTitle = `重复章节 ${RUN_ID}`;
    const result = await importAs(owner, {
      workTitle: duplicateTitle,
      volumeNumber: 1,
      volumeTitle: '第一卷',
      chapters: [
        { number: 5, title: '甲', content: '第一份。' },
        { number: 5, title: '乙', content: '第二份。' },
      ],
    });
    expectError(result, 409, 'CHAPTER_NUMBER_DUPLICATED');

    const workRows = await sql<{ id: string }[]>`
      SELECT id FROM works
      WHERE workspace_id = ${primaryWorkspaceId} AND title = ${duplicateTitle}
    `;
    expect(workRows).toHaveLength(0);
  });

  it('审阅与计费角色不能导入，且不会留下作品', async () => {
    const forbiddenTitle = `无权导入 ${RUN_ID}`;
    const payload: ImportChaptersInput = {
      workTitle: forbiddenTitle,
      volumeNumber: 1,
      volumeTitle: '第一卷',
      chapters: [{ number: 1, title: '越权', content: '不应写入。' }],
    };
    expectError(await importAs(reviewer, payload), 403, 'FORBIDDEN');
    expectError(await importAs(billing, payload), 403, 'FORBIDDEN');

    const workRows = await sql<{ id: string }[]>`
      SELECT id FROM works
      WHERE workspace_id = ${primaryWorkspaceId} AND title = ${forbiddenTitle}
    `;
    expect(workRows).toHaveLength(0);
  });

  it('不同工作区同名作品互不冲突，且不能跨工作区读取', async () => {
    const other = await importAs(otherOwner, {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: '隔离卷',
      chapters: [{ number: 1, title: '别人的第一章', content: '隔离工作区的正文。' }],
    });
    expect(other.status).toBe(200);
    const otherBody = other.body as ImportChaptersResponse;
    expect(otherBody.imported).toHaveLength(1);

    const primaryNumbers = await chapterIdsByNumber(WORK_TITLE);
    expect(primaryNumbers.size).toBe(4);
    expect(primaryNumbers.has(1)).toBe(true);

    const crossRead = await call<ErrorBody>(
      'GET',
      `/api/chapters/${otherBody.imported[0]!.id}`,
      owner,
    );
    expect(crossRead.status).toBe(404);
    expect((crossRead.body as ErrorBody).error.code).toBe('CHAPTER_NOT_FOUND');

    const ownList = await call<ChapterListItem[]>('GET', '/api/chapters', otherOwner);
    expect(ownList.status).toBe(200);
    expect(ownList.body).toHaveLength(1);
    expect(ownList.body[0]?.workTitle).toBe(WORK_TITLE);
  });

  it('正典版本详情按 id 读取：跨工作区与幽灵 id 都是 404，计费角色 403，导入版本仍显示未评估', async () => {
    interface VersionAnchor {
      id: string;
      content: string;
      actorName: string | null;
      versionNo: number;
    }

    async function currentVersion(chapterId: string): Promise<VersionAnchor> {
      const rows = await sql<
        { id: string; content: string; actor_name: string | null; version_no: number }[]
      >`
        SELECT v.id, v.content, u.name AS actor_name, v.version_no
        FROM chapters c
        JOIN canon_versions v ON v.id = c.current_version_id
        LEFT JOIN users u ON u.id = v.actor_id
        WHERE c.id = ${chapterId}
      `;
      const row = rows[0];
      if (!row) throw new Error('章节没有生效正典版本');
      return { id: row.id, content: row.content, actorName: row.actor_name, versionNo: row.version_no };
    }

    const primaryChapterId = (await chapterIdsByNumber(WORK_TITLE)).get(1)!;
    const expected = await currentVersion(primaryChapterId);

    const detail = await call<VersionDetail>(
      'GET',
      `/api/versions/${expected.id}`,
      owner,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(expected.id);
    expect(detail.body.versionNo).toBe(expected.versionNo);
    expect(detail.body.content).toBe(expected.content);
    expect(detail.body.actorName).toBe(expected.actorName);
    expect(detail.body.source).toBe('import');
    expect(detail.body.parentVersionId).toBeNull();
    expect(detail.body.waiver).toBeNull();
    // 导入章节的“未评估”必须在这一页也成立，不能只在列表里显示
    expect(detail.body.evaluationId).toBeNull();
    expect(detail.body.evaluation).toBeNull();
    expect(detail.body.gateStatus).toBe('not_evaluated');

    const foreignChapterId = (
      await chapterIdsByNumber(WORK_TITLE, otherWorkspaceId)
    ).get(1)!;
    const foreign = await currentVersion(foreignChapterId);
    expectError(
      await call<ErrorBody>('GET', `/api/versions/${foreign.id}`, owner),
      404,
      'VERSION_NOT_FOUND',
    );
    expectError(
      await call<ErrorBody>('GET', `/api/versions/${expected.id}`, otherOwner),
      404,
      'VERSION_NOT_FOUND',
    );
    expectError(
      await call<ErrorBody>('GET', `/api/versions/${randomUUID()}`, owner),
      404,
      'VERSION_NOT_FOUND',
    );

    // 读取口径与正典一致：审阅者可读，计费角色不可读正文
    expect((await call('GET', `/api/versions/${expected.id}`, reviewer)).status).toBe(200);
    expectError(
      await call<ErrorBody>('GET', `/api/versions/${expected.id}`, billing),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call<ErrorBody>('GET', '/api/versions/not-a-uuid', owner),
      400,
      'VALIDATION',
    );
  });
});
