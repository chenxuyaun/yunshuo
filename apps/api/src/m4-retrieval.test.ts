import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type {
  EmbeddingProbeResponse,
  MeResponse,
  ModelDiscoveryResponse,
  ModelProviderView,
  ReindexResponse,
  SearchResponse,
} from '@yunshuo/contracts';
import type { ChapterPlan } from '@yunshuo/domain';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { EMBEDDING_PROBE_TEXT } from '@yunshuo/model-gateway';
import { buildLexicalText } from '@yunshuo/retrieval';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { loadChapter } from './services/chapter-data.js';
import {
  loadProposalRetrieval,
  prepareProposal,
  proposalMeta,
  releaseGenerationLock,
} from './services/ai-service.js';

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

interface StubRequest {
  path: string;
  authorization: string | null;
  body: { model?: string; input?: unknown } | null;
}

type StubMode = 'ok' | 'error' | 'drift' | 'orthogonal' | 'partial';

type ModelsStub =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'no_data_field' }
  | { kind: 'echo_authorization'; status: number }
  | { kind: 'hang' };

const EMBEDDING_MODEL = 'stub-embed';
const EMBEDDING_DIMENSIONS = 4;
const RUN_ID = randomUUID().slice(0, 8);
const TEST_EMAIL_SUFFIX = `@m4-${RUN_ID}.test`;
const TEST_CHAPTER_NUMBERS = {
  seal: 8801,
  oldVersion: 8802,
  current: 8803,
  pending: 8804,
  noCanon: 8805,
} as const;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M4 集成测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M4 正典索引与混合检索', () => {
  let app: FastifyInstance;
  let stub: Server;
  let stubPort = 0;
  let stubMode: StubMode = 'ok';
  let modelsStub: ModelsStub = { kind: 'ids', ids: ['stub-chat'] };
  let stubRequests: StubRequest[] = [];

  let workspaceA = '';
  let workspaceB = '';
  let workA = '';
  let workB = '';
  let ownerA: Session;
  let leadA: Session;
  let authorA: Session;
  let ownerB: Session;
  const testUserIds: string[] = [];

  let embeddingProviderId = '';
  let chatProviderId = '';

  let chapterSeal = '';
  let chapterOldVersion = '';
  let chapterCurrent = '';
  let chapterPending = '';
  let chapterNoCanon = '';
  let chapterIsolation = '';

  let sealVersion = '';
  let oldVersion = '';
  let oldChunkId = '';
  let currentVersion = '';
  let currentChunkId = '';
  let currentChapterVersion = '';
  let pendingVersion = '';
  let isolationVersion = '';

  function vectorLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }

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
    return {
      cookie: rawCookie.split(';')[0]!,
      me: response.json() as MeResponse,
    };
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
    workspaceId: string,
    email: string,
    name: string,
    role: 'owner' | 'lead' | 'author',
  ): Promise<{ id: string; session: Promise<Session> }> {
    const id = randomUUID();
    testUserIds.push(id);
    await sql`INSERT INTO users (id, email, name) VALUES (${id}, ${email}, ${name})`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return { id, session: login(email) };
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
    status: 'canon' | 'revision' | 'planned',
    plan: ChapterPlan,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (${id}, ${workId}, ${volumeId}, ${number}, ${title}, ${status},
        ${sql.json(jsonValue(plan))})
    `;
    return id;
  }

  async function insertVersion(
    chapterId: string,
    versionNo: number,
    content: string,
  ): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source
      )
      VALUES (
        ${id}, ${chapterId}, ${versionNo}, ${content}, ${contentHash(content)},
        ${content.length}, 'human'
      )
    `;
    return id;
  }

  async function setCurrentVersion(chapterId: string, versionId: string): Promise<void> {
    await sql`UPDATE chapters SET current_version_id = ${versionId} WHERE id = ${chapterId}`;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${versionId})
      ON CONFLICT (chapter_id) DO UPDATE SET version_id = EXCLUDED.version_id, updated_at = now()
    `;
  }

  async function insertChunk(params: {
    workspaceId: string;
    workId: string;
    chapterId: string;
    versionId: string;
    content: string;
    vector?: number[];
  }): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO canon_chunks (
        id, workspace_id, work_id, chapter_id, version_id,
        chunk_index, paragraph_start, paragraph_end, char_start, char_end,
        content, content_hash, lexical_text
      )
      VALUES (
        ${id}, ${params.workspaceId}, ${params.workId}, ${params.chapterId}, ${params.versionId},
        0, 0, 0, 0, ${Math.max(1, params.content.length)},
        ${params.content}, ${contentHash(params.content)}, ${buildLexicalText(params.content)}
      )
    `;
    if (params.vector) {
      await sql`
        INSERT INTO chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
        VALUES (
          ${id}, ${embeddingProviderId}, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS},
          ${vectorLiteral(params.vector)}::vector
        )
      `;
    }
    return id;
  }

  async function insertIndexStatus(
    chapterId: string,
    versionId: string,
    status: 'ready' | 'pending',
    chunkCount: number,
  ): Promise<void> {
    await sql`
      INSERT INTO index_status (
        chapter_id, version_id, status, chunk_count, provider_name, model, dimensions, updated_at
      )
      VALUES (
        ${chapterId}, ${versionId}, ${status}, ${chunkCount},
        ${status === 'ready' ? 'M4 嵌入测试服务商' : null},
        ${status === 'ready' ? EMBEDDING_MODEL : null},
        ${status === 'ready' ? EMBEDDING_DIMENSIONS : null}, now()
      )
    `;
  }

  async function removeWorkspaceData(workspaceId: string): Promise<void> {
    await sql`DELETE FROM ai_generation_locks WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM ai_proposals WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
    await sql`
      UPDATE chapters SET current_version_id = NULL
      WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${workspaceId})
    `;
    await sql`
      DELETE FROM canon_current
      WHERE chapter_id IN (
        SELECT id FROM chapters
        WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${workspaceId})
      )
    `;
    await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM model_providers WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
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

        if ((request.url ?? '').endsWith('/models')) {
          const reply = (status: number, payload: unknown) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(payload));
          };
          if (modelsStub.kind === 'hang') {
            // 接受连接但一行响应都不写：这条请求只能由客户端的 8 秒超时结束
            return;
          }
          if (modelsStub.kind === 'echo_authorization') {
            reply(modelsStub.status, {
              error: { message: `stub 收到 ${request.headers.authorization ?? '无授权头'}` },
            });
            return;
          }
          if (modelsStub.kind === 'no_data_field') {
            reply(200, { results: ['不是 data 数组'] });
            return;
          }
          reply(200, {
            object: 'list',
            data: modelsStub.ids.map((id) => ({ id, object: 'model' })),
          });
          return;
        }

        if (!(request.url ?? '').endsWith('/embeddings')) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 未实现该接口' } }));
          return;
        }

        if (stubMode === 'error') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 嵌入服务故障' } }));
          return;
        }

        const inputs = Array.isArray(body?.input)
          ? body.input
          : [typeof body?.input === 'string' ? body.input : ''];
        const dimensions = stubMode === 'drift' ? 3 : EMBEDDING_DIMENSIONS;
        const queryVector =
          stubMode === 'orthogonal'
            ? [0, 0, 1, 0]
            : stubMode === 'partial'
              ? [1, 0.08, 0, 0]
              : null;
        const data = inputs.map((_, index) => ({
          object: 'embedding',
          index,
          embedding:
            queryVector ??
            Array.from({ length: dimensions }, (_, position) => (position === 0 ? 1 : 0)),
        }));

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            model: body?.model ?? EMBEDDING_MODEL,
            data,
            usage: {
              prompt_tokens: inputs.length * 12,
              total_tokens: inputs.length * 12,
            },
          }),
        );
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

    workspaceA = await createWorkspace('M4 检索测试工作区 A');
    workspaceB = await createWorkspace('M4 检索测试工作区 B');

    const ownerUser = await createUser(workspaceA, `owner-a${TEST_EMAIL_SUFFIX}`, 'M4 所有者', 'owner');
    const leadUser = await createUser(workspaceA, `lead-a${TEST_EMAIL_SUFFIX}`, 'M4 主笔', 'lead');
    const authorUser = await createUser(workspaceA, `author-a${TEST_EMAIL_SUFFIX}`, 'M4 作者', 'author');
    const ownerBUser = await createUser(workspaceB, `owner-b${TEST_EMAIL_SUFFIX}`, 'M4 B 所有者', 'owner');
    ownerA = await ownerUser.session;
    leadA = await leadUser.session;
    authorA = await authorUser.session;
    ownerB = await ownerBUser.session;

    const createdEmbedding = await call<ModelProviderView>('POST', '/api/model-providers', ownerA, {
      name: 'M4 嵌入测试服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: EMBEDDING_MODEL,
      purpose: 'embedding',
      apiKey: 'm4-embedding-key',
      isEnabled: true,
      priority: 1,
      promptPricePer1m: 2,
      priceCurrency: 'CNY',
    });
    expect(createdEmbedding.status).toBe(200);
    embeddingProviderId = createdEmbedding.body.id;
    expect(createdEmbedding.body.purpose).toBe('embedding');
    expect(createdEmbedding.body.hasKey).toBe(true);

    const createdChat = await call<ModelProviderView>('POST', '/api/model-providers', ownerA, {
      name: 'M4 对话测试服务商',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-chat',
      purpose: 'chat',
      apiKey: 'm4-chat-key',
      isEnabled: true,
      priority: 2,
      promptPricePer1m: 2,
      completionPricePer1m: 8,
      priceCurrency: 'CNY',
    });
    expect(createdChat.status).toBe(200);
    chatProviderId = createdChat.body.id;

    const createdA = await createWork(workspaceA, 'M4 检索测试作品');
    const createdB = await createWork(workspaceB, 'M4 隔离测试作品');
    workA = createdA.workId;
    workB = createdB.workId;

    chapterSeal = await createChapter(
      workA,
      createdA.volumeId,
      TEST_CHAPTER_NUMBERS.seal,
      '封印之夜',
      'canon',
      {},
    );
    chapterOldVersion = await createChapter(
      workA,
      createdA.volumeId,
      TEST_CHAPTER_NUMBERS.oldVersion,
      '旧版本秘密',
      'canon',
      {},
    );
    chapterCurrent = await createChapter(
      workA,
      createdA.volumeId,
      TEST_CHAPTER_NUMBERS.current,
      '追兵将至',
      'revision',
      {
        requiredEntities: ['林默'],
        goalKeywords: ['封印'],
        obstacleKeywords: ['追兵'],
      },
    );
    chapterPending = await createChapter(
      workA,
      createdA.volumeId,
      TEST_CHAPTER_NUMBERS.pending,
      '尚未索引',
      'canon',
      {},
    );
    chapterNoCanon = await createChapter(
      workA,
      createdA.volumeId,
      TEST_CHAPTER_NUMBERS.noCanon,
      '尚无正典',
      'planned',
      {},
    );
    chapterIsolation = await createChapter(
      workB,
      createdB.volumeId,
      8901,
      '隔离章节',
      'canon',
      {},
    );

    const sealContent = '雨水压低了长街。林默把封印钉在门槛上，追兵在巷口停下脚步。';
    sealVersion = await insertVersion(chapterSeal, 1, sealContent);
    await setCurrentVersion(chapterSeal, sealVersion);
    await insertChunk({
      workspaceId: workspaceA,
      workId: workA,
      chapterId: chapterSeal,
      versionId: sealVersion,
      content: sealContent,
      vector: [1, 0, 0, 0],
    });
    await insertIndexStatus(chapterSeal, sealVersion, 'ready', 1);

    oldVersion = await insertVersion(
      chapterOldVersion,
      1,
      '封印核心藏在旧井里，追兵尚未发现。',
    );
    oldChunkId = await insertChunk({
      workspaceId: workspaceA,
      workId: workA,
      chapterId: chapterOldVersion,
      versionId: oldVersion,
      content: '封印核心藏在旧井里，追兵尚未发现。',
      vector: [1, 0, 0, 0],
    });
    const currentContent = '北境商队带来了盐和铁，没有人在意旧井。';
    currentVersion = await insertVersion(chapterOldVersion, 2, currentContent);
    await setCurrentVersion(chapterOldVersion, currentVersion);
    currentChunkId = await insertChunk({
      workspaceId: workspaceA,
      workId: workA,
      chapterId: chapterOldVersion,
      versionId: currentVersion,
      content: currentContent,
      vector: [0.45, -0.9, 0, 0],
    });
    await insertIndexStatus(chapterOldVersion, currentVersion, 'ready', 1);

    const currentChapterContent = '追兵沿着河岸追来，火光映红了水面。';
    currentChapterVersion = await insertVersion(chapterCurrent, 1, currentChapterContent);
    await setCurrentVersion(chapterCurrent, currentChapterVersion);
    await insertChunk({
      workspaceId: workspaceA,
      workId: workA,
      chapterId: chapterCurrent,
      versionId: currentChapterVersion,
      content: currentChapterContent,
      vector: [1, 0, 0, 0],
    });
    await insertIndexStatus(chapterCurrent, currentChapterVersion, 'ready', 1);
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, expires_at)
      VALUES (${chapterCurrent}, ${ownerUser.id}, ${new Date(Date.now() + 60 * 60_000)})
    `;

    pendingVersion = await insertVersion(chapterPending, 1, '这份正典尚未建立索引。');
    await setCurrentVersion(chapterPending, pendingVersion);
    await insertIndexStatus(chapterPending, pendingVersion, 'pending', 0);

    isolationVersion = await insertVersion(chapterIsolation, 1, '封印在另一个工作区的古堡里。');
    await setCurrentVersion(chapterIsolation, isolationVersion);
    await insertChunk({
      workspaceId: workspaceB,
      workId: workB,
      chapterId: chapterIsolation,
      versionId: isolationVersion,
      content: '封印在另一个工作区的古堡里。',
    });
    await insertIndexStatus(chapterIsolation, isolationVersion, 'ready', 1);
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, expires_at)
      VALUES (${chapterSeal}, ${ownerUser.id}, ${new Date(Date.now() + 60 * 60_000)})
    `;
  });

  afterAll(async () => {
    for (const workspaceId of [workspaceA, workspaceB]) {
      if (workspaceId) await removeWorkspaceData(workspaceId);
    }
    if (testUserIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(testUserIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(testUserIds)}`;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (app) await app.close();
    await closeDb();
  });

  it('混合检索返回当前正典片段，旧版本永不返回', async () => {
    stubMode = 'ok';
    stubRequests = [];

    const query = encodeURIComponent('封印');
    const result = await call<SearchResponse>('GET', `/api/search?q=${query}`, ownerA);
    expect(result.status).toBe(200);
    const body = result.body;

    expect(body.mode).toBe('hybrid');
    expect(body.semanticReason).toBeNull();
    expect(body.coverage).toEqual({
      totalCanonChapters: 4,
      ready: 3,
      indexing: 0,
      pending: 1,
      failed: 0,
      notConfigured: 0,
      stale: 0,
      chunks: 3,
      vectorChunks: 3,
      vectorModel: EMBEDDING_MODEL,
    });

    const seal = body.results.find((item) => item.chapterId === chapterSeal);
    expect(seal).toBeTruthy();
    expect(seal!.versionId).toBe(sealVersion);
    expect(seal!.versionNo).toBe(1);
    expect(seal!.lexicalRank).not.toBeNull();
    expect(seal!.vectorRank).not.toBeNull();
    expect(seal!.lexicalScore).not.toBeNull();
    expect(seal!.vectorScore).not.toBeNull();
    expect(seal!.excerpt).toContain('封印');

    const current = body.results.find((item) => item.chapterId === chapterOldVersion);
    expect(current).toBeTruthy();
    expect(current!.chunkId).toBe(currentChunkId);
    expect(current!.versionId).toBe(currentVersion);
    expect(current!.versionNo).toBe(2);
    expect(current!.lexicalRank).toBeNull();
    expect(current!.vectorRank).not.toBeNull();

    expect(body.results.some((item) => item.chunkId === oldChunkId)).toBe(false);
    expect(body.results.some((item) => item.versionId === oldVersion)).toBe(false);
    expect(body.results.some((item) => item.chapterId === chapterIsolation)).toBe(false);
    expect(body.results.some((item) => item.chapterId === chapterPending)).toBe(false);

    const queryCall = stubRequests.find(
      (request) => request.body?.model === EMBEDDING_MODEL && request.path.endsWith('/embeddings'),
    );
    expect(queryCall).toBeTruthy();
    expect(queryCall!.body?.input).toEqual(['封印']);
    expect(queryCall!.authorization).toBe('Bearer m4-embedding-key');
    expect(stubRequests.some((request) => request.body?.model === 'stub-chat')).toBe(false);
  });

  it('向量最高相似度低于阈值时整条向量通道降级为词法', async () => {
    stubMode = 'orthogonal';
    try {
      const result = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('封印')}`,
        ownerA,
      );
      expect(result.status).toBe(200);
      expect(result.body.mode).toBe('lexical');
      expect(result.body.semanticReason).toContain('相似度');
      expect(result.body.semanticReason).toContain('阈值');
      expect(result.body.semanticReason).toContain('仅用词法检索');

      const seal = result.body.results.find((item) => item.chapterId === chapterSeal);
      expect(seal).toBeTruthy();
      expect(seal!.lexicalRank).not.toBeNull();
      expect(seal!.vectorRank).toBeNull();
      expect(seal!.vectorScore).toBeNull();
      expect(result.body.results.some((item) => item.chapterId === chapterOldVersion)).toBe(
        false,
      );
    } finally {
      stubMode = 'ok';
    }
  });

  it('低于阈值的向量邻居被过滤，高分向量命中仍参与混合检索', async () => {
    stubMode = 'partial';
    try {
      const result = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('封印')}`,
        ownerA,
      );
      expect(result.status).toBe(200);
      expect(result.body.mode).toBe('hybrid');
      expect(result.body.semanticReason).toBeNull();

      const seal = result.body.results.find((item) => item.chapterId === chapterSeal);
      expect(seal).toBeTruthy();
      expect(seal!.vectorRank).not.toBeNull();
      expect(seal!.vectorScore).toBeGreaterThan(0.9);
      expect(result.body.results.some((item) => item.chapterId === chapterOldVersion)).toBe(
        false,
      );
    } finally {
      stubMode = 'ok';
    }
  });

  it('诊断模式强制词法检索时不调用嵌入服务', async () => {
    stubRequests = [];
    const result = await call<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent('封印')}&mode=lexical`,
      ownerA,
    );
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('lexical');
    expect(result.body.semanticReason).toContain('诊断模式');
    expect(stubRequests).toHaveLength(0);
    const seal = result.body.results.find((item) => item.chapterId === chapterSeal);
    expect(seal).toBeTruthy();
    expect(seal!.lexicalRank).not.toBeNull();
    expect(seal!.vectorRank).toBeNull();
    expect(seal!.vectorScore).toBeNull();
    expect(result.body.results.some((item) => item.chapterId === chapterOldVersion)).toBe(
      false,
    );
  });

  it('单字查询退回子串匹配，且不返回旧版本', async () => {
    const result = await call<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent('封')}`,
      ownerA,
    );
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('hybrid');
    const seal = result.body.results.find((item) => item.chapterId === chapterSeal);
    expect(seal).toBeTruthy();
    expect(seal!.lexicalRank).not.toBeNull();
    expect(seal!.lexicalScore).toBeNull();
    expect(result.body.results.some((item) => item.chunkId === oldChunkId)).toBe(false);
  });

  it('检索只覆盖当前工作区，词法降级原因明确', async () => {
    const result = await call<SearchResponse>(
      'GET',
      `/api/search?q=${encodeURIComponent('封印')}`,
      ownerB,
    );
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe('lexical');
    expect(result.body.semanticReason).toContain('向量索引');
    expect(result.body.coverage).toEqual({
      totalCanonChapters: 1,
      ready: 1,
      indexing: 0,
      pending: 0,
      failed: 0,
      notConfigured: 0,
      stale: 0,
      chunks: 1,
      vectorChunks: 0,
      vectorModel: null,
    });
    expect(result.body.results.map((item) => item.chapterId)).toContain(chapterIsolation);
    expect(result.body.results.every((item) => item.chapterId !== chapterSeal)).toBe(true);
    expect(result.body.results.every((item) => item.vectorRank === null)).toBe(true);
  });

  it('停用嵌入服务商后检索降级为词法，AI 检索也如实标注', async () => {
    const disabled = await call<ModelProviderView>(
      'PATCH',
      `/api/model-providers/${embeddingProviderId}`,
      ownerA,
      { isEnabled: false },
    );
    expect(disabled.status).toBe(200);

    try {
      const result = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('封印')}`,
        ownerA,
      );
      expect(result.status).toBe(200);
      expect(result.body.mode).toBe('lexical');
      expect(result.body.semanticReason).toContain('嵌入服务商');
      const seal = result.body.results.find((item) => item.chapterId === chapterSeal);
      expect(seal).toBeTruthy();
      expect(seal!.lexicalRank).not.toBeNull();
      expect(seal!.vectorRank).toBeNull();
      expect(result.body.results.some((item) => item.chapterId === chapterOldVersion)).toBe(
        false,
      );

      const chapter = await loadChapter(sql, workspaceA, chapterCurrent);
      if (!chapter) throw new Error('找不到用于 AI 检索的章节');
      const retrieval = await loadProposalRetrieval(workspaceA, chapter, '');
      expect(retrieval.view.status).toBe('lexical');
      expect(retrieval.view.reason).toContain('嵌入服务商');
      expect(retrieval.view.citations.length).toBeGreaterThan(0);
      expect(retrieval.view.citations.map((item) => item.chapterId)).toContain(chapterSeal);
      expect(retrieval.view.citations.map((item) => item.chapterId)).not.toContain(chapterCurrent);
    } finally {
      const restored = await call<ModelProviderView>(
        'PATCH',
        `/api/model-providers/${embeddingProviderId}`,
        ownerA,
        { isEnabled: true },
      );
      expect(restored.status).toBe(200);
    }
  });

  it('查询嵌入失败或维度漂移时只降级，不影响词法结果', async () => {
    const before = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_calls
      WHERE workspace_id = ${workspaceA}
        AND purpose = 'embedding_query' AND status = 'failed'
    `;

    stubMode = 'error';
    try {
      const failed = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('封印')}`,
        ownerA,
      );
      expect(failed.status).toBe(200);
      expect(failed.body.mode).toBe('lexical');
      expect(failed.body.semanticReason).toContain('查询嵌入失败');
      expect(failed.body.results.some((item) => item.chapterId === chapterSeal)).toBe(true);
    } finally {
      stubMode = 'ok';
    }

    stubMode = 'drift';
    try {
      const drift = await call<SearchResponse>(
        'GET',
        `/api/search?q=${encodeURIComponent('封印')}`,
        ownerA,
      );
      expect(drift.status).toBe(200);
      expect(drift.body.mode).toBe('lexical');
      expect(drift.body.semanticReason).toContain('维度');
    } finally {
      stubMode = 'ok';
    }

    const after = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_calls
      WHERE workspace_id = ${workspaceA}
        AND purpose = 'embedding_query' AND status = 'failed'
    `;
    expect(after[0]!.count).toBe(before[0]!.count + 1);
  });

  it('AI 上下文引用当前正典且排除本章，检索快照进入提案', async () => {
    const auth: AuthContext = { ...ownerA.me, sessionId: 'm4-test-session' };
    const run = await prepareProposal(auth, chapterCurrent, {
      mode: 'continue',
      instruction: '',
      targetWords: 300,
    });

    try {
      const retrieval = run.context.retrieval;
      expect(retrieval).toBeTruthy();
      expect(retrieval!.status).toBe('ok');
      expect(retrieval!.reason).toBeNull();
      expect(retrieval!.citations.length).toBeGreaterThan(0);
      expect(retrieval!.citations.length).toBeLessThanOrEqual(6);

      const citedChapters = retrieval!.citations.map((item) => item.chapterId);
      expect(citedChapters).toContain(chapterSeal);
      expect(citedChapters).not.toContain(chapterCurrent);
      for (const citation of retrieval!.citations) {
        expect(citation.versionId === sealVersion || citation.versionId === currentVersion).toBe(
          true,
        );
        expect(citation.chars).toBeLessThanOrEqual(500);
      }
      const currentCitation = retrieval!.citations.find(
        (item) => item.chapterId === chapterOldVersion,
      );
      if (currentCitation) {
        expect(currentCitation.versionId).toBe(currentVersion);
        expect(currentCitation.versionNo).toBe(2);
      }

      const section = run.context.sections.find((item) => item.key === 'canon_retrieval');
      expect(section).toBeTruthy();
      expect(section!.usedChars).toBeGreaterThan(0);

      const userMessage = run.messages.find((message) => message.role === 'user');
      expect(userMessage).toBeTruthy();
      expect(userMessage!.content).toContain('[R1] 第8801章');
      expect(userMessage!.content).not.toContain('第8803章');

      expect(run.contextSnapshot.retrievalQuery).toBe('林默 封印 追兵');
      const snapshotRetrieval = run.contextSnapshot.retrievalView as {
        citations: unknown[];
      };
      expect(snapshotRetrieval.citations.length).toBe(retrieval!.citations.length);

      const rows = await sql<{ context: { retrievalView?: { citations: unknown[] } } }[]>`
        SELECT context FROM ai_proposals WHERE id = ${run.proposalId}
      `;
      expect(rows[0]?.context.retrievalView?.citations.length).toBe(
        retrieval!.citations.length,
      );

      const meta = proposalMeta(run);
      expect(meta.context.retrieval?.citations.length).toBe(retrieval!.citations.length);
    } finally {
      await releaseGenerationLock(chapterCurrent, run.proposalId);
    }
  });

  it('嵌入服务商用途、价表与探测接口受权限和规则约束', async () => {
    const invalidPricing = await call<unknown>('POST', '/api/model-providers', ownerA, {
      name: '非法嵌入价表',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: EMBEDDING_MODEL,
      purpose: 'embedding',
      promptPricePer1m: 2,
      completionPricePer1m: 8,
    });
    expectError(invalidPricing, 400, 'VALIDATION');

    const reused = await call<ModelProviderView>('POST', '/api/model-providers', ownerA, {
      name: 'M4 嵌入复用密钥',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: EMBEDDING_MODEL,
      purpose: 'embedding',
      reuseKeyFromProviderId: embeddingProviderId,
      isEnabled: false,
      priority: 9,
      promptPricePer1m: 2,
    });
    expect(reused.status).toBe(200);
    expect(reused.body.hasKey).toBe(true);
    expect(reused.body.purpose).toBe('embedding');
    await sql`DELETE FROM model_providers WHERE id = ${reused.body.id}`;

    stubRequests = [];
    const probe = await call<EmbeddingProbeResponse>(
      'POST',
      '/api/model-providers/probe-embedding',
      ownerA,
      {
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: EMBEDDING_MODEL,
        apiKey: 'm4-probe-key',
      },
    );
    expect(probe.status).toBe(200);
    expect(probe.body.supported).toBe(true);
    expect(probe.body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(probe.body.usage?.promptTokens).toBe(12);
    expect(probe.body.message).toContain('4 维');
    const probeCall = stubRequests.find((request) => request.path.endsWith('/embeddings'));
    expect(probeCall?.body?.input).toEqual([EMBEDDING_PROBE_TEXT]);
    expect(probeCall?.authorization).toBe('Bearer m4-probe-key');

    const audits = await sql<{ result: string; metadata: Record<string, unknown> }[]>`
      SELECT result, metadata FROM audit_log
      WHERE workspace_id = ${workspaceA} AND action = 'model_provider.probe_embedding'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(audits[0]?.result).toBe('success');
    expect(audits[0]?.metadata.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(EMBEDDING_PROBE_TEXT);

    stubMode = 'error';
    try {
      const failedProbe = await call<EmbeddingProbeResponse>(
        'POST',
        '/api/model-providers/probe-embedding',
        ownerA,
        {
          baseUrl: `http://127.0.0.1:${stubPort}/v1`,
          model: EMBEDDING_MODEL,
          apiKey: 'm4-probe-key',
        },
      );
      expect(failedProbe.status).toBe(200);
      expect(failedProbe.body.supported).toBe(false);
      expect(failedProbe.body.message).toContain('500');
    } finally {
      stubMode = 'ok';
    }

    const forbiddenProbe = await call<unknown>(
      'POST',
      '/api/model-providers/probe-embedding',
      authorA,
      {
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        model: EMBEDDING_MODEL,
        apiKey: 'm4-probe-key',
      },
    );
    expectError(forbiddenProbe, 403, 'FORBIDDEN');

    const providers = await sql<{ id: string; purpose: string }[]>`
      SELECT id, purpose FROM model_providers
      WHERE workspace_id = ${workspaceA}
      ORDER BY id ASC
    `;
    expect(providers.map((row) => row.purpose).sort()).toEqual(['chat', 'embedding']);
    expect(providers.some((row) => row.id === chatProviderId)).toBe(true);
    expect(providers.some((row) => row.id === embeddingProviderId)).toBe(true);
  });

  it('重建索引按权限排队，且不覆盖尚无正典的章节', async () => {
    const authorChapter = await call<unknown>(
      'POST',
      `/api/chapters/${chapterSeal}/reindex`,
      authorA,
    );
    expectError(authorChapter, 403, 'FORBIDDEN');

    const authorWorkspace = await call<unknown>('POST', '/api/index/reindex', authorA, {
      workId: workA,
    });
    expectError(authorWorkspace, 403, 'FORBIDDEN');

    const leadWorkspace = await call<unknown>('POST', '/api/index/reindex', leadA, {
      workId: workA,
    });
    expectError(leadWorkspace, 403, 'FORBIDDEN');

    const beforeIdRows = await sql<{ id: number }[]>`
      SELECT COALESCE(MAX(id), 0)::int AS id FROM outbox
    `;
    const beforeId = beforeIdRows[0]!.id;
    const leadChapter = await call<ReindexResponse>(
      'POST',
      `/api/chapters/${chapterPending}/reindex`,
      leadA,
    );
    expect(leadChapter.status).toBe(200);
    expect(leadChapter.body.queued).toBe(1);
    expect(leadChapter.body.alreadyQueued).toBe(0);
    expect(leadChapter.body.message).toContain('重建本章索引');

    const leadChapterAgain = await call<ReindexResponse>(
      'POST',
      `/api/chapters/${chapterPending}/reindex`,
      leadA,
    );
    expect(leadChapterAgain.status).toBe(200);
    expect(leadChapterAgain.body.queued).toBe(0);
    expect(leadChapterAgain.body.alreadyQueued).toBe(1);
    expect(leadChapterAgain.body.message).toContain('已在队列中');

    const ownerWorkspace = await call<ReindexResponse>(
      'POST',
      '/api/index/reindex',
      ownerA,
      { workId: workA },
    );
    expect(ownerWorkspace.status).toBe(200);
    expect(ownerWorkspace.body.queued).toBe(3);
    expect(ownerWorkspace.body.alreadyQueued).toBe(1);
    expect(ownerWorkspace.body.skipped).toBe(1);

    const noCanon = await call<unknown>(
      'POST',
      `/api/chapters/${chapterNoCanon}/reindex`,
      ownerA,
    );
    expectError(noCanon, 409, 'CHAPTER_NO_CANON');

    const jobs = await sql<
      { version_id: string | null; dedupe_key: string | null; next_attempt_at: Date | null }[]
    >`
      SELECT payload->>'versionId' AS version_id,
             dedupe_key,
             next_attempt_at
      FROM outbox
      WHERE event_type = 'index.chapter'
        AND payload->>'workspaceId' = ${workspaceA}
        AND id > ${beforeId}
      ORDER BY id ASC
    `;
    expect(jobs.length).toBe(4);
    expect(jobs.every((job) => job.version_id !== null)).toBe(true);
    expect(jobs.every((job) => job.dedupe_key?.startsWith('index:'))).toBe(true);
    expect(new Set(jobs.map((job) => job.dedupe_key)).size).toBe(4);
    expect(jobs.map((job) => `${job.version_id}`).sort()).toEqual(
      [sealVersion, currentVersion, currentChapterVersion, pendingVersion].sort(),
    );

    const pendingStatus = await sql<{ status: string; attempts: number; version_id: string }[]>`
      SELECT status, attempts, version_id FROM index_status WHERE chapter_id = ${chapterPending}
    `;
    expect(pendingStatus[0]).toEqual({
      status: 'pending',
      attempts: 0,
      version_id: pendingVersion,
    });

    const ownerBWorkspace = await call<ReindexResponse>(
      'POST',
      '/api/index/reindex',
      ownerB,
      { workId: workB },
    );
    expect(ownerBWorkspace.status).toBe(200);
    expect(ownerBWorkspace.body.queued).toBe(1);
    expect(ownerBWorkspace.body.alreadyQueued).toBe(0);
    expect(ownerBWorkspace.body.skipped).toBe(0);

    const audits = await sql<
      {
        metadata: Record<string, unknown>;
        object_type: string;
      }[]
    >`
      SELECT metadata, object_type FROM audit_log
      WHERE workspace_id = ${workspaceA} AND action = 'index.reindex'
      ORDER BY id ASC
    `;
    expect(audits).toHaveLength(3);
    expect(audits.every((row) => typeof row.metadata === 'object')).toBe(true);
    expect(audits[0]?.metadata).toMatchObject({ queued: 1, alreadyQueued: 0 });
    expect(audits[1]?.metadata).toMatchObject({ queued: 0, alreadyQueued: 1 });
    expect(audits[2]?.metadata).toMatchObject({
      queued: 3,
      alreadyQueued: 1,
      skipped: 1,
    });
  });

  it('审计 metadata 为对象，非对象写入被数据库拒绝', async () => {
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE workspace_id IN (${workspaceA}, ${workspaceB})
        AND jsonb_typeof(metadata) <> 'object'
    `;
    expect(rows[0]?.count).toBe(0);

    const providerAudits = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_log
      WHERE workspace_id = ${workspaceA}
        AND action IN ('model_provider.create', 'model_provider.update', 'model_provider.probe_embedding')
      ORDER BY id ASC
    `;
    expect(providerAudits.length).toBeGreaterThanOrEqual(3);
    for (const audit of providerAudits) {
      expect(typeof audit.metadata).toBe('object');
      expect(Array.isArray(audit.metadata)).toBe(false);
    }

    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO audit_log (
            workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
          )
          VALUES (
            ${workspaceA}, NULL, 'human', 'owner', 'test.invalid_metadata', 'workspace',
            ${workspaceA}, 'success', ${tx.json('oops')}
          )
        `;
      }),
    ).rejects.toThrow(/audit_log_metadata_object/);
  });

  it('拉取模型清单按端点响应形状给出口径，失败提示不回显明文密钥', async () => {
    const DISCOVER = '/api/model-providers/discover-models';
    const KEY = 'm4-discover-secret-key';
    const baseUrl = `http://127.0.0.1:${stubPort}/v1`;
    stubRequests = [];

    // 去空白、丢空串、去重都发生在服务端：桩给 4 条，其中一条重复、一条带空格、一条为空
    modelsStub = { kind: 'ids', ids: ['stub-a', ' stub-b ', 'stub-a', ''] };
    const listed = await call<ModelDiscoveryResponse>('POST', DISCOVER, ownerA, {
      baseUrl,
      apiKey: KEY,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.models).toEqual(['stub-a', 'stub-b']);
    expect(listed.body.message).toBe('读取到 2 个模型。');
    expect(listed.body.latencyMs).toBeGreaterThanOrEqual(0);
    // baseUrl 末尾斜杠被规范化（不会拼出 //models），明文 key 只出现在发往端点的请求头里
    expect(stubRequests[0]?.path).toBe('/v1/models');
    expect(stubRequests[0]?.authorization).toBe(`Bearer ${KEY}`);

    modelsStub = { kind: 'ids', ids: Array.from({ length: 201 }, (_, index) => `m${index}`) };
    const capped = await call<ModelDiscoveryResponse>('POST', DISCOVER, ownerA, {
      baseUrl: `http://127.0.0.1:${stubPort}/v1/`,
    });
    expect(capped.status).toBe(200);
    expect(capped.body.models).toHaveLength(200);
    // 提示说端点返回的总数，清单只回前 200：不把截断说成全部
    expect(capped.body.message).toBe('读取到 201 个模型，仅显示前 200 个。');
    expect(stubRequests[1]?.path).toBe('/v1/models');

    // 200 但没有 data 数组：如实说"未包含模型清单"，不混作空清单
    modelsStub = { kind: 'no_data_field' };
    const noData = await call<ModelDiscoveryResponse>('POST', DISCOVER, ownerA, { baseUrl });
    expect(noData.status).toBe(200);
    expect(noData.body.models).toEqual([]);
    expect(noData.body.message).toBe('连接成功（HTTP 200），但响应未包含模型清单。');

    modelsStub = { kind: 'ids', ids: [] };
    const empty = await call<ModelDiscoveryResponse>('POST', DISCOVER, ownerA, { baseUrl });
    expect(empty.status).toBe(200);
    expect(empty.body.models).toEqual([]);
    expect(empty.body.message).toBe('端点返回了空模型清单。');

    // 端点报错时把状态与响应体摘要带回，但响应体里回显的明文密钥必须先被替换
    modelsStub = { kind: 'echo_authorization', status: 500 };
    const failed = await call<ErrorBody>('POST', DISCOVER, ownerA, { baseUrl, apiKey: KEY });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('MODEL_DISCOVERY_FAILED');
    expect(failed.body.error.message).toContain('HTTP 500');
    expect(failed.body.error.message).not.toContain(KEY);
    expect(failed.body.error.message).toContain('••••');

    // 没有鉴权头时不伪造：桩收到的是"无授权头"
    const noKey = await call<ErrorBody>('POST', DISCOVER, ownerA, { baseUrl });
    expect(noKey.status).toBe(502);
    expect(noKey.body.error.message).toContain('无授权头');

    // 端口无人监听时把底层原因码如实带回，而不是含糊的"连接失败"。
    // 先占一个端口再释放，不写死端口号：Windows 上 1 号端口给的是 "bad port" 而不是 ECONNREFUSED。
    const deadPort = await new Promise<number>((resolve, reject) => {
      const gate = createServer();
      gate.once('error', reject);
      gate.listen(0, '127.0.0.1', () => {
        const port = (gate.address() as { port: number }).port;
        gate.close(() => resolve(port));
      });
    });
    modelsStub = { kind: 'ids', ids: ['unused'] };
    const refused = await call<ErrorBody>('POST', DISCOVER, ownerA, {
      baseUrl: `http://127.0.0.1:${deadPort}/v1`,
    });
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe('MODEL_DISCOVERY_FAILED');
    expect(refused.body.error.message).toContain('ECONNREFUSED');

    // 清单形状非法（data 不是数组）也归入"未包含模型清单"，不 500
    modelsStub = { kind: 'no_data_field' };
    expect((await call('POST', DISCOVER, ownerA, { baseUrl, apiKey: 'x' })).status).toBe(200);
    modelsStub = { kind: 'ids', ids: ['stub-chat'] };
  });

  it('拉取模型清单只限所有者与主笔，密钥来源按工作区隔离且不落持久数据', async () => {
    const DISCOVER = '/api/model-providers/discover-models';
    const baseUrl = `http://127.0.0.1:${stubPort}/v1`;
    modelsStub = { kind: 'ids', ids: ['stub-a'] };
    stubRequests = [];
    const auditBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = ${workspaceA}
    `;

    // assertCanView：作者连清单都拉不到，只有所有者与主笔可以查看服务商配置
    expect((await call<ModelDiscoveryResponse>('POST', DISCOVER, leadA, { baseUrl })).status).toBe(200);
    expectError(await call('POST', DISCOVER, authorA, { baseUrl }), 403, 'FORBIDDEN');

    // 跨工作区的 providerId 与不存在的 id 都是 404，不区分"存在但对你不可见"
    expectError(
      await call('POST', DISCOVER, ownerB, { baseUrl, providerId: chatProviderId }),
      404,
      'PROVIDER_NOT_FOUND',
    );
    expectError(
      await call('POST', DISCOVER, ownerA, { baseUrl, providerId: randomUUID() }),
      404,
      'PROVIDER_NOT_FOUND',
    );
    // 缺 baseUrl 由 zod 拦下，不发网络请求
    expectError(await call('POST', DISCOVER, ownerA, {}), 400, 'VALIDATION');

    // 库里那份密钥解不开时如实报"无法解密"，而不是退化成无鉴权请求去连端点
    const created = await call<ModelProviderView>('POST', '/api/model-providers', ownerA, {
      name: 'M4 清单密钥服务商',
      baseUrl,
      model: 'stub-chat',
      purpose: 'chat',
      apiKey: 'm4-discover-stored-key',
      isEnabled: false,
      priority: 9,
      promptPricePer1m: 2,
      completionPricePer1m: 8,
      priceCurrency: 'CNY',
    });
    expect(created.status).toBe(200);
    const keyProviderId = created.body.id;
    await sql`
      UPDATE model_providers SET api_key_ciphertext = ${'not-a-ciphertext'} WHERE id = ${keyProviderId}
    `;
    expectError(
      await call('POST', DISCOVER, ownerA, { baseUrl, providerId: keyProviderId }),
      400,
      'PROVIDER_KEY_UNREADABLE',
    );

    // 当场输入的 key 优先于库里那份：坏密钥服务商仍能用内联 key 拉清单
    const inlineWins = await call<ModelDiscoveryResponse>('POST', DISCOVER, ownerA, {
      baseUrl,
      providerId: keyProviderId,
      apiKey: 'm4-inline-key',
    });
    expect(inlineWins.status).toBe(200);
    expect(inlineWins.body.models).toEqual(['stub-a']);
    expect(stubRequests.at(-1)?.authorization).toBe('Bearer m4-inline-key');

    // 拉清单是临时动作：不改写库里那份（坏）密钥，也不为发现本身写审计
    const stillBroken = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM model_providers
      WHERE id = ${keyProviderId} AND api_key_ciphertext = ${'not-a-ciphertext'}
    `;
    expect(stillBroken[0]?.n).toBe('1');
    const auditAfter = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = ${workspaceA}
    `;
    // 本轮唯一新增的是上面那次 POST /api/model-providers 的 create 审计
    expect(Number(auditAfter[0]?.n)).toBe(Number(auditBefore[0]?.n) + 1);

    await sql`DELETE FROM model_providers WHERE id = ${keyProviderId}`;
    await sql`
      DELETE FROM audit_log
      WHERE workspace_id = ${workspaceA}
        AND action = 'model_provider.create'
        AND object_id = ${keyProviderId}
    `;
  });

  it('模型清单端点接受连接却不响应时按超时收口，不混作连接被拒', async () => {
    const DISCOVER = '/api/model-providers/discover-models';
    const baseUrl = `http://127.0.0.1:${stubPort}/v1`;
    modelsStub = { kind: 'hang' };
    stubRequests = [];

    const startedAt = Date.now();
    // 同 base_url 上别的用例已经建过服务商，所以这里只能比对该调用前后的增量，不能数绝对值
    const providersBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM model_providers
    `;
    const auditBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = ${workspaceA}
    `;
    const hung = await call<ErrorBody>('POST', DISCOVER, ownerA, { baseUrl });
    const elapsed = Date.now() - startedAt;

    expect(hung.status).toBe(502);
    // 三类失败必须分得开：超时、连不上、端点报错各有自己的码与文案
    expect(hung.body.error.code).toBe('MODEL_DISCOVERY_TIMEOUT');
    expect(hung.body.error.message).toContain('连接超时（8 秒）');
    expect(hung.body.error.message).not.toContain('ECONNREFUSED');
    // 文案里的"8 秒"要真是等待时长：把 AbortSignal.timeout 改成 200 毫秒而不动文案，这条先红
    expect(elapsed).toBeGreaterThanOrEqual(8_000);
    expect(elapsed).toBeLessThan(16_000);
    // 挂死的只是这一次探测：请求确实发出去了，服务端不重试
    expect(stubRequests).toHaveLength(1);

    // 超时的发现尝试既不落服务商行也不写审计，失败本身不进任何持久记录
    const providersAfter = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM model_providers`;
    const auditAfter = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = ${workspaceA}
    `;
    expect(providersAfter[0]?.n).toBe(providersBefore[0]?.n);
    expect(auditAfter[0]?.n).toBe(auditBefore[0]?.n);
    modelsStub = { kind: 'ids', ids: ['stub-chat'] };
  }, 20_000);
});
