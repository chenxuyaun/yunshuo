import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  ChapterDetail,
  ChapterListItem,
  GateEvaluationView,
  MeResponse,
  VolumeView,
  WorkView,
  WorksResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { countWords, sha256 } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { hashPassword } from './passwords.js';
import { buildServer } from './server.js';
import { createWork } from './services/work-structure-service.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@p1-structure-${RUN_ID}.test`;
const PASSWORD = `p1-structure-pass-${randomUUID()}`;
const WORKSPACE_NAME = `作品结构测试 ${RUN_ID}`;

const DRAFT_CONTENT = `旧城的雨没有停。林默把最后一张封印符按进门框，指尖的血线已经凝住。他听见巷口传来追兵的马蹄声，知道封印必须在下一声更鼓之前完成。

他把铜钉一枚枚钉进门槛，嘴里默数。门后是整条街的灯火，也是他不能退让的理由。追兵撞开第一道木栅时，封印只差最后一角。林默没有回头，他咬破指尖，把血按在符心。

雨声忽然静了一瞬。门楣上的旧漆裂开，一道暗金色的纹路顺着门框爬满整条街。追兵停在巷口，像被一堵看不见的墙挡住。林默扶住门框，终于听见更鼓响起。

更鼓过后，街角的雨水倒流回檐下。林默低头看见自己的影子被门框上的金光拉得很长。他知道追兵不会就此放弃，下一次来的，或许不只是人。

雨又落下来，落在封印之上。他完成了封印，也知道这只是开始？`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('作品结构测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;
const passwordHash = dbAvailable ? await hashPassword(PASSWORD) : '';

suite('P1 作品/卷/章结构与排序', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let owner: Session;
  let reviewer: Session;
  let viewer: Session;
  let billing: Session;
  let otherOwner: Session;

  let workId = '';
  let otherWorkId = '';
  let volumeAId = '';
  let volumeBId = '';
  let otherVolumeId = '';

  let chapterAId = '';
  let chapterBId = '';
  let chapterCId = '';
  let chapterDId = '';
  let chapterEId = '';
  let chapterFId = '';

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
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof raw !== 'string') throw new Error(`登录 ${email} 未返回会话 Cookie`);
    return { cookie: raw.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(
    targetWorkspaceId: string,
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
      VALUES (${targetWorkspaceId}, ${id}, ${role})
    `;
    return id;
  }

  async function call<T>(
    session: Session,
    method: Method,
    url: string,
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

  function expectError(result: ApiResult<unknown>, status: number, code: string): ErrorBody {
    expect(result.status).toBe(status);
    const body = result.body as ErrorBody;
    expect(body.error.code).toBe(code);
    return body;
  }

  async function createWorkApi(title: string): Promise<WorkView> {
    const created = await call<WorkView>(owner, 'POST', '/api/works', { title });
    expect(created.status).toBe(200);
    return created.body;
  }

  async function createVolumeApi(work: string, title: string, number?: number): Promise<VolumeView> {
    const created = await call<VolumeView>(owner, 'POST', `/api/works/${work}/volumes`, {
      title,
      ...(number === undefined ? {} : { number }),
    });
    expect(created.status).toBe(200);
    return created.body;
  }

  async function createChapterApi(
    work: string,
    volumeId: string,
    title: string,
    insertAfterChapterId?: string,
  ): Promise<ChapterListItem> {
    const created = await call<ChapterListItem>(owner, 'POST', `/api/works/${work}/chapters`, {
      volumeId,
      title,
      ...(insertAfterChapterId === undefined ? {} : { insertAfterChapterId }),
    });
    expect(created.status).toBe(200);
    return created.body;
  }

  async function chapterNumbers(work: string): Promise<{ id: string; number: number }[]> {
    return sql`
      SELECT id, number FROM chapters WHERE work_id = ${work} ORDER BY number ASC
    `;
  }

  async function makeCanon(chapterId: string, content: string): Promise<string> {
    const versionId = randomUUID();
    const words = countWords(content);
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id, evaluation_id, waiver_id
      )
      VALUES (
        ${versionId}, ${chapterId}, 1, ${content}, ${sha256(content)}, ${words},
        NULL, 'human', ${owner.me.user.id}, NULL, NULL
      )
    `;
    await sql`
      UPDATE chapters
      SET status = 'canon', current_version_id = ${versionId}, updated_at = now()
      WHERE id = ${chapterId}
    `;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id) VALUES (${chapterId}, ${versionId})
    `;
    await sql`
      INSERT INTO chapter_metadata (chapter_id, word_count) VALUES (${chapterId}, ${words})
    `;
    await sql`
      INSERT INTO index_status (chapter_id, version_id, status, detail)
      VALUES (${chapterId}, ${versionId}, 'ready', '结构测试正典索引')
    `;
    return versionId;
  }

  interface WorkCanonSnapshot {
    currentVersionIds: Record<string, string | null>;
    versionRows: { chapter_id: string; version_no: number; content_hash: string }[];
    indexVersionIds: Record<string, string>;
    wordCounts: Record<string, number>;
  }

  async function canonSnapshot(work: string): Promise<WorkCanonSnapshot> {
    const chapters = await sql<{ id: string; current_version_id: string | null }[]>`
      SELECT id, current_version_id FROM chapters WHERE work_id = ${work} ORDER BY id
    `;
    const versionRows = await sql<
      { chapter_id: string; version_no: number; content_hash: string }[]
    >`
      SELECT v.chapter_id, v.version_no, v.content_hash
      FROM canon_versions v JOIN chapters c ON c.id = v.chapter_id
      WHERE c.work_id = ${work}
      ORDER BY v.chapter_id, v.version_no
    `;
    const indexes = await sql<{ chapter_id: string; version_id: string }[]>`
      SELECT i.chapter_id, i.version_id
      FROM index_status i JOIN chapters c ON c.id = i.chapter_id
      WHERE c.work_id = ${work}
      ORDER BY i.chapter_id
    `;
    const metadata = await sql<{ chapter_id: string; word_count: number }[]>`
      SELECT m.chapter_id, m.word_count
      FROM chapter_metadata m JOIN chapters c ON c.id = m.chapter_id
      WHERE c.work_id = ${work}
      ORDER BY m.chapter_id
    `;
    return {
      currentVersionIds: Object.fromEntries(chapters.map((row) => [row.id, row.current_version_id])),
      versionRows,
      indexVersionIds: Object.fromEntries(indexes.map((row) => [row.chapter_id, row.version_id])),
      wordCounts: Object.fromEntries(metadata.map((row) => [row.chapter_id, row.word_count])),
    };
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspaceId = await createWorkspace(WORKSPACE_NAME);
    otherWorkspaceId = await createWorkspace(`结构隔离 ${RUN_ID}`);

    await createUser(workspaceId, `owner${EMAIL_SUFFIX}`, '结构所有者', 'owner');
    await createUser(workspaceId, `reviewer${EMAIL_SUFFIX}`, '结构审阅', 'reviewer');
    await createUser(workspaceId, `viewer${EMAIL_SUFFIX}`, '结构只读', 'viewer');
    await createUser(workspaceId, `billing${EMAIL_SUFFIX}`, '结构计费', 'billing');
    await createUser(otherWorkspaceId, `other${EMAIL_SUFFIX}`, '结构隔离者', 'owner');

    owner = await login(`owner${EMAIL_SUFFIX}`);
    reviewer = await login(`reviewer${EMAIL_SUFFIX}`);
    viewer = await login(`viewer${EMAIL_SUFFIX}`);
    billing = await login(`billing${EMAIL_SUFFIX}`);
    otherOwner = await login(`other${EMAIL_SUFFIX}`);
    expect(owner.me.workspace.id).toBe(workspaceId);
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
      const chapters = await sql<{ id: string }[]>`
        SELECT c.id FROM chapters c JOIN works w ON w.id = c.work_id
        WHERE w.workspace_id = ${id}
      `;
      for (const chapter of chapters) {
        await sql`DELETE FROM commits WHERE chapter_id = ${chapter.id}`;
        await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${chapter.id}`;
      }
      await sql`DELETE FROM workspaces WHERE id = ${id}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    await closeDb();
  });

  it('建作品：列表可见、章节为空，并写事件与审计', async () => {
    const created = await createWorkApi(`结构作品 ${RUN_ID}`);
    expect(created.id).toBeTruthy();
    expect(created.title).toBe(`结构作品 ${RUN_ID}`);
    expect(created.volumes).toEqual([]);
    expect(created.chapterCount).toBe(0);
    expect(created.canonCount).toBe(0);
    workId = created.id;

    const listed = await call<WorksResponse>(owner, 'GET', '/api/works');
    expect(listed.status).toBe(200);
    const found = listed.body.works.find((work) => work.id === workId);
    expect(found).toBeDefined();
    expect(found!.volumes).toEqual([]);

    const chapters = await call<ChapterListItem[]>(owner, 'GET', '/api/chapters');
    expect(chapters.status).toBe(200);
    expect(chapters.body.filter((item) => item.workId === workId)).toEqual([]);

    const events = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      SELECT event_type, payload FROM events
      WHERE aggregate_type = 'work' AND aggregate_id = ${workId}
      ORDER BY id ASC
    `;
    expect(events.map((row) => row.event_type)).toEqual(['work.created']);
    expect(events[0]!.payload.title).toBe(`结构作品 ${RUN_ID}`);

    const audits = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE object_id = ${workId} ORDER BY id ASC
    `;
    expect(audits.map((row) => row.action)).toEqual(['work.create']);

    const renamed = await call<WorkView>(owner, 'PATCH', `/api/works/${workId}`, {
      title: `结构作品改名 ${RUN_ID}`,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe(`结构作品改名 ${RUN_ID}`);

    const sameTitle = await call<WorkView>(owner, 'PATCH', `/api/works/${workId}`, {
      title: `结构作品改名 ${RUN_ID}`,
    });
    expect(sameTitle.status).toBe(200);
    expect(sameTitle.body.title).toBe(`结构作品改名 ${RUN_ID}`);
    const eventsAfterRename = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM events
      WHERE aggregate_type = 'work' AND aggregate_id = ${workId}
    `;
    expect(eventsAfterRename[0]!.count).toBe('1');
  });

  it('建卷自动编号；显式重复卷号返回 VOLUME_NUMBER_TAKEN', async () => {
    const first = await createVolumeApi(workId, '第一卷');
    expect(first.number).toBe(1);
    const second = await createVolumeApi(workId, '第二卷');
    expect(second.number).toBe(2);
    volumeAId = first.id;
    volumeBId = second.id;

    const duplicated = await call<ErrorBody>(owner, 'POST', `/api/works/${workId}/volumes`, {
      title: '重号卷',
      number: 2,
    });
    expectError(duplicated, 409, 'VOLUME_NUMBER_TAKEN');
    expect(duplicated.body.error.details).toEqual({ number: 2 });

    const explicit = await createVolumeApi(workId, '第九卷', 9);
    expect(explicit.number).toBe(9);

    const renamed = await call<VolumeView>(owner, 'PATCH', `/api/volumes/${explicit.id}`, {
      title: '第九卷改名',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: explicit.id, number: 9, title: '第九卷改名' });

    // 让后续排序测试只用两卷。
    await sql`DELETE FROM volumes WHERE id = ${explicit.id}`;
  });

  it('卷排序：非全集排列拒绝，合法排列后卷号连续', async () => {
    const partial = await call<ErrorBody>(owner, 'PUT', `/api/works/${workId}/volumes/order`, {
      volumeIds: [volumeAId],
    });
    expectError(partial, 400, 'VOLUME_ORDER_INVALID');

    const duplicated = await call<ErrorBody>(owner, 'PUT', `/api/works/${workId}/volumes/order`, {
      volumeIds: [volumeAId, volumeAId],
    });
    expectError(duplicated, 400, 'VOLUME_ORDER_INVALID');

    const foreign = await call<ErrorBody>(owner, 'PUT', `/api/works/${workId}/volumes/order`, {
      volumeIds: [volumeAId, randomUUID()],
    });
    expectError(foreign, 400, 'VOLUME_ORDER_INVALID');

    const reordered = await call<VolumeView[]>(owner, 'PUT', `/api/works/${workId}/volumes/order`, {
      volumeIds: [volumeBId, volumeAId],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((volume) => [volume.id, volume.number])).toEqual([
      [volumeBId, 1],
      [volumeAId, 2],
    ]);

    const restored = await call<VolumeView[]>(owner, 'PUT', `/api/works/${workId}/volumes/order`, {
      volumeIds: [volumeAId, volumeBId],
    });
    expect(restored.status).toBe(200);
    expect(restored.body.map((volume) => [volume.id, volume.number])).toEqual([
      [volumeAId, 1],
      [volumeBId, 2],
    ]);
  });

  it('建章取下一个号；插在中间让后续章号顺移且正典行不变', async () => {
    const first = await createChapterApi(workId, volumeAId, '第一章');
    expect(first.number).toBe(1);
    expect(first.status).toBe('planned');
    expect(first.planRevision).toBe(0);
    expect(first.volumeId).toBe(volumeAId);
    chapterAId = first.id;

    const second = await createChapterApi(workId, volumeAId, '第二章');
    expect(second.number).toBe(2);
    chapterBId = second.id;

    const third = await createChapterApi(workId, volumeBId, '第三章');
    expect(third.number).toBe(3);
    chapterCId = third.id;

    const canonVersionId = await makeCanon(chapterBId, DRAFT_CONTENT);
    const before = await canonSnapshot(workId);

    const inserted = await createChapterApi(workId, volumeAId, '插队章', chapterAId);
    expect(inserted.number).toBe(2);
    expect(inserted.volumeId).toBe(volumeAId);
    chapterDId = inserted.id;

    const numbers = await chapterNumbers(workId);
    expect(
      Object.fromEntries(numbers.map((row) => [row.id, row.number])),
    ).toEqual({
      [chapterAId]: 1,
      [chapterDId]: 2,
      [chapterBId]: 3,
      [chapterCId]: 4,
    });

    const after = await canonSnapshot(workId);
    for (const [id, versionId] of Object.entries(before.currentVersionIds)) {
      expect(after.currentVersionIds[id]).toBe(versionId);
    }
    expect(after.versionRows).toEqual(before.versionRows);
    expect(after.indexVersionIds).toEqual(before.indexVersionIds);
    expect(after.wordCounts).toEqual(before.wordCounts);
    expect(after.currentVersionIds[chapterBId]).toBe(canonVersionId);
    expect(after.indexVersionIds[chapterBId]).toBe(canonVersionId);

    const events = await sql<{ event_type: string; payload: Record<string, unknown> }[]>`
      SELECT event_type, payload FROM events
      WHERE aggregate_type = 'chapter' AND aggregate_id = ${chapterDId}
    `;
    expect(events.map((row) => row.event_type)).toEqual(['chapter.created']);
    expect(events[0]!.payload).toMatchObject({
      workId,
      volumeId: volumeAId,
      number: 2,
      insertAfterChapterId: chapterAId,
    });
    const audits = await sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE object_id = ${chapterDId}
    `;
    expect(audits.map((row) => row.action)).toEqual(['chapter.create']);
  });

  it('只改标题：章号、所属卷与正典正文都不变', async () => {
    const before = await canonSnapshot(workId);
    const numbersBefore = await chapterNumbers(workId);

    const updated = await call<ChapterListItem>(owner, 'PATCH', `/api/chapters/${chapterDId}`, {
      title: '插队章改名',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('插队章改名');
    expect(updated.body.number).toBe(2);
    expect(updated.body.volumeId).toBe(volumeAId);

    expect(await chapterNumbers(workId)).toEqual(numbersBefore);
    expect(await canonSnapshot(workId)).toEqual(before);
  });

  it('移到其他卷：只改归属卷，章号不变', async () => {
    const before = await canonSnapshot(workId);
    const updated = await call<ChapterListItem>(owner, 'PATCH', `/api/chapters/${chapterDId}`, {
      volumeId: volumeBId,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.volumeId).toBe(volumeBId);
    expect(updated.body.number).toBe(2);
    expect(await canonSnapshot(workId)).toEqual(before);

    const row = await sql<{ volume_id: string; number: number }[]>`
      SELECT volume_id, number FROM chapters WHERE id = ${chapterDId}
    `;
    expect(row[0]).toEqual({ volume_id: volumeBId, number: 2 });
  });

  it('跨作品/自身位置：404 或 POSITION_TARGET_INVALID，归档章节拒绝改结构', async () => {
    const secondWork = await createWorkApi(`结构作品二 ${RUN_ID}`);
    otherWorkId = secondWork.id;
    const secondVolume = await createVolumeApi(otherWorkId, '外卷');
    otherVolumeId = secondVolume.id;
    const foreignChapter = await createChapterApi(otherWorkId, otherVolumeId, '外部章');

    const foreignVolume = await call<ErrorBody>(owner, 'PATCH', `/api/chapters/${chapterDId}`, {
      volumeId: otherVolumeId,
    });
    expectError(foreignVolume, 404, 'VOLUME_NOT_FOUND');

    const foreignTarget = await call<ErrorBody>(owner, 'POST', `/api/works/${workId}/chapters`, {
      volumeId: volumeAId,
      title: '跨作品插入',
      insertAfterChapterId: foreignChapter.id,
    });
    expectError(foreignTarget, 404, 'CHAPTER_NOT_FOUND');

    const foreignWorkVolume = await call<ErrorBody>(
      owner,
      'POST',
      `/api/works/${otherWorkId}/chapters`,
      {
        volumeId: volumeAId,
        title: '外作品用内卷',
      },
    );
    expectError(foreignWorkVolume, 404, 'VOLUME_NOT_FOUND');

    const selfTarget = await call<ErrorBody>(owner, 'PATCH', `/api/chapters/${chapterBId}`, {
      insertAfterChapterId: chapterBId,
    });
    expectError(selfTarget, 400, 'POSITION_TARGET_INVALID');

    const crossVolumeTarget = await call<ErrorBody>(
      owner,
      'PATCH',
      `/api/chapters/${chapterDId}`,
      { volumeId: volumeBId, insertAfterChapterId: chapterAId },
    );
    expectError(crossVolumeTarget, 400, 'POSITION_TARGET_INVALID');

    const createCrossVolume = await call<ErrorBody>(owner, 'POST', `/api/works/${workId}/chapters`, {
      volumeId: volumeBId,
      title: '跨卷插入',
      insertAfterChapterId: chapterAId,
    });
    expectError(createCrossVolume, 400, 'POSITION_TARGET_INVALID');

    const archived = await createChapterApi(workId, volumeAId, '将归档');
    chapterFId = archived.id;
    await sql`UPDATE chapters SET status = 'archived' WHERE id = ${archived.id}`;
    const archivedEdit = await call<ErrorBody>(owner, 'PATCH', `/api/chapters/${archived.id}`, {
      title: '归档后改名',
    });
    expectError(archivedEdit, 409, 'CHAPTER_ARCHIVED');
  });

  it('新建 planned 章：租约→草稿→门禁链路走得通，缺计划时如实未配置', async () => {
    const created = await createChapterApi(workId, volumeBId, '待写章');
    chapterEId = created.id;
    expect(created.number).toBe(6);
    expect(created.status).toBe('planned');
    expect(created.currentVersionNo).toBeNull();
    expect(created.wordCount).toBeNull();

    const lease = await call<unknown>(owner, 'POST', `/api/chapters/${chapterEId}/lease`);
    expect(lease.status).toBe(200);

    const saved = await call<{ draft: { id: string; contentHash: string } }>(
      owner,
      'PUT',
      `/api/chapters/${chapterEId}/draft`,
      { content: DRAFT_CONTENT },
    );
    expect(saved.status).toBe(200);

    const evaluation = await call<GateEvaluationView>(
      owner,
      'POST',
      `/api/chapters/${chapterEId}/gates`,
    );
    expect(evaluation.status).toBe(200);
    expect(evaluation.body.status).toBe('blocked');
    const results = Object.fromEntries(
      evaluation.body.results.map((item) => [item.key, item.status]),
    );
    expect(results.core_entity).toBe('not_configured');
    expect(results.causality).toBe('not_configured');
    expect(evaluation.body.contextHash.length).toBe(64);

    const detail = await call<ChapterDetail>(owner, 'GET', `/api/chapters/${chapterEId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('writing');
    expect(detail.body.plan).toEqual({
      summary: '',
      beats: [],
      requiredEntities: [],
      goalKeywords: [],
      obstacleKeywords: [],
    });
    expect(detail.body.planRevision).toBe(0);
  });

  it('多作品列表排序：按作品创建时间、卷号、章号', async () => {
    const listed = await call<ChapterListItem[]>(owner, 'GET', '/api/chapters');
    expect(listed.status).toBe(200);
    const scoped = listed.body.filter(
      (item) => item.workId === workId || item.workId === otherWorkId,
    );
    const firstWorkItems = scoped.filter((item) => item.workId === workId);
    const secondWorkItems = scoped.filter((item) => item.workId === otherWorkId);
    expect(secondWorkItems.length).toBe(1);

    const firstWorkIds = firstWorkItems.map((item) => item.id);
    expect(firstWorkIds).toEqual([
      chapterAId,
      chapterBId,
      chapterFId,
      chapterDId,
      chapterCId,
      chapterEId,
    ]);
    expect(firstWorkItems.map((item) => item.number)).toEqual([1, 3, 5, 2, 4, 6]);
    expect(firstWorkItems.map((item) => item.volumeId)).toEqual([
      volumeAId,
      volumeAId,
      volumeAId,
      volumeBId,
      volumeBId,
      volumeBId,
    ]);

    const firstIndex = scoped.findIndex((item) => item.workId === workId);
    const secondIndex = scoped.findIndex((item) => item.workId === otherWorkId);
    expect(firstIndex).toBeLessThan(secondIndex);

    const works = await call<WorksResponse>(owner, 'GET', '/api/works');
    const first = works.body.works.find((work) => work.id === workId)!;
    expect(first.chapterCount).toBe(6);
    expect(first.canonCount).toBe(1);
    expect(first.volumes.map((volume) => [volume.id, volume.number])).toEqual([
      [volumeAId, 1],
      [volumeBId, 2],
    ]);
  });

  it('权限：只读/计费/AI/跨工作区都被挡住', async () => {
    const reviewerCreate = await call<ErrorBody>(reviewer, 'POST', '/api/works', {
      title: '审阅不该建作品',
    });
    expectError(reviewerCreate, 403, 'FORBIDDEN');
    expect(reviewerCreate.body.error.message).toContain('只有所有者、主笔与作者');

    const viewerRename = await call<ErrorBody>(viewer, 'PATCH', `/api/volumes/${volumeAId}`, {
      title: '只读改名',
    });
    expectError(viewerRename, 403, 'FORBIDDEN');

    const billingRead = await call<ErrorBody>(billing, 'GET', '/api/works');
    expectError(billingRead, 403, 'FORBIDDEN');
    expect(billingRead.body.error.message).toContain('计费管理员');

    const reviewerRead = await call<WorksResponse>(reviewer, 'GET', '/api/works');
    expect(reviewerRead.status).toBe(200);
    expect(reviewerRead.body.works.some((work) => work.id === workId)).toBe(true);

    const aiAuth: AuthContext = {
      ...owner.me,
      sessionId: 'ai-structure-session',
      automation: { jobId: randomUUID(), mandateId: randomUUID() },
    };
    await expect(createWork(aiAuth, { title: 'AI 不该建作品' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'AI 主体不能修改作品结构或章节计划',
    });

    const crossWork = await call<ErrorBody>(otherOwner, 'PATCH', `/api/works/${workId}`, {
      title: '跨工作区改名',
    });
    expectError(crossWork, 404, 'WORK_NOT_FOUND');

    const crossCreateVolume = await call<ErrorBody>(
      otherOwner,
      'POST',
      `/api/works/${workId}/volumes`,
      { title: '跨工作区建卷' },
    );
    expectError(crossCreateVolume, 404, 'WORK_NOT_FOUND');

    const crossReorder = await call<ErrorBody>(
      otherOwner,
      'PUT',
      `/api/works/${workId}/volumes/order`,
      { volumeIds: [volumeAId, volumeBId] },
    );
    expectError(crossReorder, 404, 'WORK_NOT_FOUND');

    const crossChapter = await call<ErrorBody>(otherOwner, 'PATCH', `/api/chapters/${chapterAId}`, {
      title: '跨工作区改章',
    });
    expectError(crossChapter, 404, 'CHAPTER_NOT_FOUND');

    const missingWork = await call<ErrorBody>(owner, 'POST', `/api/works/${randomUUID()}/volumes`, {
      title: '无主卷',
    });
    expectError(missingWork, 404, 'WORK_NOT_FOUND');

    const missingVolume = await call<ErrorBody>(owner, 'PATCH', `/api/volumes/${randomUUID()}`, {
      title: '无主卷改名',
    });
    expectError(missingVolume, 404, 'VOLUME_NOT_FOUND');
  });
});
