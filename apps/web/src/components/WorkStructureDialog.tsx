import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChapterListItem, MeResponse, WorkView } from '@yunshuo/contracts';
import {
  ApiError,
  createChapter,
  createVolume,
  createWork,
  listChapters,
  listWorks,
  renameVolume,
  renameWork,
  reorderVolumes,
  updateChapterMeta,
} from '../api.js';

function formatError(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export interface WorkStructureBodyProps {
  canManage: boolean;
  works: WorkView[];
  chapters: ChapterListItem[];
  selectedWorkId: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onSelectWork: (workId: string) => void;
  onCreateWork: (title: string) => void;
  onRenameWork: (title: string) => void;
  onCreateVolume: (title: string) => void;
  onRenameVolume: (volumeId: string, title: string) => void;
  onMoveVolume: (volumeId: string, direction: -1 | 1) => void;
  onCreateChapter: (input: { volumeId: string; title: string; insertAfterChapterId?: string }) => void;
  onRenameChapter: (chapterId: string, title: string) => void;
  onMoveChapter: (chapterId: string, volumeId: string) => void;
}

export function WorkStructureBody({
  canManage,
  works,
  chapters,
  selectedWorkId,
  loading,
  error,
  busy,
  onSelectWork,
  onCreateWork,
  onRenameWork,
  onCreateVolume,
  onRenameVolume,
  onMoveVolume,
  onCreateChapter,
  onRenameChapter,
  onMoveChapter,
}: WorkStructureBodyProps) {
  const [newWorkTitle, setNewWorkTitle] = useState('');
  const [workTitleDraft, setWorkTitleDraft] = useState('');
  const [newVolumeTitle, setNewVolumeTitle] = useState('');
  const [renamingVolume, setRenamingVolume] = useState<{ id: string; title: string } | null>(null);
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [chapterVolumeId, setChapterVolumeId] = useState('');
  const [insertAfter, setInsertAfter] = useState<string | null>(null);
  const [renamingChapter, setRenamingChapter] = useState<{ id: string; title: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedWork = works.find((work) => work.id === selectedWorkId) ?? null;
  const workChapters = selectedWork
    ? chapters.filter((chapter) => chapter.workId === selectedWork.id)
    : [];

  useEffect(() => {
    setWorkTitleDraft(selectedWork?.title ?? '');
    setNewChapterTitle('');
    setChapterVolumeId(selectedWork?.volumes[0]?.id ?? '');
    setInsertAfter(null);
    setRenamingVolume(null);
    setRenamingChapter(null);
    setNewVolumeTitle('');
    setFormError(null);
  }, [selectedWork?.id, selectedWork?.title, selectedWork?.volumes.length]);

  function handleCreateWork(): void {
    const title = newWorkTitle.trim();
    if (title === '') {
      setFormError('请填写作品名。');
      return;
    }
    setFormError(null);
    setNewWorkTitle('');
    onCreateWork(title);
  }

  function handleRenameWork(): void {
    const title = workTitleDraft.trim();
    if (title === '') {
      setFormError('作品名不能为空。');
      return;
    }
    if (!selectedWork || title === selectedWork.title) return;
    setFormError(null);
    onRenameWork(title);
  }

  function handleCreateVolume(): void {
    const title = newVolumeTitle.trim();
    if (title === '') {
      setFormError('请填写卷名。');
      return;
    }
    setFormError(null);
    setNewVolumeTitle('');
    onCreateVolume(title);
  }

  function handleRenameVolume(): void {
    if (!renamingVolume) return;
    const title = renamingVolume.title.trim();
    if (title === '') {
      setFormError('卷名不能为空。');
      return;
    }
    setFormError(null);
    setRenamingVolume(null);
    onRenameVolume(renamingVolume.id, title);
  }

  function handleCreateChapter(): void {
    const title = newChapterTitle.trim();
    const volumeId = chapterVolumeId || selectedWork?.volumes[0]?.id || '';
    if (title === '') {
      setFormError('请填写章节标题。');
      return;
    }
    if (volumeId === '') {
      setFormError('请先建一个卷，章节必须落在某个卷里。');
      return;
    }
    setFormError(null);
    setNewChapterTitle('');
    onCreateChapter({
      volumeId,
      title,
      ...(insertAfter ? { insertAfterChapterId: insertAfter } : {}),
    });
    setInsertAfter(null);
  }

  function handleRenameChapter(): void {
    if (!renamingChapter) return;
    const title = renamingChapter.title.trim();
    if (title === '') {
      setFormError('章节标题不能为空。');
      return;
    }
    setFormError(null);
    setRenamingChapter(null);
    onRenameChapter(renamingChapter.id, title);
  }

  function moveVolume(volumeId: string, direction: -1 | 1): void {
    onMoveVolume(volumeId, direction);
  }

  const insertAfterChapter = insertAfter
    ? workChapters.find((chapter) => chapter.id === insertAfter) ?? null
    : null;

  return (
    <div className="structure-body">
      {error ? <div className="modal-error">{error}</div> : null}
      {formError ? <div className="modal-error">{formError}</div> : null}
      {loading ? <p className="muted">正在读取作品与章节结构……</p> : null}
      {!canManage ? (
        <p className="muted">当前角色只读：可以查看作品、卷与章节，不能新建或调整。</p>
      ) : null}

      <section className="structure-works">
        <div className="structure-head">
          <h3>作品</h3>
          <span className="muted">{works.length} 部</span>
        </div>
        {works.length === 0 ? (
          <p className="muted">还没有作品。先新建一部作品，再建卷与章节。</p>
        ) : (
          <div className="structure-work-list">
            {works.map((work) => (
              <button
                key={work.id}
                type="button"
                className={`structure-work${work.id === selectedWorkId ? ' is-active' : ''}`}
                onClick={() => onSelectWork(work.id)}
              >
                <strong>{work.title}</strong>
                <span className="muted">
                  {work.volumes.length} 卷 · {work.chapterCount} 章 · 正典 {work.canonCount}
                </span>
              </button>
            ))}
          </div>
        )}
        {canManage ? (
          <div className="structure-inline-form">
            <input
              value={newWorkTitle}
              maxLength={200}
              placeholder="新作品名"
              disabled={busy}
              onChange={(event) => setNewWorkTitle(event.target.value)}
            />
            <button
              type="button"
              className="button button-primary button-small"
              disabled={busy}
              onClick={handleCreateWork}
            >
              新建作品
            </button>
          </div>
        ) : null}
      </section>

      {selectedWork ? (
        <>
          <section className="structure-work-meta">
            <div className="structure-head">
              <h3>{selectedWork.title}</h3>
              <span className="muted">
                创建于 {new Date(selectedWork.createdAt).toLocaleDateString('zh-CN')}
              </span>
            </div>
            {canManage ? (
              <div className="structure-inline-form">
                <input
                  value={workTitleDraft}
                  maxLength={200}
                  disabled={busy}
                  aria-label="作品名"
                  onChange={(event) => setWorkTitleDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="button button-quiet button-small"
                  disabled={busy || workTitleDraft.trim() === selectedWork.title}
                  onClick={handleRenameWork}
                >
                  改名
                </button>
              </div>
            ) : null}
          </section>

          <section className="structure-volumes">
            <div className="structure-head">
              <h3>卷</h3>
              <span className="muted">卷号影响目录分组；调整顺序会重排卷号</span>
            </div>
            {selectedWork.volumes.length === 0 ? (
              <p className="muted">还没有卷。</p>
            ) : (
              <ul className="structure-volume-list">
                {selectedWork.volumes.map((volume, index) => (
                  <li key={volume.id} className="structure-volume">
                    <span className="mono">第 {volume.number} 卷</span>
                    {renamingVolume?.id === volume.id ? (
                      <span className="structure-inline-form">
                        <input
                          value={renamingVolume.title}
                          maxLength={200}
                          disabled={busy}
                          aria-label="卷名"
                          onChange={(event) =>
                            setRenamingVolume({ id: volume.id, title: event.target.value })
                          }
                        />
                        <button
                          type="button"
                          className="button button-primary button-small"
                          disabled={busy}
                          onClick={handleRenameVolume}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={busy}
                          onClick={() => setRenamingVolume(null)}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <span className="structure-title">{volume.title}</span>
                    )}
                    {canManage ? (
                      <span className="structure-row-actions">
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          aria-label={`上移第 ${volume.number} 卷`}
                          title="上移"
                          disabled={busy || index === 0}
                          onClick={() => moveVolume(volume.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          aria-label={`下移第 ${volume.number} 卷`}
                          title="下移"
                          disabled={busy || index === selectedWork.volumes.length - 1}
                          onClick={() => moveVolume(volume.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={busy}
                          onClick={() => setRenamingVolume({ id: volume.id, title: volume.title })}
                        >
                          改名
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <div className="structure-inline-form">
                <input
                  value={newVolumeTitle}
                  maxLength={200}
                  placeholder="新卷名（卷号自动取下一个）"
                  disabled={busy}
                  onChange={(event) => setNewVolumeTitle(event.target.value)}
                />
                <button
                  type="button"
                  className="button button-quiet button-small"
                  disabled={busy}
                  onClick={handleCreateVolume}
                >
                  新建卷
                </button>
              </div>
            ) : null}
          </section>

          <section className="structure-chapters">
            <div className="structure-head">
              <h3>章节</h3>
              <span className="muted">章号按全书排序；插入或移卷会重排章号，正典不改</span>
            </div>
            {workChapters.length === 0 ? (
              <p className="muted">这部作品还没有章节。</p>
            ) : (
              <ul className="structure-chapter-list">
                {workChapters.map((chapter) => {
                  const volume = selectedWork.volumes.find((item) => item.id === chapter.volumeId);
                  return (
                    <li key={chapter.id} className="structure-chapter">
                      <span className="mono">第 {chapter.number} 章</span>
                      {renamingChapter?.id === chapter.id ? (
                        <span className="structure-inline-form">
                          <input
                            value={renamingChapter.title}
                            maxLength={200}
                            disabled={busy}
                            aria-label="章节标题"
                            onChange={(event) =>
                              setRenamingChapter({ id: chapter.id, title: event.target.value })
                            }
                          />
                          <button
                            type="button"
                            className="button button-primary button-small"
                            disabled={busy}
                            onClick={handleRenameChapter}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            disabled={busy}
                            onClick={() => setRenamingChapter(null)}
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <span className="structure-title">{chapter.title}</span>
                      )}
                      <span className="muted">{volume ? volume.title : '卷已不存在'}</span>
                      <span className="structure-flags">
                        {chapter.bodyNeedsRevision ? (
                          <span className="chapter-flag">待改稿</span>
                        ) : null}
                        {chapter.status === 'canon' ? (
                          <span className="muted">正典 v{chapter.currentVersionNo}</span>
                        ) : (
                          <span className="muted">尚无正典</span>
                        )}
                      </span>
                      {canManage ? (
                        <span className="structure-row-actions">
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            disabled={busy}
                            title="把新章插在这一章之后"
                            onClick={() => {
                              setInsertAfter(chapter.id);
                              setChapterVolumeId(chapter.volumeId);
                            }}
                          >
                            在此后插入
                          </button>
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            disabled={busy}
                            onClick={() => setRenamingChapter({ id: chapter.id, title: chapter.title })}
                          >
                            改名
                          </button>
                          <select
                            aria-label={`把第 ${chapter.number} 章移到其他卷`}
                            value=""
                            disabled={busy || selectedWork.volumes.length < 2}
                            onChange={(event) => {
                              if (event.target.value) onMoveChapter(chapter.id, event.target.value);
                            }}
                          >
                            <option value="">移卷…</option>
                            {selectedWork.volumes
                              .filter((item) => item.id !== chapter.volumeId)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.title}
                                </option>
                              ))}
                          </select>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {canManage ? (
              <div className="structure-chapter-form">
                <div className="structure-head">
                  <h4>新建章节</h4>
                  {insertAfterChapter ? (
                    <span className="muted">
                      插在第 {insertAfterChapter.number} 章之后
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() => setInsertAfter(null)}
                      >
                        改为卷末
                      </button>
                    </span>
                  ) : (
                    <span className="muted">默认插在所选卷的卷末</span>
                  )}
                </div>
                <div className="structure-inline-form">
                  <select
                    aria-label="新章节所属卷"
                    value={chapterVolumeId || selectedWork.volumes[0]?.id || ''}
                    disabled={busy || selectedWork.volumes.length === 0}
                    onChange={(event) => setChapterVolumeId(event.target.value)}
                  >
                    {selectedWork.volumes.map((volume) => (
                      <option key={volume.id} value={volume.id}>
                        第 {volume.number} 卷 · {volume.title}
                      </option>
                    ))}
                  </select>
                  <input
                    value={newChapterTitle}
                    maxLength={200}
                    placeholder="新章节标题"
                    disabled={busy}
                    onChange={(event) => setNewChapterTitle(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button button-primary button-small"
                    disabled={busy || selectedWork.volumes.length === 0}
                    onClick={handleCreateChapter}
                  >
                    新建章节
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : (
        !loading && works.length > 0 ? <p className="muted">先选择一个作品。</p> : null
      )}
    </div>
  );
}

interface DialogProps {
  me: MeResponse;
  onClose: () => void;
  onOpenChapter?: (chapterId: string) => void;
}

export function WorkStructureDialog({ me, onClose, onOpenChapter }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = me.role === 'owner' || me.role === 'lead' || me.role === 'author';

  const worksQuery = useQuery({ queryKey: ['works'], queryFn: listWorks });
  const chaptersQuery = useQuery({ queryKey: ['chapters'], queryFn: listChapters });
  const works = worksQuery.data?.works ?? [];

  useEffect(() => {
    if (selectedWorkId && works.some((work) => work.id === selectedWorkId)) return;
    setSelectedWorkId(works[0]?.id ?? null);
  }, [works, selectedWorkId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, busy]);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['works'] }),
        queryClient.invalidateQueries({ queryKey: ['chapters'] }),
      ]);
      return result;
    } catch (actionError) {
      setError(formatError(actionError));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateWork(title: string): Promise<void> {
    const work = await run(() => createWork({ title }));
    if (work) setSelectedWorkId(work.id);
  }

  function handleMoveVolume(volumeId: string, direction: -1 | 1): void {
    const selected = works.find((work) => work.id === selectedWorkId);
    if (!selected) return;
    const index = selected.volumes.findIndex((volume) => volume.id === volumeId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= selected.volumes.length) return;
    const ids = selected.volumes.map((volume) => volume.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    void run(() => reorderVolumes(selected.id, { volumeIds: ids }));
  }

  const loading = worksQuery.isLoading || chaptersQuery.isLoading;
  const queryError = worksQuery.isError
    ? formatError(worksQuery.error)
    : chaptersQuery.isError
      ? formatError(chaptersQuery.error)
      : null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal modal-structure"
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">作品与卷 · 开书结构</p>
            <h2 id="structure-title">作品与章节结构</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <p className="team-intro">
            这里只调整作品、卷与章节的归属和顺序：不写正文、不补造门禁结论，也不删章节。
            章号按全书重排，已有正典的版本号与正文不变。
          </p>
          <WorkStructureBody
            canManage={canManage}
            works={works}
            chapters={chaptersQuery.data ?? []}
            selectedWorkId={selectedWorkId}
            loading={loading}
            error={queryError}
            busy={busy}
            onSelectWork={setSelectedWorkId}
            onCreateWork={(title) => void handleCreateWork(title)}
            onRenameWork={(title) => {
              if (selectedWorkId) void run(() => renameWork(selectedWorkId, { title }));
            }}
            onCreateVolume={(title) => {
              if (selectedWorkId) void run(() => createVolume(selectedWorkId, { title }));
            }}
            onRenameVolume={(volumeId, title) => {
              void run(() => renameVolume(volumeId, { title }));
            }}
            onMoveVolume={handleMoveVolume}
            onCreateChapter={(input) => {
              if (!selectedWorkId) return;
              void run(() => createChapter(selectedWorkId, input)).then((created) => {
                if (created && onOpenChapter) {
                  onOpenChapter(created.id);
                  onClose();
                }
              });
            }}
            onRenameChapter={(chapterId, title) => {
              void run(() => updateChapterMeta(chapterId, { title }));
            }}
            onMoveChapter={(chapterId, volumeId) => {
              void run(() => updateChapterMeta(chapterId, { volumeId }));
            }}
          />
        </div>

        <footer className="modal-foot">
          <span className="muted">结构写操作只对所有者、主笔、作者开放；计费管理员看不到本页。</span>
          <button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
