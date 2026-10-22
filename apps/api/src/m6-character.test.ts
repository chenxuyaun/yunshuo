import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  LedgerCharacterContext,
  LedgerCharacterTimeline,
  LedgerEntryDetail,
  MeResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { buildServer } from './server.js';
import { createLedgerEntry, getCharacterTimeline } from './services/ledger-service.js';

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
const EMAIL_SUFFIX = `@m6-character-${RUN_ID}.test`;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M6-2 角色集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M6-2 角色档案：状态时间线、出场扫描与写作台上下文', () => {
  let app: FastifyInstance;
  let workspace = '';
  let outsiderWorkspace = '';
  let work = '';
  let outsiderWork = '';
  let chapter1 = '';
  let chapter2 = '';
  let chapter3 = '';
  let chapter4 = '';
  let outsiderChapter = '';
  let author: Session;
  let reviewer: Session;
  let billing: Session;
  let outsider: Session;
  let linMoId = '';
  let suWanId = '';
  let guXingId = '';
  let wuWenId = '';
  let draftOnlyId = '';
  let settingId = '';
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
    method: 'GET' | 'POST' | 'PUT',
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

  async function seedCanon(chapterId: string, content: string): Promise<void> {
    const versionId = randomUUID();
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source
      )
      VALUES (${versionId}, ${chapterId}, 1, ${content}, ${`hash-${RUN_ID}`}, ${content.length}, 'human')
    `;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${versionId})
    `;
  }

  async function createCharacter(
    session: Session,
    name: string,
    payload: Record<string, unknown>,
    options: { aliases?: string[]; workId?: string; sourceChapterId?: string } = {},
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      session,
      {
        kind: 'character',
        workId: options.workId ?? work,
        name,
        aliases: options.aliases ?? [],
        summary: `${name}的角色档案`,
        sourceChapterId: options.sourceChapterId ?? chapter1,
        payload,
      },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function publish(session: Session, entry: LedgerEntryDetail): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entry.id}/publish`,
      session,
      { expectedDraftVersionId: entry.draftVersion!.id, changeSummary: '角色验收' },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspace = await createWorkspace(`M6-2 角色工作区 ${RUN_ID}`);
    outsiderWorkspace = await createWorkspace(`M6-2 外部工作区 ${RUN_ID}`);
    author = await createUser(workspace, `author${EMAIL_SUFFIX}`, '角色作者', 'author');
    reviewer = await createUser(workspace, `reviewer${EMAIL_SUFFIX}`, '角色审阅者', 'reviewer');
    billing = await createUser(workspace, `billing${EMAIL_SUFFIX}`, '角色计费', 'billing');
    outsider = await createUser(
      outsiderWorkspace,
      `outsider${EMAIL_SUFFIX}`,
      '外部作者',
      'owner',
    );

    work = randomUUID();
    outsiderWork = randomUUID();
    const volume = randomUUID();
    chapter1 = randomUUID();
    chapter2 = randomUUID();
    chapter3 = randomUUID();
    chapter4 = randomUUID();
    outsiderChapter = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${work}, ${workspace}, '角色测试作品')`;
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${outsiderWork}, ${outsiderWorkspace}, '外部作品')
    `;
    await sql`INSERT INTO volumes (id, work_id, number, title) VALUES (${volume}, ${work}, 1, '第一卷')`;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES
        (${chapter1}, ${work}, ${volume}, 1, '初入王城', 'canon'),
        (${chapter2}, ${work}, ${volume}, 2, '雪原之死', 'canon'),
        (${chapter3}, ${work}, ${volume}, 3, '还尸王城', 'canon'),
        (${chapter4}, ${work}, ${volume}, 4, '未写之章', 'planned')
    `;
    const outsiderVolume = randomUUID();
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${outsiderVolume}, ${outsiderWork}, 1, '外部卷')
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES (${outsiderChapter}, ${outsiderWork}, ${outsiderVolume}, 1, '外部第一章', 'canon')
    `;

    await seedCanon(chapter1, '林默走进王城，默哥抬头看天。');
    await seedCanon(chapter2, '林默倒在雪地里，再也没有起身。');
    await seedCanon(chapter3, '众人抬着林默的遗体回到王城。');

    const linMo = await createCharacter(
      author,
      '林默',
      {
        role: '主角',
        appearance: '左眉有旧伤',
        personality: '执拗',
        goals: '查清父亲失踪的真相',
        faction: '北境军',
        abilities: '听风辨位',
        speechStyle: '话少，常用短句',
        relationships: [
          { name: '苏晚', relation: '同门', notes: '少年同门' },
          { name: '苏晚', relation: '恋人', notes: '未公开' },
        ],
        states: [
          {
            asOfChapterId: chapter1,
            life: 'alive',
            location: '王城',
            knowledge: '知道王城禁令',
            possessions: '一枚旧徽章',
            relationshipChanges: '',
          },
          {
            asOfChapterId: chapter2,
            life: 'dead',
            location: '雪原',
            knowledge: '',
            possessions: '旧徽章遗失',
            relationshipChanges: '苏晚与他决裂',
          },
          {
            asOfChapterId: chapter3,
            life: 'alive',
            location: '王城',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      },
      { aliases: ['默哥'], sourceChapterId: chapter1 },
    );
    linMoId = linMo.id;
    await publish(author, linMo);

    const suWan = await createCharacter(
      author,
      '苏晚',
      {
        role: '同门',
        states: [
          { asOfChapterId: chapter1, life: 'alive', location: '王城' },
          { asOfChapterId: chapter3, life: 'dead', location: '雪原' },
        ],
      },
      { sourceChapterId: chapter1 },
    );
    suWanId = suWan.id;
    await publish(author, suWan);

    const guXing = await createCharacter(
      author,
      '顾行',
      {
        role: '后期登场',
        states: [{ asOfChapterId: chapter3, life: 'alive', location: '北境' }],
      },
      { sourceChapterId: chapter3 },
    );
    guXingId = guXing.id;
    await publish(author, guXing);

    const wuWen = await createCharacter(author, '无闻', {
      role: '生死未明的旧人',
      states: [
        { asOfChapterId: chapter1, life: 'dead' },
        { asOfChapterId: chapter2, life: 'unknown' },
      ],
    });
    wuWenId = wuWen.id;
    await publish(author, wuWen);

    const draftOnly = await createCharacter(author, '影卫', {
      role: '暗线',
      states: [{ asOfChapterId: chapter1, life: 'unknown' }],
    });
    draftOnlyId = draftOnly.id;

    const setting = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      author,
      {
        kind: 'setting',
        name: '王城禁令',
        payload: { category: 'rule', details: '入夜后不得出城。' },
      },
    );
    expect(setting.status).toBe(200);
    settingId = (setting.body as LedgerEntryDetail).id;
  });

  afterAll(async () => {
    for (const workspaceId of [workspace, outsiderWorkspace].filter(Boolean)) {
      await sql`DELETE FROM ledger_entry_versions WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
      await sql`DELETE FROM ledger_entries WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (app) await app.close();
    await closeDb();
  });

  it('时间线按章节排序，出场来自当前正典，并给出三类矛盾警告', async () => {
    const result = await call<LedgerCharacterTimeline>(
      'GET',
      `/api/ledger/entries/${linMoId}/timeline`,
      reviewer,
    );
    expect(result.status).toBe(200);
    const timeline = result.body;
    expect(timeline.scanScope).toBe('canon_current');
    expect(timeline.versionNo).toBe(1);
    expect(timeline.states.map((state) => state.chapter.number)).toEqual([1, 2, 3]);
    expect(timeline.states[1]).toMatchObject({
      life: 'dead',
      location: '雪原',
      possessions: '旧徽章遗失',
    });
    expect(timeline.appearances.map((appearance) => appearance.chapter.number)).toEqual([
      1, 2, 3,
    ]);
    expect(timeline.appearances[0]?.matches).toBe(2);
    expect(timeline.firstAppearance?.number).toBe(1);
    expect(timeline.latestAppearance?.number).toBe(3);

    const codes = timeline.warnings.map((warning) => warning.code).sort();
    expect(codes).toEqual(['dead_appears_later', 'dead_revived', 'relationship_conflict']);
    expect(
      timeline.warnings.find((warning) => warning.code === 'dead_appears_later')?.message,
    ).toContain('第 3 章');
  });

  it('死亡后的未知状态不会被误报为复活', async () => {
    const result = await call<LedgerCharacterTimeline>(
      'GET',
      `/api/ledger/entries/${wuWenId}/timeline`,
      author,
    );
    expect(result.status).toBe(200);
    expect(result.body.states.map((state) => state.life)).toEqual(['dead', 'unknown']);
    expect(result.body.warnings).toEqual([]);
  });

  it('时间线只读取生效版本，未发布草稿和改名不会泄漏', async () => {
    const saved = await call<LedgerEntryDetail | ErrorBody>(
      'PUT',
      `/api/ledger/entries/${linMoId}/draft`,
      author,
      {
        expectedDraftVersionId: null,
        name: '林默（草稿改名）',
        payload: {
          role: '主角',
          states: [{ asOfChapterId: chapter1, life: 'unknown', location: '未定' }],
        },
        changeSummary: '未发布改动',
      },
    );
    expect(saved.status).toBe(200);

    const timeline = await call<LedgerCharacterTimeline>(
      'GET',
      `/api/ledger/entries/${linMoId}/timeline`,
      reviewer,
    );
    expect(timeline.status).toBe(200);
    expect(timeline.body.name).toBe('林默');
    expect(timeline.body.versionNo).toBe(1);
    expect(timeline.body.states).toHaveLength(3);
    expect(timeline.body.states[0]?.life).toBe('alive');

    const context = await call<LedgerCharacterContext>(
      'GET',
      `/api/ledger/character-context?chapterId=${chapter3}`,
      reviewer,
    );
    expect(context.status).toBe(200);
    const linMo = context.body.characters.find((item) => item.id === linMoId);
    expect(linMo?.state?.life).toBe('dead');
    expect(linMo?.state?.location).toBe('雪原');

    const versionList = await sql<{ version_no: number; snapshot: { name: string } }[]>`
      SELECT version_no, snapshot FROM ledger_entry_versions
      WHERE entry_id = ${linMoId} ORDER BY version_no ASC
    `;
    expect(versionList.map((version) => version.version_no)).toEqual([1, 2]);
    expect(versionList[0]?.snapshot.name).toBe('林默');
  });

  it('写作台上下文截至上一章，不泄漏后续状态，并标记过期状态', async () => {
    const atChapter3 = await call<LedgerCharacterContext>(
      'GET',
      `/api/ledger/character-context?chapterId=${chapter3}`,
      author,
    );
    expect(atChapter3.status).toBe(200);
    expect(atChapter3.body.chapter.number).toBe(3);
    expect(atChapter3.body.asOfChapter?.number).toBe(2);
    const linMo = atChapter3.body.characters.find((item) => item.id === linMoId);
    expect(linMo?.state?.chapter.number).toBe(2);
    expect(linMo?.state?.life).toBe('dead');
    expect(linMo?.stale).toBe(false);
    const suWan = atChapter3.body.characters.find((item) => item.id === suWanId);
    expect(suWan?.state?.chapter.number).toBe(1);
    expect(suWan?.state?.life).toBe('alive');
    expect(suWan?.stale).toBe(true);
    expect(atChapter3.body.note).toContain('截至上一章');
    expect(atChapter3.body.omittedCharacters).toBe(1);
    expect(atChapter3.body.characters.map((item) => item.id)).not.toContain(guXingId);
    expect(atChapter3.body.characters.map((item) => item.name)).not.toContain('顾行');

    const atChapter4 = await call<LedgerCharacterContext>(
      'GET',
      `/api/ledger/character-context?chapterId=${chapter4}`,
      author,
    );
    expect(atChapter4.status).toBe(200);
    expect(atChapter4.body.asOfChapter?.number).toBe(3);
    expect(
      atChapter4.body.characters.find((item) => item.id === linMoId)?.state?.life,
    ).toBe('alive');
    expect(
      atChapter4.body.characters.find((item) => item.id === suWanId)?.state?.life,
    ).toBe('dead');
    expect(
      atChapter4.body.characters.find((item) => item.id === guXingId)?.state?.chapter.number,
    ).toBe(3);
    expect(atChapter4.body.omittedCharacters).toBe(0);

    const atChapter1 = await call<LedgerCharacterContext>(
      'GET',
      `/api/ledger/character-context?chapterId=${chapter1}`,
      author,
    );
    expect(atChapter1.status).toBe(200);
    expect(atChapter1.body.asOfChapter).toBeNull();
    expect(atChapter1.body.characters).toHaveLength(0);
    expect(atChapter1.body.omittedCharacters).toBe(4);
    expect(atChapter1.body.note).toContain('开篇章节');

    const ids = atChapter3.body.characters.map((item) => item.id);
    expect(ids).not.toContain(draftOnlyId);
  });

  it('权限、未发布与跨作品边界显式失败', async () => {
    const reviewerRead = await call<LedgerCharacterContext>(
      'GET',
      `/api/ledger/character-context?chapterId=${chapter1}`,
      reviewer,
    );
    expect(reviewerRead.status).toBe(200);

    expectError(
      await call('GET', `/api/ledger/entries/${linMoId}/timeline`, billing),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call('GET', `/api/ledger/character-context?chapterId=${chapter1}`, billing),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call('GET', `/api/ledger/entries/${linMoId}/timeline`, outsider),
      404,
      'LEDGER_ENTRY_NOT_FOUND',
    );
    expectError(
      await call('GET', `/api/ledger/character-context?chapterId=${chapter1}`, outsider),
      404,
      'CHAPTER_NOT_FOUND',
    );
    expectError(
      await call('GET', `/api/ledger/entries/${draftOnlyId}/timeline`, author),
      409,
      'LEDGER_CHARACTER_NOT_PUBLISHED',
    );
    expectError(
      await call('GET', `/api/ledger/entries/${settingId}/timeline`, author),
      404,
      'LEDGER_ENTRY_NOT_FOUND',
    );

    const aiAuth = {
      user: { id: author.me.user.id, email: author.me.user.email, name: author.me.user.name },
      workspace: author.me.workspace,
      role: 'ai',
      sessionId: randomUUID(),
    } as AuthContext;
    const aiTimeline = await getCharacterTimeline(aiAuth, linMoId);
    expect(aiTimeline.entryId).toBe(linMoId);
    await expect(
      createLedgerEntry(aiAuth, {
        kind: 'character',
        workId: work,
        name: 'AI 不能写角色',
        aliases: [],
        summary: '',
        sourceChapterId: null,
        payload: {
          role: 'AI',
          appearance: '',
          personality: '',
          goals: '',
          faction: '',
          abilities: '',
          speechStyle: '',
          relationships: [],
          states: [],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('同一章节重复状态与跨作品章节显式失败', async () => {
    const duplicate = await call<ErrorBody | LedgerEntryDetail>(
      'POST',
      '/api/ledger/entries',
      author,
      {
        kind: 'character',
        workId: work,
        name: '重复状态角色',
        payload: {
          states: [
            { asOfChapterId: chapter1, life: 'alive' },
            { asOfChapterId: chapter1, life: 'dead' },
          ],
        },
      },
    );
    expectError(duplicate, 400, 'LEDGER_STATE_DUPLICATE_CHAPTER');

    const crossWork = await call<ErrorBody | LedgerEntryDetail>(
      'POST',
      '/api/ledger/entries',
      author,
      {
        kind: 'character',
        workId: work,
        name: '跨作品状态角色',
        payload: { states: [{ asOfChapterId: outsiderChapter, life: 'alive' }] },
      },
    );
    expectError(crossWork, 404, 'LEDGER_CHAPTER_NOT_FOUND');

    const detail = await call<LedgerEntryDetail>(
      'GET',
      `/api/ledger/entries/${linMoId}`,
      author,
    );
    const duplicateDraft = await call<ErrorBody | LedgerEntryDetail>(
      'PUT',
      `/api/ledger/entries/${linMoId}/draft`,
      author,
      {
        expectedDraftVersionId: detail.body.draftVersion?.id ?? null,
        payload: {
          states: [
            { asOfChapterId: chapter1, life: 'alive' },
            { asOfChapterId: chapter1, life: 'dead' },
          ],
        },
      },
    );
    expectError(duplicateDraft, 400, 'LEDGER_STATE_DUPLICATE_CHAPTER');
  });
});
