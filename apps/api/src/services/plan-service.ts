import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import {
  diffChapterPlan,
  normalizeChapterPlanDocument,
  planDocumentsEqual,
  toGatePlan,
  type ChapterPlanDocument,
} from '@yunshuo/domain';
import type {
  BodyPolicy,
  ChapterPlanStateView,
  PlanRevisionsResponse,
} from '@yunshuo/contracts';
import { assertCanManageStructure, type AuthContext } from '../auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { loadChapter, type ChapterRow } from './chapter-data.js';
import { iso } from '../views.js';

export interface UpdateChapterPlanInput {
  plan: ChapterPlanDocument;
  basePlanRevision: number;
  bodyPolicy?: BodyPolicy;
}

export interface ResolveBodyRevisionInput {
  planRevision: number;
  addressedCanonVersionId: string;
}

interface PlanStateRow {
  plan_revision: number;
  plan_updated_at: Date | string | null;
  body_needs_revision: boolean;
  marked_plan_revision: number | null;
  marked_canon_version_id: string | null;
}

function documentOf(chapter: ChapterRow): ChapterPlanDocument {
  return normalizeChapterPlanDocument({
    ...chapter.plan,
    summary: chapter.plan_summary,
    beats: chapter.plan_beats,
  });
}

function stateOf(chapter: ChapterRow): ChapterPlanStateView {
  return {
    plan: documentOf(chapter),
    planRevision: chapter.plan_revision,
    bodyNeedsRevision: chapter.body_needs_revision,
    markedPlanRevision: chapter.marked_plan_revision,
    markedCanonVersionId: chapter.marked_canon_version_id,
    planUpdatedAt: chapter.plan_updated_at ? iso(chapter.plan_updated_at) : null,
  };
}

function changedFieldNames(previous: ChapterPlanDocument, next: ChapterPlanDocument): string[] {
  const diff = diffChapterPlan(previous, next);
  return [
    diff.summaryChanged ? 'summary' : null,
    diff.beatsChanged ? 'beats' : null,
    diff.requiredEntities.added.length + diff.requiredEntities.removed.length > 0
      ? 'requiredEntities'
      : null,
    diff.goalKeywords.added.length + diff.goalKeywords.removed.length > 0 ? 'goalKeywords' : null,
    diff.obstacleKeywords.added.length + diff.obstacleKeywords.removed.length > 0
      ? 'obstacleKeywords'
      : null,
  ].filter((field): field is string => field !== null);
}

// 计划编辑不占租约：租约保护的是草稿并发，计划靠 plan_revision 做乐观锁。
export async function updateChapterPlan(
  auth: AuthContext,
  chapterId: string,
  input: UpdateChapterPlanInput,
): Promise<ChapterPlanStateView> {
  assertCanManageStructure(auth);
  const document = normalizeChapterPlanDocument(input.plan);

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (chapter.status === 'archived') throw conflict('CHAPTER_ARCHIVED', '已归档章节不能编辑计划');

    if (input.basePlanRevision !== chapter.plan_revision) {
      throw conflict('PLAN_REVISION_CONFLICT', '计划已被修改，请载入最新版本再保存', {
        planRevision: chapter.plan_revision,
        plan: documentOf(chapter),
      });
    }

    const previous = documentOf(chapter);
    if (planDocumentsEqual(previous, document)) return stateOf(chapter);

    const hasCanon = chapter.current_version_id !== null;
    if (hasCanon && input.bodyPolicy === undefined) {
      throw unprocessable(
        'BODY_POLICY_REQUIRED',
        '本章已有正典；请选择“仅修改计划”或“标记正文待改”',
      );
    }
    if (!hasCanon && input.bodyPolicy === 'mark_body_for_revision') {
      throw badRequest('BODY_POLICY_NOT_APPLICABLE', '本章还没有正典正文，无法标记正文待改');
    }

    const bodyPolicy: BodyPolicy | null = hasCanon ? (input.bodyPolicy ?? null) : null;
    const revision = chapter.plan_revision + 1;
    const markBody = bodyPolicy === 'mark_body_for_revision';

    await tx`
      INSERT INTO chapter_plan_revisions (
        id, chapter_id, revision, plan, body_policy, canon_version_id, created_by
      )
      VALUES (
        ${randomUUID()}, ${chapterId}, ${revision}, ${tx.json(jsonValue(document))}, ${bodyPolicy},
        ${bodyPolicy ? chapter.current_version_id : null}, ${auth.user.id}
      )
    `;

    // plan_only 不清既有标记；mark_body_for_revision 以本次为准。
    const bodyNeedsRevision = markBody ? true : chapter.body_needs_revision;
    const markedPlanRevision = markBody ? revision : chapter.marked_plan_revision;
    const markedCanonVersionId = markBody
      ? chapter.current_version_id
      : chapter.marked_canon_version_id;

    const rows = await tx<PlanStateRow[]>`
      UPDATE chapters
      SET
        plan = ${tx.json(jsonValue(toGatePlan(document)))},
        plan_summary = ${document.summary},
        plan_beats = ${tx.json(jsonValue(document.beats))},
        plan_revision = ${revision},
        plan_updated_at = now(),
        updated_at = now(),
        body_needs_revision = ${bodyNeedsRevision},
        marked_plan_revision = ${markedPlanRevision},
        marked_canon_version_id = ${markedCanonVersionId}
      WHERE id = ${chapterId}
      RETURNING
        plan_revision, plan_updated_at,
        body_needs_revision, marked_plan_revision, marked_canon_version_id
    `;
    const updated = rows[0]!;

    const payload = {
      fromRevision: chapter.plan_revision,
      revision,
      bodyPolicy,
      changedFields: changedFieldNames(previous, document),
    };
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.plan_updated',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.plan.update',
        'chapter', ${chapterId}, 'success', ${tx.json(jsonValue(payload))}
      )
    `;

    return {
      plan: document,
      planRevision: updated.plan_revision,
      bodyNeedsRevision: updated.body_needs_revision,
      markedPlanRevision: updated.marked_plan_revision,
      markedCanonVersionId: updated.marked_canon_version_id,
      planUpdatedAt: updated.plan_updated_at ? iso(updated.plan_updated_at) : null,
    };
  });
}

export async function resolveBodyRevision(
  auth: AuthContext,
  chapterId: string,
  input: ResolveBodyRevisionInput,
): Promise<ChapterPlanStateView> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    const chapter = await loadChapter(tx, auth.workspace.id, chapterId, true);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (chapter.status !== 'canon') {
      throw conflict('CHAPTER_NOT_CANON', `章节当前状态 ${chapter.status}，不能确认已处理改稿`);
    }
    if (!chapter.body_needs_revision) {
      throw conflict('PLAN_MARKER_NOT_SET', '当前没有待改稿标记');
    }
    if (
      input.planRevision !== chapter.marked_plan_revision ||
      input.addressedCanonVersionId !== chapter.current_version_id
    ) {
      throw conflict('PLAN_MARKER_CHANGED', '待改稿标记已变化，请刷新后再确认', {
        markedPlanRevision: chapter.marked_plan_revision,
        currentCanonVersionId: chapter.current_version_id,
      });
    }

    const markedCanonVersionId = chapter.marked_canon_version_id;
    const currentCanonVersionId = chapter.current_version_id;
    const payload = {
      markedPlanRevision: chapter.marked_plan_revision,
      markedCanonVersionId,
      currentCanonVersionId,
      canonUnchanged: markedCanonVersionId === currentCanonVersionId,
    };

    await tx`
      UPDATE chapters
      SET
        body_needs_revision = false,
        marked_plan_revision = NULL,
        marked_canon_version_id = NULL
      WHERE id = ${chapterId}
    `;
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.body_revision_resolved',
        ${tx.json(jsonValue(payload))}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
        'chapter.body_revision.resolve', 'chapter', ${chapterId}, 'success',
        ${tx.json(jsonValue(payload))}
      )
    `;

    return {
      plan: documentOf(chapter),
      planRevision: chapter.plan_revision,
      bodyNeedsRevision: false,
      markedPlanRevision: null,
      markedCanonVersionId: null,
      planUpdatedAt: chapter.plan_updated_at ? iso(chapter.plan_updated_at) : null,
    };
  });
}

interface PlanRevisionRow {
  revision: number;
  plan: unknown;
  body_policy: BodyPolicy | null;
  canon_version_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date | string;
}

export async function listPlanRevisions(
  auth: AuthContext,
  chapterId: string,
  options: { before?: number; limit?: number } = {},
): Promise<PlanRevisionsResponse> {
  const limit = options.limit ?? 20;
  const chapter = await loadChapter(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');

  const rows = await sql<PlanRevisionRow[]>`
    SELECT
      r.revision, r.plan, r.body_policy, r.canon_version_id,
      r.created_by, u.name AS created_by_name, r.created_at
    FROM chapter_plan_revisions r
    LEFT JOIN users u ON u.id = r.created_by
    WHERE r.chapter_id = ${chapterId}
      AND (${options.before ?? null}::int IS NULL OR r.revision < ${options.before ?? null})
    ORDER BY r.revision DESC
    LIMIT ${limit + 1}
  `;

  return {
    revisions: rows.slice(0, limit).map((row) => ({
      revision: row.revision,
      plan: normalizeChapterPlanDocument(row.plan),
      bodyPolicy: row.body_policy,
      canonVersionId: row.canon_version_id,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      createdAt: iso(row.created_at),
    })),
    hasMore: rows.length > limit,
  };
}
