import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import {
  countWords,
  isBlank,
  sha256,
  type ChapterStatus,
} from '@yunshuo/domain';
import { evaluateGates, runAudits } from '@yunshuo/gates';
import type {
  AbandonRevisionResponse,
  AuditReport,
  ChapterDetail,
  ChapterListItem,
  DraftView,
  GateEvaluationView,
  GateHintView,
  LeaseResponse,
  SaveDraftResponse,
  StageResponse,
  StartRevisionResponse,
  VersionDetail,
  VersionSummary,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { actorKindOf, assertCanWrite, canWrite } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import {
  assertLeaseHeld,
  contextHashOf,
  loadChapter,
  loadEvaluation,
  loadLatestDraft,
  loadLease,
  loadRuleset,
  isLeaseActive,
  upsertLease,
} from './chapter-data.js';
import { loadGateHints } from './ledger-context-service.js';
import {
  iso,
  mapEvaluation,
  mapIndex,
  mapLease,
  mapRuleset,
  mapStaged,
  mapVersionDetail,
  mapVersionSummary,
  mapWaiver,
  type EvaluationRow,
  type IndexRow,
  type StagedRow,
  type VersionRow,
  type WaiverRow,
} from '../views.js';

interface ChapterListRow {
  id: string;
  work_id: string;
  work_title: string;
  number: number;
  title: string;
  status: ChapterStatus;
  volume_title: string;
  word_count: number | null;
  current_version_no: number | null;
  updated_at: Date | string;
}

export async function listChapters(auth: AuthContext): Promise<ChapterListItem[]> {
  const rows = await sql<ChapterListRow[]>`
    SELECT
      c.id, c.work_id, w.title AS work_title,
      c.number, c.title, c.status, v.title AS volume_title,
      cm.word_count, cv.version_no AS current_version_no, c.updated_at
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    JOIN volumes v ON v.id = c.volume_id
    LEFT JOIN chapter_metadata cm ON cm.chapter_id = c.id
    LEFT JOIN canon_current cc ON cc.chapter_id = c.id
    LEFT JOIN canon_versions cv ON cv.id = cc.version_id
    WHERE w.workspace_id = ${auth.workspace.id}
    ORDER BY c.number ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    workId: row.work_id,
    workTitle: row.work_title,
    number: row.number,
    title: row.title,
    status: row.status,
    volumeTitle: row.volume_title,
    wordCount: row.word_count,
    currentVersionNo: row.current_version_no,
    updatedAt: iso(row.updated_at),
  }));
}

interface ChapterBaseRow {
  id: string;
  work_id: string;
  volume_id: string;
  number: number;
  title: string;
  status: ChapterStatus;
  plan: ChapterDetail['plan'];
  updated_at: Date | string;
  word_count: number | null;
  current_version_id: string | null;
}

interface DraftRowView {
  id: string;
  branch_id: string;
  content: string;
  content_hash: string;
  word_count: number;
  created_at: Date | string;
}

function mapDraft(row: DraftRowView): DraftView {
  return {
    id: row.id,
    branchId: row.branch_id,
    content: row.content,
    contentHash: row.content_hash,
    wordCount: row.word_count,
    updatedAt: iso(row.created_at),
  };
}

export async function getChapter(auth: AuthContext, chapterId: string): Promise<ChapterDetail> {
  const baseRows = await sql<ChapterBaseRow[]>`
    SELECT
      c.id, c.work_id, c.volume_id, c.number, c.title, c.status, c.plan,
      c.updated_at, cm.word_count, c.current_version_id
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    LEFT JOIN chapter_metadata cm ON cm.chapter_id = c.id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
  `;
  const base = baseRows[0];
  if (!base) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');

  const [
    versionRows,
    draftRows,
    leaseRows,
    evaluationRows,
    stagedRows,
    waiverRows,
    indexRows,
    ruleset,
  ] = await Promise.all([
      sql<VersionRow[]>`
        SELECT
          v.id, v.chapter_id, v.version_no, v.source, v.word_count, v.content_hash, v.content,
          v.parent_version_id, u.name AS actor_name, v.evaluation_id,
          ge.status AS evaluation_status, v.waiver_id, v.created_at
        FROM canon_versions v
        LEFT JOIN users u ON u.id = v.actor_id
        LEFT JOIN gate_evaluations ge ON ge.id = v.evaluation_id
        WHERE v.chapter_id = ${chapterId}
        ORDER BY v.version_no DESC
      `,
      sql<DraftRowView[]>`
        SELECT dr.id, dr.branch_id, dr.content, dr.content_hash, dr.word_count, dr.created_at
        FROM draft_revisions dr
        JOIN draft_branches db ON db.id = dr.branch_id
        WHERE db.chapter_id = ${chapterId} AND db.owner_id = ${auth.user.id} AND db.name = 'main'
        ORDER BY dr.created_at DESC, dr.id DESC
        LIMIT 1
      `,
      sql<{ user_id: string; user_name: string; expires_at: Date | string }[]>`
        SELECT cl.user_id, u.name AS user_name, cl.expires_at
        FROM chapter_leases cl
        JOIN users u ON u.id = cl.user_id
        WHERE cl.chapter_id = ${chapterId} AND cl.expires_at > now()
      `,
      sql<EvaluationRow[]>`
        SELECT
          e.id, e.chapter_id, e.content_hash, e.context_hash, e.status, e.results, e.hints,
          e.created_at,
          r.id AS ruleset_id, r.key AS ruleset_key, r.version AS ruleset_version,
          r.description AS ruleset_description, r.is_production AS ruleset_is_production
        FROM gate_evaluations e
        JOIN gate_rulesets r ON r.id = e.ruleset_id
        WHERE e.chapter_id = ${chapterId}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      `,
      sql<StagedRow[]>`
        SELECT
          s.id, s.chapter_id, s.content_hash, s.word_count, s.evaluation_id,
          s.staged_by, u.name AS staged_by_name, s.staged_at
        FROM staged_drafts s
        JOIN users u ON u.id = s.staged_by
        WHERE s.chapter_id = ${chapterId}
        ORDER BY s.staged_at DESC, s.id DESC
        LIMIT 1
      `,
      sql<WaiverRow[]>`
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
        WHERE wv.chapter_id = ${chapterId}
        ORDER BY wv.created_at DESC, wv.id DESC
        LIMIT 50
      `,
      sql<IndexRow[]>`
        SELECT
          i.status, i.detail, i.version_id, v.version_no, i.chunk_count, i.provider_name,
          i.model, i.dimensions, i.attempts, i.next_retry_at, i.last_error, i.updated_at
        FROM index_status i
        LEFT JOIN canon_versions v ON v.id = i.version_id
        WHERE i.chapter_id = ${chapterId}
      `,
      loadRuleset(),
    ]);

  const versions = versionRows.map(mapVersionSummary);
  const currentVersion =
    versions.find((version) => version.id === base.current_version_id) ?? null;
  const draft = draftRows[0] ? mapDraft(draftRows[0]) : null;
  const leaseRow = leaseRows[0];
  const lease = leaseRow && isLeaseActive(leaseRow) ? mapLease(leaseRow) : null;
  const latestEvaluation = evaluationRows[0] ? mapEvaluation(evaluationRows[0]) : null;
  const stagedRow = stagedRows[0];
  const stagedDraft =
    stagedRow && (base.status === 'staged' || base.status === 'commit_failed')
      ? mapStaged(stagedRow)
      : null;
  const waivers = waiverRows.map(mapWaiver);
  const indexStatus = indexRows[0] ? mapIndex(indexRows[0]) : null;

  const editableStatus = base.status === 'planned' || base.status === 'writing' || base.status === 'revision';
  const canEdit =
    canWrite(auth.role) &&
    editableStatus &&
    (!lease || lease.userId === auth.user.id);

  return {
    id: base.id,
    workId: base.work_id,
    volumeId: base.volume_id,
    number: base.number,
    title: base.title,
    status: base.status,
    plan: base.plan,
    wordCount: base.word_count,
    currentVersion,
    draft,
    lease,
    latestEvaluation,
    stagedDraft,
    versions,
    waivers,
    indexStatus,
    ruleset: ruleset ? mapRuleset(ruleset) : null,
    canEdit,
  };
}

export async function acquireLease(auth: AuthContext, chapterId: string): Promise<LeaseResponse> {
  assertCanWrite(auth.role);
  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (chapter.status === 'archived') {
      throw conflict('CHAPTER_ARCHIVED', '已归档章节不能编辑');
    }
    if (chapter.status === 'canon') {
      throw conflict('CHAPTER_READ_ONLY', '正典只读；请从“开始修订”进入修订流程');
    }

    const existing = await loadLease(tx, chapterId, true);
    if (isLeaseActive(existing) && existing!.user_id !== auth.user.id) {
      throw conflict('LEASE_HELD', `章节租约由 ${existing!.user_name} 持有`, {
        holder: existing!.user_name,
        expiresAt: new Date(existing!.expires_at).toISOString(),
      });
    }

    const leaseRow = await upsertLease(tx, chapterId, auth.user.id);
    return {
      lease: {
        userId: auth.user.id,
        userName: auth.user.name,
        expiresAt: iso(leaseRow.expires_at),
      },
    };
  });
}

interface CanonBaseRow {
  id: string;
  version_no: number;
  content: string;
  content_hash: string;
  word_count: number;
}

export async function startRevision(
  auth: AuthContext,
  chapterId: string,
): Promise<StartRevisionResponse> {
  assertCanWrite(auth.role);

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (chapter.status !== 'canon') {
      throw conflict('CHAPTER_NOT_REVISABLE', `章节当前状态 ${chapter.status}，不能开始修订`);
    }
    if (!chapter.current_version_id) {
      throw conflict('CHAPTER_NO_CANON', '章节没有可修订的正典版本');
    }

    const existing = await loadLease(tx, chapterId, true);
    if (isLeaseActive(existing) && existing!.user_id !== auth.user.id) {
      throw conflict('LEASE_HELD', `章节租约由 ${existing!.user_name} 持有`, {
        holder: existing!.user_name,
        expiresAt: new Date(existing!.expires_at).toISOString(),
      });
    }

    const baseRows = await tx<CanonBaseRow[]>`
      SELECT id, version_no, content, content_hash, word_count
      FROM canon_versions
      WHERE id = ${chapter.current_version_id} AND chapter_id = ${chapterId}
    `;
    const base = baseRows[0];
    if (!base) throw conflict('CANON_VERSION_MISSING', '当前正典版本不存在');

    const leaseRow = await upsertLease(tx, chapterId, auth.user.id);

    const branchRows = await tx<{ id: string }[]>`
      SELECT id FROM draft_branches
      WHERE chapter_id = ${chapterId} AND owner_id = ${auth.user.id} AND name = 'main'
    `;
    let branchId = branchRows[0]?.id;
    if (!branchId) {
      branchId = randomUUID();
      await tx`
        INSERT INTO draft_branches (id, chapter_id, owner_id, name)
        VALUES (${branchId}, ${chapterId}, ${auth.user.id}, 'main')
      `;
    }

    const draftId = randomUUID();
    const inserted = await tx<{ created_at: Date | string }[]>`
      INSERT INTO draft_revisions (id, branch_id, content, content_hash, word_count)
      VALUES (
        ${draftId}, ${branchId}, ${base.content}, ${base.content_hash}, ${base.word_count}
      )
      RETURNING created_at
    `;

    await tx`
      UPDATE chapters SET status = 'revision', updated_at = now() WHERE id = ${chapterId}
    `;

    const payload = {
      baseVersionId: base.id,
      baseVersionNo: base.version_no,
      draftRevisionId: draftId,
    };
    await tx`
      INSERT INTO events (
        workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
      )
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.revision_started',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.revision.start',
        'chapter', ${chapterId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;

    return {
      chapterId,
      status: 'revision',
      baseVersionId: base.id,
      baseVersionNo: base.version_no,
      draft: {
        id: draftId,
        branchId,
        content: base.content,
        contentHash: base.content_hash,
        wordCount: base.word_count,
        updatedAt: iso(inserted[0]!.created_at),
      },
      lease: {
        userId: auth.user.id,
        userName: auth.user.name,
        expiresAt: iso(leaseRow.expires_at),
      },
    };
  });
}

export async function abandonRevision(
  auth: AuthContext,
  chapterId: string,
): Promise<AbandonRevisionResponse> {
  assertCanWrite(auth.role);

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (!chapter.current_version_id) {
      throw conflict('CHAPTER_NO_CANON', '章节没有可返回的正典版本');
    }
    if (chapter.status !== 'revision' && chapter.status !== 'writing') {
      throw conflict('CHAPTER_NOT_IN_REVISION', `章节当前状态 ${chapter.status}，不能放弃修订`);
    }
    await assertLeaseHeld(tx, chapterId, auth);

    await tx`
      UPDATE chapters SET status = 'canon', updated_at = now() WHERE id = ${chapterId}
    `;
    await tx`DELETE FROM chapter_leases WHERE chapter_id = ${chapterId}`;

    const payload = {
      currentVersionId: chapter.current_version_id,
      discardedStatus: chapter.status,
    };
    await tx`
      INSERT INTO events (
        workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
      )
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.revision_abandoned',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.revision.abandon',
        'chapter', ${chapterId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;

    return {
      chapterId,
      status: 'canon',
      currentVersionId: chapter.current_version_id,
    };
  });
}

export async function releaseLease(auth: AuthContext, chapterId: string): Promise<void> {
  const chapter = await loadChapter(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  await sql`
    DELETE FROM chapter_leases
    WHERE chapter_id = ${chapterId} AND user_id = ${auth.user.id}
  `;
}

export async function saveDraft(
  auth: AuthContext,
  chapterId: string,
  content: string,
): Promise<SaveDraftResponse> {
  assertCanWrite(auth.role);
  if (isBlank(content)) throw conflict('EMPTY_DRAFT', '空草稿不落盘');

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (!(chapter.status === 'planned' || chapter.status === 'writing' || chapter.status === 'revision')) {
      throw conflict('CHAPTER_NOT_EDITABLE', `章节当前状态 ${chapter.status} 不允许写草稿`);
    }
    await assertLeaseHeld(tx, chapterId, auth);

    const branchRows = await tx<{ id: string }[]>`
      SELECT id FROM draft_branches
      WHERE chapter_id = ${chapterId} AND owner_id = ${auth.user.id} AND name = 'main'
    `;
    let branchId = branchRows[0]?.id;
    if (!branchId) {
      branchId = randomUUID();
      await tx`
        INSERT INTO draft_branches (id, chapter_id, owner_id, name)
        VALUES (${branchId}, ${chapterId}, ${auth.user.id}, 'main')
      `;
    }

    const hash = sha256(content);
    const wordCount = countWords(content);
    const revisionId = randomUUID();
    const inserted = await tx<{ created_at: Date | string }[]>`
      INSERT INTO draft_revisions (id, branch_id, content, content_hash, word_count)
      VALUES (${revisionId}, ${branchId}, ${content}, ${hash}, ${wordCount})
      RETURNING created_at
    `;

    const nextStatus: ChapterStatus = 'writing';
    await tx`
      UPDATE chapters
      SET status = ${nextStatus}, updated_at = now()
      WHERE id = ${chapterId}
    `;

    return {
      draft: {
        id: revisionId,
        branchId,
        content,
        contentHash: hash,
        wordCount,
        updatedAt: iso(inserted[0]!.created_at),
      },
      chapterStatus: nextStatus,
    };
  });
}

export async function evaluateChapterGates(
  auth: AuthContext,
  chapterId: string,
): Promise<GateEvaluationView> {
  const chapter = await loadChapter(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  const draft = await loadLatestDraft(sql, chapterId, auth.user.id);
  if (!draft) throw conflict('NO_DRAFT', '请先保存草稿，再跑门禁');

  const ruleset = await loadRuleset();
  if (!ruleset) throw conflict('RULESET_MISSING', '没有可用的门禁规则集');

  const contextHash = contextHashOf(chapter, ruleset.id);
  const evaluation = evaluateGates({
    content: draft.content,
    wordCount: draft.word_count,
    plan: chapter.plan,
    ruleset: ruleset.rules,
  });
  const id = randomUUID();
  const createdAt = new Date();
  let hints: GateHintView[] = [];
  try {
    hints = await loadGateHints({
      workspaceId: auth.workspace.id,
      workId: chapter.work_id,
      chapterId,
      chapterNumber: chapter.number,
      content: draft.content,
      plan: chapter.plan,
    });
  } catch (error) {
    console.warn(
      `[gate] 章节 ${chapterId} 账本提示计算失败，门禁结论不受影响：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await sql`
    INSERT INTO gate_evaluations (
      id, chapter_id, content_hash, ruleset_id, context_hash, status, results, hints, created_at
    )
    VALUES (
      ${id}, ${chapterId}, ${draft.content_hash}, ${ruleset.id}, ${contextHash},
      ${evaluation.status}, ${sql.json(jsonValue(evaluation.results))},
      ${sql.json(jsonValue(hints))}, ${createdAt}
    )
  `;

  return {
    id,
    chapterId,
    contentHash: draft.content_hash,
    contextHash,
    ruleset: mapRuleset(ruleset),
    status: evaluation.status,
    results: evaluation.results,
    hints,
    createdAt: createdAt.toISOString(),
  };
}

export async function getAudits(auth: AuthContext, chapterId: string): Promise<AuditReport> {
  const chapter = await loadChapter(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  const draft = await loadLatestDraft(sql, chapterId, auth.user.id);
  if (!draft) throw conflict('NO_DRAFT', '请先保存草稿，再跑审计');
  return { audits: runAudits(draft.content), advisoryOnly: true };
}

export async function stageDraft(
  auth: AuthContext,
  chapterId: string,
  evaluationId: string,
  expectedContentHash: string,
): Promise<StageResponse> {
  assertCanWrite(auth.role);

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (
      !(
        chapter.status === 'writing' ||
        chapter.status === 'revision' ||
        chapter.status === 'commit_failed'
      )
    ) {
      throw conflict('CHAPTER_NOT_STAGEABLE', `章节当前状态 ${chapter.status} 不允许暂存`);
    }
    await assertLeaseHeld(tx, chapterId, auth);

    const draft = await loadLatestDraft(tx, chapterId, auth.user.id);
    if (!draft) throw conflict('NO_DRAFT', '请先保存草稿');
    if (draft.content_hash !== expectedContentHash) {
      throw conflict('DRAFT_CHANGED', '保存后草稿已变化，请重新跑门禁');
    }

    const evaluation = await loadEvaluation(tx, evaluationId, chapterId);
    if (!evaluation) {
      throw conflict('EVALUATION_NOT_FOUND', '门禁评估不属于本章');
    }
    if (evaluation.content_hash !== draft.content_hash) {
      throw conflict('EVALUATION_STALE', '门禁评估对应的正文不是当前草稿，请重新跑门禁');
    }
    if (evaluation.status !== 'passed') {
      throw conflict('GATE_NOT_PASSED', `门禁结论为 ${evaluation.status}，不能暂存`);
    }
    if (evaluation.context_hash !== contextHashOf(chapter, evaluation.ruleset_id)) {
      throw conflict('CONTEXT_CHANGED', '设定或规则版本已变化，请重新跑门禁');
    }

    const stagedId = randomUUID();
    const inserted = await tx<{ staged_at: Date | string }[]>`
      INSERT INTO staged_drafts (
        id, chapter_id, branch_id, revision_id, content, content_hash,
        word_count, evaluation_id, staged_by
      )
      VALUES (
        ${stagedId}, ${chapterId}, ${draft.branch_id}, ${draft.id}, ${draft.content},
        ${draft.content_hash}, ${draft.word_count}, ${evaluationId}, ${auth.user.id}
      )
      RETURNING staged_at
    `;

    await tx`
      UPDATE chapters SET status = 'staged', updated_at = now() WHERE id = ${chapterId}
    `;
    const stagePayload = {
      stagedDraftId: stagedId,
      evaluationId,
      contentHash: draft.content_hash,
      ...(auth.automation
        ? { jobId: auth.automation.jobId, mandateId: auth.automation.mandateId }
        : {}),
    };
    await tx`
      INSERT INTO events (
        workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
      )
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.staged',
        ${tx.json(jsonValue(stagePayload))},
        ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, ${actorKindOf(auth)}, ${auth.role}, 'chapter.stage',
        'chapter', ${chapterId}, 'success',
        ${tx.json(jsonValue(stagePayload))}
      )
    `;

    return {
      stagedDraft: {
        id: stagedId,
        chapterId,
        contentHash: draft.content_hash,
        wordCount: draft.word_count,
        evaluationId,
        stagedBy: auth.user.id,
        stagedByName: auth.user.name,
        stagedAt: iso(inserted[0]!.staged_at),
      },
      chapterStatus: 'staged',
    };
  });
}

export async function unstageDraft(auth: AuthContext, chapterId: string): Promise<void> {
  assertCanWrite(auth.role);
  await sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (chapter.status !== 'staged') {
      throw conflict('CHAPTER_NOT_STAGED', '章节当前不在暂存状态');
    }
    await assertLeaseHeld(tx, chapterId, auth);
    await tx`
      UPDATE chapters SET status = 'writing', updated_at = now() WHERE id = ${chapterId}
    `;
    await tx`
      INSERT INTO events (
        workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
      )
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.unstaged', '{}'::jsonb, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.unstage',
        'chapter', ${chapterId}, 'success', '{}'::jsonb
      )
    `;
  });
}

export async function listVersions(
  auth: AuthContext,
  chapterId: string,
): Promise<VersionSummary[]> {
  const chapter = await loadChapter(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  const rows = await sql<VersionRow[]>`
    SELECT
      v.id, v.chapter_id, v.version_no, v.source, v.word_count, v.content_hash, v.content,
      v.parent_version_id, u.name AS actor_name, v.evaluation_id,
      ge.status AS evaluation_status, v.waiver_id, v.created_at
    FROM canon_versions v
    LEFT JOIN users u ON u.id = v.actor_id
    LEFT JOIN gate_evaluations ge ON ge.id = v.evaluation_id
    WHERE v.chapter_id = ${chapterId}
    ORDER BY v.version_no DESC
  `;
  return rows.map(mapVersionSummary);
}

export async function getVersion(auth: AuthContext, versionId: string): Promise<VersionDetail> {
  const rows = await sql<VersionRow[]>`
    SELECT
      v.id, v.chapter_id, v.version_no, v.source, v.word_count, v.content_hash, v.content,
      v.parent_version_id, u.name AS actor_name, v.evaluation_id,
      ge.status AS evaluation_status, v.waiver_id, v.created_at
    FROM canon_versions v
    JOIN chapters c ON c.id = v.chapter_id
    JOIN works w ON w.id = c.work_id
    LEFT JOIN users u ON u.id = v.actor_id
    LEFT JOIN gate_evaluations ge ON ge.id = v.evaluation_id
    WHERE v.id = ${versionId} AND w.workspace_id = ${auth.workspace.id}
  `;
  const row = rows[0];
  if (!row) throw notFound('VERSION_NOT_FOUND', '版本不存在或不属于当前工作区');

  const evaluation = row.evaluation_id
    ? await loadEvaluation(sql, row.evaluation_id, row.chapter_id)
    : null;
  let waiver: WaiverRow | null = null;
  if (row.waiver_id) {
    const waiverRows = await sql<WaiverRow[]>`
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
      WHERE wv.id = ${row.waiver_id}
    `;
    waiver = waiverRows[0] ?? null;
  }

  return mapVersionDetail(row, evaluation, waiver);
}
