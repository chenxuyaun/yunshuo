import { sql } from '@yunshuo/db';
import type {
  LedgerEntryKind,
  LedgerEntryScope,
  LedgerRetrievalCoverageView,
  RetrievalCoverageView,
  SearchLedgerResultView,
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

export interface LedgerCoverageInternal extends LedgerRetrievalCoverageView {
  vectorDimensions: number | null;
}

interface VectorTarget {
  model: string;
  dimensions: number;
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

interface LedgerHitRow {
  chunk_id: string;
  entry_id: string;
  kind: LedgerEntryKind;
  name: string;
  aliases: string[];
  scope: LedgerEntryScope;
  work_id: string | null;
  source_chapter_id: string | null;
  source_chapter_number: number | null;
  source_chapter_title: string | null;
  version_id: string;
  version_no: number;
  chunk_index: number;
  content: string;
  score: number | null;
}

interface LedgerStatsRow {
  chunks: number;
  vector_chunks: number;
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

function ledgerWorkFilter(workId?: string) {
  return workId
    ? sql`AND (e.work_id = ${workId} OR (e.kind = 'setting' AND e.work_id IS NULL))`
    : sql``;
}

export async function loadLedgerRetrievalCoverage(
  workspaceId: string,
  workId?: string,
): Promise<LedgerCoverageInternal> {
  const workFilter = ledgerWorkFilter(workId);

  const coverageRows = await sql<{ active_entries: number; indexed_entries: number }[]>`
    SELECT
      count(*)::int AS active_entries,
      count(*) FILTER (
        WHERE i.status IN ('ready', 'not_configured')
          AND i.version_id = e.current_version_id
          AND EXISTS (
            SELECT 1 FROM ledger_chunks lch
            WHERE lch.entry_id = e.id AND lch.version_id = e.current_version_id
          )
      )::int AS indexed_entries
    FROM ledger_entries e
    LEFT JOIN ledger_index_status i ON i.entry_id = e.id
    WHERE e.workspace_id = ${workspaceId}
      AND e.status = 'active'
      AND e.current_version_id IS NOT NULL
      ${workFilter}
  `;
  const coverage = coverageRows[0] ?? { active_entries: 0, indexed_entries: 0 };

  const statsRows = await sql<LedgerStatsRow[]>`
    SELECT count(*)::int AS chunks,
           count(lce.chunk_id)::int AS vector_chunks
    FROM ledger_chunks lch
    JOIN ledger_entries e ON e.id = lch.entry_id
    JOIN ledger_index_status i
      ON i.entry_id = lch.entry_id AND i.version_id = lch.version_id
      AND i.status IN ('ready', 'not_configured')
    LEFT JOIN ledger_chunk_embeddings lce ON lce.chunk_id = lch.id
    WHERE e.workspace_id = ${workspaceId}
      AND e.status = 'active'
      AND e.current_version_id = lch.version_id
      ${workFilter}
  `;
  const stats = statsRows[0] ?? { chunks: 0, vector_chunks: 0 };

  const modelRows = await sql<VectorModelRow[]>`
    SELECT lce.model, lce.dimensions, count(*)::int AS count
    FROM ledger_chunks lch
    JOIN ledger_entries e ON e.id = lch.entry_id
    JOIN ledger_index_status i
      ON i.entry_id = lch.entry_id AND i.version_id = lch.version_id AND i.status = 'ready'
    JOIN ledger_chunk_embeddings lce ON lce.chunk_id = lch.id
    WHERE e.workspace_id = ${workspaceId}
      AND e.status = 'active'
      AND e.current_version_id = lch.version_id
      ${workFilter}
    GROUP BY lce.model, lce.dimensions
    ORDER BY count DESC, lce.model ASC
    LIMIT 1
  `;
  const modelRow = modelRows[0];

  return {
    activeEntries: coverage.active_entries,
    indexedEntries: coverage.indexed_entries,
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
  target: VectorTarget | null,
): Promise<QueryEmbedding> {
  const routing = await loadEmbeddingProviders(sql, input.workspaceId, env.modelKeySecret);
  if (target === null) {
    return {
      vector: null,
      reason: '检索范围尚未建立向量索引；配置嵌入服务并重建索引后可用语义检索，本次仅用词法检索',
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
    (provider) => provider.model === target.model,
  );
  if (candidates.length === 0) {
    const enabled = routing.providers.map((provider) => provider.model).join('、');
    return {
      vector: null,
      reason: `当前启用嵌入模型（${enabled}）与索引模型（${target.model}）不一致；请重建索引，本次仅用词法检索`,
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
      if (result.dimensions !== target.dimensions) {
        lastFailure = `查询向量维度 ${result.dimensions} 与索引维度 ${target.dimensions} 不一致`;
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

async function runLedgerLexicalSearch(
  input: SearchCanonInput,
  tokens: string[],
): Promise<LedgerHitRow[]> {
  const workFilter = ledgerWorkFilter(input.workId);

  const usesSubstring = isSingleCharQuery(input.query) || tokens.length === 0;
  if (usesSubstring) {
    const pattern = `%${escapeLike(input.query.trim())}%`;
    return sql<LedgerHitRow[]>`
      SELECT lch.id AS chunk_id,
             e.id AS entry_id,
             e.kind,
             e.name,
             e.aliases,
             e.scope,
             e.work_id,
             e.source_chapter_id,
             sc.number AS source_chapter_number,
             sc.title AS source_chapter_title,
             lch.version_id,
             v.version_no,
             lch.chunk_index,
             lch.content,
             NULL::float8 AS score
      FROM ledger_chunks lch
      JOIN ledger_entries e ON e.id = lch.entry_id
      LEFT JOIN chapters sc ON sc.id = e.source_chapter_id
      JOIN ledger_entry_versions v ON v.id = lch.version_id
      JOIN ledger_index_status i
        ON i.entry_id = lch.entry_id AND i.version_id = lch.version_id
        AND i.status IN ('ready', 'not_configured')
      WHERE e.workspace_id = ${input.workspaceId}
        AND e.status = 'active'
        AND e.current_version_id = lch.version_id
        AND lch.content ILIKE ${pattern}
        ${workFilter}
      ORDER BY e.name ASC, lch.chunk_index ASC
      LIMIT ${CHANNEL_LIMIT}
    `;
  }

  const tsQuery = toTsQuery(tokens);
  if (!tsQuery) return [];

  return sql<LedgerHitRow[]>`
    SELECT lch.id AS chunk_id,
           e.id AS entry_id,
           e.kind,
           e.name,
           e.aliases,
           e.scope,
           e.work_id,
           e.source_chapter_id,
           sc.number AS source_chapter_number,
           sc.title AS source_chapter_title,
           lch.version_id,
           v.version_no,
           lch.chunk_index,
           lch.content,
           ts_rank_cd(
             to_tsvector('simple', lch.lexical_text),
             to_tsquery('simple', ${tsQuery})
           ) AS score
    FROM ledger_chunks lch
    JOIN ledger_entries e ON e.id = lch.entry_id
    LEFT JOIN chapters sc ON sc.id = e.source_chapter_id
    JOIN ledger_entry_versions v ON v.id = lch.version_id
    JOIN ledger_index_status i
      ON i.entry_id = lch.entry_id AND i.version_id = lch.version_id
      AND i.status IN ('ready', 'not_configured')
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.status = 'active'
      AND e.current_version_id = lch.version_id
      AND to_tsvector('simple', lch.lexical_text) @@ to_tsquery('simple', ${tsQuery})
      ${workFilter}
    ORDER BY score DESC, e.name ASC, lch.chunk_index ASC
    LIMIT ${CHANNEL_LIMIT}
  `;
}

async function runLedgerVectorSearch(
  input: SearchCanonInput,
  target: VectorTarget,
  vector: number[],
): Promise<LedgerHitRow[]> {
  const workFilter = ledgerWorkFilter(input.workId);

  return sql<LedgerHitRow[]>`
    SELECT lch.id AS chunk_id,
           e.id AS entry_id,
           e.kind,
           e.name,
           e.aliases,
           e.scope,
           e.work_id,
           e.source_chapter_id,
           sc.number AS source_chapter_number,
           sc.title AS source_chapter_title,
           lch.version_id,
           v.version_no,
           lch.chunk_index,
           lch.content,
           (1 - (lce.embedding <=> ${vectorLiteral(vector)}::vector))::float8 AS score
    FROM ledger_chunks lch
    JOIN ledger_chunk_embeddings lce ON lce.chunk_id = lch.id
    JOIN ledger_entries e ON e.id = lch.entry_id
    LEFT JOIN chapters sc ON sc.id = e.source_chapter_id
    JOIN ledger_entry_versions v ON v.id = lch.version_id
    JOIN ledger_index_status i
      ON i.entry_id = lch.entry_id AND i.version_id = lch.version_id AND i.status = 'ready'
    WHERE e.workspace_id = ${input.workspaceId}
      AND e.status = 'active'
      AND e.current_version_id = lch.version_id
      AND lce.model = ${target.model}
      AND lce.dimensions = ${target.dimensions}
      ${workFilter}
    ORDER BY lce.embedding <=> ${vectorLiteral(vector)}::vector ASC
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

function toLedgerChannelHits(rows: LedgerHitRow[]): ChannelHit[] {
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    chapterId: row.entry_id,
    versionId: row.version_id,
    paragraphStart: row.chunk_index,
    paragraphEnd: row.chunk_index,
    score: numericScore(row.score) ?? 0,
  }));
}

function acceptVectorRows<T extends { score: number | null }>(
  rows: T[],
  minScore: number,
): T[] {
  const top = rows.reduce((best, row) => Math.max(best, numericScore(row.score) ?? -1), -1);
  return top >= minScore
    ? rows.filter((row) => (numericScore(row.score) ?? -1) >= minScore)
    : [];
}

export async function searchCanon(input: SearchCanonInput): Promise<CanonSearchOutcome> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const tokens = buildLexicalQuery(input.query);
  const [coverage, ledgerCoverage] = await Promise.all([
    loadRetrievalCoverage(input.workspaceId, input.workId),
    loadLedgerRetrievalCoverage(input.workspaceId, input.workId),
  ]);

  const vectorTarget: VectorTarget | null =
    coverage.vectorModel !== null && coverage.vectorDimensions !== null
      ? { model: coverage.vectorModel, dimensions: coverage.vectorDimensions }
      : ledgerCoverage.vectorModel !== null && ledgerCoverage.vectorDimensions !== null
        ? {
            model: ledgerCoverage.vectorModel,
            dimensions: ledgerCoverage.vectorDimensions,
          }
        : null;

  const forcedLexical = input.mode === 'lexical';
  const queryEmbeddingPromise: Promise<QueryEmbedding> = forcedLexical
    ? Promise.resolve({
        vector: null,
        reason: '诊断模式：已强制词法检索，未调用嵌入服务',
      })
    : embedSearchQuery(input, vectorTarget);

  const [lexicalRows, ledgerLexicalRows, queryEmbedding] = await Promise.all([
    runLexicalSearch(input, tokens),
    runLedgerLexicalSearch(input, tokens),
    queryEmbeddingPromise,
  ]);

  const [vectorRows, ledgerVectorRows] = queryEmbedding.vector
    ? await Promise.all([
        runVectorSearch(input, coverage, queryEmbedding.vector),
        vectorTarget
          ? runLedgerVectorSearch(input, vectorTarget, queryEmbedding.vector)
          : Promise.resolve([]),
      ])
    : [[], []];
  const minVectorScore = env.searchVectorMinScore;
  const topVectorScore =
    vectorRows.length === 0 && ledgerVectorRows.length === 0
      ? null
      : [...vectorRows, ...ledgerVectorRows].reduce(
          (top, row) => Math.max(top, numericScore(row.score) ?? -1),
          -1,
        );
  const acceptedVectorRows = acceptVectorRows(vectorRows, minVectorScore);
  const acceptedLedgerVectorRows = acceptVectorRows(ledgerVectorRows, minVectorScore);

  const fused = fuseHybrid(toChannelHits(lexicalRows), toChannelHits(acceptedVectorRows), {
    limit,
  });
  const ledgerFused = fuseHybrid(
    toLedgerChannelHits(ledgerLexicalRows),
    toLedgerChannelHits(acceptedLedgerVectorRows),
    { limit },
  );

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

  const ledgerLexicalById = new Map(ledgerLexicalRows.map((row) => [row.chunk_id, row]));
  const ledgerVectorById = new Map(acceptedLedgerVectorRows.map((row) => [row.chunk_id, row]));
  const ledgerResults: SearchLedgerResultView[] = [];
  for (const hit of ledgerFused) {
    const meta = ledgerLexicalById.get(hit.chunkId) ?? ledgerVectorById.get(hit.chunkId);
    if (!meta) continue;
    const lexicalScore =
      hit.lexicalRank === null
        ? null
        : numericScore(ledgerLexicalById.get(hit.chunkId)?.score ?? null);
    const vectorScore =
      hit.vectorRank === null
        ? null
        : numericScore(ledgerVectorById.get(hit.chunkId)?.score ?? null);
    ledgerResults.push({
      chunkId: hit.chunkId,
      entryId: meta.entry_id,
      kind: meta.kind,
      name: meta.name,
      aliases: meta.aliases ?? [],
      scope: meta.scope,
      workId: meta.work_id,
      sourceChapterId: meta.source_chapter_id,
      sourceChapterNumber: meta.source_chapter_number,
      sourceChapterTitle: meta.source_chapter_title,
      versionId: meta.version_id,
      versionNo: meta.version_no,
      excerpt: buildExcerpt(meta.content, input.query),
      lexicalRank: hit.lexicalRank,
      vectorRank: hit.vectorRank,
      lexicalScore: lexicalScore === null ? null : round(lexicalScore),
      vectorScore: vectorScore === null ? null : round(vectorScore),
      rrfScore: hit.rrfScore,
    });
  }

  const usedVector = acceptedVectorRows.length > 0 || acceptedLedgerVectorRows.length > 0;
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
  const publicLedgerCoverage: LedgerRetrievalCoverageView = {
    activeEntries: ledgerCoverage.activeEntries,
    indexedEntries: ledgerCoverage.indexedEntries,
    chunks: ledgerCoverage.chunks,
    vectorChunks: ledgerCoverage.vectorChunks,
    vectorModel: ledgerCoverage.vectorModel,
  };
  const ledgerReason =
    ledgerCoverage.activeEntries === 0
      ? '当前范围没有已发布的设定、角色或伏笔条目'
      : ledgerCoverage.chunks === 0
        ? '账本条目尚未建立索引；配置嵌入服务并重建索引后可在检索中命中'
        : ledgerCoverage.chunks > ledgerCoverage.vectorChunks
          ? '部分账本条目只有词法索引，没有可用的向量索引（未配置嵌入服务或尚未完成索引）；这些条目仅支持词法检索'
          : null;

  return {
    response: {
      query: input.query,
      mode,
      semanticReason,
      results,
      coverage: publicCoverage,
      ledgerResults,
      ledgerCoverage: publicLedgerCoverage,
      ledgerReason,
    },
    contents,
  };
}
