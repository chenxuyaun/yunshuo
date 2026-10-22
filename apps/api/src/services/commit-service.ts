import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import type { CommitResponse } from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { actorKindOf, assertCanWrite } from '../auth.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import {
  assertLeaseHeld,
  contextHashOf,
  loadChapter,
  loadEvaluation,
} from './chapter-data.js';
import { mapIndex, pendingIndexStatus, type IndexRow, type StagedRow } from '../views.js';
export interface CommitInput {
  idempotencyKey: string;
  targetChapterId: string;
  expectedCurrentVersionId: string | null;
  stagedDraftId: string;
}

interface IntentRow {
  id: string;
  chapter_id: string;
  operation: string;
  status: 'pending' | 'committing' | 'committed' | 'failed';
  error_code: string | null;
  error_message: string | null;
}

interface CommittedRow {
  version_id: string;
  version_no: number;
  waiver_id: string | null;
}

interface CommitStagedRow extends StagedRow {
  content: string;
}

async function committedResponse(
  chapterId: string,
  row: CommittedRow,
  alreadyCommitted: boolean,
): Promise<CommitResponse> {
  const indexRows = await sql<IndexRow[]>`
    SELECT
      i.status, i.detail, i.version_id, v.version_no, i.chunk_count, i.provider_name,
      i.model, i.dimensions, i.attempts, i.next_retry_at, i.last_error, i.updated_at
    FROM index_status i
    LEFT JOIN canon_versions v ON v.id = i.version_id
    WHERE i.chapter_id = ${chapterId}
  `;
  const indexStatus = indexRows[0]
    ? mapIndex(indexRows[0])
    : pendingIndexStatus(row.version_id);
  return {
    chapterId,
    versionId: row.version_id,
    versionNo: row.version_no,
    status: 'canon',
    indexStatus,
    alreadyCommitted,
    waiverId: row.waiver_id,
  };
}

export async function commitChapter(
  auth: AuthContext,
  chapterId: string,
  input: CommitInput,
): Promise<CommitResponse> {
  assertCanWrite(auth.role);

  if (input.targetChapterId !== chapterId) {
    throw badRequest('TARGET_MISMATCH', '提交目标章节与当前章节不一致');
  }

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO commit_intents (
      id, idempotency_key, chapter_id, staged_draft_id, expected_current_version_id, status
    )
    VALUES (
      ${randomUUID()}, ${input.idempotencyKey}, ${chapterId}, ${input.stagedDraftId},
      ${input.expectedCurrentVersionId}, 'pending'
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;

  let intentId = inserted[0]?.id;
  if (!intentId) {
    const existingRows = await sql<IntentRow[]>`
      SELECT id, chapter_id, operation, status, error_code, error_message
      FROM commit_intents
      WHERE idempotency_key = ${input.idempotencyKey}
    `;
    const existing = existingRows[0];
    if (!existing) {
      throw new AppError(500, 'INTENT_RACE', '提交意图创建失败，请重试');
    }
    if (existing.chapter_id !== chapterId) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于其他章节的提交');
    }
    if (existing.operation !== 'commit') {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于其他操作，不能复用');
    }
    if (existing.status === 'committed') {
      const rows = await sql<CommittedRow[]>`
        SELECT c.version_id, v.version_no, v.waiver_id
        FROM commits c
        JOIN canon_versions v ON v.id = c.version_id
        WHERE c.intent_id = ${existing.id}
      `;
      if (!rows[0]) throw new AppError(500, 'COMMIT_RECORD_MISSING', '提交记录缺失');
      return committedResponse(chapterId, rows[0], true);
    }
    if (existing.status === 'pending' || existing.status === 'committing') {
      throw conflict('COMMIT_IN_PROGRESS', '相同幂等键的提交正在进行，请稍后刷新');
    }
    await sql`
      UPDATE commit_intents
      SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${existing.id}
    `;
    intentId = existing.id;
  }

  try {
    const committed = await sql.begin(async (tx) => {
      await tx`
        UPDATE commit_intents SET status = 'committing', updated_at = now() WHERE id = ${intentId}
      `;

      const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
      if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
      if (chapter.status !== 'staged' && chapter.status !== 'commit_failed') {
        throw conflict('CHAPTER_NOT_COMMITTABLE', `章节当前状态 ${chapter.status} 不允许提交`);
      }
      await assertLeaseHeld(tx, chapterId, auth);

      if ((chapter.current_version_id ?? null) !== (input.expectedCurrentVersionId ?? null)) {
        throw conflict('CONCURRENT_COMMIT', '当前正典版本已变化，请刷新后重试', {
          currentVersionId: chapter.current_version_id,
        });
      }

      const stagedRows = await tx<CommitStagedRow[]>`
        SELECT
          s.id, s.chapter_id, s.content, s.content_hash, s.word_count, s.evaluation_id,
          s.staged_by, u.name AS staged_by_name, s.staged_at
        FROM staged_drafts s
        JOIN users u ON u.id = s.staged_by
        WHERE s.id = ${input.stagedDraftId} AND s.chapter_id = ${chapterId}
      `;
      const staged = stagedRows[0];
      if (!staged) {
        throw conflict('STAGED_DRAFT_NOT_FOUND', '暂存草稿不存在或不属于本章');
      }

      const latestRows = await tx<{ id: string }[]>`
        SELECT id FROM staged_drafts
        WHERE chapter_id = ${chapterId}
        ORDER BY staged_at DESC, id DESC
        LIMIT 1
      `;
      if (latestRows[0]?.id !== staged.id) {
        throw conflict('STAGED_DRAFT_STALE', '该暂存草稿已被更新的暂存覆盖');
      }

      const evaluation = await loadEvaluation(tx, staged.evaluation_id, chapterId);
      if (!evaluation) {
        throw conflict('EVALUATION_NOT_FOUND', '暂存草稿缺少门禁证据');
      }
      if (evaluation.status !== 'passed') {
        throw conflict('GATE_NOT_PASSED', `门禁结论为 ${evaluation.status}，不能提交正典`);
      }
      if (evaluation.content_hash !== staged.content_hash) {
        throw conflict('EVALUATION_STALE', '门禁证据与暂存正文不一致');
      }
      if (evaluation.context_hash !== contextHashOf(chapter, evaluation.ruleset_id)) {
        throw conflict('CONTEXT_CHANGED', '设定或规则版本已变化，请重新跑门禁');
      }

      const nextNoRows = await tx<{ next_no: number }[]>`
        SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
        FROM canon_versions
        WHERE chapter_id = ${chapterId}
      `;
      const versionNo = nextNoRows[0]!.next_no;
      const versionId = randomUUID();
      const source = auth.automation ? 'batch' : 'human';

      await tx`
        INSERT INTO canon_versions (
          id, chapter_id, version_no, content, content_hash, word_count,
          parent_version_id, source, actor_id, evaluation_id, waiver_id
        )
        VALUES (
          ${versionId}, ${chapterId}, ${versionNo}, ${staged.content},
          ${staged.content_hash}, ${staged.word_count}, ${chapter.current_version_id},
          ${source}, ${auth.user.id}, ${staged.evaluation_id}, NULL
        )
      `;

      await tx`
        INSERT INTO commits (id, intent_id, chapter_id, version_id, actor_id)
        VALUES (${randomUUID()}, ${intentId}, ${chapterId}, ${versionId}, ${auth.user.id})
      `;
      await tx`
        INSERT INTO canon_current (chapter_id, version_id, updated_at)
        VALUES (${chapterId}, ${versionId}, now())
        ON CONFLICT (chapter_id) DO UPDATE
          SET version_id = EXCLUDED.version_id, updated_at = now()
      `;
      await tx`
        UPDATE chapters
        SET status = 'canon', current_version_id = ${versionId}, updated_at = now()
        WHERE id = ${chapterId}
      `;
      await tx`
        INSERT INTO chapter_metadata (chapter_id, word_count, updated_at)
        VALUES (${chapterId}, ${staged.word_count}, now())
        ON CONFLICT (chapter_id) DO UPDATE
          SET word_count = EXCLUDED.word_count, updated_at = now()
      `;
      await tx`
        INSERT INTO index_status (chapter_id, version_id, status, detail, updated_at)
        VALUES (
          ${chapterId}, ${versionId}, 'pending',
          '已入提交事务，等待索引 worker', now()
        )
        ON CONFLICT (chapter_id) DO UPDATE
          SET version_id = EXCLUDED.version_id, status = 'pending',
              detail = EXCLUDED.detail, chunk_count = 0, provider_name = NULL,
              model = NULL, dimensions = NULL, attempts = 0,
              next_retry_at = NULL, last_error = NULL, updated_at = now()
      `;

      const payload = {
        versionId,
        versionNo,
        source,
        evaluationId: staged.evaluation_id,
        stagedDraftId: staged.id,
        targetChapterId: input.targetChapterId,
        idempotencyKey: input.idempotencyKey,
        ...(auth.automation
          ? { jobId: auth.automation.jobId, mandateId: auth.automation.mandateId }
          : {}),
      };
      await tx`
        INSERT INTO events (
          workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
        )
        VALUES (
          ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.committed',
          ${tx.json(jsonValue(payload))}, ${auth.user.id}
        )
      `;
      await tx`
        INSERT INTO audit_log (
          workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
        )
        VALUES (
          ${auth.workspace.id}, ${auth.user.id}, ${actorKindOf(auth)}, ${auth.role}, 'chapter.commit',
          'chapter', ${chapterId}, 'success', ${tx.json(jsonValue(payload))}
        )
      `;
      await tx`
        INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
        VALUES (
          'index.chapter',
          ${tx.json(jsonValue({ chapterId, versionId, workspaceId: auth.workspace.id }))},
          ${`index:${versionId}`}, now()
        )
        ON CONFLICT (dedupe_key) DO NOTHING
      `;
      await tx`DELETE FROM chapter_leases WHERE chapter_id = ${chapterId}`;
      await tx`
        UPDATE commit_intents SET status = 'committed', updated_at = now() WHERE id = ${intentId}
      `;

      return { version_id: versionId, version_no: versionNo, waiver_id: null };
    });

    return committedResponse(chapterId, committed, false);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(500, 'COMMIT_FAILED', error instanceof Error ? error.message : String(error));
    await sql`
      UPDATE commit_intents
      SET status = 'failed', error_code = ${appError.code}, error_message = ${appError.message},
          updated_at = now()
      WHERE id = ${intentId} AND status <> 'committed'
    `;
    throw error;
  }
}
