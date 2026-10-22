import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import type { WaiverGateKey, WaiverView } from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { assertCanWrite } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { loadChapter, type Executor } from './chapter-data.js';
import { mapWaiver, type WaiverRow } from '../views.js';

export interface WaiverRequestInput {
  targetVersionId: string;
  gateKey: WaiverGateKey;
  reason: string;
}

export type WaiverDecision = 'approved' | 'rejected';

function canDecide(role: AuthContext['role']): boolean {
  return role === 'owner' || role === 'lead';
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

export async function loadWaiverRow(
  exec: Executor,
  waiverId: string,
): Promise<WaiverRow | null> {
  const rows = await exec<WaiverRow[]>`
    SELECT
      wv.id, wv.chapter_id, wv.target_version_id, wv.gate_key, wv.reason, wv.status,
      wv.requested_by, ru.name AS requested_by_name,
      wv.approved_by, au.name AS approved_by_name, wv.approved_at,
      wv.decided_by, du.name AS decided_by_name, wv.decided_at,
      wv.decision_note, wv.created_at
    FROM waivers wv
    JOIN users ru ON ru.id = wv.requested_by
    LEFT JOIN users au ON au.id = wv.approved_by
    LEFT JOIN users du ON du.id = wv.decided_by
    WHERE wv.id = ${waiverId}
  `;
  return rows[0] ?? null;
}

export async function requestWaiver(
  auth: AuthContext,
  chapterId: string,
  input: WaiverRequestInput,
): Promise<WaiverView> {
  assertCanWrite(auth.role);
  if (input.gateKey !== 'rollback') {
    throw badRequest(
      'WAIVER_GATE_UNSUPPORTED',
      'M2 仅支持回滚豁免（rollback）；其余门禁不提供豁免入口',
    );
  }

  const waiverId = randomUUID();
  try {
    const row = await sql.begin(async (tx) => {
      const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
      if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
      if (chapter.status !== 'canon') {
        throw conflict('CHAPTER_NOT_CANON', '只有正典章节可以申请回滚豁免');
      }

      const targetRows = await tx<{ id: string; version_no: number }[]>`
        SELECT id, version_no
        FROM canon_versions
        WHERE id = ${input.targetVersionId} AND chapter_id = ${chapterId}
      `;
      const target = targetRows[0];
      if (!target) throw notFound('VERSION_NOT_FOUND', '目标版本不存在或不属于本章');
      if (target.id === chapter.current_version_id) {
        throw conflict('ROLLBACK_TARGET_CURRENT', '目标版本就是当前正典，无需回滚');
      }

      const openRows = await tx<{ id: string; status: string }[]>`
        SELECT w.id, w.status
        FROM waivers w
        WHERE w.chapter_id = ${chapterId}
          AND w.target_version_id = ${input.targetVersionId}
          AND w.gate_key = 'rollback'
          AND w.status IN ('pending', 'approved')
          AND NOT EXISTS (SELECT 1 FROM canon_versions v WHERE v.waiver_id = w.id)
        LIMIT 1
      `;
      const open = openRows[0];
      if (open) {
        throw conflict(
          'WAIVER_ALREADY_EXISTS',
          open.status === 'pending'
            ? '该版本已有待审批的回滚豁免'
            : '该版本已有已批准且尚未使用的回滚豁免',
          { waiverId: open.id, status: open.status },
        );
      }

      await tx`
        INSERT INTO waivers (
          id, chapter_id, target_version_id, gate_key, reason, status, requested_by
        )
        VALUES (
          ${waiverId}, ${chapterId}, ${input.targetVersionId}, ${input.gateKey},
          ${input.reason}, 'pending', ${auth.user.id}
        )
      `;

      const payload = {
        waiverId,
        chapterId,
        targetVersionId: input.targetVersionId,
        gateKey: input.gateKey,
        reason: input.reason,
      };
      await tx`
        INSERT INTO events (
          workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
        )
        VALUES (
          ${auth.workspace.id}, 'chapter', ${chapterId}, 'waiver.requested',
          ${tx.json(jsonValue(payload))}, ${auth.user.id}
        )
      `;
      await tx`
        INSERT INTO audit_log (
          workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
        )
        VALUES (
          ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'waiver.request',
          'waiver', ${waiverId}, 'success', ${tx.json(jsonValue(payload))}
        )
      `;

      const row = await loadWaiverRow(tx, waiverId);
      if (!row) throw conflict('WAIVER_NOT_FOUND', '豁免申请写入失败');
      return mapWaiver(row);
    });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('WAIVER_PENDING_EXISTS', '该版本已有待审批的回滚豁免');
    }
    throw error;
  }
}

export async function decideWaiver(
  auth: AuthContext,
  chapterId: string,
  waiverId: string,
  decision: WaiverDecision,
  note: string,
): Promise<WaiverView> {
  if (!canDecide(auth.role)) {
    throw forbidden('仅所有者或主笔可以审批豁免');
  }

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');

    const waiverRows = await tx<{
      id: string;
      status: string;
      requested_by: string;
      target_version_id: string | null;
      gate_key: string;
    }[]>`
      SELECT id, status, requested_by, target_version_id, gate_key
      FROM waivers
      WHERE id = ${waiverId} AND chapter_id = ${chapterId}
      FOR UPDATE
    `;
    const waiver = waiverRows[0];
    if (!waiver) throw notFound('WAIVER_NOT_FOUND', '豁免申请不存在或不属于本章');
    if (waiver.status !== 'pending') {
      throw conflict('WAIVER_ALREADY_DECIDED', '该豁免已有结论，不能重复审批');
    }
    if (waiver.requested_by === auth.user.id) {
      throw forbidden('豁免申请人不能审批自己的申请');
    }

    const approved = decision === 'approved';
    await tx`
      UPDATE waivers
      SET status = ${decision},
          approved_by = ${approved ? auth.user.id : null},
          approved_at = ${approved ? new Date() : null},
          decided_by = ${auth.user.id},
          decided_at = now(),
          decision_note = ${note}
      WHERE id = ${waiverId}
    `;

    const payload = {
      waiverId,
      chapterId,
      targetVersionId: waiver.target_version_id,
      gateKey: waiver.gate_key,
      decision,
      note,
      requestedBy: waiver.requested_by,
      decidedBy: auth.user.id,
    };
    await tx`
      INSERT INTO events (
        workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
      )
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, ${`waiver.${decision}`},
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
        ${`waiver.${decision}`}, 'waiver', ${waiverId}, 'success',
        ${tx.json(jsonValue(payload))}
      )
    `;

    const row = await loadWaiverRow(tx, waiverId);
    if (!row) throw conflict('WAIVER_NOT_FOUND', '豁免读取失败');
    return mapWaiver(row);
  });
}
