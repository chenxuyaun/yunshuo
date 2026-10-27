import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BodyPolicy,
  ChapterDetail,
  ChapterPlanStateView,
  MeResponse,
  PlanRevisionView,
} from '@yunshuo/contracts';
import type { ChapterPlanDocument } from '@yunshuo/domain';
import { emptyChapterPlanDocument } from '@yunshuo/domain/plan';
import { ApiError, listPlanRevisions, saveChapterPlan } from '../api.js';
import {
  beatsInput,
  keywordInput,
  planDiffLines,
  planFromFields,
} from '../plan.js';

type Tab = 'plan' | 'history';

function formatError(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

function planFacts(plan: ChapterPlanDocument): string[] {
  return [
    `摘要：${plan.summary || '未填写'}`,
    `节拍：${plan.beats.length > 0 ? plan.beats.join(' / ') : '未设置'}`,
    `核心人物：${plan.requiredEntities.length > 0 ? plan.requiredEntities.join('、') : '未设置'}`,
    `目标关键词：${plan.goalKeywords.length > 0 ? plan.goalKeywords.join('、') : '未设置'}`,
    `阻碍关键词：${plan.obstacleKeywords.length > 0 ? plan.obstacleKeywords.join('、') : '未设置'}`,
  ];
}

interface ConflictProps {
  serverRevision: number;
  serverPlan: ChapterPlanDocument;
  minePlan: ChapterPlanDocument;
  onLoadLatest: () => void;
  onKeepMine: () => void;
}

export function PlanConflictPanel({
  serverRevision,
  serverPlan,
  minePlan,
  onLoadLatest,
  onKeepMine,
}: ConflictProps) {
  return (
    <section className="plan-conflict">
      <p className="eyebrow">保存冲突</p>
      <h3>服务端已经是 r{serverRevision}</h3>
      <p className="muted">
        计划在你打开之后被改过。可以载入服务端版本重填，或保留当前输入并把它当作新的基线。
      </p>
      <div className="plan-conflict-columns">
        <div>
          <strong>服务端计划 r{serverRevision}</strong>
          <ul>
            {planFacts(serverPlan).map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
        <div>
          <strong>我的输入</strong>
          <ul>
            {planFacts(minePlan).map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="plan-conflict-actions">
        <button type="button" className="button button-primary button-small" onClick={onLoadLatest}>
          载入最新再改
        </button>
        <button type="button" className="button button-quiet button-small" onClick={onKeepMine}>
          基于最新版保留我的输入
        </button>
      </div>
    </section>
  );
}

interface HistoryProps {
  revisions: PlanRevisionView[];
  currentRevision: number;
}

function revisionPolicyText(policy: BodyPolicy | null): string | null {
  if (policy === 'plan_only') return '仅修改计划';
  if (policy === 'mark_body_for_revision') return '标记正文待改';
  return null;
}

export function PlanHistoryList({ revisions, currentRevision }: HistoryProps) {
  if (revisions.length === 0) {
    return <p className="muted">还没有计划历史。第一次保存后会记录逐版差异。</p>;
  }
  return (
    <ol className="plan-history">
      {revisions.map((revision, index) => {
        const older = revisions[index + 1]?.plan ?? emptyChapterPlanDocument();
        const policy = revisionPolicyText(revision.bodyPolicy);
        return (
          <li
            key={revision.revision}
            className={`plan-history-item${revision.revision === currentRevision ? ' is-current' : ''}`}
          >
            <div className="plan-history-head">
              <strong>r{revision.revision}</strong>
              {revision.revision === currentRevision ? (
                <span className="badge badge-green">当前</span>
              ) : null}
              <span className="muted">
                {new Date(revision.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
              <span className="muted">{revision.createdByName ?? '未知操作者'}</span>
              {policy ? <span className="plan-history-policy">{policy}</span> : null}
            </div>
            <ul className="plan-history-diff">
              {planDiffLines(older, revision.plan).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

interface Props {
  me: MeResponse;
  chapter: ChapterDetail;
  initialTab?: Tab;
  onClose: () => void;
  onSaved?: (state: ChapterPlanStateView) => void;
}

export function PlanDialog({ me, chapter, initialTab = 'plan', onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [summary, setSummary] = useState(chapter.plan.summary);
  const [beats, setBeats] = useState(beatsInput(chapter.plan.beats));
  const [entities, setEntities] = useState(keywordInput(chapter.plan.requiredEntities));
  const [goals, setGoals] = useState(keywordInput(chapter.plan.goalKeywords));
  const [obstacles, setObstacles] = useState(keywordInput(chapter.plan.obstacleKeywords));
  const [bodyPolicy, setBodyPolicy] = useState<BodyPolicy | null>(null);
  const [baseRevision, setBaseRevision] = useState(chapter.planRevision);
  const [conflict, setConflict] = useState<{
    serverRevision: number;
    serverPlan: ChapterPlanDocument;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasCanon = chapter.currentVersion !== null;
  const roleCanWrite = me.role === 'owner' || me.role === 'lead' || me.role === 'author';
  const readOnly = !roleCanWrite || chapter.status === 'archived';

  const historyQuery = useQuery({
    queryKey: ['planRevisions', chapter.id],
    queryFn: () => listPlanRevisions(chapter.id),
    enabled: tab === 'history',
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, saving]);

  const minePlan = planFromFields({ summary, beats, entities, goals, obstacles });

  async function handleSave(): Promise<void> {
    if (readOnly) return;
    if (hasCanon && bodyPolicy === null) {
      setError('本章已有正典，请选择“仅修改计划”或“标记正文待改”后再保存。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const state = await saveChapterPlan(chapter.id, {
        plan: minePlan,
        basePlanRevision: baseRevision,
        ...(hasCanon && bodyPolicy ? { bodyPolicy } : {}),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] }),
        queryClient.invalidateQueries({ queryKey: ['chapters'] }),
        queryClient.invalidateQueries({ queryKey: ['planRevisions', chapter.id] }),
      ]);
      onSaved?.(state);
      onClose();
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.code === 'PLAN_REVISION_CONFLICT') {
        const details = (saveError.details ?? {}) as {
          planRevision?: number;
          plan?: unknown;
        };
        setConflict({
          serverRevision: details.planRevision ?? baseRevision + 1,
          serverPlan: (details.plan as ChapterPlanDocument | undefined) ?? emptyChapterPlanDocument(),
        });
        setError(`${saveError.message}（${saveError.code}）`);
      } else {
        setError(formatError(saveError));
      }
    } finally {
      setSaving(false);
    }
  }

  function applyServerPlan(): void {
    if (!conflict) return;
    setSummary(conflict.serverPlan.summary);
    setBeats(beatsInput(conflict.serverPlan.beats));
    setEntities(keywordInput(conflict.serverPlan.requiredEntities));
    setGoals(keywordInput(conflict.serverPlan.goalKeywords));
    setObstacles(keywordInput(conflict.serverPlan.obstacleKeywords));
    setBaseRevision(conflict.serverRevision);
    setConflict(null);
    setError(null);
  }

  function keepMine(): void {
    if (!conflict) return;
    setBaseRevision(conflict.serverRevision);
    setConflict(null);
    setError(`已换用服务端 r${conflict.serverRevision} 作为基线；你的输入保持不变，再次保存即可。`);
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="modal modal-plan"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-dialog-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">计划 r{chapter.planRevision} · 改计划不写正文</p>
            <h2 id="plan-dialog-title">编辑本章计划</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} disabled={saving}>
            关闭
          </button>
        </header>

        <div className="modal-body plan-body">
          <div className="plan-tabs" role="tablist" aria-label="计划视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'plan'}
              className={`plan-tab${tab === 'plan' ? ' is-active' : ''}`}
              onClick={() => setTab('plan')}
            >
              计划
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={`plan-tab${tab === 'history' ? ' is-active' : ''}`}
              onClick={() => setTab('history')}
            >
              历史
            </button>
          </div>

          {tab === 'plan' ? (
            <>
              <p className="muted">
                摘要与节拍供人与 AI 参考；只有核心人物、目标关键词、阻碍关键词会进入门禁上下文。
                保存计划不需要编辑租约，也不会改正文、草稿或版本。
              </p>

              <section className="plan-form">
                <label className="field">
                  <span>摘要</span>
                  <textarea
                    rows={4}
                    maxLength={2000}
                    value={summary}
                    disabled={readOnly || saving}
                    placeholder="一两句话写清本章发生什么"
                    onChange={(event) => setSummary(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>节拍（每行一条，最多 20 条）</span>
                  <textarea
                    rows={6}
                    value={beats}
                    disabled={readOnly || saving}
                    placeholder={'林默赶到旧宅\n追兵封住巷口\n他用血补完封印'}
                    onChange={(event) => setBeats(event.target.value)}
                  />
                </label>
                <div className="field-grid">
                  <label className="field">
                    <span>核心人物（顿号或逗号分隔）</span>
                    <input
                      value={entities}
                      disabled={readOnly || saving}
                      placeholder="林默、老周"
                      onChange={(event) => setEntities(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>目标关键词</span>
                    <input
                      value={goals}
                      disabled={readOnly || saving}
                      placeholder="封印"
                      onChange={(event) => setGoals(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>阻碍关键词</span>
                    <input
                      value={obstacles}
                      disabled={readOnly || saving}
                      placeholder="追兵"
                      onChange={(event) => setObstacles(event.target.value)}
                    />
                  </label>
                </div>
              </section>

              {hasCanon ? (
                <fieldset className="plan-policy">
                  <legend>
                    本章已有正典 v{chapter.currentVersion?.versionNo}，请选择改计划后的正文策略（必选）
                  </legend>
                  <label>
                    <input
                      type="radio"
                      name="bodyPolicy"
                      value="plan_only"
                      checked={bodyPolicy === 'plan_only'}
                      disabled={readOnly || saving}
                      onChange={() => setBodyPolicy('plan_only')}
                    />
                    仅修改计划：正文、草稿与正典都不动
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="bodyPolicy"
                      value="mark_body_for_revision"
                      checked={bodyPolicy === 'mark_body_for_revision'}
                      disabled={readOnly || saving}
                      onChange={() => setBodyPolicy('mark_body_for_revision')}
                    />
                    标记正文待改：正典不动，写作台会出现“待改稿”横幅
                  </label>
                </fieldset>
              ) : (
                <p className="muted">本章还没有正典正文，保存计划不需要选择正文策略。</p>
              )}

              {conflict ? (
                <PlanConflictPanel
                  serverRevision={conflict.serverRevision}
                  serverPlan={conflict.serverPlan}
                  minePlan={minePlan}
                  onLoadLatest={applyServerPlan}
                  onKeepMine={keepMine}
                />
              ) : null}

              {error ? <div className="modal-error">{error}</div> : null}
            </>
          ) : (
            <>
              <p className="muted">按版本倒序列出每次保存；差异只对比相邻版本，不展示正文。</p>
              {historyQuery.isLoading ? <p className="muted">正在读取计划历史……</p> : null}
              {historyQuery.isError ? (
                <div className="modal-error">{formatError(historyQuery.error)}</div>
              ) : null}
              {historyQuery.data ? (
                <PlanHistoryList
                  revisions={historyQuery.data.revisions}
                  currentRevision={chapter.planRevision}
                />
              ) : null}
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>
            取消
          </button>
          {roleCanWrite && chapter.status !== 'archived' ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleSave()}
              disabled={saving || (hasCanon && bodyPolicy === null)}
            >
              {saving ? '保存中…' : '保存计划'}
            </button>
          ) : (
            <span className="muted">
              {chapter.status === 'archived' ? '已归档章节不能编辑计划' : '当前角色只读'}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
