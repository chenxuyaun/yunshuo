import { randomUUID } from 'node:crypto';
import { sql, jsonValue } from '@yunshuo/db';
import type {
  ChapterLedgerLinkView,
  ChapterLedgerLinksResponse,
  CreateChapterLedgerLinkInput,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { assertCanReadManuscript, assertCanWrite } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import type { Executor } from './chapter-data.js';
import { iso } from '../views.js';

const LINK_NOTE =
  '人工关联仅用于标注本章涉及的设定、角色或伏笔，不参与门禁判定，也不会生成评估结论。';

interface ChapterScopeRow {
  id: string;
  work_id: string;
}

interface LinkRow {
  id: string;
  chapter_id: string;
  entry_id: string;
  kind: ChapterLedgerLinkView['kind'];
  name: string;
  status: ChapterLedgerLinkView['status'];
  scope: ChapterLedgerLinkView['scope'];
  work_id: string | null;
  version_id: string | null;
  version_no: number | null;
  note: string;
  created_by_name: string | null;
  created_at: Date | string;
}

function mapLink(row: LinkRow): ChapterLedgerLinkView {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    entryId: row.entry_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    scope: row.scope,
    workId: row.work_id,
    versionId: row.version_id,
    versionNo: row.version_no,
    note: row.note,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at),
  };
}

async function loadChapterScope(
  exec: Executor,
  workspaceId: string,
  chapterId: string,
): Promise<ChapterScopeRow | null> {
  const rows = await exec<ChapterScopeRow[]>`
    SELECT c.id, c.work_id
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${workspaceId}
  `;
  return rows[0] ?? null;
}

async function listLinks(
  exec: Executor,
  chapterId: string,
): Promise<ChapterLedgerLinksResponse> {
  const rows = await exec<LinkRow[]>`
    SELECT l.id, l.chapter_id, l.entry_id,
           e.kind, e.name, e.status, e.scope, e.work_id,
           e.current_version_id AS version_id, v.version_no,
           l.note, u.name AS created_by_name, l.created_at
    FROM chapter_ledger_links l
    JOIN ledger_entries e ON e.id = l.entry_id
    LEFT JOIN ledger_entry_versions v ON v.id = e.current_version_id
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.chapter_id = ${chapterId}
    ORDER BY l.created_at ASC, l.id ASC
  `;
  return { links: rows.map(mapLink), note: LINK_NOTE };
}

async function writeAudit(
  exec: Executor,
  auth: AuthContext,
  action: string,
  chapterId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
      ${action}, 'chapter', ${chapterId}, 'success',
      ${exec.json(jsonValue(metadata))}
    )
  `;
}

export async function listChapterLedgerLinks(
  auth: AuthContext,
  chapterId: string,
): Promise<ChapterLedgerLinksResponse> {
  assertCanReadManuscript(auth.role);
  const chapter = await loadChapterScope(sql, auth.workspace.id, chapterId);
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  return listLinks(sql, chapterId);
}

export async function createChapterLedgerLink(
  auth: AuthContext,
  chapterId: string,
  input: CreateChapterLedgerLinkInput,
): Promise<ChapterLedgerLinksResponse> {
  assertCanWrite(auth.role);
  return sql.begin(async (tx) => {
    const chapter = await loadChapterScope(tx, auth.workspace.id, chapterId);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');

    const entryRows = await tx<{
      id: string;
      work_id: string | null;
      scope: 'workspace' | 'work';
      status: string;
    }[]>`
      SELECT id, work_id, scope, status
      FROM ledger_entries
      WHERE id = ${input.entryId} AND workspace_id = ${auth.workspace.id}
    `;
    const entry = entryRows[0];
    if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (entry.status !== 'active') {
      throw conflict('LEDGER_ENTRY_NOT_ACTIVE', '只能关联已发布的账本条目');
    }
    if (entry.work_id !== null && entry.work_id !== chapter.work_id) {
      throw conflict('LEDGER_ENTRY_WORK_MISMATCH', '该账本条目属于其他作品，不能关联到本章');
    }

    const linkId = randomUUID();
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO chapter_ledger_links (
        id, workspace_id, chapter_id, entry_id, note, created_by
      )
      VALUES (
        ${linkId}, ${auth.workspace.id}, ${chapterId}, ${input.entryId},
        ${input.note}, ${auth.user.id}
      )
      ON CONFLICT (chapter_id, entry_id)
      DO UPDATE SET note = EXCLUDED.note
      RETURNING id
    `;
    await writeAudit(tx, auth, 'chapter.ledger_link.add', chapterId, {
      linkId: inserted[0]?.id ?? linkId,
      entryId: input.entryId,
      note: input.note,
    });
    return listLinks(tx, chapterId);
  });
}

export async function deleteChapterLedgerLink(
  auth: AuthContext,
  chapterId: string,
  linkId: string,
): Promise<ChapterLedgerLinksResponse> {
  assertCanWrite(auth.role);
  return sql.begin(async (tx) => {
    const chapter = await loadChapterScope(tx, auth.workspace.id, chapterId);
    if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
    const deleted = await tx<{ id: string; entry_id: string }[]>`
      DELETE FROM chapter_ledger_links
      WHERE id = ${linkId} AND chapter_id = ${chapterId}
      RETURNING id, entry_id
    `;
    if (!deleted[0]) throw notFound('CHAPTER_LEDGER_LINK_NOT_FOUND', '关联不存在');
    await writeAudit(tx, auth, 'chapter.ledger_link.remove', chapterId, {
      linkId,
      entryId: deleted[0].entry_id,
    });
    return listLinks(tx, chapterId);
  });
}
