import type { TransactionSql } from 'postgres';
import { sql, jsonValue } from '@yunshuo/db';
import type { ReindexResponse } from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import type { AuthContext } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import {
  enqueueChapterIndex,
  enqueueLedgerIndex,
  type CanonChapterIndexRow,
} from './index-queue.js';

interface LedgerIndexRow {
  entry_id: string;
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
    const rows = await tx<CanonChapterIndexRow[]>`
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
    const result = await enqueueChapterIndex(tx, auth.workspace.id, row);
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
      ? await tx<CanonChapterIndexRow[]>`
          SELECT c.id AS chapter_id, cc.version_id
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id} AND c.work_id = ${workId}
          ORDER BY c.number ASC
        `
      : await tx<CanonChapterIndexRow[]>`
          SELECT c.id AS chapter_id, cc.version_id
          FROM chapters c
          JOIN works w ON w.id = c.work_id
          JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE w.workspace_id = ${auth.workspace.id}
          ORDER BY c.number ASC
        `;

    let chapterQueued = 0;
    let chapterAlreadyQueued = 0;
    for (const row of rows) {
      const result = await enqueueChapterIndex(tx, auth.workspace.id, row);
      chapterQueued += result.queued;
      chapterAlreadyQueued += result.alreadyQueued;
    }

    const ledgerRows = workId
      ? await tx<LedgerIndexRow[]>`
          SELECT e.id AS entry_id, e.current_version_id AS version_id
          FROM ledger_entries e
          WHERE e.workspace_id = ${auth.workspace.id}
            AND e.status = 'active'
            AND e.current_version_id IS NOT NULL
            AND (e.work_id = ${workId} OR (e.kind = 'setting' AND e.work_id IS NULL))
          ORDER BY e.name ASC
        `
      : await tx<LedgerIndexRow[]>`
          SELECT e.id AS entry_id, e.current_version_id AS version_id
          FROM ledger_entries e
          WHERE e.workspace_id = ${auth.workspace.id}
            AND e.status = 'active'
            AND e.current_version_id IS NOT NULL
          ORDER BY e.name ASC
        `;

    let ledgerQueued = 0;
    let ledgerAlreadyQueued = 0;
    for (const row of ledgerRows) {
      const result = await enqueueLedgerIndex(
        tx,
        auth.workspace.id,
        row.entry_id,
        row.version_id,
      );
      ledgerQueued += result.queued;
      ledgerAlreadyQueued += result.alreadyQueued;
    }
    const queued = chapterQueued + ledgerQueued;
    const alreadyQueued = chapterAlreadyQueued + ledgerAlreadyQueued;

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
      ledgerQueued,
      ledgerAlreadyQueued,
    });
    return {
      queued,
      alreadyQueued,
      skipped,
      chapterQueued,
      chapterAlreadyQueued,
      ledgerQueued,
      ledgerAlreadyQueued,
    };
  });

  const parts: string[] = [];
  if (result.chapterQueued > 0) parts.push(`已排队 ${result.chapterQueued} 章重建索引`);
  if (result.ledgerQueued > 0) parts.push(`已排队 ${result.ledgerQueued} 个账本条目重建索引`);
  if (result.chapterAlreadyQueued > 0) {
    parts.push(`${result.chapterAlreadyQueued} 章索引任务已在队列中`);
  }
  if (result.ledgerAlreadyQueued > 0) {
    parts.push(`${result.ledgerAlreadyQueued} 个账本条目索引任务已在队列中`);
  }
  if (result.skipped > 0) parts.push(`${result.skipped} 章尚无正典已跳过`);
  const summary = parts.length > 0 ? parts.join('；') : '没有可重建索引的正典章节或账本条目';
  return {
    queued: result.queued,
    alreadyQueued: result.alreadyQueued,
    skipped: result.skipped,
    message: result.queued > 0 ? `${summary}。提交不会被阻塞。` : `${summary}。`,
  };
}
