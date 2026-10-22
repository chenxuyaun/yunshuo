import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  LedgerEntryDetail,
  LedgerSuggestionListResponse,
  LedgerSuggestionView,
  MeResponse,
} from '@yunshuo/contracts';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import type { ChapterPlan } from '@yunshuo/domain';
import { countWords } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const EMAIL_SUFFIX = `@m6-suggestion-${RUN_ID}.test`;
const CHARACTER_JSON =
  '{"life":"dead","location":"井底","knowledge":"铜钉是钥匙","possessions":"","relationshipChanges":"与沈砚反目","rationale":"正文写他坠井后不再应答"}';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M6-7 账本建议测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M6-7 账本 AI 建议：生成、人工确认与仅写草稿', () => {
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let chatReply = CHARACTER_JSON;
  let chatStatus = 200;
  const chatBodies: { messages: { role: string; content: string }[]; max_tokens: number }[] = [];

  let workspace = '';
  let outsider = '';
  let work = '';
  let volume = '';
  let chapterOne = '';
  let chapterTwo = '';
  let chapterThree = '';
  let providerId = '';
  let owner: Session;
  let author: Session;
  let reviewer: Session;
  let viewer: Session;
  let billing: Session;
  let outsiderOwner: Session;
  const userIds: string[] = [];

  function contentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  async function login(email: string): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email } });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!rawCookie) throw new Error('登录未返回会话 Cookie');
    return { cookie: rawCookie.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
    expect(result.status, `响应体：${JSON.stringify(result.body)}`).toBe(status);
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
    role: 'owner' | 'author' | 'reviewer' | 'viewer' | 'billing',
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

  async function createChapter(number: number, title: string, content: string | null): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (
        ${id}, ${work}, ${volume}, ${number}, ${title},
        ${content === null ? 'planned' : 'canon'},
        ${sql.json(jsonValue({} satisfies ChapterPlan))}
      )
    `;
    if (content !== null) {
      const versionId = randomUUID();
      await sql`
        INSERT INTO canon_versions (
          id, chapter_id, version_no, content, content_hash, word_count, source
        )
        VALUES (
          ${versionId}, ${id}, 1, ${content}, ${contentHash(content)},
          ${countWords(content)}, 'human'
        )
      `;
      await sql`UPDATE chapters SET current_version_id = ${versionId} WHERE id = ${id}`;
      await sql`INSERT INTO canon_current (chapter_id, version_id) VALUES (${id}, ${versionId})`;
    }
    return id;
  }

  async function createEntry(input: Record<string, unknown>): Promise<LedgerEntryDetail> {
    const created = await call<LedgerEntryDetail | ErrorBody>('POST', '/api/ledger/entries', owner, input);
    expect(
      created.status,
      `创建条目失败：${JSON.stringify(created.body)}`,
    ).toBe(200);
    const entry = created.body as LedgerEntryDetail;
    const published = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entry.id}/publish`,
      owner,
      { expectedDraftVersionId: entry.draftVersion!.id, changeSummary: 'M6-7 测试发布' },
    );
    expect(published.status, `发布条目失败：${JSON.stringify(published.body)}`).toBe(200);
    return published.body as LedgerEntryDetail;
  }

  function characterInput(name: string) {
    return {
      kind: 'character',
      workId: work,
      name,
      aliases: [`${name}的别称`],
      summary: '北门守夜人',
      sourceChapterId: chapterOne,
      payload: {
        role: '守夜人',
        faction: '王城',
        appearance: '披旧斗篷',
        personality: '沉默',
        goals: '守住北门',
        abilities: '辨认铜钉银纹',
        speechStyle: '简短',
        relationships: [{ name: '沈砚', relation: '同僚', notes: '' }],
        states: [
          {
            asOfChapterId: chapterOne,
            life: 'alive',
            location: '北门',
            knowledge: '铜钉在雨夜发亮',
            possessions: '铜钉',
            relationshipChanges: '',
          },
        ],
      },
    };
  }

  function foreshadowingInput(
    name: string,
    state: 'planted' | 'paid_off',
    payoffMin: number | null,
    payoffMax: number | null,
  ) {
    return {
      kind: 'foreshadowing',
      workId: work,
      name,
      aliases: [],
      summary: '铜钉银纹在月缺时发暗',
      sourceChapterId: chapterOne,
      payload: {
        seedChapterId: chapterOne,
        payoffChapterMin: payoffMin,
        payoffChapterMax: payoffMax,
        importance: 'high',
        state,
        payoffChapterId: state === 'paid_off' ? chapterOne : null,
        note: '黑潮专属标记：铜钉银纹发暗时，北门将迎来黑潮。',
        resolutionNote: state === 'paid_off' ? '第一章已明确旧潮退去。' : '',
      },
    };
  }

  async function generate(
    entryId: string,
    basisChapterId: string,
    session: Session = owner,
    instruction = '',
  ): Promise<ApiResult<LedgerSuggestionView | ErrorBody>> {
    return call<LedgerSuggestionView | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entryId}/suggestions`,
      session,
      { basisChapterId, instruction },
    );
  }

  async function suggestionOf(entryId: string, id: string): Promise<LedgerSuggestionView> {
    const list = await call<LedgerSuggestionListResponse>('GET', `/api/ledger/entries/${entryId}/suggestions`, owner);
    expect(list.status).toBe(200);
    const found = list.body.suggestions.find((item) => item.id === id);
    if (!found) throw new Error(`未读到建议 ${id}`);
    return found;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';

    stub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        if (!(request.url ?? '').endsWith('/chat/completions')) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 未实现该接口' } }));
          return;
        }
        try {
          chatBodies.push(JSON.parse(raw) as { messages: never[]; max_tokens: number });
        } catch {
          chatBodies.push({ messages: [], max_tokens: 0 });
        }
        if (chatStatus !== 200) {
          response.writeHead(chatStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 故意失败' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: chatReply } }],
            usage: { prompt_tokens: 900, completion_tokens: 120 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (!address || typeof address === 'string') throw new Error('桩服务端口获取失败');
    stubPort = address.port;

    app = await buildServer();

    workspace = await createWorkspace(`M6-7 建议工作区 ${RUN_ID}`);
    outsider = await createWorkspace(`M6-7 外部工作区 ${RUN_ID}`);
    owner = await createUser(workspace, `owner${EMAIL_SUFFIX}`, 'M6-7 所有者', 'owner');
    author = await createUser(workspace, `author${EMAIL_SUFFIX}`, 'M6-7 作者', 'author');
    reviewer = await createUser(workspace, `reviewer${EMAIL_SUFFIX}`, 'M6-7 审阅', 'reviewer');
    viewer = await createUser(workspace, `viewer${EMAIL_SUFFIX}`, 'M6-7 读者', 'viewer');
    billing = await createUser(workspace, `billing${EMAIL_SUFFIX}`, 'M6-7 计费', 'billing');
    outsiderOwner = await createUser(outsider, `outsider${EMAIL_SUFFIX}`, 'M6-7 外部所有者', 'owner');

    work = randomUUID();
    volume = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${work}, ${workspace}, 'M6-7 建议作品')`;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volume}, ${work}, 1, '第一卷')
    `;

    chapterOne = await createChapter(1, '前夜', '前夜，林默在北门守夜，铜钉在雨里发亮。');
    chapterTwo = await createChapter(
      2,
      '铜钉之夜',
      '这一夜林默坠入枯井，井下的铜钉原来是钥匙；他在井底不再应答，沈砚在井口与他反目。',
    );
    chapterThree = await createChapter(3, '远雷', null);

    const provider = await call<{ id: string }>('POST', '/api/model-providers', owner, {
      name: 'M6-7 建议服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-suggest',
      purpose: 'chat',
      apiKey: 'm6-suggestion-key',
      isEnabled: true,
      priority: 1,
      promptPricePer1m: 2,
      completionPricePer1m: 8,
      priceCurrency: 'CNY',
    });
    expect(provider.status).toBe(200);
    providerId = provider.body.id;
  });

  afterAll(async () => {
    for (const workspaceId of [workspace, outsider].filter(Boolean)) {
      await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ledger_suggestions WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
      await sql`DELETE FROM ledger_entry_versions WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ledger_entries WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_budgets WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM chapters WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${workspaceId})`;
      await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM model_providers WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (app) await app.close();
    await closeDb();
  });

  it('生成角色状态建议：绑定依据章节、记录引用与费用，且不写任何账本版本', async () => {
    const entry = await createEntry(characterInput(`林默·生成 ${RUN_ID}`));
    chatBodies.length = 0;

    const result = await generate(entry.id, chapterTwo, author, '不要把未写到的字段补齐');
    expect(result.status).toBe(200);
    const suggestion = result.body as LedgerSuggestionView;
    expect(suggestion.status).toBe('ready');
    expect(suggestion.kind).toBe('character_state');
    expect(suggestion.entryKind).toBe('character');
    expect(suggestion.baseVersionNo).toBe(1);
    expect(suggestion.basisChapter).toEqual({ id: chapterTwo, number: 2, title: '铜钉之夜' });
    expect(suggestion.instruction).toBe('不要把未写到的字段补齐');
    expect(suggestion.providerName).toBe('M6-7 建议服务商');
    expect(suggestion.model).toBe('stub-suggest');
    expect(suggestion.promptVersion).toBe('m6s-v1');
    expect(suggestion.proposal).toEqual({
      kind: 'character_state',
      asOfChapterNumber: 2,
      life: 'dead',
      location: '井底',
      knowledge: '铜钉是钥匙',
      possessions: '',
      relationshipChanges: '与沈砚反目',
    });
    expect(suggestion.rationale).toContain('坠井');
    expect(suggestion.attempts).toBe(1);
    expect(suggestion.usage).toEqual({ promptTokens: 900, completionTokens: 120 });
    expect(suggestion.costCurrency).toBe('CNY');
    expect(suggestion.cost).not.toBeNull();
    expect(suggestion.errorCode).toBeNull();
    expect(suggestion.decidedByName).toBeNull();
    expect(suggestion.resultDraftVersionNo).toBeNull();

    expect(suggestion.evidence.map((item) => item.type)).toEqual(['chapter', 'ledger_version']);
    expect(suggestion.evidence[0]!.label).toContain('第 2 章');
    expect(suggestion.evidence[0]!.truncated).toBe(false);

    const prompt = chatBodies[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('你只提出建议，没有任何写入权限');
    expect(prompt).toContain('第 2 章《铜钉之夜》');
    expect(prompt).toContain('不要把未写到的字段补齐');
    expect(prompt).not.toContain(chapterTwo);
    expect(chatBodies[0]!.max_tokens).toBeGreaterThanOrEqual(128);

    const after = await call<LedgerEntryDetail>('GET', `/api/ledger/entries/${entry.id}`, owner);
    expect(after.status).toBe(200);
    expect(after.body.currentVersion?.versionNo).toBe(1);
    expect(after.body.draftVersion).toBeNull();

    const calls = await sql<{ purpose: string; status: string; suggestion_id: string | null }[]>`
      SELECT purpose, status, suggestion_id FROM model_calls
      WHERE workspace_id = ${workspace} AND purpose = 'ledger_suggestion'
    `;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ purpose: 'ledger_suggestion', status: 'ok', suggestion_id: suggestion.id });

    const audit = await sql<{ action: string; object_type: string }[]>`
      SELECT action, object_type FROM audit_log
      WHERE workspace_id = ${workspace} AND object_id = ${suggestion.id}
        AND action = 'ledger.suggestion.generate'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.object_type).toBe('ledger_suggestion');

    const events = await sql<{ event_type: string }[]>`
      SELECT event_type FROM events
      WHERE workspace_id = ${workspace} AND aggregate_id = ${entry.id}
        AND event_type = 'ledger.suggestion.created'
    `;
    expect(events).toHaveLength(1);
  });

  it('模型输出不是 JSON 或字段不合法时标记失败，建议不进入可采纳状态', async () => {
    const entry = await createEntry(characterInput(`林默·非JSON ${RUN_ID}`));
    chatReply = '我判断他死了，位置在井底。';
    const notJson = await generate(entry.id, chapterTwo);
    expect(notJson.status).toBe(200);
    expect((notJson.body as LedgerSuggestionView).status).toBe('failed');
    expect((notJson.body as LedgerSuggestionView).errorCode).toBe('LEDGER_SUGGESTION_NOT_JSON');
    expect((notJson.body as LedgerSuggestionView).proposal).toBeNull();
    // 调用真的发生了，用量与费用必须留在建议上：不能因为输出不可用就显示“用量未上报”，
    // 也不能让这一笔花费在工作区账面上隐身。
    expect((notJson.body as LedgerSuggestionView).usage).toEqual({
      promptTokens: 900,
      completionTokens: 120,
    });
    expect((notJson.body as LedgerSuggestionView).cost).not.toBeNull();
    expect((notJson.body as LedgerSuggestionView).costCurrency).toBe('CNY');
    expect((notJson.body as LedgerSuggestionView).latencyMs).not.toBeNull();
    expect((notJson.body as LedgerSuggestionView).errorMessage).toContain('用量与费用已按实际记录');

    chatReply = '{"life":"undead","location":"井底"}';
    const invalid = await generate(entry.id, chapterTwo);
    expect((invalid.body as LedgerSuggestionView).errorCode).toBe('LEDGER_SUGGESTION_OUTPUT_INVALID');
    expect((invalid.body as LedgerSuggestionView).status).toBe('failed');

    chatReply = CHARACTER_JSON;
    const list = await call<LedgerSuggestionListResponse>(
      'GET',
      `/api/ledger/entries/${entry.id}/suggestions`,
      owner,
    );
    expect(list.body.note).toContain('采纳只会写入草稿');
    expect(list.body.suggestions).toHaveLength(2);

    const accept = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${(invalid.body as LedgerSuggestionView).id}/accept`,
      owner,
      { note: '' },
    );
    expectError(accept, 409, 'LEDGER_SUGGESTION_NOT_DECIDABLE');
  });

  it('采纳只写入草稿：生效版本、检索与门禁结论均不变', async () => {
    const entry = await createEntry(characterInput(`林默·采纳 ${RUN_ID}`));
    const generated = (await generate(entry.id, chapterTwo)).body as LedgerSuggestionView;

    const outboxCount = async (): Promise<number> => {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox WHERE payload->>'workspaceId' = ${workspace}
      `;
      return rows[0]!.count;
    };
    const outboxBeforeAccept = await outboxCount();

    const accepted = await call<{ suggestion: LedgerSuggestionView; entry: LedgerEntryDetail }>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '与正文一致' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.suggestion.status).toBe('accepted');
    expect(accepted.body.suggestion.resultDraftVersionNo).toBe(2);
    expect(accepted.body.suggestion.decidedByName).toBe('M6-7 所有者');
    expect(accepted.body.suggestion.decisionNote).toBe('与正文一致');
    expect(await outboxCount()).toBe(outboxBeforeAccept);

    const detail = accepted.body.entry;
    expect(detail.currentVersion?.versionNo).toBe(1);
    expect(detail.draftVersion?.versionNo).toBe(2);
    const currentPayload = detail.currentVersion!.snapshot.payload as {
      states: { asOfChapterId: string; life: string }[];
    };
    const draftPayload = detail.draftVersion!.snapshot.payload as {
      states: { asOfChapterId: string; life: string; location: string }[];
    };
    expect(currentPayload.states).toHaveLength(1);
    expect(draftPayload.states).toHaveLength(2);
    expect(draftPayload.states.find((state) => state.asOfChapterId === chapterTwo)?.life).toBe('dead');
    expect(detail.updatedBy?.name).toBe('M6-7 所有者');

    const publishedRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_entry_versions
      WHERE entry_id = ${entry.id}
    `;
    expect(publishedRows[0]!.count).toBe(2);

    const repeat = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '' },
    );
    expectError(repeat, 409, 'LEDGER_SUGGESTION_ALREADY_DECIDED');

    const rejectDecided = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/reject`,
      owner,
      { note: '' },
    );
    expectError(rejectDecided, 409, 'LEDGER_SUGGESTION_ALREADY_DECIDED');
  });

  it('发布或新版本使旧建议过期；条目已有草稿时既不生成也不采纳', async () => {
    const entry = await createEntry(characterInput(`林默·过期 ${RUN_ID}`));
    const generated = (await generate(entry.id, chapterTwo)).body as LedgerSuggestionView;

    const draft = await call<LedgerEntryDetail>('PUT', `/api/ledger/entries/${entry.id}/draft`, owner, {
      expectedDraftVersionId: null,
      summary: '人工补充的摘要',
      changeSummary: '人工改动',
    });
    expect(draft.status).toBe(200);

    const blocked = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '' },
    );
    expectError(blocked, 409, 'LEDGER_SUGGESTION_DRAFT_EXISTS');

    const regenerate = await generate(entry.id, chapterTwo);
    expectError(regenerate as ApiResult<unknown>, 409, 'LEDGER_SUGGESTION_DRAFT_EXISTS');

    const published = await call<LedgerEntryDetail>(
      'POST',
      `/api/ledger/entries/${entry.id}/publish`,
      owner,
      { expectedDraftVersionId: draft.body.draftVersion!.id, changeSummary: '发布 v2' },
    );
    expect(published.status).toBe(200);
    expect(published.body.currentVersion?.versionNo).toBe(2);

    const stale = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '' },
    );
    expectError(stale, 409, 'LEDGER_SUGGESTION_STALE');
    expect((stale.body as ErrorBody).error.message).toContain('请基于新版本重新生成建议');
  });

  it('拒绝建议不做任何写入，并留下决策人与说明', async () => {
    const entry = await createEntry(characterInput(`林默·拒绝 ${RUN_ID}`));
    const generated = (await generate(entry.id, chapterTwo)).body as LedgerSuggestionView;

    const rejected = await call<LedgerSuggestionView>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/reject`,
      author,
      { note: '井底描写属于下一章，暂不接受' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.decidedByName).toBe('M6-7 作者');
    expect(rejected.body.decisionNote).toContain('下一章');

    const detail = await call<LedgerEntryDetail>('GET', `/api/ledger/entries/${entry.id}`, owner);
    expect(detail.body.draftVersion).toBeNull();
    expect(detail.body.currentVersion?.versionNo).toBe(1);

    const listed = await suggestionOf(entry.id, generated.id);
    expect(listed.status).toBe('rejected');
  });

  it('伏笔建议：回收写入草稿，非法终态与窗口外回收被账本规则拒绝', async () => {
    const entry = await createEntry(foreshadowingInput(`黑潮·回收 ${RUN_ID}`, 'planted', 2, 5));
    chatReply = '{"state":"paid_off","resolutionNote":"井底铜钉证实黑潮入口就在北门","rationale":"本章明确解答"}';
    const generated = (await generate(entry.id, chapterTwo)).body as LedgerSuggestionView;
    expect(generated.proposal).toEqual({
      kind: 'foreshadowing_state',
      state: 'paid_off',
      payoffChapterNumber: 2,
      resolutionNote: '井底铜钉证实黑潮入口就在北门',
    });

    const accepted = await call<{ suggestion: LedgerSuggestionView; entry: LedgerEntryDetail }>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '' },
    );
    expect(accepted.status).toBe(200);
    const payload = accepted.body.entry.draftVersion!.snapshot.payload as {
      state: string;
      payoffChapterId: string | null;
    };
    expect(payload.state).toBe('paid_off');
    expect(payload.payoffChapterId).toBe(chapterTwo);
    expect(accepted.body.entry.currentVersion?.versionNo).toBe(1);

    const terminal = await createEntry(foreshadowingInput(`黑潮·终态 ${RUN_ID}`, 'paid_off', 1, 5));
    chatReply = '{"state":"reinforced","resolutionNote":"","rationale":"依据不足"}';
    const terminalSuggestion = (await generate(terminal.id, chapterTwo)).body as LedgerSuggestionView;
    const terminalAccept = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${terminalSuggestion.id}/accept`,
      owner,
      { note: '' },
    );
    expectError(terminalAccept, 409, 'LEDGER_FORESHADOWING_TRANSITION');
    const afterTerminal = await suggestionOf(terminal.id, terminalSuggestion.id);
    expect(afterTerminal.status).toBe('ready');
    expect(afterTerminal.errorCode).toBe('LEDGER_SUGGESTION_APPLY_FAILED');
    const terminalEntry = await call<LedgerEntryDetail>('GET', `/api/ledger/entries/${terminal.id}`, owner);
    expect(terminalEntry.body.draftVersion).toBeNull();

    const outOfWindow = await createEntry(foreshadowingInput(`黑潮·窗口 ${RUN_ID}`, 'planted', 4, 6));
    chatReply = '{"state":"paid_off","resolutionNote":"本章提前解答了黑潮","rationale":"本章解答"}';
    const windowSuggestion = (await generate(outOfWindow.id, chapterTwo)).body as LedgerSuggestionView;
    const windowAccept = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${windowSuggestion.id}/accept`,
      owner,
      { note: '' },
    );
    expectError(windowAccept, 400, 'LEDGER_PAYOFF_OUTSIDE_WINDOW');
    const afterWindow = await suggestionOf(outOfWindow.id, windowSuggestion.id);
    expect(afterWindow.status).toBe('ready');
    expect(afterWindow.errorCode).toBe('LEDGER_SUGGESTION_APPLY_FAILED');
    const windowEntry = await call<LedgerEntryDetail>('GET', `/api/ledger/entries/${outOfWindow.id}`, owner);
    expect(windowEntry.body.draftVersion).toBeNull();

    chatReply = CHARACTER_JSON;
  });

  it('前置条件与权限：设定条目、无生效版本、无正典依据章、归档、只读与计费角色均被拒绝', async () => {
    const setting = await createEntry({
      kind: 'setting',
      workId: work,
      name: `封印铜钉·建议 ${RUN_ID}`,
      aliases: [],
      summary: '设定条目不支持建议',
      payload: { category: 'item', details: '银纹铜钉固定在王城北门。', tags: [], verification: 'verified' },
    });
    expectError(await generate(setting.id, chapterTwo), 409, 'LEDGER_SUGGESTION_KIND_UNSUPPORTED');

    const draftOnly = await call<LedgerEntryDetail>('POST', '/api/ledger/entries', owner, characterInput(`林默·未发布 ${RUN_ID}`));
    expectError(
      await generate(draftOnly.body.id, chapterTwo),
      409,
      'LEDGER_SUGGESTION_NO_PUBLISHED_VERSION',
    );

    const entry = await createEntry(characterInput(`林默·前置 ${RUN_ID}`));
    expectError(await generate(entry.id, chapterThree), 409, 'LEDGER_SUGGESTION_NO_CANON');

    const workspaceScope = await createEntry({
      kind: 'setting',
      name: `北境通行令·建议 ${RUN_ID}`,
      aliases: [],
      summary: '工作区通用设定',
      payload: { category: 'rule', details: '持令者可在北门通行。', tags: [], verification: 'unverified' },
    });
    expectError(
      await generate(workspaceScope.id, chapterTwo, outsiderOwner),
      404,
      'LEDGER_ENTRY_NOT_FOUND',
    );
    expectError(await generate(entry.id, chapterTwo, outsiderOwner), 404, 'LEDGER_ENTRY_NOT_FOUND');

    expectError(await generate(entry.id, chapterTwo, reviewer), 403, 'FORBIDDEN');
    expectError(await generate(entry.id, chapterTwo, viewer), 403, 'FORBIDDEN');

    const readable = await call<LedgerSuggestionListResponse>(
      'GET',
      `/api/ledger/entries/${entry.id}/suggestions`,
      viewer,
    );
    expect(readable.status).toBe(200);
    expect(readable.body.suggestions).toHaveLength(0);

    // 建议列表会带出条目名、依据章节与提案内容，读权限必须与正典一致：计费管理员连列表都读不到。
    expectError(
      await call<ErrorBody>('GET', `/api/ledger/entries/${entry.id}/suggestions`, billing),
      403,
      'FORBIDDEN',
    );
    expectError(await generate(entry.id, chapterTwo, billing), 403, 'FORBIDDEN');

    const archived = await createEntry(characterInput(`林默·归档 ${RUN_ID}`));
    const archive = await call<LedgerEntryDetail>(
      'POST',
      `/api/ledger/entries/${archived.id}/archive`,
      owner,
      { reason: 'M6-7 测试归档', discardDraft: false },
    );
    expect(archive.status).toBe(200);
    expectError(await generate(archived.id, chapterTwo), 409, 'LEDGER_ENTRY_ARCHIVED');
  });

  it('预算与服务商故障：预算耗尽记录 blocked 调用且不发起请求，故障时按服务商故障转移', async () => {
    const entry = await createEntry(characterInput(`林默·预算 ${RUN_ID}`));
    await sql`
      INSERT INTO workspace_budgets (workspace_id, monthly_limit, currency)
      VALUES (${workspace}, 0, 'CNY')
      ON CONFLICT (workspace_id) DO UPDATE SET monthly_limit = 0, currency = 'CNY'
    `;
    const before = chatBodies.length;

    const result = await generate(entry.id, chapterTwo);
    expect(result.status).toBe(200);
    const suggestion = result.body as LedgerSuggestionView;
    expect(suggestion.status).toBe('failed');
    expect(suggestion.errorCode).toBe('BUDGET_INSUFFICIENT');
    expect(suggestion.errorMessage).toContain('本次未发起调用');
    expect(suggestion.cost).toBeNull();
    expect(chatBodies.length).toBe(before);

    const blocked = await sql<
      {
        status: string;
        error_code: string;
        cost: string | null;
        cost_currency: string | null;
        completed_at: Date | null;
        attempt_no: number;
      }[]
    >`
      SELECT status, error_code, cost, cost_currency, completed_at, attempt_no FROM model_calls
      WHERE workspace_id = ${workspace} AND purpose = 'ledger_suggestion'
        AND status = 'blocked' AND suggestion_id = ${suggestion.id}
    `;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.error_code).toBe('BUDGET_INSUFFICIENT');
    expect(blocked[0]!.attempt_no).toBe(1);
    // 与章节提案的 blocked 行同口径：成本按 0 计入、币种留痕、时间已闭合，报表里不会被当成缺失用量。
    expect(String(blocked[0]!.cost)).toBe('0.0000');
    expect(blocked[0]!.cost_currency).toBe('CNY');
    expect(blocked[0]!.completed_at).not.toBeNull();

    const report = await call<Record<string, unknown>>('GET', '/api/billing/report', owner);
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body)).toContain('账本建议');

    await sql`
      INSERT INTO workspace_budgets (workspace_id, monthly_limit, currency)
      VALUES (${workspace}, 5000, 'CNY')
      ON CONFLICT (workspace_id) DO UPDATE SET monthly_limit = 5000, currency = 'CNY'
    `;

    chatStatus = 503;
    const singleProviderFailure = await generate(entry.id, chapterTwo);
    chatStatus = 200;
    expect((singleProviderFailure.body as LedgerSuggestionView).status).toBe('failed');
    expect((singleProviderFailure.body as LedgerSuggestionView).errorCode).toBe('AI_HTTP_ERROR');
    expect((singleProviderFailure.body as LedgerSuggestionView).attempts).toBe(1);

    const backupProvider = await call<{ id: string }>('POST', '/api/model-providers', owner, {
      name: 'M6-7 备用建议服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-suggest-backup',
      purpose: 'chat',
      apiKey: 'm6-suggestion-backup-key',
      isEnabled: true,
      priority: 2,
      promptPricePer1m: 2,
      completionPricePer1m: 8,
      priceCurrency: 'CNY',
    });
    expect(backupProvider.status).toBe(200);

    chatStatus = 503;
    const failed = await generate(entry.id, chapterTwo);
    chatStatus = 200;
    expect((failed.body as LedgerSuggestionView).status).toBe('failed');
    expect((failed.body as LedgerSuggestionView).errorCode).toBe('AI_HTTP_ERROR');
    expect((failed.body as LedgerSuggestionView).attempts).toBe(2);
    expect((failed.body as LedgerSuggestionView).providerName).toBe('M6-7 备用建议服务商');

    const retryCalls = await sql<{ attempt_no: number; status: string; provider_id: string }[]>`
      SELECT attempt_no, status, provider_id FROM model_calls
      WHERE workspace_id = ${workspace} AND purpose = 'ledger_suggestion'
        AND suggestion_id = ${(failed.body as LedgerSuggestionView).id}
      ORDER BY attempt_no
    `;
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls.every((row) => row.status === 'failed')).toBe(true);
    expect(new Set(retryCalls.map((row) => row.provider_id)).size).toBe(2);
  });

  it('中断的建议在读取时如实回收，界面不会永久停在生成中或采纳中', async () => {
    const entry = await createEntry(characterInput(`林默·中断 ${RUN_ID}`));
    const baseVersion = entry.currentVersion!.id;

    const stuckGenerating = randomUUID();
    await sql`
      INSERT INTO ledger_suggestions (
        id, workspace_id, entry_id, kind, base_version_id, basis_chapter_id,
        status, created_by, created_at
      )
      VALUES (
        ${stuckGenerating}, ${workspace}, ${entry.id}, 'character_state',
        ${baseVersion}, ${chapterTwo}, 'generating', ${owner.me.user.id},
        now() - interval '30 minutes'
      )
    `;

    const stuckApplying = randomUUID();
    await sql`
      INSERT INTO ledger_suggestions (
        id, workspace_id, entry_id, kind, base_version_id, basis_chapter_id,
        proposal, status, created_by, created_at, decided_by, decided_at
      )
      VALUES (
        ${stuckApplying}, ${workspace}, ${entry.id}, 'character_state',
        ${baseVersion}, ${chapterTwo},
        ${sql.json(
          jsonValue({
            kind: 'character_state',
            asOfChapterNumber: 2,
            life: 'unknown',
            location: '',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          }),
        )},
        'applying', ${owner.me.user.id}, now() - interval '30 minutes',
        ${owner.me.user.id}, now() - interval '20 minutes'
      )
    `;

    const list = await call<LedgerSuggestionListResponse>(
      'GET',
      `/api/ledger/entries/${entry.id}/suggestions`,
      owner,
    );
    expect(list.status).toBe(200);
    const generating = list.body.suggestions.find((item) => item.id === stuckGenerating);
    expect(generating?.status).toBe('failed');
    expect(generating?.errorCode).toBe('AI_ABANDONED');

    const applying = list.body.suggestions.find((item) => item.id === stuckApplying);
    expect(applying?.status).toBe('ready');
    expect(applying?.errorCode).toBe('SUGGESTION_APPLY_INTERRUPTED');
    expect(applying?.errorMessage).toContain('没有留下草稿');

    const accept = await call<{ suggestion: LedgerSuggestionView }>(
      'POST',
      `/api/ledger/suggestions/${stuckApplying}/accept`,
      owner,
      { note: '中断后重试' },
    );
    expect(accept.status).toBe(200);
    expect(accept.body.suggestion.status).toBe('accepted');

    // 草稿已提交、状态没来得及落库：回收时不能再说“草稿未写入”，也不能静默再写一份草稿。
    await sql`
      UPDATE ledger_suggestions
      SET status = 'applying', decided_at = now() - interval '20 minutes'
      WHERE id = ${stuckApplying}
    `;
    const afterDraft = await call<LedgerSuggestionListResponse>(
      'GET',
      `/api/ledger/entries/${entry.id}/suggestions`,
      owner,
    );
    const reclaimed = afterDraft.body.suggestions.find((item) => item.id === stuckApplying);
    expect(reclaimed?.status).toBe('ready');
    expect(reclaimed?.errorMessage).toContain('草稿可能是那次采纳写入的');
    expect(reclaimed?.decidedByName).toBeNull();
    expect(reclaimed?.decidedAt).toBeNull();

    expectError(
      await call<ErrorBody>('POST', `/api/ledger/suggestions/${stuckApplying}/accept`, owner, {
        note: '重复采纳',
      }),
      409,
      'LEDGER_SUGGESTION_DRAFT_EXISTS',
    );
  });

  it('同一条目已有正在生成的建议时拒绝再次发起，不重复花一次钱', async () => {
    chatReply = CHARACTER_JSON;
    chatStatus = 200;
    const entry = await createEntry(characterInput(`林默·并发 ${RUN_ID}`));
    const inflight = randomUUID();
    await sql`
      INSERT INTO ledger_suggestions (
        id, workspace_id, entry_id, kind, base_version_id, basis_chapter_id,
        status, created_by, created_at
      )
      VALUES (
        ${inflight}, ${workspace}, ${entry.id}, 'character_state',
        ${entry.currentVersion!.id}, ${chapterTwo}, 'generating', ${owner.me.user.id}, now()
      )
    `;

    // 兜底在数据库：并发的第二条 generating 直接撞唯一索引，不靠应用层"先查后写"。
    const rival = randomUUID();
    await expect(
      sql`
        INSERT INTO ledger_suggestions (
          id, workspace_id, entry_id, kind, base_version_id, basis_chapter_id,
          status, created_by, created_at
        )
        VALUES (
          ${rival}, ${workspace}, ${entry.id}, 'character_state',
          ${entry.currentVersion!.id}, ${chapterTwo}, 'generating', ${owner.me.user.id}, now()
        )
      `,
    ).rejects.toMatchObject({ code: '23505' });

    const before = chatBodies.length;
    expectError(await generate(entry.id, chapterTwo), 409, 'LEDGER_SUGGESTION_IN_PROGRESS');
    expect(chatBodies.length).toBe(before);
    const orphan = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_suggestions WHERE id = ${rival}
    `;
    expect(orphan[0]!.count).toBe(0);

    await sql`DELETE FROM ledger_suggestions WHERE id = ${inflight}`;
    const created = await generate(entry.id, chapterTwo);
    expect(created.status).toBe(200);
    expect((created.body as LedgerSuggestionView).status).toBe('ready');
    expect(chatBodies.length).toBe(before + 1);
  });

  it('采纳写入的草稿按章节号排序，并绑定建议登记的依据章节本身', async () => {
    chatReply = CHARACTER_JSON;
    chatStatus = 200;
    const entry = await createEntry({
      kind: 'character',
      workId: work,
      name: `林默·倒序 ${RUN_ID}`,
      aliases: [],
      summary: '北门守夜人',
      sourceChapterId: chapterOne,
      payload: {
        role: '守夜人',
        faction: '王城',
        appearance: '',
        personality: '',
        goals: '',
        abilities: '',
        speechStyle: '',
        relationships: [],
        states: [
          {
            asOfChapterId: chapterTwo,
            life: 'dead',
            location: '枯井',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
          {
            asOfChapterId: chapterOne,
            life: 'alive',
            location: '北门',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      },
    });

    // 依据章取第 1 章：建议只会替换第 1 章那条状态，位置由章节号决定，不跟着数组顺序跑。
    const generated = (await generate(entry.id, chapterOne)).body as LedgerSuggestionView;
    expect(generated.status).toBe('ready');
    const accepted = await call<{ suggestion: LedgerSuggestionView; entry: LedgerEntryDetail }>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '按章节顺序写回' },
    );
    expect(accepted.status).toBe(200);

    const draftStates = (
      accepted.body.entry.draftVersion!.snapshot.payload as {
        states: { asOfChapterId: string; life: string }[];
      }
    ).states;
    expect(draftStates.map((state) => state.asOfChapterId)).toEqual([chapterOne, chapterTwo]);
    expect(draftStates[0]!.life).toBe('dead');
    expect(draftStates[1]!.life).toBe('dead');

    const publishedStates = (
      accepted.body.entry.currentVersion!.snapshot.payload as {
        states: { asOfChapterId: string }[];
      }
    ).states;
    expect(publishedStates.map((state) => state.asOfChapterId)).toEqual([chapterTwo, chapterOne]);
  });

  it('依据章节被重新编号后拒绝采纳，不把状态绑到编号已变的章节上', async () => {
    chatReply = CHARACTER_JSON;
    chatStatus = 200;
    const entry = await createEntry(characterInput(`林默·改号 ${RUN_ID}`));
    const generated = (await generate(entry.id, chapterTwo)).body as LedgerSuggestionView;
    expect(generated.status).toBe('ready');

    await sql`UPDATE chapters SET number = 9 WHERE id = ${chapterTwo}`;
    const rejected = await call<ErrorBody>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '改号后采纳' },
    );
    expectError(rejected, 409, 'LEDGER_SUGGESTION_CHAPTER_UNRESOLVED');
    expect((rejected.body as ErrorBody).error.message).toContain('编号已变化');
    await sql`UPDATE chapters SET number = 2 WHERE id = ${chapterTwo}`;

    const accepted = await call<{ suggestion: LedgerSuggestionView }>(
      'POST',
      `/api/ledger/suggestions/${generated.id}/accept`,
      owner,
      { note: '改回原编号后采纳' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.suggestion.status).toBe('accepted');
  });
});
