import type { TransactionSql } from 'postgres';
import { sql, jsonValue } from '@yunshuo/db';
import type { ReindexResponse } from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import type { AuthContext } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';

const REINDEX_DETAIL = '手工重建索引已排队，等待 worker';

interface CanonChapterRow {
  chapter_id: string;
  version_id: string;
}

function assertCanReindex(role: Role): void {
  if (role !== 'owner' && role !== 'lead') {
    throw forbidden('仅所有者与主笔可以重建索引');
  }
}

function assertOwner(role: Role): void {
  if (role !== 'owner') {
    throw forbidden('仅所有者可以重建整个工作区的索引');
  }
}

interface EnqueueResult {
  queued: number;
  alreadyQueued: number;
}

async function enqueueChapter(
  tx: TransactionSql<any>,
  workspaceId: string,
  row: CanonChapterRow,
): Promise<EnqueueResult> {
  const inserted = await tx<{ id: number }[]>`
    INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
    VALUES (
      'index.chapter',
      ${tx.json(jsonValue({
        chapterId: row.chapter_id,
        versionId: row.version_id,
        workspaceId,
      }))},
      ${`index:${row.version_id}:reindex`},
      now()
    )
    ON CONFLICT (dedupe_key) DO UPDATE
      SET status = 'pending',
          payload = EXCLUDED.payload,
          attempts = 0,
          next_attempt_at = now(),
          locked_at = NULL,
          processed_at = NULL,
          last_error = NULL
      WHERE outbox.status IN ('processed', 'failed')
    RETURNING id
  `;
  if (inserted.length === 0) {
    return { queued: 0, alreadyQueued: 1 };
  }

  await tx`
    INSERT INTO index_status (chapter_id, version_id, status, detail, updated_at)
    VALUES (${row.chapter_id}, ${row.version_id}, 'pending', ${REINDEX_DETAIL}, now())
    ON CONFLICT (chapter_id) DO UPDATE
      SET version_id = EXCLUDED.version_id, status = 'pending',
          detail = EXCLUDED.detail, chunk_count = 0, provider_name = NULL,
          model = NULL, dimensions = NULL, attempts = 0,
          next_retry_at = NULL, last_error = NULL, updated_at = now()
  `;
  return { queued: 1, alreadyQueued: 0 };
}

async function writeReindexAudit(
  tx: TransactionSql<any>,
  auth: AuthContext,
  objectType: 'chapter' | 'workspace',
  objectId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'index.reindex',
      ${objectType}, ${objectId}, 'success', ${tx.json(jsonValue(metadata))}
    )
  `;
}

export async function reindexChapter(
  auth: AuthContext,
  chapterId: string,
): Promise<ReindexResponse> {
  assertCanReindex(auth.role);

  const enqueue = await sql.begin(async (tx) => {
    const rows = await tx<CanonChapterRow[]>`
      SELECT c.id AS chapter_id, cc.version_id
      FROM chapters c
      JOIN works w ON w.id = c.work_id
      JOIN canon_current cc ON cc.chapter_id = c.id
      WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
    `;
    const row = rows[0];
    if (!row) {
      const existing = await tx<{ id: string }[]>`
        SELECT c.id
        FROM chapters c
        JOIN works w ON w.id = c.work_id
        WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
      `;
      if (!existing[0]) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
      throw conflict('CHAPTER_NO_CANON', '章节还没有正典版本，无法重建索引');
    }
    const result = await enqueueChapter(tx, auth.workspace.id, row);
    await writeReindexAudit(tx, auth, 'chapter', chapterId, {
      versionId: row.version_id,
      queued: result.queued,
      alreadyQueued: result.alreadyQueued,
    });
    return result;
  });

  return {
    queued: enqueue.queued,
    alreadyQueued: enqueue.alreadyQueued,
    skipped: 0,
    message:
      enqueue.queued > 0
        ? '已排队重建本章索引，提交不会被阻塞。'
        : '本章索引任务已在队列中，未重复排队。',
  };
}

export async function reindexWorkspace(
  auth: AuthContext,
  workId?: string,
): Promise<ReindexResponse> {
  assertOwner(auth.role);

  const result = await sql.begin(async (tx) => {
    const rows = workId
      ? await tx<CanonChapterRow[]>`
          SELECT c.id AS chapter_id, cc.version_id
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id} AND c.work_id = ${workId}
          ORDER BY c.number ASC
        `
      : await tx<CanonChapterRow[]>`
          SELECT c.id AS chapter_id, cc.version_id
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id}
          ORDER BY c.number ASC
        `;

    let queued = 0;
    let alreadyQueued = 0;
    for (const row of rows) {
      const result = await enqueueChapter(tx, auth.workspace.id, row);
      queued += result.queued;
      alreadyQueued += result.alreadyQueued;
    }

    const skippedRows = workId
      ? await tx<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          LEFT JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id}
            AND c.work_id = ${workId} AND cc.chapter_id IS NULL
        `
      : await tx<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          LEFT JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id} AND cc.chapter_id IS NULL
        `;

    const skipped = skippedRows[0]?.count ?? 0;
    await writeReindexAudit(tx, auth, 'workspace', auth.workspace.id, {
      workId: workId ?? null,
      queued,
      alreadyQueued,
      skipped,
    });
    return { queued, alreadyQueued, skipped };
  });

  const parts: string[] = [];
  if (result.queued > 0) parts.push(`已排队 ${result.queued} 章重建索引`);
  if (result.alreadyQueued > 0) parts.push(`${result.alreadyQueued} 章索引任务已在队列中`);
  if (result.skipped > 0) parts.push(`${result.skipped} 章尚无正典已跳过`);
  const summary = parts.length > 0 ? parts.join('；') : '没有可重建索引的正典章节';
  return {
    queued: result.queued,
    alreadyQueued: result.alreadyQueued,
    skipped: result.skipped,
    message: result.queued > 0 ? `${summary}。提交不会被阻塞。` : `${summary}。`,
  };
}
