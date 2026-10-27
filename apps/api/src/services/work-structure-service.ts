import { randomUUID } from 'node:crypto';
import { sql } from '@yunshuo/db';
import { reorderIds, type ChapterStatus } from '@yunshuo/domain';
import type {
  ChapterListItem,
  VolumeView,
  WorkView,
  WorksResponse,
} from '@yunshuo/contracts';
import { assertCanManageStructure, type AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { iso } from '../views.js';
import type { Executor } from './chapter-data.js';

interface WorkRow {
  id: string;
  title: string;
  created_at: Date | string;
  chapter_count: number;
  canon_count: number;
}

interface VolumeRow {
  id: string;
  work_id: string;
  number: number;
  title: string;
}

interface ChapterNumberRow {
  id: string;
  number: number;
  volume_id: string;
}

interface ChapterListRow {
  id: string;
  work_id: string;
  work_title: string;
  number: number;
  title: string;
  status: ChapterStatus;
  volume_id: string;
  volume_title: string;
  plan_revision: number;
  body_needs_revision: boolean;
  word_count: number | null;
  current_version_no: number | null;
  updated_at: Date | string;
}

export interface CreateChapterInput {
  volumeId: string;
  title: string;
  insertAfterChapterId?: string;
}

export interface UpdateChapterMetaInput {
  title?: string;
  volumeId?: string;
  insertAfterChapterId?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

// 同一作品的结构写操作串行化：章号 max+1 与两段式重排都不能被并发插入截断。
async function lockWorkStructure(exec: Executor, workId: string): Promise<void> {
  await exec`SELECT pg_advisory_xact_lock(hashtext(${`work-structure:${workId}`}))`;
}

async function loadWork(exec: Executor, workspaceId: string, workId: string): Promise<WorkRow | null> {
  const rows = await exec<WorkRow[]>`
    SELECT
      w.id, w.title, w.created_at,
      (SELECT count(*)::int FROM chapters c WHERE c.work_id = w.id) AS chapter_count,
      (SELECT count(*)::int
         FROM chapters c JOIN canon_current cc ON cc.chapter_id = c.id
        WHERE c.work_id = w.id) AS canon_count
    FROM works w
    WHERE w.id = ${workId} AND w.workspace_id = ${workspaceId}
  `;
  return rows[0] ?? null;
}

async function volumesOf(exec: Executor, workId: string): Promise<VolumeView[]> {
  const rows = await exec<VolumeRow[]>`
    SELECT id, work_id, number, title
    FROM volumes
    WHERE work_id = ${workId}
    ORDER BY number ASC, id ASC
  `;
  return rows.map((row) => ({ id: row.id, number: row.number, title: row.title }));
}

function workView(row: WorkRow, volumes: VolumeView[]): WorkView {
  return {
    id: row.id,
    title: row.title,
    createdAt: iso(row.created_at),
    volumes,
    chapterCount: row.chapter_count,
    canonCount: row.canon_count,
  };
}

export async function listWorks(auth: AuthContext): Promise<WorksResponse> {
  const rows = await sql<WorkRow[]>`
    SELECT
      w.id, w.title, w.created_at,
      (SELECT count(*)::int FROM chapters c WHERE c.work_id = w.id) AS chapter_count,
      (SELECT count(*)::int
         FROM chapters c JOIN canon_current cc ON cc.chapter_id = c.id
        WHERE c.work_id = w.id) AS canon_count
    FROM works w
    WHERE w.workspace_id = ${auth.workspace.id}
    ORDER BY w.created_at ASC, w.id ASC
  `;
  const volumeRows = await sql<VolumeRow[]>`
    SELECT v.id, v.work_id, v.number, v.title
    FROM volumes v
    JOIN works w ON w.id = v.work_id
    WHERE w.workspace_id = ${auth.workspace.id}
    ORDER BY v.number ASC, v.id ASC
  `;
  const volumesByWork = new Map<string, VolumeView[]>();
  for (const row of volumeRows) {
    const list = volumesByWork.get(row.work_id) ?? [];
    list.push({ id: row.id, number: row.number, title: row.title });
    volumesByWork.set(row.work_id, list);
  }
  return { works: rows.map((row) => workView(row, volumesByWork.get(row.id) ?? [])) };
}

export async function createWork(auth: AuthContext, input: { title: string }): Promise<WorkView> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    const workId = randomUUID();
    const rows = await tx<{ created_at: Date | string }[]>`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${workId}, ${auth.workspace.id}, ${input.title})
      RETURNING created_at
    `;
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'work', ${workId}, 'work.created',
        ${tx.json({ title: input.title })}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'work.create',
        'work', ${workId}, 'success', ${tx.json({ title: input.title })}
      )
    `;
    return {
      id: workId,
      title: input.title,
      createdAt: iso(rows[0]!.created_at),
      volumes: [],
      chapterCount: 0,
      canonCount: 0,
    };
  });
}

export async function renameWork(
  auth: AuthContext,
  workId: string,
  input: { title: string },
): Promise<WorkView> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    const current = await loadWork(tx, auth.workspace.id, workId);
    if (!current) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');
    const volumes = await volumesOf(tx, workId);
    if (current.title === input.title) return workView(current, volumes);

    const rows = await tx<WorkRow[]>`
      UPDATE works
      SET title = ${input.title}
      WHERE id = ${workId}
      RETURNING
        id, title, created_at,
        (SELECT count(*)::int FROM chapters c WHERE c.work_id = works.id) AS chapter_count,
        (SELECT count(*)::int
           FROM chapters c JOIN canon_current cc ON cc.chapter_id = c.id
          WHERE c.work_id = works.id) AS canon_count
    `;
    return workView(rows[0]!, volumes);
  });
}

export async function createVolume(
  auth: AuthContext,
  workId: string,
  input: { title: string; number?: number },
): Promise<VolumeView> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    await lockWorkStructure(tx, workId);
    const work = await loadWork(tx, auth.workspace.id, workId);
    if (!work) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');

    let number = input.number;
    if (number === undefined) {
      const rows = await tx<{ next: number }[]>`
        SELECT COALESCE(max(number), 0) + 1 AS next FROM volumes WHERE work_id = ${workId}
      `;
      number = rows[0]!.next;
    }

    try {
      await tx`
        INSERT INTO volumes (id, work_id, number, title)
        VALUES (${randomUUID()}, ${workId}, ${number}, ${input.title})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('VOLUME_NUMBER_TAKEN', `卷号 ${number} 已被占用，请换一个卷号或留空自动编号`, {
          number,
        });
      }
      throw error;
    }

    const rows = await tx<VolumeRow[]>`
      SELECT id, work_id, number, title FROM volumes
      WHERE work_id = ${workId} AND number = ${number}
    `;
    const row = rows[0]!;
    return { id: row.id, number: row.number, title: row.title };
  });
}

export async function renameVolume(
  auth: AuthContext,
  volumeId: string,
  input: { title: string },
): Promise<VolumeView> {
  assertCanManageStructure(auth);

  const rows = await sql<VolumeRow[]>`
    UPDATE volumes v
    SET title = ${input.title}
    FROM works w
    WHERE v.work_id = w.id AND v.id = ${volumeId} AND w.workspace_id = ${auth.workspace.id}
    RETURNING v.id, v.work_id, v.number, v.title
  `;
  const row = rows[0];
  if (!row) throw notFound('VOLUME_NOT_FOUND', '卷不存在或不属于当前工作区');
  return { id: row.id, number: row.number, title: row.title };
}

async function renumberVolumes(
  db: Executor,
  workId: string,
  orderedIds: string[],
): Promise<void> {
  const negatives = orderedIds.map((id, index) => [id, -(index + 1)]);
  await db`
    UPDATE volumes AS v
    SET number = data.n::int
    FROM (VALUES ${db(negatives)}) AS data(id, n)
    WHERE v.id = data.id::uuid AND v.work_id = ${workId}
  `;
  await db`
    UPDATE volumes SET number = -number
    WHERE work_id = ${workId} AND number < 0
  `;
}

export async function reorderVolumes(
  auth: AuthContext,
  workId: string,
  input: { volumeIds: string[] },
): Promise<VolumeView[]> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    await lockWorkStructure(tx, workId);
    const work = await loadWork(tx, auth.workspace.id, workId);
    if (!work) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');

    const rows = await tx<{ id: string }[]>`
      SELECT id FROM volumes WHERE work_id = ${workId} ORDER BY number ASC
    `;
    const existing = rows.map((row) => row.id);
    const given = input.volumeIds;
    const givenSet = new Set(given);
    const isPermutation =
      givenSet.size === given.length &&
      given.length === existing.length &&
      existing.every((id) => givenSet.has(id));
    if (!isPermutation) {
      throw badRequest('VOLUME_ORDER_INVALID', '排序数组必须恰好包含该作品的全部卷，且不能重复');
    }

    await renumberVolumes(tx, workId, given);
    const updated = await tx<VolumeRow[]>`
      SELECT id, work_id, number, title
      FROM volumes
      WHERE work_id = ${workId}
      ORDER BY number ASC, id ASC
    `;
    return updated.map((row) => ({ id: row.id, number: row.number, title: row.title }));
  });
}

async function renumberChapters(
  db: Executor,
  workId: string,
  orderedIds: string[],
): Promise<void> {
  const negatives = orderedIds.map((id, index) => [id, -(index + 1)]);
  await db`
    UPDATE chapters AS c
    SET number = data.n::int
    FROM (VALUES ${db(negatives)}) AS data(id, n)
    WHERE c.id = data.id::uuid AND c.work_id = ${workId}
  `;
  await db`
    UPDATE chapters SET number = -number
    WHERE work_id = ${workId} AND number < 0
  `;
}

async function loadChapterListItem(
  exec: Executor,
  workspaceId: string,
  chapterId: string,
): Promise<ChapterListItem> {
  const rows = await exec<ChapterListRow[]>`
    SELECT
      c.id, c.work_id, w.title AS work_title,
      c.number, c.title, c.status, c.volume_id, v.title AS volume_title,
      c.plan_revision, c.body_needs_revision,
      cm.word_count, cv.version_no AS current_version_no, c.updated_at
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    JOIN volumes v ON v.id = c.volume_id
    LEFT JOIN chapter_metadata cm ON cm.chapter_id = c.id
    LEFT JOIN canon_current cc ON cc.chapter_id = c.id
    LEFT JOIN canon_versions cv ON cv.id = cc.version_id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${workspaceId}
  `;
  const row = rows[0]!;
  return {
    id: row.id,
    workId: row.work_id,
    workTitle: row.work_title,
    number: row.number,
    title: row.title,
    status: row.status,
    volumeId: row.volume_id,
    volumeTitle: row.volume_title,
    planRevision: row.plan_revision,
    bodyNeedsRevision: row.body_needs_revision,
    wordCount: row.word_count,
    currentVersionNo: row.current_version_no,
    updatedAt: iso(row.updated_at),
  };
}

export async function createChapter(
  auth: AuthContext,
  workId: string,
  input: CreateChapterInput,
): Promise<ChapterListItem> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    await lockWorkStructure(tx, workId);
    const work = await loadWork(tx, auth.workspace.id, workId);
    if (!work) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');

    const volumeRows = await tx<{ id: string }[]>`
      SELECT id FROM volumes WHERE id = ${input.volumeId} AND work_id = ${workId}
    `;
    if (!volumeRows[0]) throw notFound('VOLUME_NOT_FOUND', '卷不存在或不属于该作品');

    const chapterRows = await tx<ChapterNumberRow[]>`
      SELECT id, number, volume_id FROM chapters WHERE work_id = ${workId} ORDER BY number ASC
    `;
    const chapterId = randomUUID();
    let ordered: string[] | null = null;

    if (input.insertAfterChapterId) {
      const target = chapterRows.find((row) => row.id === input.insertAfterChapterId);
      if (!target) {
        throw notFound('CHAPTER_NOT_FOUND', '插入位置目标章节不存在或不属于该作品');
      }
      if (target.volume_id !== input.volumeId) {
        throw badRequest(
          'POSITION_TARGET_INVALID',
          '插入位置目标章节与指定卷不一致；请先确认新章节应属于哪一卷',
        );
      }
      ordered = reorderIds(
        [...chapterRows.map((row) => row.id), chapterId],
        chapterId,
        input.insertAfterChapterId,
      );
      if (!ordered) throw badRequest('POSITION_TARGET_INVALID', '插入位置不合法');
    }

    const number = ordered
      ? 0
      : chapterRows.length > 0
        ? chapterRows[chapterRows.length - 1]!.number + 1
        : 1;

    await tx`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan, plan_revision)
      VALUES (
        ${chapterId}, ${workId}, ${input.volumeId}, ${number}, ${input.title},
        'planned', ${tx.json({})}, 0
      )
    `;
    if (ordered) await renumberChapters(tx, workId, ordered);

    const payload = {
      workId,
      volumeId: input.volumeId,
      number: ordered ? ordered.indexOf(chapterId) + 1 : number,
      insertAfterChapterId: input.insertAfterChapterId ?? null,
    };
    await tx`
      INSERT INTO events (workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
      VALUES (
        ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.created',
        ${tx.json(payload)}, ${auth.user.id}
      )
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.create',
        'chapter', ${chapterId}, 'success', ${tx.json(payload)}
      )
    `;

    return loadChapterListItem(tx, auth.workspace.id, chapterId);
  });
}

export async function updateChapterMeta(
  auth: AuthContext,
  chapterId: string,
  input: UpdateChapterMetaInput,
): Promise<ChapterListItem> {
  assertCanManageStructure(auth);

  return sql.begin(async (tx) => {
    const baseRows = await tx<{
      id: string;
      work_id: string;
      volume_id: string;
      number: number;
      title: string;
      status: ChapterStatus;
    }[]>`
      SELECT c.id, c.work_id, c.volume_id, c.number, c.title, c.status
      FROM chapters c
      JOIN works w ON w.id = c.work_id
      WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
      FOR UPDATE OF c
    `;
    const base = baseRows[0];
    if (!base) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    if (base.status === 'archived') throw conflict('CHAPTER_ARCHIVED', '已归档章节不能调整结构');

    await lockWorkStructure(tx, base.work_id);
    const chapterRows = await tx<ChapterNumberRow[]>`
      SELECT id, number, volume_id FROM chapters WHERE work_id = ${base.work_id} ORDER BY number ASC
    `;

    let volumeId = base.volume_id;
    if (input.volumeId !== undefined && input.volumeId !== volumeId) {
      const volumeRows = await tx<{ id: string }[]>`
        SELECT id FROM volumes WHERE id = ${input.volumeId} AND work_id = ${base.work_id}
      `;
      if (!volumeRows[0]) throw notFound('VOLUME_NOT_FOUND', '卷不存在或不属于该作品');
      volumeId = input.volumeId;
    }

    let ordered: string[] | null = null;
    if (input.insertAfterChapterId !== undefined) {
      const afterId = input.insertAfterChapterId;
      if (afterId !== null) {
        if (afterId === chapterId) {
          throw badRequest('POSITION_TARGET_INVALID', '不能把章节插到它自己后面');
        }
        const target = chapterRows.find((row) => row.id === afterId);
        if (!target) {
          throw notFound('CHAPTER_NOT_FOUND', '插入位置目标章节不存在或不属于该作品');
        }
        if (input.volumeId !== undefined && target.volume_id !== input.volumeId) {
          throw badRequest(
            'POSITION_TARGET_INVALID',
            '插入位置目标章节不在指定卷内，不能静默改卷',
          );
        }
      }
      ordered = reorderIds(
        chapterRows.map((row) => row.id),
        chapterId,
        afterId,
      );
      if (!ordered) throw badRequest('POSITION_TARGET_INVALID', '插入位置不合法');
    }

    const title = input.title ?? base.title;
    const changed = title !== base.title || volumeId !== base.volume_id || ordered !== null;
    if (!changed) return loadChapterListItem(tx, auth.workspace.id, chapterId);

    await tx`
      UPDATE chapters
      SET title = ${title}, volume_id = ${volumeId}, updated_at = now()
      WHERE id = ${chapterId}
    `;
    if (ordered) await renumberChapters(tx, base.work_id, ordered);

    return loadChapterListItem(tx, auth.workspace.id, chapterId);
  });
}
