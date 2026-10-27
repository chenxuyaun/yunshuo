import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import type { Role } from '@yunshuo/domain';
import { buildLexicalText } from '@yunshuo/retrieval';
import { getCharacterStateAsOfInputSchema, searchToolInputSchema } from '@yunshuo/tool-surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth.js';
import { AppError } from '../errors.js';
import { getCharacterStateAsOfToolHandler } from './character-state-handler.js';
import { searchToolHandler } from './search-handler.js';

/**
 * L1a 两个工具 handler 的集成用例：打真实 PostgreSQL（AGENTS.md 硬规则 8），
 * 不 mock 服务层。AuthContext 直接构造（工具入参里没有身份，身份只能由调用方注入）。
 */

const RUN_ID = randomUUID().slice(0, 8);
const QUERY = '封印';
// 向量桩的模型名与维度必须与 chunk_embeddings 里写的逐字一致，
// 否则 searchCanon 会判定「启用嵌入模型与索引模型不一致」而静默退回纯词法路。
const EMBEDDING_MODEL = 'l1a-stub-embed';
const EMBEDDING_DIMENSIONS = 4;

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('L1a 工具集成测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function authFor(params: { workspaceId: string; userId: string; role: Role }): AuthContext {
  return {
    user: { id: params.userId, email: `l1a-${params.userId}@example.test`, name: '工具测试' },
    workspace: {
      id: params.workspaceId,
      name: 'L1a 工具测试工作区',
      settingsVersion: 1,
      ledgerVersion: 1,
    },
    role: params.role,
    sessionId: 'l1a-tool-session',
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError.statusCode).toBe(statusCode);
  expect(appError.code).toBe(code);
}

suite('L1a 工具 handler', () => {
  let workspaceA = '';
  let workspaceB = '';
  let workA = '';
  let workB = '';
  let chapterA1 = '';
  let chapterA2 = '';
  let chapterA3 = '';
  let chapterB1 = '';
  let authorA: AuthContext;
  let ownerB: AuthContext;
  let billingA: AuthContext;
  const testUserIds: string[] = [];

  // 嵌入桩：只实现 POST /embeddings，把任何输入都嵌成 [1,0,0,0]。
  // 服务商行直接插库、api_key_ciphertext 留空——桩不校验授权头，测试里也就不需要任何凭据字面量。
  let embeddingStub: Server | null = null;
  let embeddingProviderId = '';
  const stubInputs: string[] = [];

  const canonContent: Record<number, string> = {};

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(workspaceId: string, role: Role): Promise<string> {
    const id = randomUUID();
    testUserIds.push(id);
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${id}, ${`l1a-${RUN_ID}-${role}-${id.slice(0, 8)}@example.test`}, '工具测试用户')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return id;
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
  ): Promise<{ chapterId: string; versionId: string }> {
    const chapterId = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (${chapterId}, ${workId}, ${volumeId}, ${number}, ${`第${number}章`}, 'canon', '{}'::jsonb)
    `;
    const content = `第${number}章：${QUERY}之门。` + '雨夜的山门被雾气吞没，林默按住门框。'.repeat(10);
    canonContent[number] = content;
    const versionId = randomUUID();
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source
      )
      VALUES (
        ${versionId}, ${chapterId}, 1, ${content}, ${contentHash(content)},
        ${content.length}, 'human'
      )
    `;
    await sql`UPDATE chapters SET current_version_id = ${versionId} WHERE id = ${chapterId}`;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${versionId})
    `;
    await sql`
      INSERT INTO canon_chunks (
        id, workspace_id, work_id, chapter_id, version_id,
        chunk_index, paragraph_start, paragraph_end, char_start, char_end,
        content, content_hash, lexical_text
      )
      VALUES (
        ${randomUUID()},
        (SELECT workspace_id FROM works WHERE id = ${workId}),
        ${workId}, ${chapterId}, ${versionId},
        0, 0, 0, 0, ${content.length},
        ${content}, ${contentHash(content)}, ${buildLexicalText(content)}
      )
    `;
    await sql`
      INSERT INTO index_status (
        chapter_id, version_id, status, chunk_count, provider_name, model, dimensions, updated_at
      )
      VALUES (${chapterId}, ${versionId}, 'ready', 1, NULL, NULL, NULL, now())
    `;
    return { chapterId, versionId };
  }

  /** 给一章的正典切块挂上向量。chunk_embeddings 的 chunk_id 是主键，每块最多一行。 */
  async function attachCanonEmbedding(chapterId: string, vector: number[]): Promise<void> {
    await sql`
      INSERT INTO chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
      SELECT ch.id, ${embeddingProviderId}, ${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS},
             ${vectorLiteral(vector)}::vector
      FROM canon_chunks ch
      WHERE ch.chapter_id = ${chapterId}
    `;
  }

  async function createCharacterEntry(params: {
    workspaceId: string;
    workId: string;
    name: string;
    states: { chapterId: string; location: string }[];
  }): Promise<string> {
    const entryId = randomUUID();
    const versionId = randomUUID();
    await sql`
      INSERT INTO ledger_entries (
        id, workspace_id, work_id, kind, scope, name, aliases, summary, status
      )
      VALUES (
        ${entryId}, ${params.workspaceId}, ${params.workId}, 'character', 'work',
        ${params.name}, '{}'::text[], '', 'active'
      )
    `;
    const snapshot = {
      name: params.name,
      aliases: [],
      summary: '',
      sourceChapterId: null,
      payload: {
        states: params.states.map((state) => ({
          asOfChapterId: state.chapterId,
          life: 'alive',
          location: state.location,
          knowledge: '',
          possessions: '',
          relationshipChanges: '',
        })),
      },
    };
    await sql`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary
      )
      VALUES (
        ${versionId}, ${entryId}, ${params.workspaceId}, 1,
        ${sql.json(jsonValue(snapshot))}, ''
      )
    `;
    await sql`UPDATE ledger_entries SET current_version_id = ${versionId} WHERE id = ${entryId}`;
    return entryId;
  }

  async function createSettingChunk(params: {
    workspaceId: string;
    workId: string;
    name: string;
    sourceChapterId: string;
    content: string;
  }): Promise<string> {
    const entryId = randomUUID();
    const versionId = randomUUID();
    await sql`
      INSERT INTO ledger_entries (
        id, workspace_id, work_id, kind, scope, name, aliases, summary, status, source_chapter_id
      )
      VALUES (
        ${entryId}, ${params.workspaceId}, ${params.workId}, 'setting', 'work',
        ${params.name}, '{}'::text[], '', 'active', ${params.sourceChapterId}
      )
    `;
    await sql`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary
      )
      VALUES (
        ${versionId}, ${entryId}, ${params.workspaceId}, 1,
        ${sql.json(
          jsonValue({
            name: params.name,
            aliases: [],
            summary: '',
            sourceChapterId: params.sourceChapterId,
            payload: { category: 'world', details: params.content, tags: [], verification: 'unverified' },
          }),
        )},
        ''
      )
    `;
    await sql`UPDATE ledger_entries SET current_version_id = ${versionId} WHERE id = ${entryId}`;
    await sql`
      INSERT INTO ledger_chunks (
        id, workspace_id, entry_id, version_id, kind, work_id,
        chunk_index, content, content_hash, lexical_text
      )
      VALUES (
        ${randomUUID()}, ${params.workspaceId}, ${entryId}, ${versionId}, 'setting', ${params.workId},
        0, ${params.content}, ${contentHash(params.content)}, ${buildLexicalText(params.content)}
      )
    `;
    await sql`
      INSERT INTO ledger_index_status (
        entry_id, workspace_id, version_id, status, chunk_count, attempts, updated_at
      )
      VALUES (${entryId}, ${params.workspaceId}, ${versionId}, 'not_configured', 1, 0, now())
    `;
    return entryId;
  }

  let ledgerContent = '';

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';

    embeddingStub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        if (!(request.url ?? '').endsWith('/embeddings')) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'L1a 嵌入桩只实现 /embeddings' } }));
          return;
        }
        let body: { input?: unknown; model?: unknown } | null = null;
        try {
          body = raw ? (JSON.parse(raw) as { input?: unknown; model?: unknown }) : null;
        } catch {
          body = null;
        }
        const inputs = Array.isArray(body?.input)
          ? body.input.map((item) => String(item))
          : [String(body?.input ?? '')];
        stubInputs.push(...inputs);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            model: typeof body?.model === 'string' ? body.model : EMBEDDING_MODEL,
            data: inputs.map((_, index) => ({
              object: 'embedding',
              index,
              embedding: [1, 0, 0, 0],
            })),
            usage: { prompt_tokens: inputs.length * 8, total_tokens: inputs.length * 8 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      embeddingStub?.listen(0, '127.0.0.1', resolve);
    });
    const stubAddress = embeddingStub.address();
    if (!stubAddress || typeof stubAddress === 'string') {
      throw new Error('L1a 嵌入桩未能绑定到 127.0.0.1 端口');
    }

    workspaceA = await createWorkspace(`L1a 工具 A ${RUN_ID}`);
    workspaceB = await createWorkspace(`L1a 工具 B ${RUN_ID}`);

    embeddingProviderId = randomUUID();
    await sql`
      INSERT INTO model_providers (id, workspace_id, name, base_url, model, purpose, is_enabled, priority)
      VALUES (
        ${embeddingProviderId}, ${workspaceA}, 'L1a 嵌入桩',
        ${`http://127.0.0.1:${stubAddress.port}/v1`}, ${EMBEDDING_MODEL}, 'embedding', true, 1
      )
    `;

    const authorAId = await createUser(workspaceA, 'author');
    const ownerBId = await createUser(workspaceB, 'owner');
    const billingAId = await createUser(workspaceA, 'billing');
    authorA = authFor({ workspaceId: workspaceA, userId: authorAId, role: 'author' });
    ownerB = authFor({ workspaceId: workspaceB, userId: ownerBId, role: 'owner' });
    billingA = authFor({ workspaceId: workspaceA, userId: billingAId, role: 'billing' });

    const workARecord = await createWork(workspaceA, '封印之书');
    workA = workARecord.workId;
    const workBRecord = await createWork(workspaceB, '别的工作区');
    workB = workBRecord.workId;

    chapterA1 = (await createChapter(workA, workARecord.volumeId, 1)).chapterId;
    chapterA2 = (await createChapter(workA, workARecord.volumeId, 2)).chapterId;
    chapterA3 = (await createChapter(workA, workARecord.volumeId, 3)).chapterId;
    chapterB1 = (await createChapter(workB, workBRecord.volumeId, 1)).chapterId;

    // 三章都挂向量（同一个查询向量下分数依次递减，但都在默认阈值 0.4 之上），
    // 这样「只有向量命中」的场景才能检验 as-of 上界是否也作用在向量路上。
    await attachCanonEmbedding(chapterA1, [1, 0, 0, 0]);
    await attachCanonEmbedding(chapterA2, [0.9, 0.1, 0, 0]);
    await attachCanonEmbedding(chapterA3, [0.8, 0.2, 0, 0]);

    await createCharacterEntry({
      workspaceId: workspaceA,
      workId: workA,
      name: '林默',
      states: [{ chapterId: chapterA1, location: '山门' }],
    });
    await createCharacterEntry({
      workspaceId: workspaceA,
      workId: workA,
      name: '苏禾',
      states: [{ chapterId: chapterA2, location: '藏经阁' }],
    });

    ledgerContent =
      '封印：历代掌门以血封门。' +
      '每逢月圆，门上的符纹会自行发亮，山下的村子能听见低沉的震动。'.repeat(5);
    await createSettingChunk({
      workspaceId: workspaceA,
      workId: workA,
      name: '封印',
      sourceChapterId: chapterA1,
      content: ledgerContent,
    });
  });

  afterAll(async () => {
    for (const workspaceId of [workspaceA, workspaceB]) {
      if (!workspaceId) continue;
      await sql`
        DELETE FROM canon_current
        WHERE chapter_id IN (
          SELECT c.id FROM chapters c
          JOIN works w ON w.id = c.work_id
          WHERE w.workspace_id = ${workspaceId}
        )
      `;
      await sql`
        UPDATE chapters SET current_version_id = NULL
        WHERE work_id IN (SELECT id FROM works WHERE workspace_id = ${workspaceId})
      `;
      await sql`DELETE FROM works WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM model_calls WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (testUserIds.length > 0) {
      await sql`DELETE FROM sessions WHERE user_id IN ${sql(testUserIds)}`;
      await sql`DELETE FROM users WHERE id IN ${sql(testUserIds)}`;
    }
    if (embeddingStub) {
      const stubToClose = embeddingStub;
      await new Promise<void>((resolve, reject) => {
        stubToClose.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await closeDb();
  });

  it('角色 403：计费角色两个工具都读不了（在发任何查询之前）', async () => {
    await expectAppError(
      searchToolHandler(billingA, searchToolInputSchema.parse({ query: QUERY })),
      403,
      'FORBIDDEN',
    );
    await expectAppError(
      getCharacterStateAsOfToolHandler(
        billingA,
        getCharacterStateAsOfInputSchema.parse({ chapterId: chapterA1 }),
      ),
      403,
      'FORBIDDEN',
    );
  });

  it('跨工作区 404：search 的 workId / excludeChapterId 与角色状态的 chapterId 都不区分「存在但不可见」', async () => {
    await expectAppError(
      searchToolHandler(authorA, searchToolInputSchema.parse({ query: QUERY, workId: workB })),
      404,
      'WORK_NOT_FOUND',
    );
    await expectAppError(
      searchToolHandler(
        authorA,
        searchToolInputSchema.parse({ query: QUERY, excludeChapterId: chapterB1 }),
      ),
      404,
      'CHAPTER_NOT_FOUND',
    );
    // 对照：同一份数据在自己的工作区里是能读到的（证明 404 来自工作区归属，不是数据不存在）
    const ownChapter = await getCharacterStateAsOfToolHandler(
      ownerB,
      getCharacterStateAsOfInputSchema.parse({ chapterId: chapterB1 }),
    );
    expect(ownChapter.chapterId).toBe(chapterB1);

    await expectAppError(
      getCharacterStateAsOfToolHandler(
        authorA,
        getCharacterStateAsOfInputSchema.parse({ chapterId: chapterB1 }),
      ),
      404,
      'CHAPTER_NOT_FOUND',
    );
  });

  it('search 一次调用同时取两半：正典与账本都带展开正文与步级预算', async () => {
    const result = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: QUERY, workId: workA }),
    );

    expect(result.scope).toEqual({
      workId: workA,
      excludeChapterId: null,
      excludeChapterScope: 'canon-only',
      asOfChapterNumber: null,
      ledgerAsOf: 'not-supported',
    });

    // 正典：3 章各 1 块，正文来自 contents（比 160 字摘要长），元数据与版本身份都在
    expect(result.results).toHaveLength(3);
    for (const hit of result.results) {
      expect(hit.textStatus).toBe('expanded');
      const expected = canonContent[hit.chapterNumber];
      expect(expected).toBeDefined();
      expect(hit.text).toBe(expected);
      expect(hit.text.length).toBeGreaterThan(hit.excerpt.length);
      expect(hit.versionNo).toBe(1);
      expect(hit.chapterId).toBeTruthy();
    }
    expect(result.budget.canon.hits).toBe(3);
    expect(result.budget.canon.expanded).toBe(3);
    expect(result.budget.canon.usedChars).toBeGreaterThan(0);

    // 账本：L1a 之前 contents 里没有账本正文，这里必须来自 ledgerContents
    expect(result.ledgerResults).toHaveLength(1);
    const ledgerHit = result.ledgerResults[0];
    expect(ledgerHit?.text).toBe(ledgerContent);
    expect(ledgerHit?.textStatus).toBe('expanded');
    expect(ledgerHit?.text.length).toBeGreaterThan(ledgerHit?.excerpt.length ?? 0);
    expect(ledgerHit?.sourceChapterNumber).toBe(1);
    expect(ledgerHit?.sourceChapterMeaning).toBe('entry-source-not-state-time');
    expect(result.budget.ledger.usedChars).toBe(ledgerContent.length);
    expect(result.budget.totalUsedChars).toBe(
      result.budget.canon.usedChars + result.budget.ledger.usedChars,
    );
    expect(result.notes.join('')).toContain('不是状态时点');
  });

  it('asOfChapterNumber：不传时行为不变（3 章都在），传了就只返回写作位之前的正典', async () => {
    const withoutAsOf = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: QUERY, workId: workA }),
    );
    expect(withoutAsOf.results.map((hit) => hit.chapterNumber).sort()).toEqual([1, 2, 3]);
    expect(withoutAsOf.scope.asOfChapterNumber).toBeNull();

    const asOfTwo = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: QUERY, workId: workA, asOfChapterNumber: 2 }),
    );
    expect(asOfTwo.results.map((hit) => hit.chapterNumber).sort()).toEqual([1, 2]);
    expect(asOfTwo.results.every((hit) => hit.chapterNumber <= 2)).toBe(true);
    expect(asOfTwo.scope.asOfChapterNumber).toBe(2);
    // 账本半不受这个上界影响：账本命中照旧在
    expect(asOfTwo.ledgerResults).toHaveLength(1);
    expect(asOfTwo.notes.join('')).toContain('章号 <= 2');

    const asOfOne = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: QUERY, workId: workA, asOfChapterNumber: 1 }),
    );
    expect(asOfOne.results.map((hit) => hit.chapterNumber)).toEqual([1]);
  });

  it('asOfChapterNumber 同样约束向量路：词法打不中时结果全来自向量，且仍被写作位截断', async () => {
    // 'zzz' 不在任何正文里（正文只有中文），所以这个词的结果集只可能来自向量路；
    // 若向量路没跑（例如嵌入失败退回词法），下面第一条断言就会先红。
    const vectorOnlyQuery = 'zzz';
    const withoutAsOf = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: vectorOnlyQuery, workId: workA }),
    );
    expect(stubInputs).toContain(vectorOnlyQuery);
    expect(withoutAsOf.results.map((hit) => hit.chapterNumber).sort()).toEqual([1, 2, 3]);
    for (const hit of withoutAsOf.results) {
      expect(hit.lexicalRank).toBeNull();
      expect(hit.vectorRank).not.toBeNull();
      // 桩向量与插入向量夹角极小，三条都远高于默认阈值 0.4，因此命中集不因阈值而缩水
      expect(hit.vectorScore).toBeGreaterThan(0.9);
    }
    expect(withoutAsOf.ledgerResults).toEqual([]);

    const asOfTwo = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({
        query: vectorOnlyQuery,
        workId: workA,
        asOfChapterNumber: 2,
      }),
    );
    // 向量路的 SQL 同样带 AND c.number <= 2；不生效的话第 3 章会照旧出现（它的分数在阈值之上）
    expect(asOfTwo.results.map((hit) => hit.chapterNumber).sort()).toEqual([1, 2]);
    expect(asOfTwo.results.every((hit) => hit.vectorRank !== null)).toBe(true);
    expect(asOfTwo.scope.asOfChapterNumber).toBe(2);
  });

  it('excludeChapterId 只作用于正典半：排除账本条目来源章，账本命中照旧', async () => {
    const baseline = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({ query: QUERY, workId: workA }),
    );
    expect(baseline.results.map((hit) => hit.chapterNumber).sort()).toEqual([1, 2, 3]);
    expect(baseline.ledgerResults).toHaveLength(1);
    expect(baseline.scope.excludeChapterId).toBeNull();
    expect(baseline.scope.excludeChapterScope).toBe('canon-only');

    // 账本条目的来源章就是第 1 章：这里排除的正是它，账本半仍不应受影响
    const excluded = await searchToolHandler(
      authorA,
      searchToolInputSchema.parse({
        query: QUERY,
        workId: workA,
        excludeChapterId: chapterA1,
      }),
    );
    expect(excluded.results.map((hit) => hit.chapterNumber).sort()).toEqual([2, 3]);
    expect(excluded.scope.excludeChapterId).toBe(chapterA1);
    expect(excluded.scope.excludeChapterScope).toBe('canon-only');
    expect(excluded.ledgerResults).toHaveLength(1);
    expect(excluded.ledgerResults[0]?.chunkId).toBe(baseline.ledgerResults[0]?.chunkId);
    expect(excluded.ledgerResults[0]?.text).toBe(ledgerContent);
    expect(excluded.ledgerResults[0]?.sourceChapterNumber).toBe(1);
    expect(excluded.budget.ledger.usedChars).toBe(baseline.budget.ledger.usedChars);
  });

  it('get_character_state_as_of：保留 as-of / stale / omittedCharacters 口径', async () => {
    // 第 2 章的时点是第 1 章：林默有状态，苏禾的状态在第 2 章（晚于时点）→ 被隐藏并计入 omitted
    const asOfTwo = await getCharacterStateAsOfToolHandler(
      authorA,
      getCharacterStateAsOfInputSchema.parse({ chapterId: chapterA2 }),
    );
    expect(asOfTwo.asOfChapter?.number).toBe(1);
    expect(asOfTwo.characters.map((item) => item.name)).toEqual(['林默']);
    expect(asOfTwo.characters[0]?.state.chapter.number).toBe(1);
    expect(asOfTwo.characters[0]?.state.location).toBe('山门');
    expect(asOfTwo.characters[0]?.stale).toBe(false);
    expect(asOfTwo.omittedCharacters).toBe(1);

    // 第 3 章的时点是第 2 章：林默最近状态是第 1 章 → stale=true；苏禾是第 2 章 → stale=false
    const asOfThree = await getCharacterStateAsOfToolHandler(
      authorA,
      getCharacterStateAsOfInputSchema.parse({ chapterId: chapterA3 }),
    );
    expect(asOfThree.asOfChapter?.number).toBe(2);
    const lin = asOfThree.characters.find((item) => item.name === '林默');
    const su = asOfThree.characters.find((item) => item.name === '苏禾');
    expect(lin?.stale).toBe(true);
    expect(lin?.state.chapter.number).toBe(1);
    expect(su?.stale).toBe(false);
    expect(su?.state.location).toBe('藏经阁');
    expect(asOfThree.omittedCharacters).toBe(0);

    // 开篇章：没有上一章 → asOfChapter=null、角色列表为空（这是正常结果，不是错误）
    const opening = await getCharacterStateAsOfToolHandler(
      authorA,
      getCharacterStateAsOfInputSchema.parse({ chapterId: chapterA1 }),
    );
    expect(opening.asOfChapter).toBeNull();
    expect(opening.characters).toEqual([]);
    expect(opening.note).toContain('开篇');
  });
});
