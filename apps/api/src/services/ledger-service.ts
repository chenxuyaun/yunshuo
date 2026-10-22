import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { jsonValue, sql } from '@yunshuo/db';
import {
  ledgerCharacterPayloadSchema,
  ledgerForeshadowingPayloadSchema,
  ledgerSettingPayloadSchema,
  type ArchiveLedgerEntryInput,
  type CreateLedgerEntryInput,
  type LedgerChapterRef,
  type LedgerCharacterAppearance,
  type LedgerCharacterContext,
  type LedgerCharacterContextItem,
  type LedgerCharacterStateEntry,
  type LedgerCharacterTimeline,
  type LedgerCharacterWarning,
  type LedgerEntryDetail,
  type LedgerEntryKind,
  type LedgerEntryListResponse,
  type LedgerEntryPayload,
  type LedgerEntryScope,
  type LedgerEntrySnapshot,
  type LedgerEntryStatus,
  type LedgerEntrySummary,
  type LedgerEntryVersionListResponse,
  type LedgerEntryVersionView,
  type ListLedgerEntriesQuery,
  type PublishLedgerEntryInput,
  type RollbackLedgerEntryInput,
  type UpdateLedgerDraftInput,
  type UserSummary,
} from '@yunshuo/contracts';
import { assertCanReadLedger, assertCanWriteLedger, type AuthContext } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { iso } from '../views.js';

type Executor = Sql<Record<string, unknown>> | TransactionSql<Record<string, unknown>>;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface EntryRow {
  id: string;
  workspace_id: string;
  work_id: string | null;
  kind: string;
  scope: string;
  name: string;
  aliases: string[];
  summary: string;
  status: string;
  source_chapter_id: string | null;
  current_version_id: string | null;
  draft_version_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  current_version_no: number | null;
  draft_version_no: number | null;
  created_by_name?: string | null;
  created_by_email?: string | null;
  updated_by_name?: string | null;
  updated_by_email?: string | null;
}

interface VersionRow {
  id: string;
  entry_id: string;
  version_no: number;
  snapshot: LedgerEntrySnapshot;
  change_summary: string;
  created_by: string | null;
  created_at: Date | string;
  created_by_name?: string | null;
  created_by_email?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

function actor(
  id: string | null | undefined,
  name: string | null | undefined,
  email: string | null | undefined,
): UserSummary | null {
  return id && name && email ? { id, name, email } : null;
}

function mapSummary(row: EntryRow): LedgerEntrySummary {
  return {
    id: row.id,
    workId: row.work_id,
    kind: row.kind as LedgerEntryKind,
    scope: row.scope as LedgerEntryScope,
    name: row.name,
    aliases: row.aliases,
    summary: row.summary,
    status: row.status as LedgerEntryStatus,
    sourceChapterId: row.source_chapter_id,
    currentVersionNo: row.current_version_no,
    draftVersionNo: row.draft_version_no,
    updatedAt: iso(row.updated_at),
  };
}

function mapVersion(row: VersionRow): LedgerEntryVersionView {
  return {
    id: row.id,
    versionNo: row.version_no,
    snapshot: row.snapshot,
    changeSummary: row.change_summary,
    createdBy: actor(row.created_by, row.created_by_name, row.created_by_email),
    createdAt: iso(row.created_at),
  };
}

const ENTRY_SELECT = sql`
  SELECT
    e.id, e.workspace_id, e.work_id, e.kind, e.scope, e.name, e.aliases, e.summary,
    e.status, e.source_chapter_id, e.current_version_id, e.draft_version_id,
    e.created_by, e.updated_by, e.created_at, e.updated_at,
    cv.version_no AS current_version_no,
    dv.version_no AS draft_version_no,
    cu.name AS created_by_name, cu.email AS created_by_email,
    uu.name AS updated_by_name, uu.email AS updated_by_email
  FROM ledger_entries e
  LEFT JOIN ledger_entry_versions cv
    ON cv.id = e.current_version_id AND cv.workspace_id = e.workspace_id
  LEFT JOIN ledger_entry_versions dv
    ON dv.id = e.draft_version_id AND dv.workspace_id = e.workspace_id
  LEFT JOIN users cu ON cu.id = e.created_by
  LEFT JOIN users uu ON uu.id = e.updated_by
`;

async function loadEntryRow(
  exec: Executor,
  workspaceId: string,
  entryId: string,
): Promise<EntryRow | null> {
  const rows = await exec<EntryRow[]>`
    ${ENTRY_SELECT}
    WHERE e.id = ${entryId} AND e.workspace_id = ${workspaceId}
  `;
  return rows[0] ?? null;
}

async function loadEntryForUpdate(
  exec: Executor,
  workspaceId: string,
  entryId: string,
): Promise<EntryRow | null> {
  const rows = await exec<EntryRow[]>`
    SELECT
      e.id, e.workspace_id, e.work_id, e.kind, e.scope, e.name, e.aliases, e.summary,
      e.status, e.source_chapter_id, e.current_version_id, e.draft_version_id,
      e.created_by, e.updated_by, e.created_at, e.updated_at,
      NULL::integer AS current_version_no,
      NULL::integer AS draft_version_no
    FROM ledger_entries e
    WHERE e.id = ${entryId} AND e.workspace_id = ${workspaceId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function loadVersionById(
  exec: Executor,
  workspaceId: string,
  entryId: string,
  versionId: string,
): Promise<VersionRow | null> {
  const rows = await exec<VersionRow[]>`
    SELECT
      v.id, v.entry_id, v.version_no, v.snapshot, v.change_summary, v.created_by, v.created_at,
      u.name AS created_by_name, u.email AS created_by_email
    FROM ledger_entry_versions v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.id = ${versionId}
      AND v.entry_id = ${entryId}
      AND v.workspace_id = ${workspaceId}
  `;
  return rows[0] ?? null;
}

async function loadVersionByNo(
  exec: Executor,
  workspaceId: string,
  entryId: string,
  versionNo: number,
): Promise<VersionRow | null> {
  const rows = await exec<VersionRow[]>`
    SELECT
      v.id, v.entry_id, v.version_no, v.snapshot, v.change_summary, v.created_by, v.created_at,
      u.name AS created_by_name, u.email AS created_by_email
    FROM ledger_entry_versions v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.version_no = ${versionNo}
      AND v.entry_id = ${entryId}
      AND v.workspace_id = ${workspaceId}
  `;
  return rows[0] ?? null;
}

async function loadDetail(
  exec: Executor,
  workspaceId: string,
  entryId: string,
): Promise<LedgerEntryDetail> {
  const row = await loadEntryRow(exec, workspaceId, entryId);
  if (!row) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
  const current = row.current_version_id
    ? await loadVersionById(exec, workspaceId, entryId, row.current_version_id)
    : null;
  const draft = row.draft_version_id
    ? await loadVersionById(exec, workspaceId, entryId, row.draft_version_id)
    : null;
  return {
    ...mapSummary(row),
    currentVersion: current ? mapVersion(current) : null,
    draftVersion: draft ? mapVersion(draft) : null,
    createdBy: actor(row.created_by, row.created_by_name, row.created_by_email),
    updatedBy: actor(row.updated_by, row.updated_by_name, row.updated_by_email),
    createdAt: iso(row.created_at),
  };
}

async function assertWork(
  exec: Executor,
  workspaceId: string,
  workId: string,
): Promise<void> {
  const rows = await exec<{ id: string }[]>`
    SELECT id FROM works WHERE id = ${workId} AND workspace_id = ${workspaceId}
  `;
  if (!rows[0]) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');
}

async function assertSourceChapter(
  exec: Executor,
  workspaceId: string,
  workId: string | null,
  chapterId: string | null,
): Promise<void> {
  if (!chapterId) return;
  const rows = await exec<{ id: string; work_id: string }[]>`
    SELECT c.id, c.work_id
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${workspaceId}
  `;
  const chapter = rows[0];
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '来源章节不存在或不属于当前工作区');
  if (workId && chapter.work_id !== workId) {
    throw badRequest('LEDGER_CHAPTER_WORK_MISMATCH', '来源章节与账本条目不属于同一作品');
  }
}

async function assertPayloadChapter(
  exec: Executor,
  workspaceId: string,
  workId: string,
  chapterId: string,
): Promise<void> {
  const rows = await exec<{ id: string }[]>`
    SELECT c.id
    FROM chapters c
    WHERE c.id = ${chapterId} AND c.work_id = ${workId}
      AND EXISTS (
        SELECT 1 FROM works w WHERE w.id = c.work_id AND w.workspace_id = ${workspaceId}
      )
  `;
  if (!rows[0]) throw notFound('LEDGER_CHAPTER_NOT_FOUND', '章节不存在或不属于当前作品');
}

async function parseAndValidatePayload(
  exec: Executor,
  workspaceId: string,
  workId: string | null,
  kind: LedgerEntryKind,
  value: unknown,
): Promise<LedgerEntryPayload> {
  if (kind === 'setting') {
    return ledgerSettingPayloadSchema.parse(value);
  }
  if (!workId) {
    throw badRequest('LEDGER_WORK_REQUIRED', '角色档案与伏笔台账必须属于一个作品');
  }
  if (kind === 'character') {
    const payload = ledgerCharacterPayloadSchema.parse(value);
    if (payload.states.length > 0) {
      const chapterIds = Array.from(
        new Set(payload.states.map((state) => state.asOfChapterId)),
      );
      if (chapterIds.length !== payload.states.length) {
        throw badRequest(
          'LEDGER_STATE_DUPLICATE_CHAPTER',
          '同一角色在同一章节只能记录一条状态',
        );
      }
      const rows = await exec<{ id: string }[]>`
        SELECT id FROM chapters
        WHERE work_id = ${workId} AND id IN ${sql(chapterIds)}
      `;
      if (rows.length !== chapterIds.length) {
        throw notFound('LEDGER_CHAPTER_NOT_FOUND', '状态绑定章节不存在或不属于当前作品');
      }
    }
    return payload;
  }
  const payload = ledgerForeshadowingPayloadSchema.parse(value);
  await assertPayloadChapter(exec, workspaceId, workId, payload.seedChapterId);
  if (payload.payoffChapterId) {
    await assertPayloadChapter(exec, workspaceId, workId, payload.payoffChapterId);
  }
  return payload;
}

async function assertNameAvailable(
  exec: Executor,
  workspaceId: string,
  kind: LedgerEntryKind,
  workId: string | null,
  name: string,
  aliases: string[],
  excludeId?: string,
): Promise<void> {
  const candidates = Array.from(new Set([name, ...aliases].map((value) => value.toLowerCase())));
  const rows = await exec<{ id: string; name: string }[]>`
    SELECT id, name
    FROM ledger_entries
    WHERE workspace_id = ${workspaceId}
      AND kind = ${kind}
      AND status <> 'archived'
      AND COALESCE(work_id, ${ZERO_UUID}::uuid) = COALESCE(${workId}::uuid, ${ZERO_UUID}::uuid)
      AND id <> ${excludeId ?? ZERO_UUID}::uuid
      AND (
        lower(name) = ANY(${sql.array(candidates)})
        OR EXISTS (
          SELECT 1 FROM unnest(aliases) AS alias
          WHERE lower(alias) = ANY(${sql.array(candidates)})
        )
      )
    LIMIT 1
  `;
  if (rows[0]) {
    throw conflict(
      'LEDGER_NAME_CONFLICT',
      `名称或别名与已有条目「${rows[0].name}」冲突`,
      { conflictingEntryId: rows[0].id },
    );
  }
}

async function nextVersionNo(exec: Executor, entryId: string): Promise<number> {
  const rows = await exec<{ next: number }[]>`
    SELECT COALESCE(MAX(version_no), 0) + 1 AS next
    FROM ledger_entry_versions
    WHERE entry_id = ${entryId}
  `;
  return Number(rows[0]?.next ?? 1);
}

function snapshotOf(input: {
  name: string;
  aliases: string[];
  summary: string;
  sourceChapterId: string | null;
  payload: LedgerEntryPayload;
}): LedgerEntrySnapshot {
  return {
    name: input.name,
    aliases: input.aliases,
    summary: input.summary,
    sourceChapterId: input.sourceChapterId,
    payload: input.payload,
  };
}

function changedFields(
  before: LedgerEntrySnapshot | null,
  after: LedgerEntrySnapshot,
): string[] {
  const fields: string[] = [];
  for (const key of ['name', 'aliases', 'summary', 'sourceChapterId'] as const) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after[key])) {
      fields.push(key);
    }
  }
  if (JSON.stringify(before?.payload ?? null) !== JSON.stringify(after.payload)) {
    fields.push('payload');
  }
  return fields;
}

async function writeAudit(
  exec: Executor,
  auth: AuthContext,
  action: string,
  entryId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
      ${action}, 'ledger_entry', ${entryId}, 'success',
      ${exec.json(jsonValue(metadata))}
    )
  `;
}

async function writeEvent(
  exec: Executor,
  auth: AuthContext,
  entryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO events (
      workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
    )
    VALUES (
      ${auth.workspace.id}, 'ledger_entry', ${entryId}, ${eventType},
      ${exec.json(jsonValue(payload))}, ${auth.user.id}
    )
  `;
}

export async function listLedgerEntries(
  auth: AuthContext,
  query: ListLedgerEntriesQuery,
): Promise<LedgerEntryListResponse> {
  assertCanReadLedger(auth.role);
  const conditions = [sql`e.workspace_id = ${auth.workspace.id}`];
  if (query.kind) conditions.push(sql`e.kind = ${query.kind}`);
  if (query.status) {
    conditions.push(sql`e.status = ${query.status}`);
  } else {
    conditions.push(sql`e.status <> 'archived'`);
  }
  if (query.workId) {
    conditions.push(
      sql`(e.work_id = ${query.workId} OR (e.kind = 'setting' AND e.work_id IS NULL))`,
    );
  }
  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(sql`(
      e.name ILIKE ${like}
      OR e.summary ILIKE ${like}
      OR EXISTS (
        SELECT 1 FROM unnest(e.aliases) AS alias WHERE alias ILIKE ${like}
      )
    )`);
  }
  const where = conditions.reduce((left, right) => sql`${left} AND ${right}`);
  const rows = await sql<EntryRow[]>`
    ${ENTRY_SELECT}
    WHERE ${where}
    ORDER BY e.updated_at DESC, e.name ASC
    LIMIT ${query.limit}
  `;
  return { entries: rows.map(mapSummary) };
}

export async function getLedgerEntry(
  auth: AuthContext,
  entryId: string,
): Promise<LedgerEntryDetail> {
  assertCanReadLedger(auth.role);
  return loadDetail(sql, auth.workspace.id, entryId);
}

export async function listLedgerVersions(
  auth: AuthContext,
  entryId: string,
): Promise<LedgerEntryVersionListResponse> {
  assertCanReadLedger(auth.role);
  const entry = await loadEntryRow(sql, auth.workspace.id, entryId);
  if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
  const rows = await sql<VersionRow[]>`
    SELECT
      v.id, v.entry_id, v.version_no, v.snapshot, v.change_summary, v.created_by, v.created_at,
      u.name AS created_by_name, u.email AS created_by_email
    FROM ledger_entry_versions v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.entry_id = ${entryId} AND v.workspace_id = ${auth.workspace.id}
    ORDER BY v.version_no DESC
  `;
  return { versions: rows.map(mapVersion) };
}

export async function createLedgerEntry(
  auth: AuthContext,
  input: CreateLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  assertCanWriteLedger(auth.role);
  return sql.begin(async (tx) => {
    const workspaceId = auth.workspace.id;
    const workId = input.kind === 'setting' ? (input.workId ?? null) : input.workId;
    if (workId) await assertWork(tx, workspaceId, workId);
    const sourceChapterId = input.sourceChapterId ?? null;
    await assertSourceChapter(tx, workspaceId, workId, sourceChapterId);
    const payload = await parseAndValidatePayload(
      tx,
      workspaceId,
      workId,
      input.kind,
      input.payload,
    );
    await assertNameAvailable(
      tx,
      workspaceId,
      input.kind,
      workId,
      input.name,
      input.aliases,
    );

    const entryId = randomUUID();
    const versionId = randomUUID();
    const snapshot = snapshotOf({
      name: input.name,
      aliases: input.aliases,
      summary: input.summary,
      sourceChapterId,
      payload,
    });
    try {
      await tx`
        INSERT INTO ledger_entries (
          id, workspace_id, work_id, kind, scope, name, aliases, summary, status,
          source_chapter_id, created_by, updated_by
        )
        VALUES (
          ${entryId}, ${workspaceId}, ${workId}, ${input.kind},
          ${workId ? 'work' : 'workspace'}, ${input.name}, ${input.aliases},
          ${input.summary}, 'draft', ${sourceChapterId},
          ${auth.user.id}, ${auth.user.id}
        )
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('LEDGER_NAME_CONFLICT', '名称或别名与已有条目冲突');
      }
      throw error;
    }
    await tx`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary, created_by
      )
      VALUES (
        ${versionId}, ${entryId}, ${workspaceId}, 1,
        ${tx.json(jsonValue(snapshot))}, '创建草稿', ${auth.user.id}
      )
    `;
    await tx`
      UPDATE ledger_entries
      SET draft_version_id = ${versionId}, updated_at = now()
      WHERE id = ${entryId} AND workspace_id = ${workspaceId}
    `;
    await writeAudit(tx, auth, 'ledger.entry.create', entryId, {
      kind: input.kind,
      name: input.name,
      workId,
      versionNo: 1,
      status: 'draft',
    });
    await writeEvent(tx, auth, entryId, 'ledger.entry.created', {
      kind: input.kind,
      name: input.name,
      workId,
      versionNo: 1,
    });
    return loadDetail(tx, workspaceId, entryId);
  });
}

export async function saveLedgerDraft(
  auth: AuthContext,
  entryId: string,
  input: UpdateLedgerDraftInput,
): Promise<LedgerEntryDetail> {
  assertCanWriteLedger(auth.role);
  return sql.begin(async (tx) => {
    const workspaceId = auth.workspace.id;
    const entry = await loadEntryForUpdate(tx, workspaceId, entryId);
    if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (entry.status === 'archived') {
      throw conflict('LEDGER_ENTRY_ARCHIVED', '已归档条目不能编辑；请先恢复');
    }
    if (entry.draft_version_id !== input.expectedDraftVersionId) {
      throw conflict(
        'LEDGER_DRAFT_CONFLICT',
        '草稿已被其他修改更新，请刷新后重试',
        { currentDraftVersionId: entry.draft_version_id },
      );
    }

    const baseVersionId = entry.draft_version_id ?? entry.current_version_id;
    if (!baseVersionId) throw new Error('账本条目缺少可编辑版本');
    const baseVersion = await loadVersionById(tx, workspaceId, entryId, baseVersionId);
    if (!baseVersion) throw new Error('账本基准版本读取失败');
    const base = baseVersion.snapshot;
    const kind = entry.kind as LedgerEntryKind;

    const name = input.name ?? base.name;
    const aliases = input.aliases ?? base.aliases;
    const summary = input.summary ?? base.summary;
    const sourceChapterId =
      input.sourceChapterId === undefined ? base.sourceChapterId : input.sourceChapterId;
    const payload =
      input.payload === undefined
        ? base.payload
        : await parseAndValidatePayload(tx, workspaceId, entry.work_id, kind, input.payload);

    await assertSourceChapter(tx, workspaceId, entry.work_id, sourceChapterId);
    await assertNameAvailable(
      tx,
      workspaceId,
      kind,
      entry.work_id,
      name,
      aliases,
      entry.id,
    );

    const versionNo = await nextVersionNo(tx, entryId);
    const versionId = randomUUID();
    const snapshot = snapshotOf({ name, aliases, summary, sourceChapterId, payload });
    await tx`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary, created_by
      )
      VALUES (
        ${versionId}, ${entryId}, ${workspaceId}, ${versionNo},
        ${tx.json(jsonValue(snapshot))}, ${input.changeSummary}, ${auth.user.id}
      )
    `;
    if (entry.status === 'draft' && !entry.current_version_id) {
      await tx`
        UPDATE ledger_entries SET
          name = ${name},
          aliases = ${aliases},
          summary = ${summary},
          source_chapter_id = ${sourceChapterId},
          draft_version_id = ${versionId},
          updated_by = ${auth.user.id},
          updated_at = now()
        WHERE id = ${entryId} AND workspace_id = ${workspaceId}
      `;
    } else {
      await tx`
        UPDATE ledger_entries SET
          draft_version_id = ${versionId},
          updated_by = ${auth.user.id},
          updated_at = now()
        WHERE id = ${entryId} AND workspace_id = ${workspaceId}
      `;
    }
    await writeAudit(tx, auth, 'ledger.entry.update_draft', entryId, {
      versionNo,
      previousVersionNo: baseVersion.version_no,
      changedFields: changedFields(base, snapshot),
      changeSummary: input.changeSummary,
    });
    await writeEvent(tx, auth, entryId, 'ledger.entry.version_saved', {
      versionNo,
      previousVersionNo: baseVersion.version_no,
      changedFields: changedFields(base, snapshot),
    });
    return loadDetail(tx, workspaceId, entryId);
  });
}

export async function publishLedgerEntry(
  auth: AuthContext,
  entryId: string,
  input: PublishLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  assertCanWriteLedger(auth.role);
  return sql.begin(async (tx) => {
    const workspaceId = auth.workspace.id;
    const entry = await loadEntryForUpdate(tx, workspaceId, entryId);
    if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (entry.status === 'archived') {
      throw conflict('LEDGER_ENTRY_ARCHIVED', '已归档条目不能发布；请先恢复');
    }
    if (!entry.draft_version_id) {
      throw conflict('LEDGER_NO_DRAFT', '没有待发布的草稿');
    }
    if (entry.draft_version_id !== input.expectedDraftVersionId) {
      throw conflict(
        'LEDGER_DRAFT_CONFLICT',
        '草稿已被其他修改更新，请刷新后重试',
        { currentDraftVersionId: entry.draft_version_id },
      );
    }
    const draft = await loadVersionById(
      tx,
      workspaceId,
      entryId,
      entry.draft_version_id,
    );
    if (!draft) throw new Error('待发布草稿读取失败');
    const snapshot = draft.snapshot;
    const kind = entry.kind as LedgerEntryKind;
    await assertSourceChapter(tx, workspaceId, entry.work_id, snapshot.sourceChapterId);
    await parseAndValidatePayload(
      tx,
      workspaceId,
      entry.work_id,
      kind,
      snapshot.payload,
    );
    await assertNameAvailable(
      tx,
      workspaceId,
      kind,
      entry.work_id,
      snapshot.name,
      snapshot.aliases,
      entry.id,
    );

    const previousVersion = entry.current_version_id
      ? await loadVersionById(tx, workspaceId, entryId, entry.current_version_id)
      : null;
    await tx`
      UPDATE ledger_entries SET
        current_version_id = ${entry.draft_version_id},
        draft_version_id = NULL,
        status = 'active',
        name = ${snapshot.name},
        aliases = ${snapshot.aliases},
        summary = ${snapshot.summary},
        source_chapter_id = ${snapshot.sourceChapterId},
        updated_by = ${auth.user.id},
        updated_at = now()
      WHERE id = ${entryId} AND workspace_id = ${workspaceId}
    `;
    if (kind === 'setting') {
      await tx`
        UPDATE workspaces SET settings_version = settings_version + 1
        WHERE id = ${workspaceId}
      `;
    } else {
      await tx`
        UPDATE workspaces SET ledger_version = ledger_version + 1
        WHERE id = ${workspaceId}
      `;
    }
    await writeAudit(tx, auth, 'ledger.entry.publish', entryId, {
      versionNo: draft.version_no,
      previousVersionNo: previousVersion?.version_no ?? null,
      changedFields: changedFields(previousVersion?.snapshot ?? null, snapshot),
      changeSummary: input.changeSummary,
    });
    await writeEvent(tx, auth, entryId, 'ledger.entry.published', {
      versionNo: draft.version_no,
      previousVersionNo: previousVersion?.version_no ?? null,
    });
    return loadDetail(tx, workspaceId, entryId);
  });
}

export async function archiveLedgerEntry(
  auth: AuthContext,
  entryId: string,
  input: ArchiveLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  assertCanWriteLedger(auth.role);
  return sql.begin(async (tx) => {
    const workspaceId = auth.workspace.id;
    const entry = await loadEntryForUpdate(tx, workspaceId, entryId);
    if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (entry.status === 'archived') {
      return loadDetail(tx, workspaceId, entryId);
    }
    if (entry.draft_version_id && !input.discardDraft) {
      const draft = await loadVersionById(
        tx,
        workspaceId,
        entryId,
        entry.draft_version_id,
      );
      throw conflict(
        'LEDGER_DRAFT_PENDING',
        '存在未发布草稿；请先发布，或选择丢弃草稿后再归档',
        { draftVersionNo: draft?.version_no ?? null },
      );
    }
    const hadActive = Boolean(entry.current_version_id);
    const kind = entry.kind as LedgerEntryKind;
    await tx`
      UPDATE ledger_entries SET
        status = 'archived',
        draft_version_id = NULL,
        updated_by = ${auth.user.id},
        updated_at = now()
      WHERE id = ${entryId} AND workspace_id = ${workspaceId}
    `;
    if (hadActive) {
      if (kind === 'setting') {
        await tx`
          UPDATE workspaces SET settings_version = settings_version + 1
          WHERE id = ${workspaceId}
        `;
      } else {
        await tx`
          UPDATE workspaces SET ledger_version = ledger_version + 1
          WHERE id = ${workspaceId}
        `;
      }
    }
    await writeAudit(tx, auth, 'ledger.entry.archive', entryId, {
      reason: input.reason,
      discardedDraftVersionId: entry.draft_version_id,
      hadActive,
    });
    await writeEvent(tx, auth, entryId, 'ledger.entry.archived', {
      reason: input.reason,
      hadActive,
    });
    return loadDetail(tx, workspaceId, entryId);
  });
}

export async function rollbackLedgerEntry(
  auth: AuthContext,
  entryId: string,
  input: RollbackLedgerEntryInput,
): Promise<LedgerEntryDetail> {
  assertCanWriteLedger(auth.role);
  return sql.begin(async (tx) => {
    const workspaceId = auth.workspace.id;
    const entry = await loadEntryForUpdate(tx, workspaceId, entryId);
    if (!entry) throw notFound('LEDGER_ENTRY_NOT_FOUND', '账本条目不存在或不属于当前工作区');
    if (entry.status === 'archived') {
      throw conflict('LEDGER_ENTRY_ARCHIVED', '已归档条目不能回滚；请先恢复');
    }
    if (entry.draft_version_id !== input.expectedDraftVersionId) {
      throw conflict(
        'LEDGER_DRAFT_CONFLICT',
        '草稿已被其他修改更新，请刷新后重试',
        { currentDraftVersionId: entry.draft_version_id },
      );
    }
    const target = await loadVersionByNo(
      tx,
      workspaceId,
      entryId,
      input.targetVersionNo,
    );
    if (!target) throw notFound('LEDGER_VERSION_NOT_FOUND', '目标版本不存在');
    const versionNo = await nextVersionNo(tx, entryId);
    const versionId = randomUUID();
    await tx`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary, created_by
      )
      VALUES (
        ${versionId}, ${entryId}, ${workspaceId}, ${versionNo},
        ${tx.json(jsonValue(target.snapshot))},
        ${`回滚到 v${target.version_no}：${input.reason}`}, ${auth.user.id}
      )
    `;
    if (entry.status === 'draft' && !entry.current_version_id) {
      await tx`
        UPDATE ledger_entries SET
          name = ${target.snapshot.name},
          aliases = ${target.snapshot.aliases},
          summary = ${target.snapshot.summary},
          source_chapter_id = ${target.snapshot.sourceChapterId},
          draft_version_id = ${versionId},
          updated_by = ${auth.user.id},
          updated_at = now()
        WHERE id = ${entryId} AND workspace_id = ${workspaceId}
      `;
    } else {
      await tx`
        UPDATE ledger_entries SET
          draft_version_id = ${versionId},
          updated_by = ${auth.user.id},
          updated_at = now()
        WHERE id = ${entryId} AND workspace_id = ${workspaceId}
      `;
    }
    await writeAudit(tx, auth, 'ledger.entry.rollback_draft', entryId, {
      targetVersionNo: target.version_no,
      newVersionNo: versionNo,
      reason: input.reason,
    });
    await writeEvent(tx, auth, entryId, 'ledger.entry.rollback_drafted', {
      targetVersionNo: target.version_no,
      newVersionNo: versionNo,
    });
    return loadDetail(tx, workspaceId, entryId);
  });
}

interface CharacterChapterRow {
  id: string;
  number: number;
  title: string;
}

interface CharacterContentRow extends CharacterChapterRow {
  content: string;
}

function chapterRef(row: CharacterChapterRow): LedgerChapterRef {
  return { id: row.id, number: row.number, title: row.title };
}

function stateEntries(
  states: {
    asOfChapterId: string;
    life: 'alive' | 'dead' | 'unknown';
    location: string;
    knowledge: string;
    possessions: string;
    relationshipChanges: string;
  }[],
  chapterById: Map<string, CharacterChapterRow>,
): LedgerCharacterStateEntry[] {
  return states
    .map((state) => {
      const chapter = chapterById.get(state.asOfChapterId);
      if (!chapter) return null;
      return {
        chapter: chapterRef(chapter),
        life: state.life,
        location: state.location,
        knowledge: state.knowledge,
        possessions: state.possessions,
        relationshipChanges: state.relationshipChanges,
      };
    })
    .filter((state): state is LedgerCharacterStateEntry => state !== null)
    .sort((left, right) => left.chapter.number - right.chapter.number);
}

function characterWarnings(
  relationships: { name: string; relation: string }[],
  states: LedgerCharacterStateEntry[],
  appearances: LedgerCharacterAppearance[],
): LedgerCharacterWarning[] {
  const warnings: LedgerCharacterWarning[] = [];
  const deaths: LedgerCharacterStateEntry[] = [];
  let death: LedgerCharacterStateEntry | null = null;
  for (const state of states) {
    if (state.life === 'dead') {
      death ??= state;
      continue;
    }
    if (state.life === 'alive' && death) {
      warnings.push({
        code: 'dead_revived',
        severity: 'warning',
        message: `第 ${death.chapter.number} 章状态为死亡，第 ${state.chapter.number} 章又标记为“存活”。若没有复活或假死设定，请修正时间线。`,
        chapterId: state.chapter.id,
      });
      deaths.push(death);
      death = null;
    }
  }
  if (death) deaths.push(death);
  for (const deadState of deaths) {
    const later = appearances.find(
      (appearance) => appearance.chapter.number > deadState.chapter.number,
    );
    if (later) {
      warnings.push({
        code: 'dead_appears_later',
        severity: 'warning',
        message: `角色在第 ${deadState.chapter.number} 章状态为死亡，但正典第 ${later.chapter.number} 章仍出现其名称或别名。可能是回忆、转述或尸体提及，请人工确认。`,
        chapterId: later.chapter.id,
      });
    }
  }
  const groups = new Map<string, Set<string>>();
  for (const relationship of relationships) {
    const key = relationship.name.trim().toLowerCase();
    if (!key) continue;
    const relations = groups.get(key) ?? new Set<string>();
    relations.add(relationship.relation.trim());
    groups.set(key, relations);
  }
  for (const [name, relations] of groups) {
    if (relations.size > 1) {
      warnings.push({
        code: 'relationship_conflict',
        severity: 'warning',
        message: `角色关系中对「${name}」存在多种关系描述：${Array.from(relations).join('、')}。请确认是否遗漏了关系变化的时间点。`,
        chapterId: null,
      });
    }
  }
  return warnings;
}

async function characterAppearances(
  exec: Executor,
  workId: string,
  names: string[],
): Promise<LedgerCharacterAppearance[]> {
  const terms = Array.from(
    new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean)),
  );
  if (terms.length === 0) return [];
  const rows = await exec<CharacterContentRow[]>`
    SELECT c.id, c.number, c.title, cv.content
    FROM chapters c
    JOIN canon_current cc ON cc.chapter_id = c.id
    JOIN canon_versions cv ON cv.id = cc.version_id
    WHERE c.work_id = ${workId}
    ORDER BY c.number ASC
  `;
  const appearances: LedgerCharacterAppearance[] = [];
  for (const row of rows) {
    const content = row.content.toLowerCase();
    let matches = 0;
    for (const term of terms) {
      let index = content.indexOf(term);
      while (index !== -1) {
        matches += 1;
        index = content.indexOf(term, index + term.length);
      }
    }
    if (matches > 0) {
      appearances.push({ chapter: chapterRef(row), matches });
    }
  }
  return appearances;
}

export async function getCharacterTimeline(
  auth: AuthContext,
  entryId: string,
): Promise<LedgerCharacterTimeline> {
  assertCanReadLedger(auth.role);
  const rows = await sql<
    {
      id: string;
      work_id: string;
      name: string;
      aliases: string[];
      version_no: number;
      snapshot: LedgerEntrySnapshot;
    }[]
  >`
    SELECT e.id, e.work_id, e.name, e.aliases, v.version_no, v.snapshot
    FROM ledger_entries e
    JOIN ledger_entry_versions v ON v.id = e.current_version_id
    WHERE e.id = ${entryId}
      AND e.workspace_id = ${auth.workspace.id}
      AND e.kind = 'character'
      AND e.status = 'active'
  `;
  const entry = rows[0];
  if (!entry) {
    const existing = await sql<{ status: string }[]>`
      SELECT status FROM ledger_entries
      WHERE id = ${entryId} AND workspace_id = ${auth.workspace.id} AND kind = 'character'
    `;
    if (!existing[0]) {
      throw notFound('LEDGER_ENTRY_NOT_FOUND', '角色档案不存在或不属于当前工作区');
    }
    throw conflict('LEDGER_CHARACTER_NOT_PUBLISHED', '角色时间线只读取已发布的生效版本');
  }
  const payload = ledgerCharacterPayloadSchema.parse(entry.snapshot.payload);
  const chapterRows = await sql<CharacterChapterRow[]>`
    SELECT id, number, title FROM chapters WHERE work_id = ${entry.work_id} ORDER BY number ASC
  `;
  const chapterById = new Map(chapterRows.map((chapter) => [chapter.id, chapter]));
  const states = stateEntries(payload.states, chapterById);
  const appearances = await characterAppearances(sql, entry.work_id, [
    entry.name,
    ...entry.aliases,
  ]);
  return {
    entryId: entry.id,
    workId: entry.work_id,
    name: entry.name,
    aliases: entry.aliases,
    versionNo: entry.version_no,
    states,
    appearances,
    firstAppearance: appearances[0]?.chapter ?? null,
    latestAppearance: appearances[appearances.length - 1]?.chapter ?? null,
    warnings: characterWarnings(payload.relationships, states, appearances),
    scanScope: 'canon_current',
  };
}

export async function getCharacterContext(
  auth: AuthContext,
  chapterId: string,
): Promise<LedgerCharacterContext> {
  assertCanReadLedger(auth.role);
  const chapterRows = await sql<(CharacterChapterRow & { work_id: string })[]>`
    SELECT c.id, c.work_id, c.number, c.title
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
  `;
  const chapter = chapterRows[0];
  if (!chapter) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
  const previousRows = await sql<CharacterChapterRow[]>`
    SELECT id, number, title
    FROM chapters
    WHERE work_id = ${chapter.work_id} AND number < ${chapter.number}
    ORDER BY number DESC
    LIMIT 1
  `;
  const asOf = previousRows[0] ?? null;
  const characterRows = await sql<
    {
      id: string;
      name: string;
      snapshot: LedgerEntrySnapshot;
    }[]
  >`
    SELECT e.id, e.name, v.snapshot
    FROM ledger_entries e
    JOIN ledger_entry_versions v ON v.id = e.current_version_id
    WHERE e.workspace_id = ${auth.workspace.id}
      AND e.work_id = ${chapter.work_id}
      AND e.kind = 'character'
      AND e.status = 'active'
    ORDER BY lower(e.name) ASC
  `;
  const chapterMapRows = await sql<CharacterChapterRow[]>`
    SELECT id, number, title FROM chapters WHERE work_id = ${chapter.work_id}
  `;
  const chapterById = new Map(chapterMapRows.map((row) => [row.id, row]));
  const characters: LedgerCharacterContextItem[] = [];
  let omittedCharacters = 0;
  for (const row of characterRows) {
    const payload = ledgerCharacterPayloadSchema.parse(row.snapshot.payload);
    const states = asOf
      ? stateEntries(payload.states, chapterById).filter(
          (item) => item.chapter.number <= asOf.number,
        )
      : [];
    const state = states.at(-1) ?? null;
    if (!state) {
      omittedCharacters += 1;
      continue;
    }
    characters.push({
      id: row.id,
      name: row.name,
      state,
      stale: state.chapter.number < asOf!.number,
    });
  }
  const baseNote = asOf
    ? '仅显示上一章及之前已登记状态的角色，状态截至上一章；草稿与后续章节不会出现。'
    : '这是开篇章节，没有上一章；为避免剧透，开篇页不展示角色状态。';
  return {
    chapterId: chapter.id,
    chapter: chapterRef(chapter),
    asOfChapter: asOf ? chapterRef(asOf) : null,
    characters,
    omittedCharacters,
    note:
      omittedCharacters > 0
        ? `${baseNote}另有 ${omittedCharacters} 个已发布角色在该时点前没有状态记录，已隐藏。`
        : baseNote,
  };
}
