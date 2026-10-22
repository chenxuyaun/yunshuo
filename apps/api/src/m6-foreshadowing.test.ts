import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  LedgerEntryDetail,
  LedgerEntryListResponse,
  LedgerForeshadowingReminders,
  LedgerForeshadowingReport,
  MeResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { buildServer } from './server.js';
import {
  createLedgerEntry,
  getForeshadowingReport,
} from './services/ledger-service.js';

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
const EMAIL_SUFFIX = `@m6-foreshadowing-${RUN_ID}.test`;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M6-3 伏笔集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M6-3 伏笔台账：回收状态、逾期报告与写作台提醒', () => {
  let app: FastifyInstance;
  let workspace = '';
  let outsiderWorkspace = '';
  let work = '';
  let outsiderWork = '';
  let emptyWork = '';
  let chapter1 = '';
  let chapter2 = '';
  let chapter3 = '';
  let chapter4 = '';
  let chapter5 = '';
  let chapter6 = '';
  let emptyChapter = '';
  let outsiderChapter = '';
  let author: Session;
  let reviewer: Session;
  let viewer: Session;
  let billing: Session;
  let outsider: Session;
  let overdueId = '';
  let inWindowId = '';
  let futureId = '';
  let paidOffId = '';
  let abandonedId = '';
  let noWindowId = '';
  let draftOnlyId = '';
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
      VALUES (${versionId}, ${chapterId}, 1, ${content}, ${`hash-${RUN_ID}-${chapterId}`}, ${content.length}, 'human')
    `;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${versionId})
    `;
  }

  async function createForeshadowing(
    session: Session,
    name: string,
    payload: Record<string, unknown>,
    options: { workId?: string } = {},
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      session,
      {
        kind: 'foreshadowing',
        workId: options.workId ?? work,
        name,
        summary: `${name}的伏笔摘要`,
        payload,
      },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function publish(
    session: Session,
    entry: LedgerEntryDetail,
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entry.id}/publish`,
      session,
      { expectedDraftVersionId: entry.draftVersion!.id, changeSummary: '伏笔验收' },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function saveDraft(
    session: Session,
    entryId: string,
    expectedDraftVersionId: string | null,
    payload: Record<string, unknown>,
  ): Promise<ApiResult<LedgerEntryDetail | ErrorBody>> {
    return call<LedgerEntryDetail | ErrorBody>(
      'PUT',
      `/api/ledger/entries/${entryId}/draft`,
      session,
      { expectedDraftVersionId, payload },
    );
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspace = await createWorkspace(`M6-3 伏笔工作区 ${RUN_ID}`);
    outsiderWorkspace = await createWorkspace(`M6-3 外部工作区 ${RUN_ID}`);
    author = await createUser(workspace, `author${EMAIL_SUFFIX}`, '伏笔作者', 'author');
    reviewer = await createUser(workspace, `reviewer${EMAIL_SUFFIX}`, '伏笔审阅者', 'reviewer');
    viewer = await createUser(workspace, `viewer${EMAIL_SUFFIX}`, '伏笔读者', 'viewer');
    billing = await createUser(workspace, `billing${EMAIL_SUFFIX}`, '伏笔计费', 'billing');
    outsider = await createUser(
      outsiderWorkspace,
      `outsider${EMAIL_SUFFIX}`,
      '外部作者',
      'owner',
    );

    work = randomUUID();
    outsiderWork = randomUUID();
    emptyWork = randomUUID();
    const volume = randomUUID();
    chapter1 = randomUUID();
    chapter2 = randomUUID();
    chapter3 = randomUUID();
    chapter4 = randomUUID();
    chapter5 = randomUUID();
    chapter6 = randomUUID();
    emptyChapter = randomUUID();
    outsiderChapter = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${work}, ${workspace}, '伏笔测试作品')`;
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${outsiderWork}, ${outsiderWorkspace}, '外部伏笔作品')
    `;
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${emptyWork}, ${workspace}, '无伏笔作品')
    `;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volume}, ${work}, 1, '第一卷')
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES
        (${chapter1}, ${work}, ${volume}, 1, '徽章初现', 'canon'),
        (${chapter2}, ${work}, ${volume}, 2, '雪夜来客', 'canon'),
        (${chapter3}, ${work}, ${volume}, 3, '纹章揭晓', 'canon'),
        (${chapter4}, ${work}, ${volume}, 4, '余波', 'canon'),
        (${chapter5}, ${work}, ${volume}, 5, '旧信', 'planned'),
        (${chapter6}, ${work}, ${volume}, 6, '王城之火', 'planned')
    `;
    const emptyVolume = randomUUID();
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${emptyVolume}, ${emptyWork}, 1, '空作品卷')
    `;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status)
      VALUES (${emptyChapter}, ${emptyWork}, ${emptyVolume}, 1, '空作品第一章', 'canon')
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

    await seedCanon(chapter1, '林默在旧货摊上买下一枚徽章。');
    await seedCanon(chapter2, '雪夜里，一名来客认出了徽章上的纹章。');
    await seedCanon(chapter3, '纹章被证实属于早已覆灭的王室。');
    await seedCanon(chapter4, '林默把徽章收进衣襟，决定不再示人。');
    await seedCanon(emptyChapter, '空作品的第一章正文。');

    const overdue = await createForeshadowing(author, '王城徽章的纹章', {
      seedChapterId: chapter1,
      payoffChapterMin: 2,
      payoffChapterMax: 3,
      importance: 'high',
      state: 'planted',
      note: '纹章指向覆灭王室，最晚应在第 3 章给出解释。',
    });
    overdueId = overdue.id;
    await publish(author, overdue);

    const inWindow = await createForeshadowing(author, '雪夜来客的身份', {
      seedChapterId: chapter2,
      payoffChapterMin: 4,
      payoffChapterMax: 5,
      importance: 'medium',
      state: 'planted',
      note: '来客可能是旧王室幸存者。',
    });
    inWindowId = inWindow.id;
    await publish(author, inWindow);

    const future = await createForeshadowing(author, '旧信的发件人', {
      seedChapterId: chapter3,
      payoffChapterMin: 6,
      payoffChapterMax: 6,
      importance: 'low',
      state: 'planted',
      note: '计划在第六卷末前揭示，不急于回收。',
    });
    futureId = future.id;
    await publish(author, future);

    const paidOff = await createForeshadowing(author, '徽章的第一位主人', {
      seedChapterId: chapter1,
      payoffChapterMin: 1,
      payoffChapterMax: 3,
      importance: 'high',
      state: 'paid_off',
      payoffChapterId: chapter3,
      resolutionNote: '第 3 章通过纹章记录揭示，第一位主人是末代王储。',
      note: '已在第三章回收。',
    });
    paidOffId = paidOff.id;
    await publish(author, paidOff);

    const abandoned = await createForeshadowing(author, '北境狼群的预兆', {
      seedChapterId: chapter1,
      payoffChapterMin: 2,
      payoffChapterMax: 4,
      importance: 'low',
      state: 'abandoned',
      resolutionNote: '后续大纲删去狼群线，改用王城政变推进冲突。',
    });
    abandonedId = abandoned.id;
    await publish(author, abandoned);

    const noWindow = await createForeshadowing(author, '尚无窗口的暗线', {
      seedChapterId: chapter1,
      importance: 'medium',
      state: 'planted',
      note: '暂不设定回收窗口。',
    });
    noWindowId = noWindow.id;
    await publish(author, noWindow);

    const draftOnly = await createForeshadowing(author, '未发布伏笔', {
      seedChapterId: chapter1,
      payoffChapterMin: 2,
      payoffChapterMax: 2,
      state: 'planted',
      note: '只存在于草稿。',
    });
    draftOnlyId = draftOnly.id;
  });

  afterAll(async () => {
    for (const workspaceId of [workspace, outsiderWorkspace].filter(Boolean)) {
      await sql`DELETE FROM ledger_entry_versions WHERE workspace_id = ${workspaceId}`;
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

  it('报告只统计生效版本，逾期优先，草稿不进入报告', async () => {
    const result = await call<LedgerForeshadowingReport>(
      'GET',
      '/api/ledger/foreshadowing/report',
      reviewer,
    );
    expect(result.status).toBe(200);
    const report = result.body;
    expect(report.workId).toBeNull();
    expect(report.summary).toEqual({
      total: 6,
      unresolved: 4,
      overdue: 1,
      paidOff: 1,
      abandoned: 1,
    });
    expect(report.items.map((item) => item.id)).not.toContain(draftOnlyId);
    expect(report.items[0]).toMatchObject({
      id: overdueId,
      state: 'planted',
      overdue: true,
      overdueBy: 1,
      basis: 'current',
    });
    expect(report.items[0]?.latestCanonChapter?.number).toBe(4);
    expect(report.items.find((item) => item.id === paidOffId)).toMatchObject({
      state: 'paid_off',
      payoffChapter: { id: chapter3, number: 3 },
      overdue: false,
    });
    expect(report.items.find((item) => item.id === noWindowId)?.overdue).toBe(false);
    expect(report.note).toContain('不改变状态');

    const byWork = await call<LedgerForeshadowingReport>(
      'GET',
      `/api/ledger/foreshadowing/report?workId=${work}`,
      viewer,
    );
    expect(byWork.status).toBe(200);
    expect(byWork.body.workId).toBe(work);
    expect(byWork.body.summary.total).toBe(6);

    const list = await call<LedgerEntryListResponse>(
      'GET',
      `/api/ledger/entries?kind=foreshadowing&workId=${work}`,
      author,
    );
    expect(list.status).toBe(200);
    const draftSummary = list.body.entries.find((item) => item.id === draftOnlyId);
    expect(draftSummary?.foreshadowing).toMatchObject({
      state: 'planted',
      basis: 'draft',
      overdue: true,
      overdueBy: 2,
    });
    expect(
      list.body.entries.find((item) => item.id === overdueId)?.foreshadowing,
    ).toMatchObject({ overdue: true, overdueBy: 1 });
  });

  it('写作台提醒只列已埋设、已进入窗口或已逾期的生效伏笔', async () => {
    const atChapter4 = await call<LedgerForeshadowingReminders>(
      'GET',
      `/api/ledger/foreshadowing/reminders?chapterId=${chapter4}`,
      author,
    );
    expect(atChapter4.status).toBe(200);
    expect(atChapter4.body.chapter.number).toBe(4);
    expect(atChapter4.body.latestCanonChapter?.number).toBe(4);
    expect(atChapter4.body.reminders.map((item) => item.id)).toEqual([
      overdueId,
      inWindowId,
    ]);
    expect(atChapter4.body.reminders[0]).toMatchObject({
      reason: 'overdue',
      overdueBy: 1,
      versionNo: 1,
    });
    expect(atChapter4.body.reminders[0]?.message).toContain('已逾期 1 章');
    expect(atChapter4.body.reminders[1]).toMatchObject({
      reason: 'in_window',
      state: 'planted',
    });
    expect(atChapter4.body.reminders[1]?.message).toContain('第 4 章进入回收窗口');
    expect(atChapter4.body.reminders.map((item) => item.id)).not.toContain(futureId);
    expect(atChapter4.body.reminders.map((item) => item.id)).not.toContain(paidOffId);
    expect(atChapter4.body.reminders.map((item) => item.id)).not.toContain(abandonedId);
    expect(atChapter4.body.reminders.map((item) => item.id)).not.toContain(draftOnlyId);
    expect(atChapter4.body.reminders.map((item) => item.id)).not.toContain(noWindowId);
    expect(atChapter4.body.note).toContain('提醒');

    const atChapter3 = await call<LedgerForeshadowingReminders>(
      'GET',
      `/api/ledger/foreshadowing/reminders?chapterId=${chapter3}`,
      viewer,
    );
    expect(atChapter3.status).toBe(200);
    expect(atChapter3.body.reminders.map((item) => item.id)).toEqual([overdueId]);

    const atChapter6 = await call<LedgerForeshadowingReminders>(
      'GET',
      `/api/ledger/foreshadowing/reminders?chapterId=${chapter6}`,
      author,
    );
    expect(atChapter6.status).toBe(200);
    expect(atChapter6.body.reminders.map((item) => item.id)).toEqual([
      overdueId,
      futureId,
    ]);
    expect(atChapter6.body.reminders.find((item) => item.id === futureId)).toMatchObject({
      reason: 'in_window',
    });
    expect(atChapter6.body.reminders.map((item) => item.id)).not.toContain(inWindowId);
  });

  it('没有伏笔的作品仍返回当前正典与空状态说明', async () => {
    const result = await call<LedgerForeshadowingReminders>(
      'GET',
      `/api/ledger/foreshadowing/reminders?chapterId=${emptyChapter}`,
      author,
    );
    expect(result.status).toBe(200);
    expect(result.body.latestCanonChapter?.number).toBe(1);
    expect(result.body.latestCanonChapter?.id).toBe(emptyChapter);
    expect(result.body.reminders).toEqual([]);
    expect(result.body.note).toContain('尚未发布伏笔台账');
  });

  it('草稿改动不进入提醒；发布后才更新报告与摘要', async () => {
    const before = await call<LedgerEntryListResponse>(
      'GET',
      `/api/ledger/entries?kind=foreshadowing&workId=${work}`,
      author,
    );
    expect(before.status).toBe(200);
    expect(
      before.body.entries.find((item) => item.id === overdueId)?.foreshadowing?.state,
    ).toBe('planted');

    const saved = await saveDraft(author, overdueId, null, {
      seedChapterId: chapter1,
      payoffChapterMin: 2,
      payoffChapterMax: 3,
      importance: 'high',
      state: 'paid_off',
      payoffChapterId: chapter2,
      resolutionNote: '草稿中改为第二章提前回收。',
      note: '尚未发布。',
    });
    expect(saved.status).toBe(200);

    const afterDraft = await call<LedgerForeshadowingReport>(
      'GET',
      '/api/ledger/foreshadowing/report',
      reviewer,
    );
    expect(afterDraft.status).toBe(200);
    expect(afterDraft.body.items.find((item) => item.id === overdueId)).toMatchObject({
      state: 'planted',
      overdue: true,
      basis: 'current',
    });
    expect(afterDraft.body.summary).toMatchObject({ overdue: 1, paidOff: 1 });

    const reminders = await call<LedgerForeshadowingReminders>(
      'GET',
      `/api/ledger/foreshadowing/reminders?chapterId=${chapter4}`,
      author,
    );
    expect(reminders.status).toBe(200);
    expect(reminders.body.reminders.find((item) => item.id === overdueId)).toMatchObject({
      state: 'planted',
      reason: 'overdue',
    });

    const published = await publish(author, saved.body as LedgerEntryDetail);
    expect(published.currentVersion?.versionNo).toBe(2);
    const afterPublish = await call<LedgerForeshadowingReport>(
      'GET',
      '/api/ledger/foreshadowing/report',
      reviewer,
    );
    expect(afterPublish.status).toBe(200);
    expect(afterPublish.body.items.find((item) => item.id === overdueId)).toMatchObject({
      state: 'paid_off',
      overdue: false,
      payoffChapter: { id: chapter2, number: 2 },
    });
    expect(afterPublish.body.summary).toMatchObject({
      overdue: 0,
      paidOff: 2,
      unresolved: 3,
    });
    expect(
      afterPublish.body.items.some((item) => item.id === overdueId && item.overdue),
    ).toBe(false);
  });

  it('状态只能向前流转，回收必须绑定章节与说明', async () => {
    const entry = await createForeshadowing(author, '需要流转的伏笔', {
      seedChapterId: chapter1,
      payoffChapterMin: 1,
      payoffChapterMax: 3,
      state: 'planted',
    });
    let published = await publish(author, entry);

    const reinforced = await saveDraft(author, entry.id, null, {
      seedChapterId: chapter1,
      payoffChapterMin: 1,
      payoffChapterMax: 3,
      state: 'reinforced',
    });
    expect(reinforced.status).toBe(200);
    published = await publish(author, reinforced.body as LedgerEntryDetail);
    expect(
      (published.currentVersion?.snapshot.payload as { state: string }).state,
    ).toBe('reinforced');

    expectError(
      await saveDraft(author, entry.id, null, {
        seedChapterId: chapter1,
        payoffChapterMin: 1,
        payoffChapterMax: 3,
        state: 'planted',
      }),
      409,
      'LEDGER_FORESHADOWING_TRANSITION',
    );

    expectError(
      await saveDraft(author, entry.id, null, {
        seedChapterId: chapter1,
        payoffChapterMin: 1,
        payoffChapterMax: 3,
        state: 'paid_off',
        payoffChapterId: chapter3,
      }),
      400,
      'VALIDATION',
    );

    const paidOff = await saveDraft(author, entry.id, null, {
      seedChapterId: chapter1,
      payoffChapterMin: 1,
      payoffChapterMax: 3,
      state: 'paid_off',
      payoffChapterId: chapter3,
      resolutionNote: '第三章以对话回收该伏笔。',
    });
    expect(paidOff.status).toBe(200);
    published = await publish(author, paidOff.body as LedgerEntryDetail);
    expect(
      (published.currentVersion?.snapshot.payload as { state: string }).state,
    ).toBe('paid_off');

    expectError(
      await saveDraft(author, entry.id, null, {
        seedChapterId: chapter1,
        payoffChapterMin: 1,
        payoffChapterMax: 3,
        state: 'reinforced',
      }),
      409,
      'LEDGER_FORESHADOWING_TRANSITION',
    );

    expectError(
      await call(
        'POST',
        '/api/ledger/entries',
        author,
        {
          kind: 'foreshadowing',
          workId: work,
          name: '窗口早于埋设',
          payload: {
            seedChapterId: chapter3,
            payoffChapterMin: 2,
            payoffChapterMax: 4,
          },
        },
      ),
      400,
      'LEDGER_PAYOFF_WINDOW_BEFORE_SEED',
    );

    expectError(
      await call(
        'POST',
        '/api/ledger/entries',
        author,
        {
          kind: 'foreshadowing',
          workId: work,
          name: '回收章节超出窗口',
          payload: {
            seedChapterId: chapter1,
            payoffChapterMin: 2,
            payoffChapterMax: 2,
            state: 'paid_off',
            payoffChapterId: chapter3,
            resolutionNote: '故意超出窗口',
          },
        },
      ),
      400,
      'LEDGER_PAYOFF_OUTSIDE_WINDOW',
    );

    expectError(
      await call(
        'POST',
        '/api/ledger/entries',
        author,
        {
          kind: 'foreshadowing',
          workId: work,
          name: '放弃但不写原因',
          payload: {
            seedChapterId: chapter1,
            state: 'abandoned',
          },
        },
      ),
      400,
      'VALIDATION',
    );

    expectError(
      await call(
        'POST',
        '/api/ledger/entries',
        author,
        {
          kind: 'foreshadowing',
          workId: work,
          name: '跨作品埋设',
          payload: {
            seedChapterId: outsiderChapter,
          },
        },
      ),
      404,
      'LEDGER_CHAPTER_NOT_FOUND',
    );

    const abandoned = await createForeshadowing(author, '放弃后不能重开', {
      seedChapterId: chapter1,
      payoffChapterMin: 2,
      payoffChapterMax: 3,
      state: 'abandoned',
      resolutionNote: '大纲调整，放弃这条线。',
    });
    await publish(author, abandoned);
    expectError(
      await saveDraft(author, abandoned.id, null, {
        seedChapterId: chapter1,
        payoffChapterMin: 2,
        payoffChapterMax: 3,
        state: 'planted',
      }),
      409,
      'LEDGER_FORESHADOWING_TRANSITION',
    );
  });

  it('权限与工作区隔离：计费不可读，跨工作区显式失败，AI 只读', async () => {
    expectError(
      await call('GET', '/api/ledger/foreshadowing/report', billing),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call(
        'GET',
        `/api/ledger/foreshadowing/reminders?chapterId=${chapter1}`,
        billing,
      ),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call(
        'GET',
        `/api/ledger/foreshadowing/report?workId=${work}`,
        outsider,
      ),
      404,
      'WORK_NOT_FOUND',
    );
    expectError(
      await call(
        'GET',
        `/api/ledger/foreshadowing/reminders?chapterId=${chapter1}`,
        outsider,
      ),
      404,
      'CHAPTER_NOT_FOUND',
    );
    expectError(
      await call(
        'GET',
        `/api/ledger/foreshadowing/reminders?chapterId=${randomUUID()}`,
        author,
      ),
      404,
      'CHAPTER_NOT_FOUND',
    );

    const aiAuth = {
      user: {
        id: author.me.user.id,
        email: author.me.user.email,
        name: author.me.user.name,
      },
      workspace: author.me.workspace,
      role: 'ai',
      sessionId: randomUUID(),
    } as AuthContext;
    const aiReport = await getForeshadowingReport(aiAuth, work);
    expect(aiReport.summary.total).toBeGreaterThan(0);
    await expect(
      createLedgerEntry(aiAuth, {
        kind: 'foreshadowing',
        workId: work,
        name: 'AI 不能写伏笔',
        aliases: [],
        summary: '',
        sourceChapterId: null,
        payload: {
          seedChapterId: chapter1,
          payoffChapterMin: null,
          payoffChapterMax: null,
          importance: 'medium',
          state: 'planted',
          payoffChapterId: null,
          note: '',
          resolutionNote: '',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
