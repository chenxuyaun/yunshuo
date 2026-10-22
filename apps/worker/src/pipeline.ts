import { randomUUID } from 'node:crypto';
import { sql } from '@yunshuo/db';
import { sha256 } from '@yunshuo/domain';
import {
  EmbeddingError,
  computeEmbeddingCost,
  embedBatch,
  loadEmbeddingProviders,
  type EmbeddingProvider,
} from '@yunshuo/model-gateway';
import {
  buildLexicalText,
  chunkCanon,
  embeddingInput,
  type CanonChunk,
} from '@yunshuo/retrieval';

const BATCH_SIZE = 16;
const EMBED_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MINUTES = [1, 5, 15, 60];
const PROVIDER_ATTEMPTS = 2;
const PROVIDER_BACKOFF_MS = 600;
const STALE_PROCESSING_MINUTES = 5;
const ERROR_LIMIT = 500;

export interface IndexJobPayload {
  chapterId?: string;
  entryId?: string;
  versionId?: string;
  workspaceId?: string;
  [key: string]: unknown;
}

export interface ClaimedOutboxJob {
  id: number;
  event_type: string;
  payload: IndexJobPayload;
  attempts: number;
}

export interface IndexPipelineOptions {
  secret?: string;
  sleep?: (ms: number) => Promise<void>;
}

export type IndexJobOutcome =
  | { outcome: 'ready'; chunks: number; providerName: string; model: string; dimensions: number }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'not_configured'; reason: string }
  | { outcome: 'failed'; code: string; message: string }
  | { outcome: 'retry'; message: string; delayMinutes: number };

class IndexJobFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'IndexJobFailure';
    this.code = code;
    this.retryable = retryable;
  }
}

interface IndexJobContext {
  chapter_id: string;
  chapter_number: number;
  chapter_title: string;
  work_id: string;
  workspace_id: string;
  version_id: string;
  version_no: number;
  content: string;
  current_version_id: string | null;
  index_version_id: string | null;
}

function truncate(value: string, max = ERROR_LIMIT): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSecret(options: IndexPipelineOptions): string {
  return (
    options.secret ??
    process.env.MODEL_KEY_SECRET ??
    process.env.SESSION_SECRET ??
    'dev-only-change-me'
  );
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

async function markOutboxProcessed(id: number): Promise<void> {
  await sql`
    UPDATE outbox
    SET status = 'processed', processed_at = now(), locked_at = NULL, last_error = NULL
    WHERE id = ${id}
  `;
}

async function markOutboxFailed(id: number, message: string): Promise<void> {
  await sql`
    UPDATE outbox
    SET status = 'failed', processed_at = now(), locked_at = NULL, last_error = ${truncate(message)}
    WHERE id = ${id}
  `;
}

async function scheduleOutboxRetry(
  id: number,
  delayMinutes: number,
  message: string,
): Promise<void> {
  await sql`
    UPDATE outbox
    SET status = 'pending',
        locked_at = NULL,
        attempts = attempts,
        next_attempt_at = now() + ${delayMinutes} * interval '1 minute',
        last_error = ${truncate(message)}
    WHERE id = ${id}
  `;
}

async function setIndexState(
  job: { chapterId: string; versionId: string },
  fields: {
    status: string;
    detail: string;
    attempts: number;
    chunkCount?: number;
    providerName?: string | null;
    model?: string | null;
    dimensions?: number | null;
    delayMinutes?: number | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  const rows = await sql<{ chapter_id: string }[]>`
    UPDATE index_status
    SET status = ${fields.status},
        detail = ${fields.detail},
        chunk_count = ${fields.chunkCount ?? 0},
        provider_name = ${fields.providerName ?? null},
        model = ${fields.model ?? null},
        dimensions = ${fields.dimensions ?? null},
        attempts = ${fields.attempts},
        next_retry_at = ${
          fields.delayMinutes == null
            ? null
            : sql`now() + ${fields.delayMinutes} * interval '1 minute'`
        },
        last_error = ${fields.lastError ?? null},
        updated_at = now()
    WHERE chapter_id = ${job.chapterId} AND version_id = ${job.versionId}
      AND status <> 'ready'
    RETURNING chapter_id
  `;
  return rows.length > 0;
}

async function markIndexing(
  chapterId: string,
  versionId: string,
  attempts: number,
): Promise<boolean> {
  const rows = await sql<{ chapter_id: string }[]>`
    INSERT INTO index_status (chapter_id, version_id, status, detail, attempts, updated_at)
    VALUES (
      ${chapterId}, ${versionId}, 'indexing',
      ${`正在切块并写入向量索引（第 ${attempts} 次尝试）`}, ${attempts}, now()
    )
    ON CONFLICT (chapter_id) DO UPDATE
      SET status = 'indexing',
          detail = EXCLUDED.detail,
          chunk_count = 0,
          provider_name = NULL,
          model = NULL,
          dimensions = NULL,
          attempts = EXCLUDED.attempts,
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
    WHERE index_status.version_id = EXCLUDED.version_id
      AND index_status.status <> 'ready'
    RETURNING chapter_id
  `;
  return rows.length > 0;
}

async function loadJobContext(
  chapterId: string,
  versionId: string,
): Promise<IndexJobContext | null> {
  const rows = await sql<IndexJobContext[]>`
    SELECT c.id AS chapter_id,
           c.number AS chapter_number,
           c.title AS chapter_title,
           c.work_id,
           w.workspace_id,
           v.id AS version_id,
           v.version_no,
           v.content,
           cc.version_id AS current_version_id,
           i.version_id AS index_version_id
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    JOIN canon_versions v ON v.id = ${versionId} AND v.chapter_id = c.id
    LEFT JOIN canon_current cc ON cc.chapter_id = c.id
    LEFT JOIN index_status i ON i.chapter_id = c.id
    WHERE c.id = ${chapterId}
  `;
  return rows[0] ?? null;
}

interface AttemptFailure {
  code: string;
  message: string;
  retryable: boolean;
}

function toAttemptFailure(error: unknown): AttemptFailure {
  if (error instanceof EmbeddingError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'EMBEDDING_UNKNOWN',
    message: truncate(errorMessage(error)),
    retryable: true,
  };
}

async function logModelCall(params: {
  workspaceId: string;
  chapterId: string | null;
  provider: EmbeddingProvider;
  attemptNo: number;
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
      ${randomUUID()}, ${params.workspaceId}, ${params.provider.id}, ${params.chapterId},
      ${params.provider.model}, ${params.promptTokens}, NULL,
      ${cost?.cost ?? null}, ${cost?.currency ?? null},
      ${params.attemptNo}, ${params.latencyMs}, ${params.status}, NULL, 'embedding',
      ${params.errorCode ?? null}, ${params.errorMessage ?? null}, now()
    )
  `;
}

interface BatchEmbeddingResult {
  vectors: number[][];
  dimensions: number;
  provider: EmbeddingProvider;
}

async function embedWithFailover(params: {
  providers: EmbeddingProvider[];
  inputs: string[];
  workspaceId: string;
  chapterId: string | null;
  expectedDimensions: number | null;
  sleep: (ms: number) => Promise<void>;
}): Promise<BatchEmbeddingResult> {
  let lastFailure: AttemptFailure | null = null;

  for (const provider of params.providers) {
    for (let attemptIndex = 0; attemptIndex < PROVIDER_ATTEMPTS; attemptIndex += 1) {
      if (attemptIndex > 0) await params.sleep(PROVIDER_BACKOFF_MS);
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof embedBatch>>;
      try {
        result = await embedBatch(provider, params.inputs, { timeoutMs: EMBED_TIMEOUT_MS });
      } catch (error) {
        const failure = toAttemptFailure(error);
        lastFailure = failure;
        await logModelCall({
          workspaceId: params.workspaceId,
          chapterId: params.chapterId,
          provider,
          attemptNo: attemptIndex + 1,
          status: 'failed',
          promptTokens: null,
          latencyMs: Date.now() - startedAt,
          errorCode: failure.code,
          errorMessage: failure.message,
        });
        if (!failure.retryable) {
          throw new IndexJobFailure(failure.code, failure.message, false);
        }
        continue;
      }

      await logModelCall({
        workspaceId: params.workspaceId,
        chapterId: params.chapterId,
        provider,
        attemptNo: attemptIndex + 1,
        status: 'ok',
        promptTokens: result.promptTokens,
        latencyMs: result.latencyMs,
      });

      if (params.expectedDimensions !== null && result.dimensions !== params.expectedDimensions) {
        throw new IndexJobFailure(
          'EMBEDDING_DIMENSION_DRIFT',
          `嵌入维度漂移：本批返回 ${result.dimensions} 维，已有批次为 ${params.expectedDimensions} 维。为避免混用不同向量，索引已终止，请重建。`,
          false,
        );
      }

      return {
        vectors: result.vectors,
        dimensions: result.dimensions,
        provider,
      };
    }
    lastFailure = lastFailure ?? {
      code: 'EMBEDDING_UNAVAILABLE',
      message: '没有可用的嵌入服务商',
      retryable: true,
    };
  }

  throw new IndexJobFailure(
    lastFailure?.code ?? 'EMBEDDING_UNAVAILABLE',
    lastFailure?.message ?? '没有可用的嵌入服务商',
    true,
  );
}

async function failJob(
  job: ClaimedOutboxJob,
  chapterId: string,
  versionId: string,
  attempts: number,
  failure: IndexJobFailure,
): Promise<IndexJobOutcome> {
  const detail = `索引失败：${failure.message}`;
  const updated = await setIndexState(
    { chapterId, versionId },
    {
      status: 'failed',
      detail: truncate(detail),
      attempts,
      lastError: failure.message,
    },
  );
  if (!updated) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '索引已就绪或已被更新的任务接管，失败结果未写入' };
  }
  await markOutboxFailed(job.id, failure.message);
  return { outcome: 'failed', code: failure.code, message: failure.message };
}

async function retryJob(
  job: ClaimedOutboxJob,
  chapterId: string,
  versionId: string,
  attempts: number,
  failure: IndexJobFailure,
): Promise<IndexJobOutcome> {
  const delayMinutes = RETRY_DELAY_MINUTES[Math.min(attempts - 1, RETRY_DELAY_MINUTES.length - 1)]!;
  const detail = `嵌入服务暂时不可用（第 ${attempts}/${MAX_ATTEMPTS} 次尝试失败），约 ${delayMinutes} 分钟后自动重试`;
  const updated = await setIndexState(
    { chapterId, versionId },
    {
      status: 'pending',
      detail,
      attempts,
      delayMinutes,
      lastError: failure.message,
    },
  );
  if (!updated) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '索引状态已被更新的正典版本接管' };
  }
  await scheduleOutboxRetry(job.id, delayMinutes, failure.message);
  return { outcome: 'retry', message: failure.message, delayMinutes };
}

function isTerminalFailure(failure: IndexJobFailure): boolean {
  return !failure.retryable;
}

async function runIndexJob(
  job: ClaimedOutboxJob,
  options: IndexPipelineOptions,
): Promise<IndexJobOutcome> {
  const chapterId = job.payload.chapterId;
  const versionId = job.payload.versionId;
  if (!chapterId || !versionId) {
    await markOutboxFailed(job.id, 'index.chapter 缺少 chapterId 或 versionId');
    return { outcome: 'failed', code: 'INVALID_PAYLOAD', message: '索引任务缺少章节或版本标识' };
  }

  const context = await loadJobContext(chapterId, versionId);
  if (!context) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '章节或正典版本已不存在' };
  }
  if (job.payload.workspaceId && job.payload.workspaceId !== context.workspace_id) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '索引任务与章节所属工作区不匹配' };
  }
  if (context.current_version_id !== versionId) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '该版本已不是当前正典，旧版本不参与生成索引' };
  }

  const indexing = await markIndexing(chapterId, versionId, job.attempts);
  if (!indexing) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '索引已就绪或已被更新的索引任务接管' };
  }

  const chunks = chunkCanon(context.content);
  if (chunks.length === 0) {
    return failJob(
      job,
      chapterId,
      versionId,
      job.attempts,
      new IndexJobFailure('EMPTY_CONTENT', '正典正文为空，无法建立索引', false),
    );
  }

  const routing = await loadEmbeddingProviders(sql, context.workspace_id, resolveSecret(options));
  if (routing.providers.length === 0) {
    const skipped = routing.skipped.map((item) => `${item.name}：${item.reason}`).join('；');
    const reason = skipped
      ? `没有可用的嵌入服务商（${skipped}）`
      : '尚未配置启用的嵌入服务商（用途=embedding）';
    const updated = await setIndexState(
      { chapterId, versionId },
      {
        status: 'not_configured',
        detail: `${reason}；正典暂不可检索，配置后请重建索引`,
        attempts: job.attempts,
      },
    );
    await markOutboxProcessed(job.id);
    if (!updated) {
      return { outcome: 'skipped', reason: '索引已就绪或已被更新的任务接管' };
    }
    return { outcome: 'not_configured', reason };
  }

  const primaryModel = routing.providers[0]!.model;
  const candidates = routing.providers.filter((provider) => provider.model === primaryModel);
  const inputs = chunks.map((chunk) =>
    embeddingInput(chunk, context.chapter_number, context.chapter_title),
  );

  const vectors: number[][] = [];
  let dimensions: number | null = null;
  let usedProvider: EmbeddingProvider | null = null;
  const sleep = options.sleep ?? defaultSleep;

  for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
    const batchInputs = inputs.slice(offset, offset + BATCH_SIZE);
    const result = await embedWithFailover({
      providers: candidates,
      inputs: batchInputs,
      workspaceId: context.workspace_id,
      chapterId,
      expectedDimensions: dimensions,
      sleep,
    });
    if (dimensions === null) dimensions = result.dimensions;
    vectors.push(...result.vectors);
    usedProvider = result.provider;
  }

  const finalDimensions = dimensions;
  const finalProvider = usedProvider;
  if (finalDimensions === null || finalProvider === null) {
    throw new IndexJobFailure('EMBEDDING_EMPTY_RESULT', '嵌入管线没有返回任何向量', true);
  }

  const committed = await sql.begin(async (tx) => {
    const locked = await tx<{ version_id: string; status: string }[]>`
      SELECT version_id, status FROM index_status
      WHERE chapter_id = ${chapterId}
      FOR UPDATE
    `;
    if (locked[0]?.version_id !== versionId) return 'version_changed' as const;
    if (locked[0].status === 'ready') return 'already_ready' as const;

    const current = await tx<{ version_id: string }[]>`
      SELECT version_id FROM canon_current WHERE chapter_id = ${chapterId}
    `;
    if (current[0]?.version_id !== versionId) return 'version_changed' as const;

    await tx`DELETE FROM canon_chunks WHERE version_id = ${versionId}`;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const vector = vectors[index]!;
      const chunkId = randomUUID();
      await tx`
        INSERT INTO canon_chunks (
          id, workspace_id, work_id, chapter_id, version_id, chunk_index,
          paragraph_start, paragraph_end, char_start, char_end,
          content, content_hash, lexical_text
        )
        VALUES (
          ${chunkId}, ${context.workspace_id}, ${context.work_id}, ${chapterId}, ${versionId},
          ${chunk.index}, ${chunk.paragraphStart}, ${chunk.paragraphEnd},
          ${chunk.charStart}, ${chunk.charEnd}, ${chunk.content}, ${sha256(chunk.content)},
          ${buildLexicalText(chunk.content)}
        )
      `;
      await tx`
        INSERT INTO chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
        VALUES (
          ${chunkId}, ${finalProvider.id}, ${finalProvider.model}, ${finalDimensions},
          ${vectorLiteral(vector)}::vector
        )
      `;
    }

    await tx`
      UPDATE index_status
      SET status = 'ready',
          detail = ${`正典 v${context.version_no} 已索引 ${chunks.length} 个片段（${finalProvider.model} · ${finalDimensions} 维）`},
          chunk_count = ${chunks.length},
          provider_name = ${finalProvider.name},
          model = ${finalProvider.model},
          dimensions = ${finalDimensions},
          attempts = ${job.attempts},
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
      WHERE chapter_id = ${chapterId} AND version_id = ${versionId}
    `;
    return 'committed' as const;
  });

  if (committed !== 'committed') {
    await markOutboxProcessed(job.id);
    return {
      outcome: 'skipped',
      reason:
        committed === 'already_ready'
          ? '索引已就绪，重复任务的结果已丢弃'
          : '索引写入前发现正典版本已变化，结果已丢弃',
    };
  }

  await markOutboxProcessed(job.id);
  return {
    outcome: 'ready',
    chunks: chunks.length,
    providerName: finalProvider.name,
    model: finalProvider.model,
    dimensions: finalDimensions,
  };
}

export async function processIndexJob(
  job: ClaimedOutboxJob,
  options: IndexPipelineOptions = {},
): Promise<IndexJobOutcome> {
  const chapterId = job.payload.chapterId;
  const versionId = job.payload.versionId;
  if (!chapterId || !versionId) {
    await markOutboxFailed(job.id, 'index.chapter 缺少 chapterId 或 versionId');
    return { outcome: 'failed', code: 'INVALID_PAYLOAD', message: '索引任务缺少章节或版本标识' };
  }

  try {
    return await runIndexJob(job, options);
  } catch (error) {
    const failure =
      error instanceof IndexJobFailure
        ? error
        : new IndexJobFailure('INDEX_JOB_ERROR', truncate(errorMessage(error)), true);

    try {
      if (isTerminalFailure(failure) || job.attempts >= MAX_ATTEMPTS) {
        return await failJob(job, chapterId, versionId, job.attempts, failure);
      }
      return await retryJob(job, chapterId, versionId, job.attempts, failure);
    } catch (stateError) {
      console.error(
        `[worker] 无法写入索引失败状态（outbox ${job.id}）：${errorMessage(stateError)}`,
      );
      return { outcome: 'failed', code: failure.code, message: failure.message };
    }
  }
}

interface LedgerSnapshot {
  name?: unknown;
  aliases?: unknown;
  summary?: unknown;
  sourceChapterId?: unknown;
  payload?: unknown;
}

interface LedgerJobContext {
  entry_id: string;
  workspace_id: string;
  work_id: string | null;
  kind: string;
  scope: string;
  name: string;
  status: string;
  version_id: string;
  version_no: number;
  snapshot: LedgerSnapshot;
  current_version_id: string | null;
}

interface LedgerChapterRow {
  id: string;
  number: number;
  title: string;
}

const LEDGER_KIND_LABELS: Record<string, string> = {
  setting: '设定',
  character: '角色',
  foreshadowing: '伏笔',
};

const SETTING_CATEGORY_LABELS: Record<string, string> = {
  world: '世界观',
  location: '地点',
  faction: '势力',
  rule: '规则',
  item: '物品',
  other: '其他',
};

const CHARACTER_LIFE_LABELS: Record<string, string> = {
  alive: '存活',
  dead: '死亡',
  unknown: '未知',
};

const FORESHADOWING_STATE_LABELS: Record<string, string> = {
  planted: '已埋设',
  reinforced: '已强化',
  paid_off: '已回收',
  abandoned: '已放弃',
};

const FORESHADOWING_IMPORTANCE_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function chapterNumberLabel(
  chapterId: string,
  chapters: Map<string, LedgerChapterRow>,
): string {
  const chapter = chapters.get(chapterId);
  return chapter ? `第 ${chapter.number} 章《${chapter.title}》` : '未登记章节';
}

function ledgerDocumentText(
  context: LedgerJobContext,
  chapters: Map<string, LedgerChapterRow>,
): string {
  const snapshot = context.snapshot ?? {};
  const payload = asRecord(snapshot.payload);
  const kindLabel = LEDGER_KIND_LABELS[context.kind] ?? '账本';
  const lines = [`${kindLabel}：${context.name}`];
  const aliases = asStringArray(snapshot.aliases);
  if (aliases.length > 0) lines.push(`别名：${aliases.join('、')}`);
  const summary = asString(snapshot.summary);
  if (summary) lines.push(`摘要：${summary}`);
  const sourceChapterId = asString(snapshot.sourceChapterId);
  if (sourceChapterId) {
    lines.push(`来源章节：${chapterNumberLabel(sourceChapterId, chapters)}`);
  }

  if (context.kind === 'setting') {
    const category = asString(payload.category);
    const tags = asStringArray(payload.tags);
    const details = asString(payload.details);
    if (category) {
      lines.push(`分类：${SETTING_CATEGORY_LABELS[category] ?? category}`);
    }
    if (tags.length > 0) lines.push(`标签：${tags.join('、')}`);
    if (details) lines.push(`设定详情：${details}`);
  } else if (context.kind === 'character') {
    const fields: Array<[string, string]> = [
      ['身份', asString(payload.role)],
      ['阵营', asString(payload.faction)],
      ['外貌', asString(payload.appearance)],
      ['性格', asString(payload.personality)],
      ['目标', asString(payload.goals)],
      ['能力', asString(payload.abilities)],
      ['说话风格', asString(payload.speechStyle)],
    ];
    for (const [label, value] of fields) {
      if (value) lines.push(`${label}：${value}`);
    }
    const relationships = Array.isArray(payload.relationships) ? payload.relationships : [];
    if (relationships.length > 0) {
      const formatted = relationships
        .map((item) => {
          const relation = asRecord(item);
          const name = asString(relation.name);
          const kind = asString(relation.relation);
          const notes = asString(relation.notes);
          if (!name) return '';
          return `${name}（${kind || '关系未注明'}${notes ? `：${notes}` : ''}）`;
        })
        .filter((item) => item.length > 0);
      if (formatted.length > 0) lines.push(`人物关系：${formatted.join('；')}`);
    }
    const states = Array.isArray(payload.states) ? payload.states : [];
    if (states.length > 0) {
      lines.push('状态时间线：');
      for (const item of states) {
        const state = asRecord(item);
        const chapterId = asString(state.asOfChapterId);
        const parts = [
          chapterNumberLabel(chapterId, chapters),
          `生死：${CHARACTER_LIFE_LABELS[asString(state.life)] ?? '未知'}`,
          asString(state.location) ? `位置：${asString(state.location)}` : '',
          asString(state.knowledge) ? `已知：${asString(state.knowledge)}` : '',
          asString(state.possessions) ? `持有：${asString(state.possessions)}` : '',
          asString(state.relationshipChanges)
            ? `关系变化：${asString(state.relationshipChanges)}`
            : '',
        ].filter((part) => part.length > 0);
        lines.push(`- ${parts.join('；')}`);
      }
    }
  } else if (context.kind === 'foreshadowing') {
    const state = asString(payload.state) || 'planted';
    const importance = asString(payload.importance) || 'medium';
    lines.push(
      `状态：${FORESHADOWING_STATE_LABELS[state] ?? state}；重要性：${
        FORESHADOWING_IMPORTANCE_LABELS[importance] ?? importance
      }`,
    );
    const seedChapterId = asString(payload.seedChapterId);
    if (seedChapterId) {
      lines.push(`埋设章节：${chapterNumberLabel(seedChapterId, chapters)}`);
    }
    const min = typeof payload.payoffChapterMin === 'number' ? payload.payoffChapterMin : null;
    const max = typeof payload.payoffChapterMax === 'number' ? payload.payoffChapterMax : null;
    if (min !== null || max !== null) {
      lines.push(
        `计划回收：${min !== null && max !== null ? `第 ${min}–${max} 章` : min !== null ? `第 ${min} 章起` : `第 ${max} 章前`}`,
      );
    }
    const payoffChapterId = asString(payload.payoffChapterId);
    if (payoffChapterId) {
      lines.push(`回收章节：${chapterNumberLabel(payoffChapterId, chapters)}`);
    }
    const note = asString(payload.note);
    if (note) lines.push(`伏笔说明：${note}`);
    const resolution = asString(payload.resolutionNote);
    if (resolution) lines.push(`回收或放弃说明：${resolution}`);
  }

  return lines.join('\n');
}

async function setLedgerIndexState(
  job: { entryId: string; versionId: string },
  fields: {
    status: string;
    detail: string;
    attempts: number;
    chunkCount?: number;
    providerName?: string | null;
    model?: string | null;
    dimensions?: number | null;
    delayMinutes?: number | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  const rows = await sql<{ entry_id: string }[]>`
    UPDATE ledger_index_status
    SET status = ${fields.status},
        detail = ${fields.detail},
        chunk_count = ${fields.chunkCount ?? 0},
        provider_name = ${fields.providerName ?? null},
        model = ${fields.model ?? null},
        dimensions = ${fields.dimensions ?? null},
        attempts = ${fields.attempts},
        next_retry_at = ${
          fields.delayMinutes == null
            ? null
            : sql`now() + ${fields.delayMinutes} * interval '1 minute'`
        },
        last_error = ${fields.lastError ?? null},
        updated_at = now()
    WHERE entry_id = ${job.entryId} AND version_id = ${job.versionId}
      AND status <> 'ready'
    RETURNING entry_id
  `;
  return rows.length > 0;
}

async function markLedgerIndexing(
  context: LedgerJobContext,
  attempts: number,
): Promise<boolean> {
  const rows = await sql<{ entry_id: string }[]>`
    INSERT INTO ledger_index_status (
      entry_id, workspace_id, version_id, status, detail, attempts, updated_at
    )
    VALUES (
      ${context.entry_id}, ${context.workspace_id}, ${context.version_id}, 'indexing',
      ${`正在切块并写入账本索引（第 ${attempts} 次尝试）`}, ${attempts}, now()
    )
    ON CONFLICT (entry_id) DO UPDATE
      SET status = 'indexing',
          detail = EXCLUDED.detail,
          chunk_count = 0,
          provider_name = NULL,
          model = NULL,
          dimensions = NULL,
          attempts = EXCLUDED.attempts,
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
    WHERE ledger_index_status.version_id = EXCLUDED.version_id
      AND ledger_index_status.status <> 'ready'
      AND NOT (
        ledger_index_status.status = 'not_configured'
        AND ledger_index_status.chunk_count > 0
      )
    RETURNING entry_id
  `;
  return rows.length > 0;
}

async function failLedgerJob(
  job: ClaimedOutboxJob,
  entryId: string,
  versionId: string,
  attempts: number,
  failure: IndexJobFailure,
): Promise<IndexJobOutcome> {
  const updated = await setLedgerIndexState(
    { entryId, versionId },
    {
      status: 'failed',
      detail: truncate(`账本索引失败：${failure.message}`),
      attempts,
      lastError: failure.message,
    },
  );
  if (!updated) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '账本索引已就绪或已被更新的任务接管，失败结果未写入' };
  }
  await markOutboxFailed(job.id, failure.message);
  return { outcome: 'failed', code: failure.code, message: failure.message };
}

async function retryLedgerJob(
  job: ClaimedOutboxJob,
  entryId: string,
  versionId: string,
  attempts: number,
  failure: IndexJobFailure,
): Promise<IndexJobOutcome> {
  const delayMinutes = RETRY_DELAY_MINUTES[Math.min(attempts - 1, RETRY_DELAY_MINUTES.length - 1)]!;
  const detail = `嵌入服务暂时不可用（第 ${attempts}/${MAX_ATTEMPTS} 次尝试失败），约 ${delayMinutes} 分钟后自动重试`;
  const updated = await setLedgerIndexState(
    { entryId, versionId },
    {
      status: 'pending',
      detail,
      attempts,
      delayMinutes,
      lastError: failure.message,
    },
  );
  if (!updated) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '账本索引状态已被更新版本接管' };
  }
  await scheduleOutboxRetry(job.id, delayMinutes, failure.message);
  return { outcome: 'retry', message: failure.message, delayMinutes };
}

async function removeLedgerChunks(entryId: string, keepVersionId: string | null): Promise<void> {
  if (keepVersionId) {
    await sql`
      DELETE FROM ledger_chunks
      WHERE entry_id = ${entryId} AND version_id <> ${keepVersionId}
    `;
  } else {
    await sql`DELETE FROM ledger_chunks WHERE entry_id = ${entryId}`;
  }
}

interface LedgerProjectionWrite {
  context: LedgerJobContext;
  chunks: CanonChunk[];
  attempts: number;
  vectors: number[][] | null;
  provider: EmbeddingProvider | null;
  dimensions: number | null;
  status: 'ready' | 'not_configured';
  detail: string;
}

async function writeLedgerProjection(
  write: LedgerProjectionWrite,
): Promise<'committed' | 'already_ready' | 'version_changed'> {
  const { context, chunks } = write;
  return await sql.begin(async (tx) => {
    const locked = await tx<{ version_id: string; status: string }[]>`
      SELECT version_id, status FROM ledger_index_status
      WHERE entry_id = ${context.entry_id}
      FOR UPDATE
    `;
    if (locked[0]?.version_id !== context.version_id) return 'version_changed' as const;
    if (locked[0].status === 'ready') return 'already_ready' as const;

    const current = await tx<
      { current_version_id: string | null; status: string }[]
    >`
      SELECT current_version_id, status FROM ledger_entries WHERE id = ${context.entry_id}
    `;
    if (
      current[0]?.status !== 'active' ||
      current[0]?.current_version_id !== context.version_id
    ) {
      return 'version_changed' as const;
    }

    await tx`DELETE FROM ledger_chunks WHERE entry_id = ${context.entry_id}`;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const chunkId = randomUUID();
      await tx`
        INSERT INTO ledger_chunks (
          id, workspace_id, entry_id, version_id, kind, work_id, chunk_index,
          content, content_hash, lexical_text
        )
        VALUES (
          ${chunkId}, ${context.workspace_id}, ${context.entry_id}, ${context.version_id},
          ${context.kind}, ${context.work_id}, ${chunk.index},
          ${chunk.content}, ${sha256(chunk.content)}, ${buildLexicalText(chunk.content)}
        )
      `;
      if (write.vectors && write.provider && write.dimensions !== null) {
        await tx`
          INSERT INTO ledger_chunk_embeddings (chunk_id, provider_id, model, dimensions, embedding)
          VALUES (
            ${chunkId}, ${write.provider.id}, ${write.provider.model}, ${write.dimensions},
            ${vectorLiteral(write.vectors[index]!)}::vector
          )
        `;
      }
    }

    await tx`
      UPDATE ledger_index_status
      SET status = ${write.status},
          detail = ${write.detail},
          chunk_count = ${chunks.length},
          provider_name = ${write.provider?.name ?? null},
          model = ${write.provider?.model ?? null},
          dimensions = ${write.dimensions},
          attempts = ${write.attempts},
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
      WHERE entry_id = ${context.entry_id} AND version_id = ${context.version_id}
    `;
    return 'committed' as const;
  });
}

async function runLedgerIndexJob(
  job: ClaimedOutboxJob,
  options: IndexPipelineOptions,
): Promise<IndexJobOutcome> {
  const entryId = job.payload.entryId;
  const versionId = job.payload.versionId;
  if (!entryId || !versionId) {
    await markOutboxFailed(job.id, 'index.ledger 缺少 entryId 或 versionId');
    return {
      outcome: 'failed',
      code: 'INVALID_PAYLOAD',
      message: '账本索引任务缺少条目或版本标识',
    };
  }

  const rows = await sql<LedgerJobContext[]>`
    SELECT e.id AS entry_id,
           e.workspace_id,
           e.work_id,
           e.kind,
           e.scope,
           e.name,
           e.status,
           v.id AS version_id,
           v.version_no,
           v.snapshot,
           e.current_version_id
    FROM ledger_entries e
    JOIN ledger_entry_versions v ON v.id = ${versionId} AND v.entry_id = e.id
    WHERE e.id = ${entryId}
  `;
  const context = rows[0];
  if (!context) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '账本条目或版本已不存在' };
  }
  if (job.payload.workspaceId && job.payload.workspaceId !== context.workspace_id) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '索引任务与账本条目所属工作区不匹配' };
  }
  if (context.status !== 'active' || context.current_version_id !== versionId) {
    if (context.status !== 'active') {
      await removeLedgerChunks(entryId, null);
      await sql`DELETE FROM ledger_index_status WHERE entry_id = ${entryId}`;
    } else {
      await removeLedgerChunks(entryId, context.current_version_id);
      await sql`
        DELETE FROM ledger_index_status
        WHERE entry_id = ${entryId} AND version_id = ${versionId}
      `;
    }
    await markOutboxProcessed(job.id);
    return {
      outcome: 'skipped',
      reason:
        context.status !== 'active'
          ? '账本条目已归档，检索投影已移除'
          : '该版本已不是账本当前生效版本，旧版本不参与索引',
    };
  }

  const indexing = await markLedgerIndexing(context, job.attempts);
  if (!indexing) {
    await markOutboxProcessed(job.id);
    return { outcome: 'skipped', reason: '账本索引已完成或已被更新的索引任务接管' };
  }

  const chapterRows = context.work_id
    ? await sql<LedgerChapterRow[]>`
        SELECT id, number, title FROM chapters WHERE work_id = ${context.work_id}
      `
    : [];
  const chapters = new Map(chapterRows.map((row) => [row.id, row]));
  const document = ledgerDocumentText(context, chapters);
  const chunks = chunkCanon(document);
  if (chunks.length === 0) {
    return failLedgerJob(
      job,
      entryId,
      versionId,
      job.attempts,
      new IndexJobFailure('EMPTY_CONTENT', '账本投影内容为空，无法建立索引', false),
    );
  }

  const routing = await loadEmbeddingProviders(sql, context.workspace_id, resolveSecret(options));
  if (routing.providers.length === 0) {
    const skipped = routing.skipped.map((item) => `${item.name}：${item.reason}`).join('；');
    const reason = skipped
      ? `没有可用的嵌入服务商（${skipped}）`
      : '尚未配置启用的嵌入服务商（用途=embedding）';
    const committed = await writeLedgerProjection({
      context,
      chunks,
      attempts: job.attempts,
      vectors: null,
      provider: null,
      dimensions: null,
      status: 'not_configured',
      detail: `${reason}；已建立词法索引 ${chunks.length} 个片段，仅词法检索可用，配置嵌入服务后请重建索引以启用向量检索`,
    });
    await markOutboxProcessed(job.id);
    if (committed !== 'committed') {
      return {
        outcome: 'skipped',
        reason:
          committed === 'already_ready'
            ? '账本索引已就绪，重复任务的结果已丢弃'
            : '账本索引写入前发现当前版本已变化，结果已丢弃',
      };
    }
    return { outcome: 'not_configured', reason };
  }

  const primaryModel = routing.providers[0]!.model;
  const candidates = routing.providers.filter((provider) => provider.model === primaryModel);
  const kindLabel = LEDGER_KIND_LABELS[context.kind] ?? '账本';
  const inputs = chunks.map(
    (chunk) => `账本${kindLabel}《${context.name}》v${context.version_no}\n${chunk.content}`,
  );

  const vectors: number[][] = [];
  let dimensions: number | null = null;
  let usedProvider: EmbeddingProvider | null = null;
  const sleep = options.sleep ?? defaultSleep;

  for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
    const batchInputs = inputs.slice(offset, offset + BATCH_SIZE);
    const result = await embedWithFailover({
      providers: candidates,
      inputs: batchInputs,
      workspaceId: context.workspace_id,
      chapterId: null,
      expectedDimensions: dimensions,
      sleep,
    });
    if (dimensions === null) dimensions = result.dimensions;
    vectors.push(...result.vectors);
    usedProvider = result.provider;
  }

  const finalDimensions = dimensions;
  const finalProvider = usedProvider;
  if (finalDimensions === null || finalProvider === null) {
    throw new IndexJobFailure('EMBEDDING_EMPTY_RESULT', '嵌入管线没有返回任何向量', true);
  }

  const committed = await writeLedgerProjection({
    context,
    chunks,
    attempts: job.attempts,
    vectors,
    provider: finalProvider,
    dimensions: finalDimensions,
    status: 'ready',
    detail: `账本 v${context.version_no} 已索引 ${chunks.length} 个片段（${finalProvider.model} · ${finalDimensions} 维）`,
  });

  if (committed !== 'committed') {
    if (committed === 'version_changed') {
      const currentRows = await sql<{ current_version_id: string | null; status: string }[]>`
        SELECT current_version_id, status FROM ledger_entries WHERE id = ${entryId}
      `;
      if (currentRows[0]?.status !== 'active') {
        await removeLedgerChunks(entryId, null);
      } else {
        await removeLedgerChunks(entryId, currentRows[0]?.current_version_id ?? null);
      }
    }
    await markOutboxProcessed(job.id);
    return {
      outcome: 'skipped',
      reason:
        committed === 'already_ready'
          ? '账本索引已就绪，重复任务的结果已丢弃'
          : '账本索引写入前发现当前版本已变化，结果已丢弃',
    };
  }

  await markOutboxProcessed(job.id);
  return {
    outcome: 'ready',
    chunks: chunks.length,
    providerName: finalProvider.name,
    model: finalProvider.model,
    dimensions: finalDimensions,
  };
}

export async function processLedgerIndexJob(
  job: ClaimedOutboxJob,
  options: IndexPipelineOptions = {},
): Promise<IndexJobOutcome> {
  const entryId = job.payload.entryId;
  const versionId = job.payload.versionId;
  if (!entryId || !versionId) {
    await markOutboxFailed(job.id, 'index.ledger 缺少 entryId 或 versionId');
    return {
      outcome: 'failed',
      code: 'INVALID_PAYLOAD',
      message: '账本索引任务缺少条目或版本标识',
    };
  }

  try {
    return await runLedgerIndexJob(job, options);
  } catch (error) {
    const failure =
      error instanceof IndexJobFailure
        ? error
        : new IndexJobFailure('INDEX_JOB_ERROR', truncate(errorMessage(error)), true);

    try {
      if (isTerminalFailure(failure) || job.attempts >= MAX_ATTEMPTS) {
        return await failLedgerJob(job, entryId, versionId, job.attempts, failure);
      }
      return await retryLedgerJob(job, entryId, versionId, job.attempts, failure);
    } catch (stateError) {
      console.error(
        `[worker] 无法写入账本索引失败状态（outbox ${job.id}）：${errorMessage(stateError)}`,
      );
      return { outcome: 'failed', code: failure.code, message: failure.message };
    }
  }
}

export async function recoverStaleOutbox(): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    UPDATE outbox
    SET status = 'pending', locked_at = NULL, next_attempt_at = now()
    WHERE status = 'processing'
      AND (locked_at IS NULL OR locked_at < now() - ${STALE_PROCESSING_MINUTES} * interval '1 minute')
    RETURNING id
  `;
  return rows.length;
}

export async function claimOutbox(limit = 10): Promise<ClaimedOutboxJob[]> {
  return sql<ClaimedOutboxJob[]>`
    UPDATE outbox
    SET status = 'processing', attempts = attempts + 1, locked_at = now()
    WHERE id IN (
      SELECT id FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, event_type, payload, attempts
  `;
}

export async function runOutboxTick(options: IndexPipelineOptions = {}): Promise<number> {
  await recoverStaleOutbox();
  const jobs = await claimOutbox();
  for (const job of jobs) {
    let outcome: IndexJobOutcome;
    const label =
      job.event_type === 'index.ledger'
        ? `账本 ${job.payload.entryId}`
        : `章 ${job.payload.chapterId}`;
    if (job.event_type === 'index.chapter') {
      outcome = await processIndexJob(job, options);
    } else if (job.event_type === 'index.ledger') {
      outcome = await processLedgerIndexJob(job, options);
    } else {
      await markOutboxFailed(job.id, `未知事件类型：${job.event_type}`);
      continue;
    }
    if (outcome.outcome === 'ready') {
      console.log(
        `[worker] ${label} 索引完成：${outcome.chunks} 块 · ${outcome.model} · ${outcome.dimensions} 维`,
      );
    } else if (outcome.outcome === 'retry') {
      console.warn(
        `[worker] ${label} 索引暂时失败，${outcome.delayMinutes} 分钟后重试：${outcome.message}`,
      );
    } else if (outcome.outcome === 'failed') {
      console.error(`[worker] ${label} 索引失败：${outcome.message}`);
    }
  }
  return jobs.length;
}
