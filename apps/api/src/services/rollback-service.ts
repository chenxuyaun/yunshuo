import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import type { RollbackResponse } from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import {
  contextHashOf,
  isLeaseActive,
  loadChapter,
  loadLease,
  loadRuleset,
} from './chapter-data.js';
import { mapIndex, pendingIndexStatus, type IndexRow } from '../views.js';

export interface RollbackInput {
  idempotencyKey: string;
  targetVersionId: string;
  expectedCurrentVersionId: string;
  reason: string;
  waiverId?: string | null;
}

interface IntentRow {
  id: string;
  chapter_id: string;
  operation: string;
  target_version_id: string | null;
  status: 'pending' | 'committing' | 'committed' | 'failed';
}

interface CommittedRollbackRow {
  version_id: string;
  version_no: number;
  parent_version_id: string;
  evaluation_id: string | null;
  waiver_id: string | null;
  target_version_id: string;
}

interface TargetVersionRow {
  id: string;
  version_no: number;
  content: string;
  content_hash: string;
  word_count: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

async function indexStatusOf(
  chapterId: string,
  versionId: string,
): Promise<RollbackResponse['indexStatus']> {
  const rows = await sql<IndexRow[]>`
    SELECT
      i.status, i.detail, i.version_id, v.version_no, i.chunk_count, i.provider_name,
      i.model, i.dimensions, i.attempts, i.next_retry_at, i.last_error, i.updated_at
    FROM index_status i
    LEFT JOIN canon_versions v ON v.id = i.version_id
    WHERE i.chapter_id = ${chapterId}
  `;
  return rows[0] ? mapIndex(rows[0]) : pendingIndexStatus(versionId);
}

async function committedResponse(
  chapterId: string,
  row: CommittedRollbackRow,
  alreadyCommitted: boolean,
): Promise<RollbackResponse> {
  return {
    chapterId,
    versionId: row.version_id,
    versionNo: row.version_no,
    status: 'canon',
    targetVersionId: row.target_version_id,
    previousVersionId: row.parent_version_id,
    evidence: row.waiver_id ? 'waived' : 'reused',
    evaluationId: row.evaluation_id,
    waiverId: row.waiver_id,
    indexStatus: await indexStatusOf(chapterId, row.version_id),
    alreadyCommitted,
  };
}

export async function rollbackChapter(
  auth: AuthContext,
  chapterId: string,
  input: RollbackInput,
): Promise<RollbackResponse> {
  if (auth.role !== 'owner' && auth.role !== 'lead') {
    throw forbidden('仅所有者或主笔可以回滚正典');
  }

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO commit_intents (
      id, idempotency_key, chapter_id, operation, target_version_id,
      expected_current_version_id, status
    )
    VALUES (
      ${randomUUID()}, ${input.idempotencyKey}, ${chapterId}, 'rollback',
      ${input.targetVersionId}, ${input.expectedCurrentVersionId}, 'pending'
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;

  let intentId = inserted[0]?.id;
  if (!intentId) {
    const existingRows = await sql<IntentRow[]>`
      SELECT id, chapter_id, operation, target_version_id, status
      FROM commit_intents
      WHERE idempotency_key = ${input.idempotencyKey}
    `;
    const existing = existingRows[0];
    if (!existing) {
      throw new AppError(500, 'INTENT_RACE', '回滚意图创建失败，请重试');
    }
    if (existing.chapter_id !== chapterId) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于其他章节的提交');
    }
    if (
      existing.operation !== 'rollback' ||
      existing.target_version_id !== input.targetVersionId
    ) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于其他操作，不能复用');
    }
    if (existing.status === 'committed') {
      const rows = await sql<CommittedRollbackRow[]>`
        SELECT
          c.version_id, v.version_no, v.parent_version_id, v.evaluation_id, v.waiver_id,
          ci.target_version_id
        FROM commits c
        JOIN canon_versions v ON v.id = c.version_id
        JOIN commit_intents ci ON ci.id = c.intent_id
        WHERE c.intent_id = ${existing.id}
      `;
      const row = rows[0];
      if (!row) throw new AppError(500, 'COMMIT_RECORD_MISSING', '回滚记录缺失');
      return committedResponse(chapterId, row, true);
    }
    if (existing.status === 'pending' || existing.status === 'committing') {
      throw conflict('COMMIT_IN_PROGRESS', '相同幂等键的回滚正在进行，请稍后刷新');
    }
    await sql`
      UPDATE commit_intents
      SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${existing.id}
    `;
    intentId = existing.id;
  }

  try {
    const result = await sql.begin(async (tx) => {
      await tx`
        UPDATE commit_intents SET status = 'committing', updated_at = now() WHERE id = ${intentId}
      `;

      const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
      if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
      if (chapter.status !== 'canon') {
        throw conflict('CHAPTER_NOT_CANON', `章节当前状态 ${chapter.status}，不能回滚正典`);
      }
      if (!chapter.current_version_id) {
        throw conflict('CHAPTER_NO_CANON', '章节没有当前正典版本');
      }
      if (chapter.current_version_id !== input.expectedCurrentVersionId) {
        throw conflict('CONCURRENT_COMMIT', '当前正典版本已变化，请刷新后重试', {
          currentVersionId: chapter.current_version_id,
        });
      }

      const lease = await loadLease(tx, chapterId, true);
      if (isLeaseActive(lease)) {
        throw conflict('LEASE_HELD', `章节租约由 ${lease!.user_name} 持有，不能回滚`, {
          holder: lease!.user_name,
          expiresAt: new Date(lease!.expires_at).toISOString(),
        });
      }

      const currentRows = await tx<{ version_no: number }[]>`
        SELECT version_no FROM canon_versions WHERE id = ${chapter.current_version_id}
      `;
      const currentVersion = currentRows[0];
      if (!currentVersion) throw conflict('CANON_VERSION_MISSING', '当前正典版本不存在');

      const targetRows = await tx<TargetVersionRow[]>`
        SELECT id, version_no, content, content_hash, word_count
        FROM canon_versions
        WHERE id = ${input.targetVersionId} AND chapter_id = ${chapterId}
      `;
      const target = targetRows[0];
      if (!target) throw notFound('VERSION_NOT_FOUND', '目标版本不存在或不属于本章');
      if (target.id === chapter.current_version_id) {
        throw conflict('ROLLBACK_TARGET_CURRENT', '目标版本就是当前正典，无需回滚');
      }
      if (target.version_no >= currentVersion.version_no) {
        throw conflict('ROLLBACK_TARGET_NOT_PRIOR', '只能回滚到更早的正典版本');
      }

      const ruleset = await loadRuleset(tx);
      if (!ruleset) throw conflict('RULESET_MISSING', '没有可用的门禁规则集');
      const contextHash = contextHashOf(chapter, ruleset.id);

      const evaluationRows = await tx<{ id: string }[]>`
        SELECT id
        FROM gate_evaluations
        WHERE chapter_id = ${chapterId}
          AND content_hash = ${target.content_hash}
          AND context_hash = ${contextHash}
          AND status = 'passed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
      let evaluationId = evaluationRows[0]?.id ?? null;
      let waiverId: string | null = null;

      if (!evaluationId) {
        if (!input.waiverId) {
          throw conflict(
            'ROLLBACK_EVIDENCE_REQUIRED',
            '目标版本没有可复用的门禁证据，需要先申请并批准回滚豁免',
            { targetVersionId: target.id, reason: 'no_valid_evaluation' },
          );
        }

        const waiverRows = await tx<{
          id: string;
          status: string;
          gate_key: string;
          target_version_id: string | null;
          requested_by: string;
          approved_by: string | null;
        }[]>`
          SELECT id, status, gate_key, target_version_id, requested_by, approved_by
          FROM waivers
          WHERE id = ${input.waiverId} AND chapter_id = ${chapterId}
          FOR UPDATE
        `;
        const waiver = waiverRows[0];
        if (!waiver) throw notFound('WAIVER_NOT_FOUND', '回滚豁免不存在或不属于本章');
        if (waiver.gate_key !== 'rollback') {
          throw conflict('WAIVER_GATE_MISMATCH', '该豁免不是回滚豁免');
        }
        if (waiver.target_version_id !== target.id) {
          throw conflict('WAIVER_TARGET_MISMATCH', '该豁免对应的目标版本不是本次回滚版本');
        }
        if (waiver.status !== 'approved') {
          throw conflict('WAIVER_NOT_APPROVED', `该豁免状态为 ${waiver.status}，不能用于回滚`);
        }
        if (!waiver.approved_by || waiver.approved_by === waiver.requested_by) {
          throw conflict('WAIVER_INVALID', '豁免缺少独立批准人，不能用于回滚');
        }

        const usedRows = await tx<{ id: string }[]>`
          SELECT id FROM canon_versions WHERE waiver_id = ${waiver.id} LIMIT 1
        `;
        if (usedRows[0]) {
          throw conflict('WAIVER_ALREADY_USED', '该豁免已被使用，不能重复回滚');
        }

        waiverId = waiver.id;
        evaluationId = null;
      }

      const nextNoRows = await tx<{ next_no: number }[]>`
        SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
        FROM canon_versions
        WHERE chapter_id = ${chapterId}
      `;
      const versionNo = nextNoRows[0]!.next_no;
      const versionId = randomUUID();

      await tx`
        INSERT INTO canon_versions (
          id, chapter_id, version_no, content, content_hash, word_count,
          parent_version_id, source, actor_id, evaluation_id, waiver_id
        )
        VALUES (
          ${versionId}, ${chapterId}, ${versionNo}, ${target.content},
          ${target.content_hash}, ${target.word_count}, ${chapter.current_version_id},
          'rollback', ${auth.user.id}, ${evaluationId}, ${waiverId}
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
        VALUES (${chapterId}, ${target.word_count}, now())
        ON CONFLICT (chapter_id) DO UPDATE
          SET word_count = EXCLUDED.word_count, updated_at = now()
      `;
      await tx`
        INSERT INTO index_status (chapter_id, version_id, status, detail, updated_at)
        VALUES (
          ${chapterId}, ${versionId}, 'pending',
          '已入回滚事务，等待索引 worker', now()
        )
        ON CONFLICT (chapter_id) DO UPDATE
          SET version_id = EXCLUDED.version_id, status = 'pending',
              detail = EXCLUDED.detail, chunk_count = 0, provider_name = NULL,
              model = NULL, dimensions = NULL, attempts = 0,
              next_retry_at = NULL, last_error = NULL, updated_at = now()
      `;

      const evidence = waiverId ? 'waived' : 'reused';
      const payload = {
        versionId,
        versionNo,
        targetVersionId: target.id,
        targetVersionNo: target.version_no,
        previousVersionId: chapter.current_version_id,
        evidence,
        evaluationId,
        waiverId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      };
      await tx`
        INSERT INTO events (
          workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
        )
        VALUES (
          ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.rolled_back',
          ${tx.json(jsonValue(payload))}, ${auth.user.id}
        )
      `;
      await tx`
        INSERT INTO audit_log (
          workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
        )
        VALUES (
          ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.rollback',
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

      return {
        version_id: versionId,
        version_no: versionNo,
        parent_version_id: chapter.current_version_id,
        evaluation_id: evaluationId,
        waiver_id: waiverId,
        target_version_id: target.id,
      } satisfies CommittedRollbackRow;
    });

    return committedResponse(chapterId, result, false);
  } catch (error) {
    if (isUniqueViolation(error)) {
      await sql`
        UPDATE commit_intents
        SET status = 'failed', error_code = 'WAIVER_ALREADY_USED',
            error_message = '该豁免已被使用，不能重复回滚', updated_at = now()
        WHERE id = ${intentId} AND status <> 'committed'
      `;
      throw conflict('WAIVER_ALREADY_USED', '该豁免已被使用，不能重复回滚');
    }
    const appError =
      error instanceof AppError
        ? error
        : new AppError(500, 'ROLLBACK_FAILED', error instanceof Error ? error.message : String(error));
    await sql`
      UPDATE commit_intents
      SET status = 'failed', error_code = ${appError.code}, error_message = ${appError.message},
          updated_at = now()
      WHERE id = ${intentId} AND status <> 'committed'
    `;
    throw error;
  }
}
