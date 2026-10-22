import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  LedgerEntryDetail,
  LedgerEntryListResponse,
  LedgerEntryVersionListResponse,
  MeResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { buildServer } from './server.js';
import { createLedgerEntry } from './services/ledger-service.js';

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

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@m6-ledger-${RUN_ID}.test`;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M6 账本集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M6-0 账本：版本、审计、权限与工作区隔离', () => {
  let app: FastifyInstance;
  let workspaceA = '';
  let workspaceB = '';
  let workA = '';
  let workB = '';
  let volumeA = '';
  let chapterA1 = '';
  let chapterA2 = '';
  let chapterB1 = '';
  let owner: Session;
  let lead: Session;
  let author: Session;
  let reviewer: Session;
  let viewer: Session;
  let billing: Session;
  let outsider: Session;
  let settingId = '';
  let settingDraftVersionId = '';
  let characterId = '';
  let foreshadowingId = '';
  const userIds: string[] = [];

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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    session: Session | null,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      ...(session ? { headers: { cookie: session.cookie } } : {}),
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
    workspaceId: string,
    email: string,
    name: string,
    role: 'owner' | 'lead' | 'author' | 'reviewer' | 'viewer' | 'billing',
  ): Promise<Session> {
    const id = randomUUID();
    userIds.push(id);
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${name})`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return login(email);
  }

  async function settingsVersion(workspaceId: string): Promise<number> {
    const rows = await sql<{ settings_version: number; ledger_version: number }[]>`
      SELECT settings_version, ledger_version FROM workspaces WHERE id = ${workspaceId}
    `;
    return rows[0]!.settings_version;
  }

  async function ledgerVersion(workspaceId: string): Promise<number> {
    const rows = await sql<{ settings_version: number; ledger_version: number }[]>`
      SELECT settings_version, ledger_version FROM workspaces WHERE id = ${workspaceId}
    `;
    return rows[0]!.ledger_version;
  }

  async function createSetting(
    session: Session,
    name: string,
    aliases: string[] = [],
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      session,
      {
        kind: 'setting',
        name,
        aliases,
        summary: '王城设定摘要',
        payload: {
          category: 'location',
          details: '王城坐落于河谷北岸。',
          tags: ['王城', '地理'],
          verification: 'verified',
        },
      },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function saveDraft(
    session: Session,
    entryId: string,
    expectedDraftVersionId: string | null,
    patch: Record<string, unknown>,
  ): Promise<ApiResult<LedgerEntryDetail | ErrorBody>> {
    return call<LedgerEntryDetail | ErrorBody>(
      'PUT',
      `/api/ledger/entries/${entryId}/draft`,
      session,
      { expectedDraftVersionId, ...patch },
    );
  }

  async function publish(
    session: Session,
    entryId: string,
    expectedDraftVersionId: string,
  ): Promise<ApiResult<LedgerEntryDetail | ErrorBody>> {
    return call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entryId}/publish`,
      session,
      { expectedDraftVersionId, changeSummary: '发布测试' },
    );
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspaceA = await createWorkspace(`M6 账本工作区 A ${RUN_ID}`);
    workspaceB = await createWorkspace(`M6 账本工作区 B ${RUN_ID}`);
    owner = await createUser(workspaceA, `owner${EMAIL_SUFFIX}`, '账本所有者', 'owner');
    lead = await createUser(workspaceA, `lead${EMAIL_SUFFIX}`, '账本主笔', 'lead');
    author = await createUser(workspaceA, `author${EMAIL_SUFFIX}`, '账本作者', 'author');
    reviewer = await createUser(workspaceA, `reviewer${EMAIL_SUFFIX}`, '账本审阅者', 'reviewer');
    viewer = await createUser(workspaceA, `viewer${EMAIL_SUFFIX}`, '账本读者', 'viewer');
    billing = await createUser(workspaceA, `billing${EMAIL_SUFFIX}`, '账本计费', 'billing');
    outsider = await createUser(workspaceB, `outsider${EMAIL_SUFFIX}`, '外部所有者', 'owner');

    workA = randomUUID();
    workB = randomUUID();
    volumeA = randomUUID();
    chapterA1 = randomUUID();
    chapterA2 = randomUUID();
    chapterB1 = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${workA}, ${workspaceA}, 'M6 账本作品 A')`;
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${workB}, ${workspaceB}, 'M6 账本作品 B')`;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeA}, ${workA}, 1, '第一卷')
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES
        (${chapterA1}, ${workA}, ${volumeA}, 1, '账本第一章', 'canon'),
        (${chapterA2}, ${workA}, ${volumeA}, 2, '账本第二章', 'planned')
    `;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${randomUUID()}, ${workB}, 1, 'B 卷')
    `;
    const volumeB = await sql<{ id: string }[]>`
      SELECT id FROM volumes WHERE work_id = ${workB} LIMIT 1
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES (${chapterB1}, ${workB}, ${volumeB[0]!.id}, 1, 'B 第一章', 'canon')
    `;
  });

  afterAll(async () => {
    if (workspaceA || workspaceB) {
      for (const workspaceId of [workspaceA, workspaceB].filter(Boolean)) {
        await sql`
          DELETE FROM ledger_entry_versions
          WHERE workspace_id = ${workspaceId}
        `;
        await sql`DELETE FROM ledger_entries WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
        await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      }
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (app) await app.close();
    await closeDb();
  });

  it('作者可创建设定草稿；审阅者只读、计费角色不可读、AI 不能写', async () => {
    expectError(
      await call('POST', '/api/ledger/entries', reviewer, {
        kind: 'setting',
        name: '审阅者不能建',
        payload: { category: 'world' },
      }),
      403,
      'FORBIDDEN',
    );
    expectError(await call('GET', '/api/ledger/entries', billing), 403, 'FORBIDDEN');

    const created = await createSetting(author, '王城', ['北境王城']);
    settingId = created.id;
    settingDraftVersionId = created.draftVersion!.id;
    expect(created.kind).toBe('setting');
    expect(created.scope).toBe('workspace');
    expect(created.status).toBe('draft');
    expect(created.currentVersion).toBeNull();
    expect(created.draftVersion?.versionNo).toBe(1);
    expect(created.draftVersion?.snapshot.payload).toMatchObject({
      category: 'location',
      verification: 'verified',
    });

    const versions = await call<LedgerEntryVersionListResponse>(
      'GET',
      `/api/ledger/entries/${settingId}/versions`,
      reviewer,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0]?.changeSummary).toBe('创建草稿');

    const audits = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_log
      WHERE workspace_id = ${workspaceA} AND object_id = ${settingId}
      ORDER BY id ASC
    `;
    expect(audits.map((row) => row.action)).toContain('ledger.entry.create');

    const aiAuth = {
      user: { id: author.me.user.id, email: author.me.user.email, name: author.me.user.name },
      workspace: author.me.workspace,
      role: 'ai',
      sessionId: randomUUID(),
    } as AuthContext;
    await expect(
      createLedgerEntry(aiAuth, {
        kind: 'setting',
        name: 'AI 不能直接写',
        aliases: [],
        summary: '',
        sourceChapterId: null,
        payload: {
          category: 'world',
          details: '',
          tags: [],
          verification: 'unverified',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('名称与别名冲突显式失败，工作区之间互不可见', async () => {
    expectError(
      await call('POST', '/api/ledger/entries', owner, {
        kind: 'setting',
        name: '王城别名冲突',
        aliases: ['北境王城'],
        payload: { category: 'location' },
      }),
      409,
      'LEDGER_NAME_CONFLICT',
    );

    const sameNameInB = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      outsider,
      {
        kind: 'setting',
        name: '王城',
        payload: { category: 'location' },
      },
    );
    expect(sameNameInB.status).toBe(200);

    expectError(
      await call('GET', `/api/ledger/entries/${settingId}`, outsider),
      404,
      'LEDGER_ENTRY_NOT_FOUND',
    );
    const listB = await call<LedgerEntryListResponse>(
      'GET',
      '/api/ledger/entries?q=王城',
      outsider,
    );
    expect(listB.status).toBe(200);
    expect(listB.body.entries.map((entry) => entry.name)).toEqual(['王城']);
    expect(listB.body.entries[0]?.id).not.toBe(settingId);
  });

  it('发布后当前版本生效并递增 settings_version，草稿编辑不提前改活动名称', async () => {
    const beforePublish = await settingsVersion(workspaceA);
    const published = await publish(author, settingId, settingDraftVersionId);
    expect(published.status).toBe(200);
    const active = published.body as LedgerEntryDetail;
    expect(active.status).toBe('active');
    expect(active.currentVersion?.versionNo).toBe(1);
    expect(active.draftVersion).toBeNull();
    expect(await settingsVersion(workspaceA)).toBe(beforePublish + 1);

    const workList = await call<LedgerEntryListResponse>(
      'GET',
      `/api/ledger/entries?workId=${workA}`,
      viewer,
    );
    expect(workList.status).toBe(200);
    expect(workList.body.entries.some((entry) => entry.id === settingId)).toBe(true);

    const draft = await saveDraft(author, settingId, null, {
      name: '王城（修订）',
      summary: '修订后的摘要',
      changeSummary: '改名并改摘要',
    });
    expect(draft.status).toBe(200);
    const withDraft = draft.body as LedgerEntryDetail;
    expect(withDraft.name).toBe('王城');
    expect(withDraft.draftVersion?.versionNo).toBe(2);
    expect(withDraft.draftVersion?.snapshot.name).toBe('王城（修订）');

    const list = await call<LedgerEntryListResponse>(
      'GET',
      '/api/ledger/entries?q=王城',
      viewer,
    );
    expect(list.status).toBe(200);
    expect(list.body.entries[0]?.name).toBe('王城');

    const beforeSecondPublish = await settingsVersion(workspaceA);
    const republished = await publish(author, settingId, withDraft.draftVersion!.id);
    expect(republished.status).toBe(200);
    const renamed = republished.body as LedgerEntryDetail;
    expect(renamed.name).toBe('王城（修订）');
    expect(renamed.currentVersion?.versionNo).toBe(2);
    expect(await settingsVersion(workspaceA)).toBe(beforeSecondPublish + 1);

    const versions = await call<LedgerEntryVersionListResponse>(
      'GET',
      `/api/ledger/entries/${settingId}/versions`,
      reviewer,
    );
    expect(versions.body.versions.map((version) => version.versionNo)).toEqual([2, 1]);
  });

  it('回滚生成新草稿而不直接改活动版本', async () => {
    const rolled = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${settingId}/rollback`,
      author,
      {
        targetVersionNo: 1,
        expectedDraftVersionId: null,
        reason: '恢复初版设定',
      },
    );
    expect(rolled.status).toBe(200);
    const withDraft = rolled.body as LedgerEntryDetail;
    expect(withDraft.currentVersion?.versionNo).toBe(2);
    expect(withDraft.name).toBe('王城（修订）');
    expect(withDraft.draftVersion?.versionNo).toBe(3);
    expect(withDraft.draftVersion?.snapshot.name).toBe('王城');

    const draftVersionId = withDraft.draftVersion!.id;
    const published = await publish(author, settingId, draftVersionId);
    expect(published.status).toBe(200);
    const restored = published.body as LedgerEntryDetail;
    expect(restored.name).toBe('王城');
    expect(restored.currentVersion?.versionNo).toBe(3);
  });

  it('并发编辑同一草稿只有一个成功，另一个返回 409', async () => {
    const draft = await saveDraft(author, settingId, null, {
      summary: '并发编辑基线',
      changeSummary: '并发基线',
    });
    expect(draft.status).toBe(200);
    const draftVersionId = (draft.body as LedgerEntryDetail).draftVersion!.id;

    const [first, second] = await Promise.all([
      saveDraft(lead, settingId, draftVersionId, { summary: '并发 A' }),
      saveDraft(lead, settingId, draftVersionId, { summary: '并发 B' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = (first.status === 200 ? first.body : second.body) as LedgerEntryDetail;
    const loser = (first.status === 409 ? first.body : second.body) as ErrorBody;
    expect(loser.error.code).toBe('LEDGER_DRAFT_CONFLICT');
    expect(winner.draftVersion?.versionNo).toBe(5);

    const published = await publish(author, settingId, winner.draftVersion!.id);
    expect(published.status).toBe(200);
  });

  it('归档需要处理待发布草稿，归档后名称释放且不能再编辑', async () => {
    const draft = await saveDraft(author, settingId, null, {
      summary: '归档前草稿',
      changeSummary: '归档前草稿',
    });
    expect(draft.status).toBe(200);
    const draftVersionId = (draft.body as LedgerEntryDetail).draftVersion!.id;

    expectError(
      await call('POST', `/api/ledger/entries/${settingId}/archive`, owner, {
        reason: '重复条目',
      }),
      409,
      'LEDGER_DRAFT_PENDING',
    );

    const beforeArchive = await settingsVersion(workspaceA);
    const archived = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${settingId}/archive`,
      owner,
      { reason: '重复条目', discardDraft: true },
    );
    expect(archived.status).toBe(200);
    const body = archived.body as LedgerEntryDetail;
    expect(body.status).toBe('archived');
    expect(body.draftVersion).toBeNull();
    expect(body.currentVersion?.versionNo).toBe(5);
    expect(await settingsVersion(workspaceA)).toBe(beforeArchive + 1);

    expectError(
      await saveDraft(author, settingId, null, { summary: '不能再改' }),
      409,
      'LEDGER_ENTRY_ARCHIVED',
    );
    expectError(
      await publish(author, settingId, draftVersionId),
      409,
      'LEDGER_ENTRY_ARCHIVED',
    );

    const replacement = await createSetting(author, '王城', ['北境王城']);
    expect(replacement.status).toBe('draft');
    await call('POST', `/api/ledger/entries/${replacement.id}/archive`, owner, {
      reason: '测试后清理',
    });
  });

  it('角色档案绑定作品与章节，伏笔校验回收信息', async () => {
    const beforeLedger = await ledgerVersion(workspaceA);
    const created = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      lead,
      {
        kind: 'character',
        workId: workA,
        name: '林默',
        aliases: ['默哥'],
        summary: '主角',
        sourceChapterId: chapterA1,
        payload: {
          role: '主角',
          goals: '查清父亲失踪的真相',
          states: [
            {
              asOfChapterId: chapterA1,
              life: 'alive',
              location: '王城',
              knowledge: '知道王城禁令',
              possessions: '一枚旧徽章',
            },
          ],
        },
      },
    );
    expect(created.status).toBe(200);
    const character = created.body as LedgerEntryDetail;
    characterId = character.id;
    expect(character.kind).toBe('character');
    expect(character.scope).toBe('work');

    const published = await publish(lead, characterId, character.draftVersion!.id);
    expect(published.status).toBe(200);
    expect(await ledgerVersion(workspaceA)).toBe(beforeLedger + 1);

    expectError(
      await call('POST', '/api/ledger/entries', lead, {
        kind: 'character',
        name: '无作品角色',
        payload: { role: '路人' },
      }),
      400,
      'VALIDATION',
    );
    expectError(
      await call('POST', '/api/ledger/entries', lead, {
        kind: 'character',
        workId: workA,
        name: '跨作品角色',
        payload: {
          states: [{ asOfChapterId: chapterB1, life: 'alive' }],
        },
      }),
      404,
      'LEDGER_CHAPTER_NOT_FOUND',
    );

    const foreshadowing = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      lead,
      {
        kind: 'foreshadowing',
        workId: workA,
        name: '旧徽章的来历',
        sourceChapterId: chapterA1,
        payload: {
          seedChapterId: chapterA1,
          payoffChapterMin: 2,
          payoffChapterMax: 5,
          importance: 'high',
          state: 'planted',
          note: '徽章上的纹章指向王室',
        },
      },
    );
    expect(foreshadowing.status).toBe(200);
    foreshadowingId = (foreshadowing.body as LedgerEntryDetail).id;

    expectError(
      await call('POST', '/api/ledger/entries', lead, {
        kind: 'foreshadowing',
        workId: workA,
        name: '非法回收伏笔',
        payload: {
          seedChapterId: chapterA1,
          state: 'paid_off',
          payoffChapterId: null,
        },
      }),
      400,
      'VALIDATION',
    );
    expectError(
      await call('POST', '/api/ledger/entries', lead, {
        kind: 'foreshadowing',
        workId: workA,
        name: '跨作品回收伏笔',
        payload: {
          seedChapterId: chapterA1,
          state: 'paid_off',
          payoffChapterId: chapterB1,
          resolutionNote: '跨作品回收测试',
        },
      }),
      404,
      'LEDGER_CHAPTER_NOT_FOUND',
    );

    const byKind = await call<LedgerEntryListResponse>(
      'GET',
      `/api/ledger/entries?kind=foreshadowing&workId=${workA}`,
      viewer,
    );
    expect(byKind.status).toBe(200);
    expect(byKind.body.entries.some((entry) => entry.id === foreshadowingId)).toBe(true);

    const workList = await call<LedgerEntryListResponse>(
      'GET',
      `/api/ledger/entries?workId=${workA}`,
      viewer,
    );
    expect(workList.status).toBe(200);
    expect(workList.body.entries.some((entry) => entry.kind === 'character')).toBe(true);
    expect(workList.body.entries.some((entry) => entry.kind === 'foreshadowing')).toBe(true);
    expect(workList.body.entries.some((entry) => entry.status === 'archived')).toBe(false);
  });
});
