import { sql } from '@yunshuo/db';
import type {
  RetrievalCoverageView,
  SearchResponse,
  SearchResultView,
} from '@yunshuo/contracts';
import {
  EmbeddingError,
  computeEmbeddingCost,
  embedBatch,
  loadEmbeddingProviders,
  type EmbeddingProvider,
} from '@yunshuo/model-gateway';
import {
  buildExcerpt,
  buildLexicalQuery,
  fuseHybrid,
  isSingleCharQuery,
  toTsQuery,
  type ChannelHit,
} from '@yunshuo/retrieval';
import { env } from '../env.js';

const CHANNEL_LIMIT = 30;
const QUERY_EMBED_TIMEOUT_MS = 10_000;

export interface CoverageInternal extends RetrievalCoverageView {
  vectorDimensions: number | null;
}

export interface SearchCanonInput {
  workspaceId: string;
  query: string;
  workId?: string;
  excludeChapterId?: string;
  mode?: 'auto' | 'lexical';
  limit?: number;
}

export interface CanonSearchOutcome {
  response: SearchResponse;
  contents: Map<string, string>;
}

interface CoverageRow {
  total: number;
  ready: number;
  indexing: number;
  pending: number;
  failed: number;
  not_configured: number;
  stale: number;
}

interface VectorStatsRow {
  chunks: number;
  vector_chunks: number;
}

interface VectorModelRow {
  model: string;
  dimensions: number;
  count: number;
}

interface HitRow {
  chunk_id: string;
  chapter_id: string;
  chapter_number: number;
  chapter_title: string;
  version_id: string;
  version_no: number;
  paragraph_start: number;
  paragraph_end: number;
  content: string;
  score: number | null;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function numericScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadRetrievalCoverage(
  workspaceId: string,
  workId?: string,
): Promise<CoverageInternal> {
  const workFilter = workId ? sql`AND c.work_id = ${workId}` : sql``;

  const coverageRows = await sql<CoverageRow[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE i.status = 'ready' AND i.version_id = cc.version_id
          AND EXISTS (
            SELECT 1 FROM canon_chunks ch
            WHERE ch.chapter_id = c.id AND ch.version_id = cc.version_id
          )
      )::int AS ready,
      count(*) FILTER (
        WHERE i.status = 'indexing' AND i.version_id = cc.version_id
      )::int AS indexing,
      count(*) FILTER (
        WHERE i.status = 'pending' AND i.version_id = cc.version_id
      )::int AS pending,
      count(*) FILTER (
        WHERE i.status = 'failed' AND i.version_id = cc.version_id
      )::int AS failed,
      count(*) FILTER (
        WHERE i.status = 'not_configured' AND i.version_id = cc.version_id
      )::int AS not_configured,
      count(*) FILTER (
        WHERE i.chapter_id IS NULL
          OR i.version_id IS DISTINCT FROM cc.version_id
          OR (
            i.status = 'ready' AND NOT EXISTS (
              SELECT 1 FROM canon_chunks ch
              WHERE ch.chapter_id = c.id AND ch.version_id = cc.version_id
            )
          )
      )::int AS stale
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    JOIN canon_current cc ON cc.chapter_id = c.id
    LEFT JOIN index_status i ON i.chapter_id = c.id
    WHERE w.workspace_id = ${workspaceId}
    ${workFilter}
  `;
  const coverage = coverageRows[0] ?? {
    total: 0,
    ready: 0,
    indexing: 0,
    pending: 0,
    failed: 0,
    not_configured: 0,
    stale: 0,
  };

  const statsRows = await sql<VectorStatsRow[]>`
    SELECT count(*)::int AS chunks,
           count(ce.chunk_id)::int AS vector_chunks
    FROM canon_chunks ch
    JOIN chapters c ON c.id = ch.chapter_id
    JOIN works w ON w.id = ch.work_id
    JOIN canon_current cc ON cc.chapter_id = ch.chapter_id AND cc.version_id = ch.version_id
    JOIN index_status i
      ON i.chapter_id = ch.chapter_id AND i.version_id = ch.version_id AND i.status = 'ready'
    LEFT JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
    WHERE w.workspace_id = ${workspaceId}
    ${workFilter}
  `;
  const stats = statsRows[0] ?? { chunks: 0, vector_chunks: 0 };

  const modelRows = await sql<VectorModelRow[]>`
    SELECT ce.model, ce.dimensions, count(*)::int AS count
    FROM canon_chunks ch
    JOIN chapters c ON c.id = ch.chapter_id
    JOIN works w ON w.id = ch.work_id
    JOIN canon_current cc ON cc.chapter_id = ch.chapter_id AND cc.version_id = ch.version_id
    JOIN index_status i
      ON i.chapter_id = ch.chapter_id AND i.version_id = ch.version_id AND i.status = 'ready'
    JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
    WHERE w.workspace_id = ${workspaceId}
    ${workFilter}
    GROUP BY ce.model, ce.dimensions
    ORDER BY count DESC, ce.model ASC
    LIMIT 1
  `;
  const modelRow = modelRows[0];

  return {
    totalCanonChapters: coverage.total,
    ready: coverage.ready,
    indexing: coverage.indexing,
    pending: coverage.pending,
    failed: coverage.failed,
    notConfigured: coverage.not_configured,
    stale: coverage.stale,
    chunks: stats.chunks,
    vectorChunks: stats.vector_chunks,
    vectorModel: modelRow?.model ?? null,
    vectorDimensions: modelRow?.dimensions ?? null,
  };
}

async function runLexicalSearch(
  input: SearchCanonInput,
  tokens: string[],
): Promise<HitRow[]> {
  const workFilter = input.workId ? sql`AND ch.work_id = ${input.workId}` : sql``;
  const excludeFilter = input.excludeChapterId
    ? sql`AND ch.chapter_id <> ${input.excludeChapterId}`
    : sql``;

  const usesSubstring = isSingleCharQuery(input.query) || tokens.length === 0;
  if (usesSubstring) {
    const pattern = `%${escapeLike(input.query.trim())}%`;
    return sql<HitRow[]>`
      SELECT ch.id AS chunk_id,
             ch.chapter_id,
             c.number AS chapter_number,
             c.title AS chapter_title,
             ch.version_id,
             v.version_no,
             ch.paragraph_start,
             ch.paragraph_end,
             ch.content,
             NULL::float8 AS score
      FROM canon_chunks ch
      JOIN chapters c ON c.id = ch.chapter_id
      JOIN works w ON w.id = ch.work_id
      JOIN canon_versions v ON v.id = ch.version_id
      JOIN canon_current cc ON cc.chapter_id = ch.chapter_id AND cc.version_id = ch.version_id
      JOIN index_status i
        ON i.chapter_id = ch.chapter_id AND i.version_id = ch.version_id AND i.status = 'ready'
      WHERE w.workspace_id = ${input.workspaceId}
        AND ch.content ILIKE ${pattern}
        ${workFilter}
        ${excludeFilter}
      ORDER BY c.number ASC, ch.chunk_index ASC
      LIMIT ${CHANNEL_LIMIT}
    `;
  }

  const tsQuery = toTsQuery(tokens);
  if (!tsQuery) return [];

  return sql<HitRow[]>`
    SELECT ch.id AS chunk_id,
           ch.chapter_id,
           c.number AS chapter_number,
           c.title AS chapter_title,
           ch.version_id,
           v.version_no,
           ch.paragraph_start,
           ch.paragraph_end,
           ch.content,
           ts_rank_cd(
             to_tsvector('simple', ch.lexical_text),
             to_tsquery('simple', ${tsQuery})
           ) AS score
    FROM canon_chunks ch
    JOIN chapters c ON c.id = ch.chapter_id
    JOIN works w ON w.id = ch.work_id
    JOIN canon_versions v ON v.id = ch.version_id
    JOIN canon_current cc ON cc.chapter_id = ch.chapter_id AND cc.version_id = ch.version_id
    JOIN index_status i
      ON i.chapter_id = ch.chapter_id AND i.version_id = ch.version_id AND i.status = 'ready'
    WHERE w.workspace_id = ${input.workspaceId}
      AND to_tsvector('simple', ch.lexical_text) @@ to_tsquery('simple', ${tsQuery})
      ${workFilter}
      ${excludeFilter}
    ORDER BY score DESC, c.number ASC, ch.chunk_index ASC
    LIMIT ${CHANNEL_LIMIT}
  `;
}

async function logQueryCall(params: {
  workspaceId: string;
  provider: EmbeddingProvider;
  status: 'ok' | 'failed';
  promptTokens: number | null;
  latencyMs: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const cost = computeEmbeddingCost(params.provider, params.promptTokens);
  await sql`
    INSERT INTO model_calls (
      id, workspace_id, provider_id, chapter_id, model,
      prompt_tokens, completion_tokens, cost, cost_currency,
      attempt_no, latency_ms, status, actor_id, purpose,
      error_code, error_message, completed_at
    )
    VALUES (
      gen_random_uuid(), ${params.workspaceId}, ${params.provider.id}, NULL,
      ${params.provider.model}, ${params.promptTokens}, NULL,
      ${cost?.cost ?? null}, ${cost?.currency ?? null},
      ${1}, ${params.latencyMs}, ${params.status}, NULL, 'embedding_query',
      ${params.errorCode ?? null}, ${params.errorMessage ?? null}, now()
    )
  `;
}

interface QueryEmbedding {
  vector: number[] | null;
  reason: string | null;
}

async function embedSearchQuery(
  input: SearchCanonInput,
  coverage: CoverageInternal,
): Promise<QueryEmbedding> {
  const routing = await loadEmbeddingProviders(sql, input.workspaceId, env.modelKeySecret);
  if (coverage.vectorModel === null || coverage.vectorDimensions === null) {
    return {
      vector: null,
      reason: '正典尚未建立向量索引；配置嵌入服务并重建索引后可用语义检索，本次仅用词法检索',
    };
  }
  if (routing.providers.length === 0) {
    const skipped = routing.skipped.map((item) => `${item.name}：${item.reason}`).join('；');
    return {
      vector: null,
      reason: skipped
        ? `没有可用的嵌入服务商（${skipped}），本次仅用词法检索`
        : '未配置启用的嵌入服务商，本次仅用词法检索',
    };
  }

  const candidates = routing.providers.filter(
    (provider) => provider.model === coverage.vectorModel,
  );
  if (candidates.length === 0) {
    const enabled = routing.providers.map((provider) => provider.model).join('、');
    return {
      vector: null,
      reason: `当前启用嵌入模型（${enabled}）与索引模型（${coverage.vectorModel}）不一致；请重建索引，本次仅用词法检索`,
    };
  }

  let lastFailure = '';
  for (const provider of candidates) {
    const startedAt = Date.now();
    try {
      const result = await embedBatch(provider, [input.query], {
        timeoutMs: QUERY_EMBED_TIMEOUT_MS,
      });
      await logQueryCall({
        workspaceId: input.workspaceId,
        provider,
        status: 'ok',
        promptTokens: result.promptTokens,
        latencyMs: result.latencyMs,
      });
      if (result.dimensions !== coverage.vectorDimensions) {
        lastFailure = `查询向量维度 ${result.dimensions} 与索引维度 ${coverage.vectorDimensions} 不一致`;
        continue;
      }
      return { vector: result.vectors[0] ?? null, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = message;
      await logQueryCall({
        workspaceId: input.workspaceId,
        provider,
        status: 'failed',
        promptTokens: null,
        latencyMs: Date.now() - startedAt,
        errorCode: error instanceof EmbeddingError ? error.code : 'EMBEDDING_UNKNOWN',
        errorMessage: message.slice(0, 500),
      });
    }
  }

  return {
    vector: null,
    reason: `查询嵌入失败（${lastFailure || '没有可用候选'}），本次仅用词法检索`,
  };
}

async function runVectorSearch(
  input: SearchCanonInput,
  coverage: CoverageInternal,
  vector: number[],
): Promise<HitRow[]> {
  if (coverage.vectorModel === null || coverage.vectorDimensions === null) return [];
  const workFilter = input.workId ? sql`AND ch.work_id = ${input.workId}` : sql``;
  const excludeFilter = input.excludeChapterId
    ? sql`AND ch.chapter_id <> ${input.excludeChapterId}`
    : sql``;

  return sql<HitRow[]>`
    SELECT ch.id AS chunk_id,
           ch.chapter_id,
           c.number AS chapter_number,
           c.title AS chapter_title,
           ch.version_id,
           v.version_no,
           ch.paragraph_start,
           ch.paragraph_end,
           ch.content,
           (1 - (ce.embedding <=> ${vectorLiteral(vector)}::vector))::float8 AS score
    FROM canon_chunks ch
    JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
    JOIN chapters c ON c.id = ch.chapter_id
    JOIN works w ON w.id = ch.work_id
    JOIN canon_versions v ON v.id = ch.version_id
    JOIN canon_current cc ON cc.chapter_id = ch.chapter_id AND cc.version_id = ch.version_id
    JOIN index_status i
      ON i.chapter_id = ch.chapter_id AND i.version_id = ch.version_id AND i.status = 'ready'
    WHERE w.workspace_id = ${input.workspaceId}
      AND ce.model = ${coverage.vectorModel}
      AND ce.dimensions = ${coverage.vectorDimensions}
      ${workFilter}
      ${excludeFilter}
    ORDER BY ce.embedding <=> ${vectorLiteral(vector)}::vector ASC
    LIMIT ${CHANNEL_LIMIT}
  `;
}

function toChannelHits(rows: HitRow[]): ChannelHit[] {
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    chapterId: row.chapter_id,
    versionId: row.version_id,
    paragraphStart: row.paragraph_start,
    paragraphEnd: row.paragraph_end,
    score: numericScore(row.score) ?? 0,
  }));
}

export async function searchCanon(input: SearchCanonInput): Promise<CanonSearchOutcome> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const tokens = buildLexicalQuery(input.query);
  const coverage = await loadRetrievalCoverage(input.workspaceId, input.workId);

  const forcedLexical = input.mode === 'lexical';
  const queryEmbeddingPromise: Promise<QueryEmbedding> = forcedLexical
    ? Promise.resolve({
        vector: null,
        reason: '诊断模式：已强制词法检索，未调用嵌入服务',
      })
    : embedSearchQuery(input, coverage);

  const [lexicalRows, queryEmbedding] = await Promise.all([
    runLexicalSearch(input, tokens),
    queryEmbeddingPromise,
  ]);

  const vectorRows = queryEmbedding.vector
    ? await runVectorSearch(input, coverage, queryEmbedding.vector)
    : [];
  const minVectorScore = env.searchVectorMinScore;
  const topVectorScore =
    vectorRows.length === 0
      ? null
      : vectorRows.reduce(
          (top, row) => Math.max(top, numericScore(row.score) ?? -1),
          -1,
        );
  const acceptedVectorRows =
    topVectorScore !== null && topVectorScore >= minVectorScore
      ? vectorRows.filter((row) => (numericScore(row.score) ?? -1) >= minVectorScore)
      : [];

  const fused = fuseHybrid(toChannelHits(lexicalRows), toChannelHits(acceptedVectorRows), {
    limit,
  });

  const lexicalById = new Map(lexicalRows.map((row) => [row.chunk_id, row]));
  const vectorById = new Map(acceptedVectorRows.map((row) => [row.chunk_id, row]));
  const contents = new Map<string, string>();
  for (const row of [...lexicalRows, ...acceptedVectorRows]) {
    contents.set(row.chunk_id, row.content);
  }

  const results: SearchResultView[] = [];
  for (const hit of fused) {
    const meta = lexicalById.get(hit.chunkId) ?? vectorById.get(hit.chunkId);
    if (!meta) continue;
    const lexicalScore =
      hit.lexicalRank === null
        ? null
        : numericScore(lexicalById.get(hit.chunkId)?.score ?? null);
    const vectorScore =
      hit.vectorRank === null
        ? null
        : numericScore(vectorById.get(hit.chunkId)?.score ?? null);
    results.push({
      chunkId: hit.chunkId,
      chapterId: meta.chapter_id,
      chapterNumber: meta.chapter_number,
      chapterTitle: meta.chapter_title,
      versionId: meta.version_id,
      versionNo: meta.version_no,
      paragraphStart: meta.paragraph_start,
      paragraphEnd: meta.paragraph_end,
      excerpt: buildExcerpt(meta.content, input.query),
      lexicalRank: hit.lexicalRank,
      vectorRank: hit.vectorRank,
      lexicalScore: lexicalScore === null ? null : round(lexicalScore),
      vectorScore: vectorScore === null ? null : round(vectorScore),
      rrfScore: hit.rrfScore,
    });
  }

  const usedVector = acceptedVectorRows.length > 0;
  const mode = usedVector ? 'hybrid' : 'lexical';
  const semanticReason = usedVector
    ? null
    : (queryEmbedding.reason ??
      (topVectorScore === null
        ? '当前检索范围内没有可用的向量片段，本次仅用词法检索'
        : `向量最高相似度 ${topVectorScore.toFixed(3)} 低于阈值 ${minVectorScore.toFixed(3)}，本次仅用词法检索`));
  const publicCoverage: RetrievalCoverageView = {
    totalCanonChapters: coverage.totalCanonChapters,
    ready: coverage.ready,
    indexing: coverage.indexing,
    pending: coverage.pending,
    failed: coverage.failed,
    notConfigured: coverage.notConfigured,
    stale: coverage.stale,
    chunks: coverage.chunks,
    vectorChunks: coverage.vectorChunks,
    vectorModel: coverage.vectorModel,
  };

  return {
    response: {
      query: input.query,
      mode,
      semanticReason,
      results,
      coverage: publicCoverage,
    },
    contents,
  };
}
