import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  ChapterDetail,
  ChapterLedgerLinksResponse,
  GateEvaluationView,
  ImportChaptersResponse,
  LedgerEntryDetail,
  MeResponse,
  SearchResponse,
} from '@yunshuo/contracts';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import type { ChapterPlan } from '@yunshuo/domain';
import { countWords } from '@yunshuo/domain';
import { DEV_RULESET, evaluateGates } from '@yunshuo/gates';
import { buildLexicalText } from '@yunshuo/retrieval';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { buildServer } from './server.js';
import { prepareProposal, releaseGenerationLock } from './services/ai-service.js';
import { loadAiLedgerContext } from './services/ledger-context-service.js';

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
const EMAIL_SUFFIX = `@m6-integration-${RUN_ID}.test`;
const EMBEDDING_MODEL = 'stub-embed';
const ALT_EMBEDDING_MODEL = 'stub-embed-alt';
const EMBEDDING_DIMENSIONS = 4;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M6-4 集成测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M6-4 检索、AI 上下文、门禁提示与章节关联', () => {
  const embedCalls: string[] = [];
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let workspaceA = '';
  let workspaceB = '';
  let workspaceC = '';
  let workA = '';
  let workB = '';
  let workC = '';
  let otherWorkA = '';
  let volumeA = '';
  let prevChapterA = '';
  let currentChapterA = '';
  let futureChapterA = '';
  let prevVersionA = '';
  let ownerA: Session;
  let authorA: Session;
  let reviewerA: Session;
  let viewerA: Session;
  let ownerB: Session;
  let settingA: LedgerEntryDetail;
  let characterA: LedgerEntryDetail;
  let foreshadowingA: LedgerEntryDetail;
  let workspaceSettingA: LedgerEntryDetail;
  let draftSettingA: LedgerEntryDetail;
  let archivedSettingA: LedgerEntryDetail;
  let otherWorkSettingA: LedgerEntryDetail;
  const userIds: string[] = [];

  const plan: ChapterPlan = {
    requiredEntities: ['林默'],
    goalKeywords: ['铜钉'],
    obstacleKeywords: ['黑潮'],
  };

  function contentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

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
    workspaceId: string,
    email: string,
    name: string,
    role: 'owner' | 'lead' | 'author' | 'reviewer' | 'viewer',
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

  async function createWork(workspaceId: string, title: string): Promise<{ workId: string; volumeId: string }> {
    const workId = randomUUID();
    const volumeId = randomUUID();
    await sql`INSERT INTO works (id, workspace_id, title) VALUES (${workId}, ${workspaceId}, ${title})`;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '第一卷')
    `;
    return { workId, volumeId };
  }

  async function createChapter(
    workId: string,
    volumeId: string,
    number: number,
    title: string,
    status: 'canon' | 'planned' | 'writing',
    chapterPlan: ChapterPlan,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (${id}, ${workId}, ${volumeId}, ${number}, ${title}, ${status},
        ${sql.json(jsonValue(chapterPlan))})
    `;
    return id;
  }

  async function createLedgerEntry(
    input: Record<string, unknown>,
    session: Session = ownerA,
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      '/api/ledger/entries',
      session,
      input,
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function publishLedgerEntry(
    entry: LedgerEntryDetail,
    session: Session = ownerA,
  ): Promise<LedgerEntryDetail> {
    const result = await call<LedgerEntryDetail | ErrorBody>(
      'POST',
      `/api/ledger/entries/${entry.id}/publish`,
      session,
      {
        expectedDraftVersionId: entry.draftVersion!.id,
        changeSummary: 'M6-4 测试发布',
      },
    );
    expect(result.status).toBe(200);
    return result.body as LedgerEntryDetail;
  }

  async function createAndPublish(
    input: Record<string, unknown>,
    session: Session = ownerA,
  ): Promise<LedgerEntryDetail> {
    return publishLedgerEntry(await createLedgerEntry(input, session), session);
  }

  async function indexLedgerEntry(
    entry: LedgerEntryDetail,
    content: string,
    workspaceId = workspaceA,
    workId: string | null = entry.workId,
  ): Promise<void> {
    const version = entry.currentVersion;
    if (!version) throw new Error('账本条目缺少当前版本，无法建立索引');
    const chunkId = randomUUID();
    await sql`
      INSERT INTO ledger_chunks (
        id, workspace_id, entry_id, version_id, kind, work_id, chunk_index,
        content, content_hash, lexical_text
      )
      VALUES (
        ${chunkId}, ${workspaceId}, ${entry.id}, ${version.id}, ${entry.kind},
        ${workId}, 0, ${content}, ${contentHash(content)}, ${buildLexicalText(content)}
      )
    `;
    await sql`
      INSERT INTO ledger_chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
      VALUES (${chunkId}, NULL, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, '[1,0,0,0]'::vector)
    `;
    await sql`
      INSERT INTO ledger_index_status (
        entry_id, workspace_id, version_id, status, detail, chunk_count,
        provider_name, model, dimensions, attempts, updated_at
      )
      VALUES (
        ${entry.id}, ${workspaceId}, ${version.id}, 'ready', 'M6-4 测试索引', 1,
        'M6-4 嵌入测试', ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, 1, now()
      )
      ON CONFLICT (entry_id) DO UPDATE SET
        version_id = EXCLUDED.version_id,
        status = EXCLUDED.status,
        detail = EXCLUDED.detail,
        chunk_count = EXCLUDED.chunk_count,
        model = EXCLUDED.model,
        dimensions = EXCLUDED.dimensions,
        updated_at = now()
    `;
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';

    stub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        let inputs: string[] = [];
        let requestedModel = '';
        try {
          const parsed = JSON.parse(raw) as { input?: unknown; model?: unknown };
          if (Array.isArray(parsed.input)) {
            inputs = parsed.input.map((item) => String(item));
          }
          if (typeof parsed.model === 'string') requestedModel = parsed.model;
        } catch {
          inputs = [];
        }
        if (!(request.url ?? '').endsWith('/embeddings')) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 未实现该接口' } }));
          return;
        }
        embedCalls.push(requestedModel);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_, index) => ({
              object: 'embedding',
              index,
              embedding: [1, 0, 0, 0],
            })),
            usage: { prompt_tokens: 12, total_tokens: 12 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (!address || typeof address === 'string') throw new Error('桩服务端口获取失败');
    stubPort = address.port;

    app = await buildServer();

    workspaceA = await createWorkspace(`M6-4 集成工作区 ${RUN_ID}`);
    workspaceB = await createWorkspace(`M6-4 外部工作区 ${RUN_ID}`);
    workspaceC = await createWorkspace(`M6-4 空工作区 ${RUN_ID}`);
    ownerA = await createUser(workspaceA, `owner${EMAIL_SUFFIX}`, 'M6-4 所有者', 'owner');
    authorA = await createUser(workspaceA, `author${EMAIL_SUFFIX}`, 'M6-4 作者', 'author');
    reviewerA = await createUser(workspaceA, `reviewer${EMAIL_SUFFIX}`, 'M6-4 审阅', 'reviewer');
    viewerA = await createUser(workspaceA, `viewer${EMAIL_SUFFIX}`, 'M6-4 读者', 'viewer');
    ownerB = await createUser(workspaceB, `owner-b${EMAIL_SUFFIX}`, 'M6-4 外部所有者', 'owner');

    const createdA = await createWork(workspaceA, 'M6-4 集成作品');
    workA = createdA.workId;
    volumeA = createdA.volumeId;
    const createdB = await createWork(workspaceB, 'M6-4 外部作品');
    workB = createdB.workId;
    const createdC = await createWork(workspaceC, 'M6-4 空作品');
    workC = createdC.workId;
    const createdOther = await createWork(workspaceA, 'M6-4 其他作品');
    otherWorkA = createdOther.workId;

    prevChapterA = await createChapter(workA, volumeA, 2, '前夜', 'canon', {});
    currentChapterA = await createChapter(workA, volumeA, 3, '铜钉之夜', 'writing', plan);
    futureChapterA = await createChapter(workA, volumeA, 4, '远雷', 'planned', {});

    prevVersionA = randomUUID();
    const prevContent = '前夜，林默在北门守夜，铜钉在雨里发亮。';
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source
      )
      VALUES (
        ${prevVersionA}, ${prevChapterA}, 1, ${prevContent},
        ${contentHash(prevContent)}, ${countWords(prevContent)}, 'human'
      )
    `;
    await sql`UPDATE chapters SET current_version_id = ${prevVersionA} WHERE id = ${prevChapterA}`;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${prevChapterA}, ${prevVersionA})
    `;
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, expires_at)
      VALUES (${currentChapterA}, ${ownerA.me.user.id}, ${new Date(Date.now() + 60 * 60_000)})
    `;

    settingA = await createAndPublish({
      kind: 'setting',
      workId: workA,
      name: '封印铜钉',
      aliases: ['旧钉'],
      summary: '北门的封印铜钉',
      sourceChapterId: prevChapterA,
      payload: {
        category: 'item',
        details: '银纹铜钉固定在王城北门，月缺时需要更换。',
        tags: ['北门', '封印'],
        verification: 'verified',
      },
    });
    characterA = await createAndPublish({
      kind: 'character',
      workId: workA,
      name: '林默',
      aliases: ['阿默'],
      summary: '北门守夜人',
      sourceChapterId: prevChapterA,
      payload: {
        role: '守夜人',
        faction: '王城',
        appearance: '披旧斗篷',
        personality: '沉默',
        goals: '守住北门',
        abilities: '辨认铜钉银纹',
        speechStyle: '简短',
        relationships: [],
        states: [
          {
            asOfChapterId: prevChapterA,
            life: 'alive',
            location: '北门',
            knowledge: '铜钉在雨夜发亮',
            possessions: '铜钉',
            relationshipChanges: '',
          },
          {
            asOfChapterId: futureChapterA,
            life: 'alive',
            location: '地牢',
            knowledge: '尚未发生的未来状态',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      },
    });
    foreshadowingA = await createAndPublish({
      kind: 'foreshadowing',
      workId: workA,
      name: '黑潮预兆',
      aliases: ['黑潮'],
      summary: '铜钉银纹在月缺时发暗',
      sourceChapterId: prevChapterA,
      payload: {
        seedChapterId: prevChapterA,
        payoffChapterMin: 3,
        payoffChapterMax: 5,
        importance: 'high',
        state: 'planted',
        payoffChapterId: null,
        note: '黑潮专属标记：铜钉银纹发暗时，北门将迎来黑潮。',
        resolutionNote: '',
      },
    });
    workspaceSettingA = await createAndPublish({
      kind: 'setting',
      name: '北境通行令',
      aliases: ['旧令'],
      summary: '北境通用通行规则',
      payload: {
        category: 'rule',
        details: '持令者可在北门通行，铜钉为验令标记。',
        tags: ['北境'],
        verification: 'verified',
      },
    });
    draftSettingA = await createLedgerEntry({
      kind: 'setting',
      workId: workA,
      name: '草稿铜钉案',
      summary: '未发布草稿',
      payload: {
        category: 'other',
        details: '草稿专属标记：铜钉方案尚未定稿。',
        tags: [],
        verification: 'unverified',
      },
    });
    archivedSettingA = await createAndPublish({
      kind: 'setting',
      workId: workA,
      name: '归档铜钉案',
      summary: '已归档旧案',
      payload: {
        category: 'other',
        details: '归档专属标记：铜钉旧案已废弃。',
        tags: [],
        verification: 'deprecated',
      },
    });
    const archived = await call<LedgerEntryDetail>('POST', `/api/ledger/entries/${archivedSettingA.id}/archive`, ownerA, {
      reason: 'M6-4 测试归档',
    });
    expect(archived.status).toBe(200);

    otherWorkSettingA = await createAndPublish({
      kind: 'setting',
      workId: otherWorkA,
      name: '他作铜钉',
      summary: '其他作品的设定',
      payload: {
        category: 'item',
        details: '其他作品的铜钉不应出现在本作品检索中。',
        tags: [],
        verification: 'unverified',
      },
    });
    const externalSettingB = await createAndPublish(
      {
        kind: 'setting',
        name: '外部工作区通行令',
        summary: '外部工作区规则',
        payload: {
          category: 'rule',
          details: '外部工作区铜钉不应出现在本工作区检索中。',
          tags: [],
          verification: 'unverified',
        },
      },
      ownerB,
    );
    expect(externalSettingB.id).toBeTruthy();

    await indexLedgerEntry(
      settingA,
      '设定：封印铜钉。银纹铜钉固定在王城北门，旧钉被投入护城河。',
    );
    await indexLedgerEntry(
      characterA,
      '角色：林默。守夜人阿默持有铜钉，守在王城北门。',
    );
    await indexLedgerEntry(
      foreshadowingA,
      '伏笔：黑潮预兆。铜钉银纹在月缺时发暗，北门将迎来黑潮。',
    );
    await indexLedgerEntry(
      workspaceSettingA,
      '设定：北境通行令。持令者可在北门通行，铜钉为验令标记。',
      workspaceA,
      null,
    );
    await indexLedgerEntry(
      archivedSettingA,
      '归档铜钉内容，不应被检索。',
    );
    await indexLedgerEntry(
      otherWorkSettingA,
      '他作铜钉内容，不应被本作品检索。',
      workspaceA,
      otherWorkA,
    );
    await sql`
      INSERT INTO ledger_chunks (
        id, workspace_id, entry_id, version_id, kind, work_id, chunk_index,
        content, content_hash, lexical_text
      )
      VALUES (
        ${randomUUID()}, ${workspaceA}, ${draftSettingA.id},
        ${draftSettingA.draftVersion!.id}, 'setting', ${workA}, 0,
        '草稿铜钉内容，不应被检索。', ${contentHash('草稿铜钉内容')},
        ${buildLexicalText('草稿铜钉内容，不应被检索。')}
      )
    `;

    const embeddingProvider = await call<{ id: string }>(
      'POST',
      '/api/model-providers',
      ownerA,
      {
        name: 'M6-4 嵌入测试服务商',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: EMBEDDING_MODEL,
        purpose: 'embedding',
        apiKey: `m6-embedding-key-${RUN_ID}`,
        isEnabled: true,
        priority: 1,
        promptPricePer1m: 2,
        priceCurrency: 'CNY',
      },
    );
    expect(embeddingProvider.status).toBe(200);

    const chatProvider = await call<{ id: string }>(
      'POST',
      '/api/model-providers',
      ownerA,
      {
        name: 'M6-4 对话测试服务商',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: 'stub-chat',
        purpose: 'chat',
        apiKey: `m6-chat-key-${RUN_ID}`,
        isEnabled: true,
        priority: 2,
        promptPricePer1m: 2,
        completionPricePer1m: 8,
        priceCurrency: 'CNY',
      },
    );
    expect(chatProvider.status).toBe(200);
  });

  afterAll(async () => {
    for (const workspaceId of [workspaceA, workspaceB, workspaceC].filter(Boolean)) {
      await sql`DELETE FROM ai_generation_locks WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ai_proposals WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
      await sql`DELETE FROM ledger_entry_versions WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM ledger_entries WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
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

  it('检索返回已生效账本条目的类型、名称、版本与来源，排除草稿、归档与其他作品', async () => {
    const result = await call<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent('铜钉')}&workId=${workA}&limit=20`,
      ownerA,
    );
    expect(result.status).toBe(200);
    const body = result.body;
    expect(body.mode).toBe('hybrid');
    expect(body.ledgerCoverage.activeEntries).toBe(4);
    expect(body.ledgerCoverage.indexedEntries).toBe(4);
    expect(body.ledgerCoverage.chunks).toBe(4);
    expect(body.ledgerCoverage.vectorChunks).toBe(4);
    expect(body.ledgerCoverage.vectorModel).toBe(EMBEDDING_MODEL);
    expect(body.ledgerReason).toBeNull();

    const names = body.ledgerResults.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining(['封印铜钉', '林默', '黑潮预兆', '北境通行令']),
    );
    expect(names).not.toContain('草稿铜钉案');
    expect(names).not.toContain('归档铜钉案');
    expect(names).not.toContain('他作铜钉');
    expect(names).not.toContain('外部工作区通行令');

    const setting = body.ledgerResults.find((item) => item.name === '封印铜钉');
    expect(setting).toBeTruthy();
    expect(setting!.kind).toBe('setting');
    expect(setting!.scope).toBe('work');
    expect(setting!.workId).toBe(workA);
    expect(setting!.versionId).toBe(settingA.currentVersion!.id);
    expect(setting!.versionNo).toBe(1);
    expect(setting!.sourceChapterId).toBe(prevChapterA);
    expect(setting!.sourceChapterNumber).toBe(2);
    expect(setting!.sourceChapterTitle).toBe('前夜');
    expect(setting!.lexicalRank).not.toBeNull();
    expect(setting!.vectorRank).not.toBeNull();
    expect(setting!.excerpt).toContain('铜钉');

    const workspaceSetting = body.ledgerResults.find((item) => item.name === '北境通行令');
    expect(workspaceSetting).toBeTruthy();
    expect(workspaceSetting!.scope).toBe('workspace');
    expect(workspaceSetting!.workId).toBeNull();
    expect(workspaceSetting!.sourceChapterId).toBeNull();
    expect(workspaceSetting!.sourceChapterNumber).toBeNull();

    const noWork = await call<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent('铜钉')}&limit=20`,
      ownerA,
    );
    expect(noWork.status).toBe(200);
    expect(noWork.body.ledgerResults.map((item) => item.name)).toContain('他作铜钉');
    expect(noWork.body.ledgerResults.map((item) => item.name)).not.toContain('外部工作区通行令');
  });

  it('正典与账本嵌入模型不同时分别生成查询向量，只启用其一时如实降级', async () => {
    const canonChunkId = randomUUID();
    const canonContent = '前夜，林默在北门守夜，铜钉在雨里发亮。';
    let altProviderId = '';
    try {
      const altProvider = await call<{ id: string }>('POST', '/api/model-providers', ownerA, {
        name: 'M6-4 备用嵌入服务商',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: ALT_EMBEDDING_MODEL,
        purpose: 'embedding',
        apiKey: `m6-embedding-key-alt-${RUN_ID}`,
        isEnabled: true,
        priority: 3,
        promptPricePer1m: 2,
        priceCurrency: 'CNY',
      });
      expect(altProvider.status).toBe(200);
      altProviderId = altProvider.body.id;

      await sql`
        INSERT INTO canon_chunks (
          id, workspace_id, work_id, chapter_id, version_id,
          chunk_index, paragraph_start, paragraph_end, char_start, char_end,
          content, content_hash, lexical_text
        )
        VALUES (
          ${canonChunkId}, ${workspaceA}, ${workA}, ${prevChapterA}, ${prevVersionA},
          0, 0, 0, 0, ${canonContent.length},
          ${canonContent}, ${contentHash(canonContent)}, ${buildLexicalText(canonContent)}
        )
      `;
      await sql`
        INSERT INTO chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
        VALUES (${canonChunkId}, NULL, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, '[1,0,0,0]'::vector)
      `;
      await sql`
        INSERT INTO index_status (
          chapter_id, version_id, status, chunk_count, provider_name, model, dimensions, updated_at
        )
        VALUES (
          ${prevChapterA}, ${prevVersionA}, 'ready', 1, 'M6-4 嵌入测试',
          ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, now()
        )
      `;
      await sql`UPDATE ledger_chunk_embeddings SET model = ${ALT_EMBEDDING_MODEL}`;
      await sql`UPDATE ledger_index_status SET model = ${ALT_EMBEDDING_MODEL}`;

      embedCalls.length = 0;
      const query = encodeURIComponent('铜钉');
      const both = await call<SearchResponse>(
        'GET',
        `/api/search?q=${query}&workId=${workA}&limit=20`,
        ownerA,
      );
      expect(both.status).toBe(200);
      expect(both.body.mode).toBe('hybrid');
      expect(both.body.coverage.vectorModel).toBe(EMBEDDING_MODEL);
      expect(both.body.ledgerCoverage.vectorModel).toBe(ALT_EMBEDDING_MODEL);
      expect(both.body.ledgerReason).toBeNull();
      expect(both.body.results.some((item) => item.vectorRank !== null)).toBe(true);
      expect(both.body.ledgerResults.some((item) => item.vectorRank !== null)).toBe(true);
      expect(new Set(embedCalls)).toEqual(new Set([EMBEDDING_MODEL, ALT_EMBEDDING_MODEL]));

      const altCalls = await sql<{ id: string }[]>`
        SELECT id FROM model_calls
        WHERE workspace_id = ${workspaceA}
          AND purpose = 'embedding_query'
          AND model = ${ALT_EMBEDDING_MODEL}
      `;
      expect(altCalls.length).toBeGreaterThan(0);

      await sql`UPDATE model_providers SET is_enabled = false WHERE id = ${altProviderId}`;
      embedCalls.length = 0;
      const degraded = await call<SearchResponse>(
        'GET',
        `/api/search?q=${query}&workId=${workA}&limit=20`,
        ownerA,
      );
      expect(degraded.status).toBe(200);
      expect(degraded.body.results.some((item) => item.vectorRank !== null)).toBe(true);
      expect(degraded.body.ledgerResults.every((item) => item.vectorRank === null)).toBe(true);
      expect(degraded.body.ledgerReason).toContain('不一致');
      expect(embedCalls).toEqual([EMBEDDING_MODEL]);
    } finally {
      await sql`UPDATE ledger_chunk_embeddings SET model = ${EMBEDDING_MODEL}`;
      await sql`UPDATE ledger_index_status SET model = ${EMBEDDING_MODEL}`;
      await sql`DELETE FROM chunk_embeddings WHERE chunk_id = ${canonChunkId}`;
      await sql`DELETE FROM canon_chunks WHERE id = ${canonChunkId}`;
      await sql`DELETE FROM index_status WHERE chapter_id = ${prevChapterA}`;
      await sql`DELETE FROM model_calls WHERE model = ${ALT_EMBEDDING_MODEL}`;
      if (altProviderId) {
        await sql`DELETE FROM model_providers WHERE id = ${altProviderId}`;
      }
    }
  });

  it('正典与账本同模型但维度漂移时仍分别取查询向量，维度不符的一路只走词法', async () => {
    const canonChunkId = randomUUID();
    const canonContent = '前夜，林默在北门守夜，铜钉在雨里发亮。';
    const driftedDimensions = 8;
    const countQueryCalls = async () =>
      sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM model_calls
        WHERE workspace_id = ${workspaceA}
          AND purpose = 'embedding_query'
          AND model = ${EMBEDDING_MODEL}
      `;
    const callsBefore = Number((await countQueryCalls())[0]?.count ?? '0');

    try {
      await sql`
        INSERT INTO canon_chunks (
          id, workspace_id, work_id, chapter_id, version_id,
          chunk_index, paragraph_start, paragraph_end, char_start, char_end,
          content, content_hash, lexical_text
        )
        VALUES (
          ${canonChunkId}, ${workspaceA}, ${workA}, ${prevChapterA}, ${prevVersionA},
          0, 0, 0, 0, ${canonContent.length},
          ${canonContent}, ${contentHash(canonContent)}, ${buildLexicalText(canonContent)}
        )
      `;
      await sql`
        INSERT INTO chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
        VALUES (${canonChunkId}, NULL, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, '[1,0,0,0]'::vector)
      `;
      await sql`
        INSERT INTO index_status (
          chapter_id, version_id, status, chunk_count, provider_name, model, dimensions, updated_at
        )
        VALUES (
          ${prevChapterA}, ${prevVersionA}, 'ready', 1, 'M6-4 嵌入测试',
          ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}, now()
        )
      `;
      await sql`
        UPDATE ledger_chunk_embeddings
        SET dimensions = ${driftedDimensions}, embedding = '[1,0,0,0,0,0,0,0]'::vector
      `;
      await sql`UPDATE ledger_index_status SET dimensions = ${driftedDimensions}`;

      embedCalls.length = 0;
      const query = encodeURIComponent('铜钉');
      const drifted = await call<SearchResponse>(
        'GET',
        `/api/search?q=${query}&workId=${workA}&limit=20`,
        ownerA,
      );

      expect(drifted.status).toBe(200);
      expect(drifted.body.mode).toBe('hybrid');
      expect(drifted.body.coverage.vectorModel).toBe(EMBEDDING_MODEL);
      expect(drifted.body.ledgerCoverage.vectorModel).toBe(EMBEDDING_MODEL);
      // 两侧模型名相同，只有索引维度不同：不能共用一个查询向量，也不能把 4 维向量打到 8 维索引上。
      expect(embedCalls).toEqual([EMBEDDING_MODEL, EMBEDDING_MODEL]);
      expect(drifted.body.results.some((item) => item.vectorRank !== null)).toBe(true);
      expect(drifted.body.semanticReason).toBeNull();
      expect(drifted.body.ledgerResults.length).toBeGreaterThan(0);
      expect(drifted.body.ledgerResults.every((item) => item.vectorRank === null)).toBe(true);
      expect(drifted.body.ledgerReason).toContain('账本向量通道未执行');
      expect(drifted.body.ledgerReason).toContain(`与索引维度 ${driftedDimensions} 不一致`);
      const callsAfter = Number((await countQueryCalls())[0]?.count ?? '0');
      expect(callsAfter - callsBefore).toBe(2);
    } finally {
      await sql`UPDATE ledger_chunk_embeddings SET dimensions = ${EMBEDDING_DIMENSIONS}, embedding = '[1,0,0,0]'::vector`;
      await sql`UPDATE ledger_index_status SET dimensions = ${EMBEDDING_DIMENSIONS}`;
      await sql`DELETE FROM chunk_embeddings WHERE chunk_id = ${canonChunkId}`;
      await sql`DELETE FROM canon_chunks WHERE id = ${canonChunkId}`;
      await sql`DELETE FROM index_status WHERE chapter_id = ${prevChapterA}`;
    }
  });

  it('未配置嵌入服务的账本条目仍可词法检索，并如实说明仅词法可用', async () => {
    const entry = await createAndPublish({
      kind: 'setting',
      workId: workA,
      name: '词法铜钉',
      aliases: ['无向量铜钉'],
      summary: '只有词法索引的设定',
      payload: {
        category: 'item',
        details: '词法铜钉内容，用于验证无嵌入时的检索降级。',
        tags: ['铜钉'],
        verification: 'verified',
      },
    });
    const version = entry.currentVersion;
    if (!version) throw new Error('词法测试条目缺少当前版本');
    const chunkId = randomUUID();
    const content = '词法铜钉内容，用于验证无嵌入时的检索降级。';
    try {
      await sql`
        INSERT INTO ledger_chunks (
          id, workspace_id, entry_id, version_id, kind, work_id, chunk_index,
          content, content_hash, lexical_text
        )
        VALUES (
          ${chunkId}, ${workspaceA}, ${entry.id}, ${version.id}, 'setting',
          ${workA}, 0, ${content}, ${contentHash(content)}, ${buildLexicalText(content)}
        )
      `;
      await sql`
        INSERT INTO ledger_index_status (
          entry_id, workspace_id, version_id, status, detail, chunk_count,
          provider_name, model, dimensions, attempts, updated_at
        )
        VALUES (
          ${entry.id}, ${workspaceA}, ${version.id}, 'not_configured',
          '尚未配置启用的嵌入服务商（用途=embedding）；已建立词法索引 1 个片段，仅词法检索可用',
          1, NULL, NULL, NULL, 1, now()
        )
        ON CONFLICT (entry_id) DO UPDATE SET
          version_id = EXCLUDED.version_id,
          status = EXCLUDED.status,
          detail = EXCLUDED.detail,
          chunk_count = EXCLUDED.chunk_count,
          provider_name = NULL,
          model = NULL,
          dimensions = NULL,
          updated_at = now()
      `;

      const result = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('铜钉')}&workId=${workA}&limit=20`,
        ownerA,
      );
      expect(result.status).toBe(200);
      expect(result.body.ledgerCoverage.activeEntries).toBe(5);
      expect(result.body.ledgerCoverage.indexedEntries).toBe(5);
      expect(result.body.ledgerCoverage.chunks).toBe(5);
      expect(result.body.ledgerCoverage.vectorChunks).toBe(4);
      expect(result.body.ledgerReason).toContain('仅支持词法检索');
      const hit = result.body.ledgerResults.find((item) => item.name === '词法铜钉');
      expect(hit).toBeTruthy();
      expect(hit!.lexicalRank).not.toBeNull();
      expect(hit!.vectorRank).toBeNull();
    } finally {
      await sql`DELETE FROM ledger_entries WHERE id = ${entry.id}`;
    }
  });

  it('AI 上下文按设定、角色、伏笔分区并带 L 引用，只使用已生效版本', async () => {
    const bundle = await loadAiLedgerContext({
      workspaceId: workspaceA,
      workId: workA,
      currentChapterNumber: 3,
    });
    expect(bundle.view.status).toBe('ok');
    expect(bundle.view.reason).toBeNull();
    expect(bundle.view.citations).toHaveLength(4);
    expect(bundle.view.usedCharacters).toEqual(['林默']);
    expect(bundle.view.truncated).toBe(false);
    expect(bundle.sections.map((section) => section.key)).toEqual([
      'ledger_settings',
      'ledger_characters',
      'ledger_foreshadowing',
    ]);
    const text = bundle.sections.map((section) => section.text).join('\n');
    expect(text).toContain('[L1]');
    expect(text).toContain('北门');
    expect(text).not.toContain('地牢');
    expect(text).not.toContain('草稿专属标记');
    expect(text).not.toContain('归档专属标记');

    const auth: AuthContext = { ...ownerA.me, sessionId: 'm6-4-session' };
    const run = await prepareProposal(auth, currentChapterA, {
      mode: 'continue',
      instruction: '',
      targetWords: 300,
    });
    try {
      expect(run.context.ledger).toBeTruthy();
      expect(run.context.ledger!.status).toBe('ok');
      expect(run.context.ledger!.citations).toHaveLength(4);
      expect(run.context.ledger!.usedCharacters).toEqual(['林默']);
      const ledgerSections = run.context.sections.filter((section) =>
        section.key.startsWith('ledger_'),
      );
      expect(ledgerSections).toHaveLength(3);
      const userMessage = run.messages.find((message) => message.role === 'user');
      expect(userMessage).toBeTruthy();
      expect(userMessage!.content).toContain('【设定、角色与伏笔');
      expect(userMessage!.content).toContain('引用编号 L1 起');
      expect(userMessage!.content).toContain('林默');
      expect(userMessage!.content).toContain('黑潮专属标记');
      expect(userMessage!.content).not.toContain('草稿专属标记');
      expect(userMessage!.content).not.toContain('归档专属标记');

      const rows = await sql<{ context: { ledger?: { citations: unknown[] } } }[]>`
        SELECT context FROM ai_proposals WHERE id = ${run.proposalId}
      `;
      expect(rows[0]?.context.ledger?.citations).toHaveLength(4);
    } finally {
      await releaseGenerationLock(currentChapterA, run.proposalId);
    }

    const empty = await loadAiLedgerContext({
      workspaceId: workspaceC,
      workId: workC,
      currentChapterNumber: 1,
    });
    expect(empty.view.status).toBe('unavailable');
    expect(empty.view.reason).toContain('尚未发布');
    expect(empty.sections).toHaveLength(0);
  });

  it('超出单条预算的账本条目在引用上逐条标记截断', async () => {
    const longEntry = await createAndPublish({
      kind: 'setting',
      workId: workA,
      name: '超长封印说明',
      aliases: [],
      summary: '用于验证逐条截断标记',
      payload: {
        category: 'item',
        details: '钉'.repeat(900),
        tags: ['封印'],
        verification: 'verified',
      },
    });
    try {
      const bundle = await loadAiLedgerContext({
        workspaceId: workspaceA,
        workId: workA,
        currentChapterNumber: 3,
      });
      const longCitation = bundle.view.citations.find(
        (citation) => citation.entryId === longEntry.id,
      );
      expect(longCitation).toBeTruthy();
      expect(longCitation!.truncated).toBe(true);
      expect(longCitation!.chars).toBe(701);

      const normalCitation = bundle.view.citations.find(
        (citation) => citation.entryId === settingA.id,
      );
      expect(normalCitation).toBeTruthy();
      expect(normalCitation!.truncated).toBe(false);
      expect(bundle.view.truncated).toBe(true);
    } finally {
      await sql`DELETE FROM ledger_entries WHERE id = ${longEntry.id}`;
    }
  });

  it('门禁提示引用别名与伏笔窗口，且不改变 dev-v0 硬门禁结论', async () => {
    await createAndPublish({
      kind: 'foreshadowing',
      workId: workA,
      name: '旧潮已退',
      aliases: [],
      summary: '已回收伏笔不应出现在窗口提示中',
      sourceChapterId: prevChapterA,
      payload: {
        seedChapterId: prevChapterA,
        payoffChapterMin: 2,
        payoffChapterMax: 5,
        importance: 'medium',
        state: 'paid_off',
        payoffChapterId: prevChapterA,
        note: '旧潮线索已在第二章回收。',
        resolutionNote: '第二章已明确回收。',
      },
    });

    const paragraph = '阿默在北门按住铜钉，雨水顺着旧斗篷落下来，他没有回头。';
    const content = `${Array.from({ length: 12 }, () => paragraph).join('\n\n')}\n\n远处传来钟声，他握紧了铜钉……`;
    const saved = await call<{ draft: { contentHash: string } }>(
      'PUT',
      `/api/chapters/${currentChapterA}/draft`,
      ownerA,
      { content },
    );
    expect(saved.status).toBe(200);

    const result = await call<GateEvaluationView>(
      'POST',
      `/api/chapters/${currentChapterA}/gates`,
      ownerA,
    );
    expect(result.status).toBe(200);
    const evaluation = result.body;
    expect(evaluation.status).toBe('failed');

    const core = evaluation.results.find((item) => item.key === 'core_entity');
    expect(core?.status).toBe('failed');
    expect(core?.evidence.missing).toEqual(['林默']);

    const coreHint = evaluation.hints.find((hint) => hint.gate === 'core_entity');
    expect(coreHint).toBeTruthy();
    expect(coreHint!.message).toContain('别名');
    expect(coreHint!.message).toContain('阿默');
    expect(coreHint!.message).toContain('不影响结论');
    expect(coreHint!.entries.map((entry) => entry.name)).toContain('林默');

    const causalityHint = evaluation.hints.find((hint) => hint.gate === 'causality');
    expect(causalityHint).toBeTruthy();
    expect(causalityHint!.entries.map((entry) => entry.name)).toContain('黑潮预兆');
    expect(causalityHint!.entries.map((entry) => entry.name)).not.toContain('旧潮已退');
    expect(causalityHint!.message).toContain('不影响结论');

    const expected = evaluateGates({
      content,
      wordCount: countWords(content),
      plan,
      ruleset: DEV_RULESET,
    });
    expect(evaluation.status).toBe(expected.status);
    expect(evaluation.results).toEqual(expected.results);

    const chapter = await call<ChapterDetail>('GET', `/api/chapters/${currentChapterA}`, ownerA);
    expect(chapter.status).toBe(200);
    expect(chapter.body.latestEvaluation?.hints).toHaveLength(evaluation.hints.length);
  });

  it('章节人工关联仅接受已生效条目，并记录权限、幂等备注与删除', async () => {
    const countEvaluations = async (): Promise<number> => {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM gate_evaluations WHERE chapter_id = ${currentChapterA}
      `;
      return rows[0]?.count ?? 0;
    };
    const before = await countEvaluations();

    const first = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: settingA.id, note: '本章核心道具' },
    );
    expect(first.status).toBe(200);
    expect(first.body.links).toHaveLength(1);
    expect(first.body.links[0]?.name).toBe('封印铜钉');
    expect(first.body.note).toContain('不参与门禁判定');
    expect(first.body.note).toContain('不会生成评估结论');

    const second = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: settingA.id, note: '更新后的备注' },
    );
    expect(second.status).toBe(200);
    expect(second.body.links).toHaveLength(1);
    expect(second.body.links[0]?.id).toBe(first.body.links[0]?.id);
    expect(second.body.links[0]?.note).toBe('更新后的备注');

    const viewerWrite = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      viewerA,
      { entryId: settingA.id },
    );
    expectError(viewerWrite, 403, 'FORBIDDEN');
    const billingReader = await call<ChapterLedgerLinksResponse>(
      'GET',
      `/api/chapters/${currentChapterA}/ledger-links`,
      reviewerA,
    );
    expect(billingReader.status).toBe(200);

    const crossWork = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: otherWorkSettingA.id },
    );
    expectError(crossWork, 409, 'LEDGER_ENTRY_WORK_MISMATCH');

    const draftLink = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: draftSettingA.id },
    );
    expectError(draftLink, 409, 'LEDGER_ENTRY_NOT_ACTIVE');

    const workspaceLink = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: workspaceSettingA.id },
    );
    expect(workspaceLink.status).toBe(200);
    expect(workspaceLink.body.links.map((link) => link.name)).toContain('北境通行令');

    const after = await countEvaluations();
    expect(after).toBe(before);

    const removed = await call<ChapterLedgerLinksResponse>(
      'DELETE',
      `/api/chapters/${currentChapterA}/ledger-links/${first.body.links[0]!.id}`,
      ownerA,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.links.map((link) => link.name)).not.toContain('封印铜钉');
    expect(await countEvaluations()).toBe(before);
  });

  it('章节关联拒绝跨工作区与已归档条目，失败的尝试不留行也不留审计，备注覆盖不改归因', async () => {
    const linkCount = async (chapterId: string): Promise<number> => {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM chapter_ledger_links WHERE chapter_id = ${chapterId}
      `;
      return rows[0]?.count ?? 0;
    };
    const currentLinksBefore = await linkCount(currentChapterA);
    const ghostChapter = randomUUID();

    const outsiderList = await call<ErrorBody>(
      'GET',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerB,
    );
    expectError(outsiderList, 404, 'CHAPTER_NOT_FOUND');
    const outsiderWrite = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerB,
      { entryId: settingA.id, note: '外部所有者试图关联' },
    );
    expectError(outsiderWrite, 404, 'CHAPTER_NOT_FOUND');

    expectError(
      await call<ErrorBody>('GET', `/api/chapters/${ghostChapter}/ledger-links`, ownerA),
      404,
      'CHAPTER_NOT_FOUND',
    );
    expectError(
      await call<ErrorBody>('POST', `/api/chapters/${ghostChapter}/ledger-links`, ownerA, {
        entryId: settingA.id,
      }),
      404,
      'CHAPTER_NOT_FOUND',
    );

    const externalEntry = await createAndPublish(
      {
        kind: 'setting',
        name: 'M6-4 外部归档令',
        summary: '只属于外部工作区',
        payload: {
          category: 'rule',
          details: '外部工作区规则，不应被本工作区关联。',
          tags: [],
          verification: 'unverified',
        },
      },
      ownerB,
    );
    const crossWorkspaceEntry = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: externalEntry.id },
    );
    expectError(crossWorkspaceEntry, 404, 'LEDGER_ENTRY_NOT_FOUND');

    const archivedLink = await call<ErrorBody>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: archivedSettingA.id, note: '已归档旧案' },
    );
    expectError(archivedLink, 409, 'LEDGER_ENTRY_NOT_ACTIVE');

    expect(await linkCount(currentChapterA)).toBe(currentLinksBefore);
    const failedAudits = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE workspace_id = ${workspaceA}
        AND action = 'chapter.ledger_link.add'
        AND metadata->>'entryId' IN (${externalEntry.id}, ${archivedSettingA.id})
    `;
    expect(failedAudits[0]?.count).toBe(0);

    const byAuthor = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      authorA,
      { entryId: characterA.id, note: '作者标注：本章出场' },
    );
    expect(byAuthor.status).toBe(200);
    const created = byAuthor.body.links.find((link) => link.entryId === characterA.id);
    expect(created?.createdByName).toBe('M6-4 作者');

    const byOwner = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${currentChapterA}/ledger-links`,
      ownerA,
      { entryId: characterA.id, note: '所有者改写备注' },
    );
    expect(byOwner.body.links).toHaveLength(byAuthor.body.links.length);
    const overwritten = byOwner.body.links.find((link) => link.entryId === characterA.id);
    expect(overwritten?.id).toBe(created?.id);
    expect(overwritten?.note).toBe('所有者改写备注');
    expect(overwritten?.createdByName).toBe('M6-4 作者');
    expect(overwritten?.createdAt).toBe(created?.createdAt);

    const prevLink = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${prevChapterA}/ledger-links`,
      ownerA,
      { entryId: settingA.id, note: '上一章的关联' },
    );
    expect(prevLink.status).toBe(200);
    const prevLinkId = prevLink.body.links.find((link) => link.entryId === settingA.id)!.id;
    expectError(
      await call<ErrorBody>(
        'DELETE',
        `/api/chapters/${currentChapterA}/ledger-links/${prevLinkId}`,
        ownerA,
      ),
      404,
      'CHAPTER_LEDGER_LINK_NOT_FOUND',
    );
    const removedPrev = await call<ChapterLedgerLinksResponse>(
      'DELETE',
      `/api/chapters/${prevChapterA}/ledger-links/${prevLinkId}`,
      ownerA,
    );
    expect(removedPrev.status).toBe(200);
    expect(removedPrev.body.links.map((link) => link.entryId)).not.toContain(settingA.id);

    const audits = await sql<
      { action: string; actor_type: string; actor_id: string; object_id: string }[]
    >`
      SELECT action, actor_type, actor_id, object_id FROM audit_log
      WHERE workspace_id = ${workspaceA}
        AND action LIKE 'chapter.ledger_link.%'
        AND metadata->>'linkId' IN (${created!.id}, ${prevLinkId})
      ORDER BY created_at ASC, id ASC
    `;
    expect(audits.map((row) => row.action)).toEqual([
      'chapter.ledger_link.add',
      'chapter.ledger_link.add',
      'chapter.ledger_link.add',
      'chapter.ledger_link.remove',
    ]);
    expect(audits.every((row) => row.actor_type === 'human')).toBe(true);
    expect(audits[0]?.actor_id).toBe(authorA.me.user.id);
    expect(audits.slice(1).every((row) => row.actor_id === ownerA.me.user.id)).toBe(true);
    expect(audits.slice(0, 2).every((row) => row.object_id === currentChapterA)).toBe(true);
    expect(audits.slice(2).every((row) => row.object_id === prevChapterA)).toBe(true);
    expect(await linkCount(currentChapterA)).toBe(currentLinksBefore + 1);
  });

  it('导入章节可人工关联账本，但保持未评估且不产生门禁结论', async () => {
    const imported = await call<ImportChaptersResponse>(
      'POST',
      '/api/chapters/import',
      ownerA,
      {
        workTitle: `M6-4 导入作品 ${RUN_ID}`,
        volumeNumber: 1,
        volumeTitle: '导一卷',
        chapters: [
          {
            number: 1,
            title: '旧章归位',
            content: '旧章里的铜钉已经生锈，守夜人把它埋进土里。',
          },
        ],
      },
    );
    expect(imported.status).toBe(200);
    const chapterId = imported.body.imported[0]!.id;

    const detail = await call<ChapterDetail>('GET', `/api/chapters/${chapterId}`, ownerA);
    expect(detail.status).toBe(200);
    expect(detail.body.currentVersion?.source).toBe('import');
    expect(detail.body.currentVersion?.gateStatus).toBe('not_evaluated');
    expect(detail.body.latestEvaluation).toBeNull();

    const linked = await call<ChapterLedgerLinksResponse>(
      'POST',
      `/api/chapters/${chapterId}/ledger-links`,
      ownerA,
      { entryId: workspaceSettingA.id, note: '导入章人工标注' },
    );
    expect(linked.status).toBe(200);
    expect(linked.body.links).toHaveLength(1);

    const after = await call<ChapterDetail>('GET', `/api/chapters/${chapterId}`, ownerA);
    expect(after.status).toBe(200);
    expect(after.body.currentVersion?.gateStatus).toBe('not_evaluated');
    expect(after.body.latestEvaluation).toBeNull();
    const evaluationRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM gate_evaluations WHERE chapter_id = ${chapterId}
    `;
    expect(evaluationRows[0]?.count).toBe(0);
  });
});
