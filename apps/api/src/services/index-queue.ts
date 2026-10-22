import type { TransactionSql } from 'postgres';
import { jsonValue } from '@yunshuo/db';

export interface EnqueueResult {
  queued: number;
  alreadyQueued: number;
}

export interface CanonChapterIndexRow {
  chapter_id: string;
  version_id: string;
}

const CHAPTER_QUEUED_DETAIL = '手工重建索引已排队，等待 worker';
const LEDGER_QUEUED_DETAIL = '账本索引已排队，等待 worker';

export async function enqueueChapterIndex(
  tx: TransactionSql<any>,
  workspaceId: string,
  row: CanonChapterIndexRow,
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
    VALUES (${row.chapter_id}, ${row.version_id}, 'pending', ${CHAPTER_QUEUED_DETAIL}, now())
    ON CONFLICT (chapter_id) DO UPDATE
      SET version_id = EXCLUDED.version_id, status = 'pending',
          detail = EXCLUDED.detail, chunk_count = 0, provider_name = NULL,
          model = NULL, dimensions = NULL, attempts = 0,
          next_retry_at = NULL, last_error = NULL, updated_at = now()
  `;
  return { queued: 1, alreadyQueued: 0 };
}

export async function enqueueLedgerIndex(
  tx: TransactionSql<any>,
  workspaceId: string,
  entryId: string,
  versionId: string,
  detail = LEDGER_QUEUED_DETAIL,
): Promise<EnqueueResult> {
  const inserted = await tx<{ id: number }[]>`
    INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
    VALUES (
      'index.ledger',
      ${tx.json(jsonValue({ entryId, versionId, workspaceId }))},
      ${`ledger-index:${entryId}:${versionId}`},
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

  await tx`
    INSERT INTO ledger_index_status (
      entry_id, workspace_id, version_id, status, detail, updated_at
    )
    VALUES (${entryId}, ${workspaceId}, ${versionId}, 'pending', ${detail}, now())
    ON CONFLICT (entry_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id,
          version_id = EXCLUDED.version_id,
          status = 'pending',
          detail = EXCLUDED.detail,
          chunk_count = 0,
          provider_name = NULL,
          model = NULL,
          dimensions = NULL,
          attempts = 0,
          next_retry_at = NULL,
          last_error = NULL,
          updated_at = now()
  `;

  return inserted.length > 0
    ? { queued: 1, alreadyQueued: 0 }
    : { queued: 0, alreadyQueued: 1 };
}
