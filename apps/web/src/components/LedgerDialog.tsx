import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChapterListItem,
  LedgerCharacterPayload,
  LedgerCharacterTimeline,
  LedgerEntryDetail,
  LedgerEntryStatus,
  LedgerEntrySummary,
  LedgerEntryVersionView,
  MeResponse,
} from '@yunshuo/contracts';
import {
  ApiError,
  archiveLedgerEntry,
  createLedgerEntry,
  getCharacterTimeline,
  getLedgerEntry,
  listLedgerEntries,
  listLedgerVersions,
  publishLedgerEntry,
  rollbackLedgerEntry,
  saveLedgerDraft,
} from '../api.js';
import {
  CHARACTER_LIFE_LABELS,
  LEDGER_KIND_LABELS,
  LEDGER_SCOPE_LABELS,
  LEDGER_STATUS_LABELS,
  SETTING_CATEGORY_LABELS,
  VERIFICATION_LABELS,
  diffLedgerSnapshots,
  isCharacterPayload,
  isSettingPayload,
  type LedgerFieldDiff,
} from '../ledger.js';
import { formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';
import { CharacterEntryForm, type CharacterDraftInput } from './CharacterEntryForm.js';
import { LedgerEntryForm, type LedgerDraftInput } from './LedgerEntryForm.js';

interface Props {
  me: MeResponse;
  chapters: ChapterListItem[];
  onClose: () => void;
}

type StatusFilter = 'all' | LedgerEntryStatus;
type LedgerKindTab = 'setting' | 'character';

type LedgerFormInput =
  | { kind: 'setting'; input: LedgerDraftInput }
  | { kind: 'character'; input: CharacterDraftInput };

const KIND_TABS: { value: LedgerKindTab; label: string }[] = [
  { value: 'setting', label: '设定' },
  { value: 'character', label: '角色' },
];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部未归档' },
  { value: 'active', label: '已生效' },
  { value: 'draft', label: '未发布草稿' },
  { value: 'archived', label: '已归档' },
];

const WRITE_ROLES = new Set(['owner', 'lead', 'author']);

function statusTone(status: LedgerEntryStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'green';
    case 'draft':
      return 'amber';
    default:
      return 'muted';
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export function LedgerDialog({ me, chapters, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const canWrite = WRITE_ROLES.has(me.role);

  const [kindFilter, setKindFilter] = useState<LedgerKindTab>('setting');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [workFilter, setWorkFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'publish' | 'archive' | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [discardDraft, setDiscardDraft] = useState(false);
  const [rollbackVersionNo, setRollbackVersionNo] = useState<number | null>(null);
  const [rollbackReason, setRollbackReason] = useState('');
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);

  const works = Array.from(
    new Map(
      chapters.map((chapter) => [
        chapter.workId,
        { id: chapter.workId, title: chapter.workTitle },
      ]),
    ).values(),
  );
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const workTitleById = new Map(works.map((work) => [work.id, work.title]));

  function chapterLabel(chapterId: string | null): string {
    if (!chapterId) return '未关联章节';
    const chapter = chapterById.get(chapterId);
    return chapter ? `第 ${chapter.number} 章 · ${chapter.title}` : '未知章节';
  }

  function chapterNumber(chapterId: string): number {
    return chapterById.get(chapterId)?.number ?? 0;
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const entriesQuery = useQuery({
    queryKey: ['ledgerEntries', kindFilter, statusFilter, workFilter, searchQuery],
    queryFn: () =>
      listLedgerEntries({
        kind: kindFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
        workId: workFilter || undefined,
        q: searchQuery || undefined,
        limit: 100,
      }),
  });

  const detailQuery = useQuery({
    queryKey: ['ledgerEntry', selectedId],
    queryFn: () => getLedgerEntry(selectedId!),
    enabled: Boolean(selectedId),
  });

  const versionsQuery = useQuery({
    queryKey: ['ledgerVersions', selectedId],
    queryFn: () => listLedgerVersions(selectedId!),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    if (mode !== 'view' || selectedId !== null) return;
    setSelectedId(entriesQuery.data?.entries[0]?.id ?? null);
  }, [entriesQuery.data, mode, selectedId]);

  const entry = detailQuery.data ?? null;
  const versions = versionsQuery.data?.versions ?? [];

  const timelineQuery = useQuery({
    queryKey: ['ledgerCharacterTimeline', selectedId, entry?.currentVersion?.id],
    queryFn: () => getCharacterTimeline(selectedId!),
    enabled: Boolean(
      selectedId &&
        entry?.kind === 'character' &&
        entry.status === 'active' &&
        entry.currentVersion,
    ),
    retry: false,
  });

  async function invalidateEntry(entryId: string | null = selectedId) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ledgerEntries'] }),
      queryClient.invalidateQueries({ queryKey: ['ledgerCharacterTimeline'] }),
      queryClient.invalidateQueries({ queryKey: ['characterContext'] }),
      entryId
        ? queryClient.invalidateQueries({ queryKey: ['ledgerEntry', entryId] })
        : Promise.resolve(),
      entryId
        ? queryClient.invalidateQueries({ queryKey: ['ledgerVersions', entryId] })
        : Promise.resolve(),
    ]);
  }

  function resetTransient() {
    setNotice(null);
    setError(null);
    setAction(null);
    setArchiveReason('');
    setDiscardDraft(false);
    setRollbackVersionNo(null);
    setRollbackReason('');
    setCompareVersionId(null);
  }

  function handleFilterChange(next: () => void) {
    resetTransient();
    setSelectedId(null);
    setMode('view');
    next();
  }

  function handleKindChange(next: LedgerKindTab) {
    resetTransient();
    setSelectedId(null);
    setMode('view');
    setKindFilter(next);
  }

  function startCreate() {
    resetTransient();
    setSelectedId(null);
    setMode('create');
  }

  function startEdit() {
    resetTransient();
    setMode('edit');
  }

  function selectEntry(entryId: string) {
    resetTransient();
    setSelectedId(entryId);
    setMode('view');
  }

  const createMutation = useMutation({
    mutationFn: (input: LedgerFormInput) =>
      input.kind === 'setting'
        ? createLedgerEntry({
            kind: 'setting',
            workId: input.input.workId,
            name: input.input.name,
            aliases: input.input.aliases,
            summary: input.input.summary,
            sourceChapterId: input.input.sourceChapterId,
            payload: input.input.payload,
          })
        : createLedgerEntry({
            kind: 'character',
            workId: input.input.workId,
            name: input.input.name,
            aliases: input.input.aliases,
            summary: input.input.summary,
            sourceChapterId: input.input.sourceChapterId,
            payload: input.input.payload,
          }),
    onSuccess: async (created) => {
      setNotice('草稿已创建。发布后才会成为生效版本。');
      setError(null);
      setMode('view');
      setSelectedId(created.id);
      await invalidateEntry(created.id);
    },
    onError: (createError) => setError(errorText(createError)),
  });

  const saveMutation = useMutation({
    mutationFn: (form: LedgerFormInput) =>
      saveLedgerDraft(selectedId!, {
        expectedDraftVersionId: entry?.draftVersion?.id ?? null,
        name: form.input.name,
        aliases: form.input.aliases,
        summary: form.input.summary,
        sourceChapterId: form.input.sourceChapterId,
        payload: form.input.payload,
        changeSummary: form.input.changeSummary,
      }),
    onSuccess: async (updated) => {
      setNotice('草稿已保存。发布后才会成为生效版本。');
      setError(null);
      setMode('view');
      await invalidateEntry(updated.id);
    },
    onError: async (saveError) => {
      setError(errorText(saveError));
      await invalidateEntry();
    },
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      publishLedgerEntry(selectedId!, {
        expectedDraftVersionId: entry!.draftVersion!.id,
        changeSummary: '',
      }),
    onSuccess: async (updated) => {
      setNotice(`已发布 v${updated.currentVersion?.versionNo ?? ''}；该版本成为生效版本，历史版本保留。`);
      setError(null);
      setAction(null);
      await invalidateEntry(updated.id);
    },
    onError: async (publishError) => {
      setError(errorText(publishError));
      await invalidateEntry();
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      archiveLedgerEntry(selectedId!, {
        reason: archiveReason.trim(),
        discardDraft,
      }),
    onSuccess: async (updated) => {
      setNotice('条目已归档。默认列表不再显示，历史版本保留。');
      setError(null);
      setAction(null);
      await invalidateEntry(updated.id);
    },
    onError: async (archiveError) => {
      setError(errorText(archiveError));
      await invalidateEntry();
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (targetVersionNo: number) =>
      rollbackLedgerEntry(selectedId!, {
        targetVersionNo,
        expectedDraftVersionId: entry?.draftVersion?.id ?? null,
        reason: rollbackReason.trim(),
      }),
    onSuccess: async (updated) => {
      setNotice(
        `已从历史版本生成草稿 v${updated.draftVersion?.versionNo ?? ''}；发布后才会成为生效版本。`,
      );
      setError(null);
      setRollbackVersionNo(null);
      setRollbackReason('');
      await invalidateEntry(updated.id);
    },
    onError: async (rollbackError) => {
      setError(errorText(rollbackError));
      await invalidateEntry();
    },
  });

  const entries = entriesQuery.data?.entries ?? [];
  const draftDiffRows =
    entry?.draftVersion !== null && entry?.draftVersion
      ? diffLedgerSnapshots(
          entry.currentVersion?.snapshot ?? null,
          entry.draftVersion.snapshot,
          chapterLabel,
        )
      : [];

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-ledger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ledger-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">{me.workspace.name} · 设定与连续性账本</p>
            <h2 id="ledger-title">设定与角色</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body ledger-body">
          <aside className="ledger-sidebar">
            <div className="ledger-kind-tabs" role="tablist" aria-label="账本类型">
              {KIND_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  aria-selected={kindFilter === tab.value}
                  className={`ledger-kind-tab${kindFilter === tab.value ? ' ledger-kind-tab-active' : ''}`}
                  onClick={() => handleKindChange(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="ledger-sidebar-actions">
              {canWrite ? (
                <button type="button" className="button button-primary button-small" onClick={startCreate}>
                  {kindFilter === 'setting' ? '新建设定' : '新建角色'}
                </button>
              ) : (
                <Badge tone="neutral">只读</Badge>
              )}
              <span className="muted">共 {entries.length} 条</span>
            </div>

            <div className="ledger-filters">
              <label className="field">
                <span>搜索</span>
                <input
                  value={searchInput}
                  maxLength={200}
                  placeholder="名称、别名或摘要"
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setSelectedId(null);
                  }}
                />
              </label>
              <div className="ledger-filter-row">
                <label className="field">
                  <span>状态</span>
                  <select
                    value={statusFilter}
                    onChange={(event) =>
                      handleFilterChange(() =>
                        setStatusFilter(event.target.value as StatusFilter),
                      )
                    }
                  >
                    {STATUS_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>作品</span>
                  <select
                    value={workFilter}
                    onChange={(event) =>
                      handleFilterChange(() => setWorkFilter(event.target.value))
                    }
                  >
                    <option value="">全部作品</option>
                    {works.map((work) => (
                      <option key={work.id} value={work.id}>
                        {work.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="ledger-list">
              {entriesQuery.isLoading ? (
                <p className="empty-state">
                  正在读取{kindFilter === 'setting' ? '设定' : '角色'}条目……
                </p>
              ) : entriesQuery.isError ? (
                <div className="modal-error">读取失败：{errorText(entriesQuery.error)}</div>
              ) : entries.length === 0 ? (
                <div className="ledger-empty">
                  <p className="empty-state">
                    {searchQuery || workFilter || statusFilter !== 'all'
                      ? `没有符合条件的${kindFilter === 'setting' ? '设定' : '角色'}条目。`
                      : kindFilter === 'setting'
                        ? '尚未建立设定条目。'
                        : '尚未建立角色档案。'}
                  </p>
                  <p className="muted">
                    {searchQuery || workFilter || statusFilter !== 'all'
                      ? `调整筛选条件，或新建一条${kindFilter === 'setting' ? '设定' : '角色'}。`
                      : kindFilter === 'setting'
                        ? '设定库为空时不会显示伪造的示例。先登记一条世界观事实，再发布为生效版本。'
                        : '角色档案为空时不会显示伪造的示例。角色归属作品，状态绑定“截至第 N 章”。'}
                  </p>
                </div>
              ) : (
                entries.map((item) => (
                  <LedgerListItem
                    key={item.id}
                    item={item}
                    workTitle={item.workId ? workTitleById.get(item.workId) : null}
                    selected={item.id === selectedId}
                    onSelect={() => selectEntry(item.id)}
                  />
                ))
              )}
            </div>
          </aside>

          <section className="ledger-main">
            {notice ? <div className="provider-notice provider-notice-success">{notice}</div> : null}
            {error ? <div className="modal-error">{error}</div> : null}

            {mode === 'create' ? (
              kindFilter === 'character' ? (
                <CharacterEntryForm
                  key="create-character"
                  initial={null}
                  initialWorkId={workFilter || null}
                  works={works}
                  chapters={chapters}
                  submitting={createMutation.isPending}
                  onSubmit={(input) => {
                    setError(null);
                    setNotice(null);
                    createMutation.mutate({ kind: 'character', input });
                  }}
                  onCancel={() => {
                    setMode('view');
                    setSelectedId(entries[0]?.id ?? null);
                  }}
                />
              ) : (
                <LedgerEntryForm
                  key="create-setting"
                  initial={null}
                  initialWorkId={workFilter || null}
                  works={works}
                  chapters={chapters}
                  submitting={createMutation.isPending}
                  onSubmit={(input) => {
                    setError(null);
                    setNotice(null);
                    createMutation.mutate({ kind: 'setting', input });
                  }}
                  onCancel={() => {
                    setMode('view');
                    setSelectedId(entries[0]?.id ?? null);
                  }}
                />
              )
            ) : mode === 'edit' && entry ? (
              entry.kind === 'character' ? (
                <CharacterEntryForm
                  key={`edit-character-${entry.id}-${entry.draftVersion?.id ?? entry.currentVersion?.id ?? 'none'}`}
                  initial={entry.draftVersion?.snapshot ?? entry.currentVersion?.snapshot ?? null}
                  initialWorkId={entry.workId}
                  works={works}
                  chapters={chapters}
                  submitting={saveMutation.isPending}
                  onSubmit={(input) => {
                    setError(null);
                    setNotice(null);
                    saveMutation.mutate({ kind: 'character', input });
                  }}
                  onCancel={() => setMode('view')}
                />
              ) : (
                <LedgerEntryForm
                  key={`edit-setting-${entry.id}-${entry.draftVersion?.id ?? entry.currentVersion?.id ?? 'none'}`}
                  initial={entry.draftVersion?.snapshot ?? entry.currentVersion?.snapshot ?? null}
                  initialWorkId={entry.workId}
                  works={works}
                  chapters={chapters}
                  submitting={saveMutation.isPending}
                  onSubmit={(input) => {
                    setError(null);
                    setNotice(null);
                    saveMutation.mutate({ kind: 'setting', input });
                  }}
                  onCancel={() => setMode('view')}
                />
              )
            ) : detailQuery.isLoading && selectedId ? (
              <p className="empty-state">正在读取条目与版本……</p>
            ) : detailQuery.isError ? (
              <div className="modal-error">读取失败：{errorText(detailQuery.error)}</div>
            ) : entry ? (
              <LedgerEntryDetailView
                entry={entry}
                versions={versions}
                versionsLoading={versionsQuery.isLoading}
                versionsError={versionsQuery.error}
                canWrite={canWrite}
                chapterLabel={chapterLabel}
                chapterNumber={chapterNumber}
                timeline={timelineQuery.data ?? null}
                timelineLoading={timelineQuery.isLoading}
                timelineError={timelineQuery.error}
                workTitle={entry.workId ? workTitleById.get(entry.workId) : null}
                draftDiffRows={draftDiffRows}
                action={action}
                archiveReason={archiveReason}
                discardDraft={discardDraft}
                rollbackVersionNo={rollbackVersionNo}
                rollbackReason={rollbackReason}
                compareVersionId={compareVersionId}
                publishPending={publishMutation.isPending}
                archivePending={archiveMutation.isPending}
                rollbackPending={rollbackMutation.isPending}
                onStartEdit={startEdit}
                onSetAction={(next) => {
                  setError(null);
                  setNotice(null);
                  setAction(next);
                }}
                onArchiveReasonChange={setArchiveReason}
                onDiscardDraftChange={setDiscardDraft}
                onPublish={() => publishMutation.mutate()}
                onArchive={() => archiveMutation.mutate()}
                onStartRollback={(versionNo) => {
                  setError(null);
                  setNotice(null);
                  setRollbackVersionNo(versionNo);
                  setRollbackReason('');
                }}
                onRollbackReasonChange={setRollbackReason}
                onRollback={() => rollbackMutation.mutate(rollbackVersionNo!)}
                onCancelRollback={() => setRollbackVersionNo(null)}
                onToggleCompare={(versionId) =>
                  setCompareVersionId((current) => (current === versionId ? null : versionId))
                }
              />
            ) : (
              <div className="ledger-empty ledger-empty-main">
                <p className="empty-state">
                  尚未选择{kindFilter === 'setting' ? '设定' : '角色'}条目。
                </p>
                <p className="muted">
                  从左侧选择条目查看版本与差异，或新建一条
                  {kindFilter === 'setting' ? '设定' : '角色档案'}。
                </p>
              </div>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          <span className="commit-foot-hint">
            设定与角色按工作区隔离；已发布版本不可修改，所有写入进入审计。角色状态已接入写作台只读提示，尚未接入检索与门禁。
          </span>
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

function LedgerListItem({
  item,
  workTitle,
  selected,
  onSelect,
}: {
  item: LedgerEntrySummary;
  workTitle: string | null | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`ledger-list-item${selected ? ' ledger-list-item-active' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <div className="ledger-list-item-head">
        <strong>{item.name}</strong>
        <Badge tone={statusTone(item.status)}>{LEDGER_STATUS_LABELS[item.status]}</Badge>
      </div>
      {item.summary ? <p className="ledger-list-summary">{item.summary}</p> : null}
      <span className="ledger-list-meta">
        {item.scope === 'work' ? workTitle ?? '作品专属' : '工作区通用'}
        {item.currentVersionNo ? ` · 生效 v${item.currentVersionNo}` : ''}
        {item.draftVersionNo ? ` · 草稿 v${item.draftVersionNo}` : ''}
      </span>
    </button>
  );
}

interface DetailViewProps {
  entry: LedgerEntryDetail;
  versions: LedgerEntryVersionView[];
  versionsLoading: boolean;
  versionsError: unknown;
  canWrite: boolean;
  chapterLabel: (chapterId: string | null) => string;
  chapterNumber: (chapterId: string) => number;
  timeline: LedgerCharacterTimeline | null;
  timelineLoading: boolean;
  timelineError: unknown;
  workTitle: string | null | undefined;
  draftDiffRows: LedgerFieldDiff[];
  action: 'publish' | 'archive' | null;
  archiveReason: string;
  discardDraft: boolean;
  rollbackVersionNo: number | null;
  rollbackReason: string;
  compareVersionId: string | null;
  publishPending: boolean;
  archivePending: boolean;
  rollbackPending: boolean;
  onStartEdit: () => void;
  onSetAction: (action: 'publish' | 'archive' | null) => void;
  onArchiveReasonChange: (value: string) => void;
  onDiscardDraftChange: (value: boolean) => void;
  onPublish: () => void;
  onArchive: () => void;
  onStartRollback: (versionNo: number) => void;
  onRollbackReasonChange: (value: string) => void;
  onRollback: () => void;
  onCancelRollback: () => void;
  onToggleCompare: (versionId: string) => void;
}

function LedgerEntryDetailView({
  entry,
  versions,
  versionsLoading,
  versionsError,
  canWrite,
  chapterLabel,
  chapterNumber,
  timeline,
  timelineLoading,
  timelineError,
  workTitle,
  draftDiffRows,
  action,
  archiveReason,
  discardDraft,
  rollbackVersionNo,
  rollbackReason,
  compareVersionId,
  publishPending,
  archivePending,
  rollbackPending,
  onStartEdit,
  onSetAction,
  onArchiveReasonChange,
  onDiscardDraftChange,
  onPublish,
  onArchive,
  onStartRollback,
  onRollbackReasonChange,
  onRollback,
  onCancelRollback,
  onToggleCompare,
}: DetailViewProps) {
  const snapshot = entry.draftVersion?.snapshot ?? entry.currentVersion?.snapshot ?? null;
  const settingPayload =
    snapshot && isSettingPayload(snapshot.payload) ? snapshot.payload : null;
  const characterPayload =
    snapshot && isCharacterPayload(snapshot.payload) ? snapshot.payload : null;
  const editable = canWrite && entry.status !== 'archived';
  const hasDraft = Boolean(entry.draftVersion);
  const latestState = timeline?.states.at(-1) ?? null;

  return (
    <div className="ledger-detail">
      <header className="ledger-detail-head">
        <div className="ledger-detail-title">
          <div className="ledger-detail-badges">
            <Badge tone={statusTone(entry.status)}>{LEDGER_STATUS_LABELS[entry.status]}</Badge>
            <Badge tone="neutral">{LEDGER_KIND_LABELS[entry.kind]}</Badge>
            <Badge tone="neutral">{LEDGER_SCOPE_LABELS[entry.scope]}</Badge>
            {settingPayload ? (
              <Badge tone="ink">{SETTING_CATEGORY_LABELS[settingPayload.category]}</Badge>
            ) : null}
            {settingPayload ? (
              <Badge tone={settingPayload.verification === 'verified' ? 'green' : 'amber'}>
                {VERIFICATION_LABELS[settingPayload.verification]}
              </Badge>
            ) : null}
            {characterPayload?.role ? (
              <Badge tone="ink">{characterPayload.role}</Badge>
            ) : null}
            {latestState ? (
              <Badge
                tone={
                  latestState.life === 'alive'
                    ? 'green'
                    : latestState.life === 'dead'
                      ? 'red'
                      : 'neutral'
                }
              >
                最新状态：{CHARACTER_LIFE_LABELS[latestState.life]}
              </Badge>
            ) : null}
          </div>
          <h3>{entry.name}</h3>
          {entry.aliases.length > 0 ? (
            <p className="ledger-alias-line">别名：{entry.aliases.join('、')}</p>
          ) : null}
          {entry.summary ? <p className="ledger-detail-summary">{entry.summary}</p> : null}
        </div>
        {editable ? (
          <div className="ledger-detail-actions">
            <button type="button" className="button button-quiet button-small" onClick={onStartEdit}>
              {hasDraft ? '继续编辑草稿' : '编辑并生成草稿'}
            </button>
            {hasDraft ? (
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() => onSetAction(action === 'publish' ? null : 'publish')}
              >
                发布草稿
              </button>
            ) : null}
            <button
              type="button"
              className="button button-danger button-small"
              onClick={() => onSetAction(action === 'archive' ? null : 'archive')}
            >
              归档
            </button>
          </div>
        ) : null}
      </header>

      <dl className="ledger-meta-grid">
        <div>
          <dt>归属</dt>
          <dd>{entry.scope === 'work' ? workTitle ?? '作品专属' : '工作区通用 · 所有作品共享'}</dd>
        </div>
        <div>
          <dt>来源章节</dt>
          <dd>{chapterLabel(entry.sourceChapterId)}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>
            {entry.currentVersion ? `生效 v${entry.currentVersion.versionNo}` : '尚未发布'}
            {entry.draftVersion ? ` · 草稿 v${entry.draftVersion.versionNo}` : ''}
          </dd>
        </div>
        <div>
          <dt>最后更新</dt>
          <dd>{formatDateTime(entry.updatedAt)}</dd>
        </div>
        <div>
          <dt>创建者</dt>
          <dd>{entry.createdBy?.name ?? '未知'}</dd>
        </div>
        <div>
          <dt>最近编辑</dt>
          <dd>{entry.updatedBy?.name ?? '未知'}</dd>
        </div>
      </dl>

      {entry.status === 'archived' ? (
        <div className="inline-warning">
          该条目已归档：默认列表不再显示，名称可被新条目复用；历史版本仍保留。当前版本未提供取消归档操作。
        </div>
      ) : null}

      {hasDraft ? (
        <section className="ledger-section">
          <div className="ledger-section-head">
            <div>
              <p className="eyebrow">待发布草稿</p>
              <h4>
                {entry.currentVersion
                  ? `草稿 v${entry.draftVersion!.versionNo} 与生效 v${entry.currentVersion.versionNo} 的差异`
                  : `草稿 v${entry.draftVersion!.versionNo}（尚未发布）`}
              </h4>
            </div>
            <Badge tone="amber">发布前预览</Badge>
          </div>
          <LedgerDiff
            rows={draftDiffRows}
            emptyText={entry.currentVersion ? '草稿与生效版本没有字段差异。' : '草稿没有任何字段内容。'}
          />
        </section>
      ) : null}

      <section className="ledger-section">
        <div className="ledger-section-head">
          <div>
            <p className="eyebrow">{entry.draftVersion ? '草稿内容' : '生效内容'}</p>
            <h4>{entry.name}</h4>
          </div>
        </div>
        {settingPayload ? (
          <div className="ledger-payload">
            <div className="ledger-payload-facts">
              <span>分类：{SETTING_CATEGORY_LABELS[settingPayload.category]}</span>
              <span>核实状态：{VERIFICATION_LABELS[settingPayload.verification]}</span>
              <span>
                标签：
                {settingPayload.tags.length > 0 ? settingPayload.tags.join('、') : '未设置'}
              </span>
            </div>
            {settingPayload.details ? (
              <div className="ledger-details">{settingPayload.details}</div>
            ) : (
              <p className="empty-state">还没有详细说明。</p>
            )}
          </div>
        ) : characterPayload ? (
          <CharacterPayloadView
            payload={characterPayload}
            chapterLabel={chapterLabel}
            chapterNumber={chapterNumber}
          />
        ) : (
          <p className="empty-state">没有可展示的条目内容。</p>
        )}
      </section>

      {entry.kind === 'character' ? (
        <CharacterContinuitySection
          entry={entry}
          timeline={timeline}
          loading={timelineLoading}
          error={timelineError}
        />
      ) : null}

      {action === 'publish' && entry.draftVersion ? (
        <div className="ledger-action-box">
          <strong>发布草稿 v{entry.draftVersion.versionNo}？</strong>
          <p>
            发布后该快照成为生效版本，历史版本保留；已发布版本不可直接修改，后续修改会生成新草稿。
          </p>
          <div className="ledger-action-buttons">
            <button type="button" className="button button-quiet" onClick={() => onSetAction(null)}>
              取消
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={publishPending}
              onClick={onPublish}
            >
              {publishPending ? '发布中…' : '确认发布'}
            </button>
          </div>
        </div>
      ) : null}

      {action === 'archive' ? (
        <div className="ledger-action-box ledger-action-danger">
          <strong>归档「{entry.name}」？</strong>
          <p>
            归档后默认列表不再显示，名称可被新条目复用；历史版本全部保留。归档不会删除审计记录。
          </p>
          {hasDraft ? (
            <label className="provider-check">
              <input
                type="checkbox"
                checked={discardDraft}
                onChange={(event) => onDiscardDraftChange(event.target.checked)}
              />
              <span>
                我确认丢弃未发布草稿 v{entry.draftVersion!.versionNo}（草稿版本仍会留在历史中）
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>归档原因（可选）</span>
            <textarea
              value={archiveReason}
              rows={2}
              maxLength={1000}
              placeholder="例如：世界观重做，旧条目停用"
              onChange={(event) => onArchiveReasonChange(event.target.value)}
            />
          </label>
          <div className="ledger-action-buttons">
            <button type="button" className="button button-quiet" onClick={() => onSetAction(null)}>
              取消
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={archivePending || (hasDraft && !discardDraft)}
              onClick={onArchive}
            >
              {archivePending ? '归档中…' : '确认归档'}
            </button>
          </div>
        </div>
      ) : null}

      <section className="ledger-section">
        <div className="ledger-section-head">
          <div>
            <p className="eyebrow">审计留痕</p>
            <h4>版本历史 · {versions.length}</h4>
          </div>
          <span className="muted">只追加 · 不删除</span>
        </div>
        {versionsLoading ? (
          <p className="empty-state">正在读取版本历史……</p>
        ) : versionsError ? (
          <div className="modal-error">版本读取失败：{errorText(versionsError)}</div>
        ) : versions.length === 0 ? (
          <p className="empty-state">还没有版本记录。</p>
        ) : (
          <ul className="ledger-version-list">
            {versions.map((version, index) => {
              const previous = versions[index + 1] ?? null;
              const isCurrent = version.id === entry.currentVersion?.id;
              const isDraft = version.id === entry.draftVersion?.id;
              const canRollback =
                editable &&
                !isCurrent &&
                !isDraft &&
                !(rollbackPending && rollbackVersionNo === version.versionNo);
              return (
                <li key={version.id} className="ledger-version-row">
                  <div className="ledger-version-head">
                    <span className="ledger-version-no">v{version.versionNo}</span>
                    {isCurrent ? <Badge tone="green">生效中</Badge> : null}
                    {isDraft ? <Badge tone="amber">当前草稿</Badge> : null}
                    <span className="muted">
                      {version.createdBy?.name ?? '系统'} · {formatDateTime(version.createdAt)}
                    </span>
                  </div>
                  {version.changeSummary ? (
                    <p className="ledger-version-summary">{version.changeSummary}</p>
                  ) : null}
                  <div className="ledger-version-actions">
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => onToggleCompare(version.id)}
                    >
                      {compareVersionId === version.id
                        ? '收起差异'
                        : previous
                          ? `对比 v${previous.versionNo}`
                          : '查看初始内容'}
                    </button>
                    {canRollback ? (
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() => onStartRollback(version.versionNo)}
                      >
                        回滚到此版
                      </button>
                    ) : null}
                  </div>
                  {compareVersionId === version.id ? (
                    <div className="ledger-version-diff">
                      <p className="muted">
                        {previous
                          ? `v${previous.versionNo} → v${version.versionNo}`
                          : `v${version.versionNo} 初始快照`}
                      </p>
                      <LedgerDiff
                        rows={diffLedgerSnapshots(
                          previous?.snapshot ?? null,
                          version.snapshot,
                          chapterLabel,
                        )}
                        emptyText="与上一版相比没有字段变化。"
                      />
                    </div>
                  ) : null}
                  {rollbackVersionNo === version.versionNo ? (
                    <div className="ledger-action-box">
                      <strong>从 v{version.versionNo} 创建回滚草稿</strong>
                      <p>
                        回滚不会直接改变生效版本，而是生成一份新草稿；发布后才生效。当前未发布草稿会被新草稿取代，旧草稿仍保留在版本历史中。
                      </p>
                      <label className="field">
                        <span>回滚原因（至少 4 个字）</span>
                        <input
                          value={rollbackReason}
                          maxLength={1000}
                          placeholder="例如：恢复旧的王城位置设定"
                          onChange={(event) => onRollbackReasonChange(event.target.value)}
                        />
                      </label>
                      <div className="ledger-action-buttons">
                        <button
                          type="button"
                          className="button button-quiet"
                          onClick={onCancelRollback}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={rollbackPending || rollbackReason.trim().length < 4}
                          onClick={onRollback}
                        >
                          {rollbackPending ? '生成中…' : '生成回滚草稿'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!canWrite ? (
        <p className="muted ledger-readonly-hint">
          审阅者与读者可查看设定与历史版本，但不能编辑、发布、归档或回滚。只有所有者、主笔与作者可以写入。
        </p>
      ) : null}
    </div>
  );
}

function CharacterPayloadView({
  payload,
  chapterLabel,
  chapterNumber,
}: {
  payload: LedgerCharacterPayload;
  chapterLabel: (chapterId: string | null) => string;
  chapterNumber: (chapterId: string) => number;
}) {
  const facts: [string, string][] = [
    ['身份', payload.role],
    ['阵营', payload.faction],
    ['外貌', payload.appearance],
    ['性格', payload.personality],
    ['目标', payload.goals],
    ['能力', payload.abilities],
    ['语言风格', payload.speechStyle],
  ];
  const states = [...payload.states].sort(
    (left, right) => chapterNumber(left.asOfChapterId) - chapterNumber(right.asOfChapterId),
  );

  return (
    <div className="ledger-character">
      <dl className="ledger-character-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || '未填写'}</dd>
          </div>
        ))}
      </dl>

      <div className="ledger-character-block">
        <h5>人物关系</h5>
        {payload.relationships.length === 0 ? (
          <p className="empty-state">未登记关系。</p>
        ) : (
          <ul className="ledger-relationship-view">
            {payload.relationships.map((relationship, index) => (
              <li key={`${relationship.name}-${relationship.relation}-${index}`}>
                <strong>{relationship.name}</strong>
                <span>{relationship.relation}</span>
                {relationship.notes ? <p>{relationship.notes}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ledger-character-block">
        <h5>状态时间线</h5>
        {states.length === 0 ? (
          <p className="empty-state">未登记状态时间线；写作台不会显示该角色的状态。</p>
        ) : (
          <ol className="ledger-timeline">
            {states.map((state) => (
              <li key={state.asOfChapterId}>
                <div className="ledger-timeline-head">
                  <strong>{chapterLabel(state.asOfChapterId)}</strong>
                  <Badge
                    tone={
                      state.life === 'alive' ? 'green' : state.life === 'dead' ? 'red' : 'neutral'
                    }
                  >
                    {CHARACTER_LIFE_LABELS[state.life]}
                  </Badge>
                </div>
                <div className="ledger-payload-facts">
                  {state.location ? <span>地点：{state.location}</span> : null}
                  {state.possessions ? <span>持有：{state.possessions}</span> : null}
                </div>
                {state.knowledge ? <p>已知：{state.knowledge}</p> : null}
                {state.relationshipChanges ? (
                  <p>关系变化：{state.relationshipChanges}</p>
                ) : null}
                {!state.location &&
                !state.possessions &&
                !state.knowledge &&
                !state.relationshipChanges ? (
                  <p className="muted">只登记了生死状态。</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const CHARACTER_WARNING_LABELS: Record<LedgerCharacterTimeline['warnings'][number]['code'], string> = {
  dead_revived: '死亡后复活',
  dead_appears_later: '死亡后仍出场',
  relationship_conflict: '关系描述冲突',
};

function CharacterContinuitySection({
  entry,
  timeline,
  loading,
  error,
}: {
  entry: LedgerEntryDetail;
  timeline: LedgerCharacterTimeline | null;
  loading: boolean;
  error: unknown;
}) {
  return (
    <section className="ledger-section">
      <div className="ledger-section-head">
        <div>
          <p className="eyebrow">连续性检查</p>
          <h4>出场与矛盾警告</h4>
        </div>
        {timeline ? <Badge tone="neutral">基于生效 v{timeline.versionNo}</Badge> : null}
      </div>

      {entry.status === 'archived' ? (
        <p className="empty-state">角色已归档，不再提供写作台上下文；历史版本与状态记录仍保留。</p>
      ) : !entry.currentVersion ? (
        <div className="inline-warning">
          角色尚未发布。出场扫描与矛盾警告在发布后基于生效版本生成；当前只展示草稿里登记的角色卡与状态时间线。
        </div>
      ) : loading ? (
        <p className="empty-state">正在扫描当前正典并检查时间线……</p>
      ) : error ? (
        <div className="modal-error">连续性检查失败：{errorText(error)}</div>
      ) : timeline ? (
        <div className="ledger-continuity">
          <div className="ledger-continuity-facts">
            <span>
              首次出场：
              {timeline.firstAppearance
                ? `第 ${timeline.firstAppearance.number} 章 · ${timeline.firstAppearance.title}`
                : '未扫描到'}
            </span>
            <span>
              最近出场：
              {timeline.latestAppearance
                ? `第 ${timeline.latestAppearance.number} 章 · ${timeline.latestAppearance.title}`
                : '未扫描到'}
            </span>
            <span>扫描范围：当前正典正文</span>
          </div>

          {timeline.appearances.length > 0 ? (
            <ul className="ledger-appearance-list">
              {timeline.appearances.map((appearance) => (
                <li key={appearance.chapter.id}>
                  <span>
                    第 {appearance.chapter.number} 章 · {appearance.chapter.title}
                  </span>
                  <span className="muted">命中 {appearance.matches} 次</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">当前正典正文中没有扫描到角色名称或别名。</p>
          )}

          {timeline.warnings.length === 0 ? (
            <p className="ledger-continuity-ok">
              未发现时间线或出场矛盾。该结论只覆盖当前正典正文与已登记状态，不代表绝对无误。
            </p>
          ) : (
            <ul className="ledger-warning-list">
              {timeline.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>
                  <Badge tone="amber">{CHARACTER_WARNING_LABELS[warning.code]}</Badge>
                  <p>{warning.message}</p>
                </li>
              ))}
            </ul>
          )}

          <p className="muted">
            警告默认不阻断发布；请人工确认是回忆、转述、尸体提及还是时间线错误。AI 只能提示，不能代替人工确认。
            {entry.draftVersion
              ? ` 当前存在草稿 v${entry.draftVersion.versionNo}，以上结果仍基于生效版本。`
              : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function LedgerDiff({ rows, emptyText }: { rows: LedgerFieldDiff[]; emptyText: string }) {
  if (rows.length === 0) return <p className="empty-state">{emptyText}</p>;
  return (
    <div className="ledger-diff">
      <div className="ledger-diff-head">
        <span>字段</span>
        <span>之前</span>
        <span>之后</span>
      </div>
      {rows.map((row) => (
        <div key={row.label} className="ledger-diff-row">
          <span className="ledger-diff-label">{row.label}</span>
          <div className="ledger-diff-value ledger-diff-before">{row.before}</div>
          <div className="ledger-diff-value ledger-diff-after">{row.after}</div>
        </div>
      ))}
    </div>
  );
}
