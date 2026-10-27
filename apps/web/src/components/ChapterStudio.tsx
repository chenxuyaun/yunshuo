import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiProposalMode,
  AuditReport,
  ChapterDetail,
  CommitResponse,
  GateEvaluationView,
  MeResponse,
  RollbackResponse,
  VersionSummary,
} from '@yunshuo/contracts';
import {
  ApiError,
  abandonRevision,
  acquireLease,
  getVersion,
  releaseLease,
  resolveBodyRevision,
  runAudits,
  runGates,
  saveDraft,
  stageDraft,
  startRevision,
  unstageDraft,
} from '../api.js';
import { countChars, formatClock, shortHash } from '../format.js';
import { planChangedAfterEvidence, planSummaryHeadline } from '../plan.js';
import { DEMO_CHAPTER_NUMBER, DEMO_DRAFT } from '../demo.js';
import { AiProposalPanel } from './AiProposalPanel.js';
import { ChapterStatusBadge } from './Badge.js';
import { GatePanel } from './GatePanel.js';
import { AuditPanel } from './AuditPanel.js';
import { CharacterContextCard } from './CharacterContextCard.js';
import { ChapterLedgerLinksCard } from './ChapterLedgerLinksCard.js';
import { ForeshadowingReminderCard } from './ForeshadowingReminderCard.js';
import { VersionList } from './VersionList.js';
import { IndexStatusCard } from './IndexStatusCard.js';
import { RetrievalPanel } from './RetrievalPanel.js';
import { CommitDialog } from './CommitDialog.js';
import { PlanDialog } from './PlanDialog.js';
import { RollbackDialog } from './RollbackDialog.js';
import { WaiverPanel } from './WaiverPanel.js';

type Busy =
  | 'lease'
  | 'release'
  | 'save'
  | 'gates'
  | 'audit'
  | 'stage'
  | 'unstage'
  | 'revision'
  | 'abandon'
  | 'resolve'
  | null;

interface Notice {
  tone: 'success' | 'error' | 'info';
  title: string;
  body?: string;
}

interface Props {
  me: MeResponse;
  chapter: ChapterDetail;
  onOpenVersion: (versionId: string) => void;
  onOpenChapter: (chapterId: string) => void;
}

const ACTION_LABELS: Record<Exclude<Busy, null>, string> = {
  lease: '取得编辑租约',
  release: '释放编辑租约',
  save: '保存草稿',
  gates: '运行五门禁',
  audit: '运行审计',
  stage: '暂存草稿',
  unstage: '撤回暂存',
  revision: '开始修订',
  abandon: '放弃修订',
  resolve: '确认已处理改稿',
};

function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ChapterStudio({ me, chapter, onOpenVersion, onOpenChapter }: Props) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<VersionSummary | null>(null);
  const [planDialogTab, setPlanDialogTab] = useState<'plan' | 'history' | null>(null);
  const dirtyRef = useRef(false);
  const lastDraftIdRef = useRef<string | null>(chapter.draft?.id ?? null);

  const isCanon = chapter.status === 'canon';
  const isStaged = chapter.status === 'staged';
  const isCommitFailed = chapter.status === 'commit_failed';
  const editableStatus =
    chapter.status === 'planned' || chapter.status === 'writing' || chapter.status === 'revision';
  const roleCanWrite = me.role === 'owner' || me.role === 'lead' || me.role === 'author';
  const leaseMine = chapter.lease?.userId === me.user.id;
  const canEditNow = roleCanWrite && editableStatus && leaseMine;
  const draft = chapter.draft;
  const evaluation = chapter.latestEvaluation;
  const staged = chapter.stagedDraft;
  const canEditPlan = roleCanWrite && chapter.status !== 'archived';
  const planHasContent =
    chapter.plan.summary.trim() !== '' ||
    chapter.plan.beats.length > 0 ||
    chapter.plan.requiredEntities.length > 0 ||
    chapter.plan.goalKeywords.length > 0 ||
    chapter.plan.obstacleKeywords.length > 0;
  const stagedEvidenceAt =
    evaluation && staged && evaluation.contentHash === staged.contentHash
      ? evaluation.createdAt
      : staged?.stagedAt;
  const stagedPlanChanged = stagedEvidenceAt
    ? planChangedAfterEvidence(chapter.planUpdatedAt, stagedEvidenceAt)
    : false;
  const canonUnchangedSinceMark =
    chapter.markedCanonVersionId !== null &&
    chapter.markedCanonVersionId === chapter.currentVersion?.id;

  const currentVersionQuery = useQuery({
    queryKey: ['version', chapter.currentVersion?.id ?? 'none'],
    queryFn: () => getVersion(chapter.currentVersion!.id),
    enabled: isCanon && Boolean(chapter.currentVersion),
  });

  useEffect(() => {
    lastDraftIdRef.current = chapter.draft?.id ?? null;
    dirtyRef.current = false;
    setDirty(false);
    setContent(chapter.draft?.content ?? '');
    setNotice(null);
    setAuditReport(null);
    setCommitOpen(false);
    setRollbackTarget(null);
  }, [chapter.id]);

  useEffect(() => {
    const serverDraft = chapter.draft;
    const serverId = serverDraft?.id ?? null;
    if (serverId === lastDraftIdRef.current) return;
    lastDraftIdRef.current = serverId;
    if (dirtyRef.current) return;
    setContent(serverDraft?.content ?? '');
    setDirty(false);
  }, [chapter.id, chapter.draft?.id]);

  const readonlyContent = isCanon
    ? currentVersionQuery.data?.content ?? ''
    : content;
  const editorContent = isCanon ? readonlyContent : content;
  const displayChars = isCanon
    ? chapter.currentVersion?.wordCount ?? 0
    : countChars(editorContent);
  const currentHash = isCanon
    ? chapter.currentVersion?.contentHash ?? null
    : draft?.contentHash ?? null;

  const evaluationMatchesDraft = Boolean(
    evaluation &&
      draft &&
      evaluation.contentHash === draft.contentHash &&
      evaluation.contextHash,
  );

  function saveBlocker(): string | null {
    if (!roleCanWrite) return '当前角色不能写入';
    if (!editableStatus) return `章节状态为 ${chapter.status}，不能写草稿`;
    if (!leaseMine) return '需要先取得编辑租约';
    if (!content.trim()) return '空草稿不落盘';
    if (!dirty) return '没有需要保存的修改';
    return null;
  }

  function gatesBlocker(): string | null {
    if (!roleCanWrite) return '当前角色不能运行门禁';
    if (!draft) return '请先保存草稿';
    if (dirty) return '请先保存当前修改，门禁只评估已落盘草稿';
    return null;
  }

  function auditsBlocker(): string | null {
    if (!draft) return '请先保存草稿';
    if (dirty) return '请先保存当前修改，审计只检查已落盘草稿';
    return null;
  }

  function stageBlocker(): string | null {
    if (!roleCanWrite) return '当前角色不能暂存';
    if (
      chapter.status !== 'writing' &&
      chapter.status !== 'revision' &&
      chapter.status !== 'commit_failed'
    ) {
      return `章节状态为 ${chapter.status}，不能暂存`;
    }
    if (!leaseMine) return '需要先取得编辑租约';
    if (!draft) return '请先保存草稿';
    if (dirty) return '编辑区有未保存内容，请先保存';
    if (!evaluation) return '请先运行五门禁';
    if (evaluation.contentHash !== draft.contentHash) return '门禁结论已过期，请重跑';
    if (evaluation.status !== 'passed') return '五门禁未全部通过，不能暂存';
    return null;
  }

  function commitBlocker(): string | null {
    if (!roleCanWrite) return '当前角色不能提交';
    if (!isStaged && !isCommitFailed) return '章节尚未暂存';
    if (!leaseMine) return '提交要求持有编辑租约';
    if (!staged) return '没有可提交的暂存草稿';
    return null;
  }

  const saveReason = saveBlocker();
  const gatesReason = gatesBlocker();
  const auditsReason = auditsBlocker();
  const stageReason = stageBlocker();
  const commitReason = commitBlocker();

  async function perform<T>(
    key: Exclude<Busy, null>,
    action: () => Promise<T>,
    onSuccess: (result: T) => void,
  ) {
    setBusy(key);
    setNotice(null);
    try {
      const result = await action();
      await queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] });
      await queryClient.invalidateQueries({ queryKey: ['chapters'] });
      onSuccess(result);
    } catch (error) {
      setNotice({ tone: 'error', title: `${ACTION_LABELS[key]}失败`, body: formatError(error) });
    } finally {
      setBusy(null);
    }
  }

  function handleAcquireLease() {
    void perform('lease', () => acquireLease(chapter.id), (result) => {
      setNotice({
        tone: 'success',
        title: '编辑租约已取得',
        body: `有效至 ${formatClock(result.lease.expiresAt)}；同一时间只允许一名编辑写入。`,
      });
    });
  }

  function handleStartRevision() {
    void perform('revision', () => startRevision(chapter.id), (result) => {
      setNotice({
        tone: 'info',
        title: `已进入修订（基于正典 v${result.baseVersionNo}）`,
        body: `草稿已从当前正典复制，租约有效至 ${formatClock(result.lease.expiresAt)}。保存后仍需门禁与暂存才能生成新正典。`,
      });
    });
  }

  function handleAbandonRevision() {
    const confirmed = window.confirm(
      '放弃修订会回到当前正典，编辑区未提交的内容不会进入正典（草稿历史仍保留在数据库）。继续？',
    );
    if (!confirmed) return;
    void perform('abandon', () => abandonRevision(chapter.id), () => {
      setNotice({
        tone: 'info',
        title: '已放弃修订',
        body: '章节回到当前正典，正典正文未被改写；下次修订会从当前正典重新生成草稿。',
      });
    });
  }

  function handleResolveBodyRevision() {
    if (!isCanon || !roleCanWrite) return;
    const markedPlanRevision = chapter.markedPlanRevision;
    const versionId = chapter.currentVersion?.id;
    if (markedPlanRevision === null || !versionId) return;
    const warning = canonUnchangedSinceMark
      ? '正典自标记后未产生新版本，确认后只会清除待改稿标记，正文不会被改写。'
      : '确认后只会清除待改稿标记，正文不会被改写。';
    if (!window.confirm(`${warning}继续？`)) return;
    void perform(
      'resolve',
      () => resolveBodyRevision(chapter.id, { planRevision: markedPlanRevision, addressedCanonVersionId: versionId }),
      () => {
        setNotice({
          tone: 'success',
          title: '已确认计划改动已处理',
          body: `待改稿标记已清除；正典 v${chapter.currentVersion?.versionNo ?? '?'} 未改写，后续门禁改用计划 r${chapter.planRevision} 的上下文。`,
        });
      },
    );
  }

  function handleRolledBack(result: RollbackResponse, target: VersionSummary) {
    setRollbackTarget(null);
    setNotice({
      tone: 'success',
      title: result.alreadyCommitted
        ? `幂等重放：仍指向回滚后的 v${result.versionNo}`
        : `已回滚：v${target.versionNo} → 新正典 v${result.versionNo}`,
      body: `证据来源：${
        result.evidence === 'reused' ? '复用了通过的门禁证据' : '一次性回滚豁免'
      }。旧版本全部保留；索引状态：${result.indexStatus.status === 'not_configured' ? '未配置（未接入嵌入服务）' : result.indexStatus.status}。`,
    });
    void queryClient.invalidateQueries({ queryKey: ['chapters'] });
    void queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] });
  }

  function handleReleaseLease() {
    if (dirty && !window.confirm('编辑区有未保存内容，释放租约后将无法保存。仍要释放？')) {
      return;
    }
    void perform('release', () => releaseLease(chapter.id), () => {
      setNotice({ tone: 'info', title: '编辑租约已释放', body: '其他编辑现在可以取得本章租约。' });
    });
  }

  function handleSave() {
    if (saveReason) return;
    void perform('save', () => saveDraft(chapter.id, content), (result) => {
      lastDraftIdRef.current = result.draft.id;
      dirtyRef.current = false;
      setDirty(false);
      const evidenceStillBound = Boolean(
        evaluation && evaluation.contentHash === result.draft.contentHash,
      );
      setNotice({
        tone: 'success',
        title: '草稿已落盘',
        body: `${result.draft.wordCount} 字 · ${shortHash(result.draft.contentHash)}；${
          evaluation
            ? evidenceStillBound
              ? evaluation.status === 'passed'
                ? '门禁证据仍绑定该正文，可继续暂存。'
                : '门禁结论仍绑定该正文，但未全部通过。'
              : '正文已变化，需重跑门禁。'
            : '下一步运行五门禁。'
        }`,
      });
    });
  }

  function handleGates() {
    if (gatesReason) return;
    void perform('gates', () => runGates(chapter.id), (result: GateEvaluationView) => {
      setNotice({
        tone: result.status === 'passed' ? 'success' : 'error',
        title:
          result.status === 'passed'
            ? '五门禁全部通过'
            : result.status === 'failed'
              ? '存在未通过的门禁'
              : '门禁存在未配置项',
        body: `规则集 ${result.ruleset.key} v${result.ruleset.version} · 正文 ${shortHash(result.contentHash)}`,
      });
    });
  }

  async function handleAudits() {
    if (auditsReason) return;
    setBusy('audit');
    setNotice(null);
    try {
      const report = await runAudits(chapter.id);
      setAuditReport(report);
    } catch (error) {
      setNotice({ tone: 'error', title: '运行审计失败', body: formatError(error) });
    } finally {
      setBusy(null);
    }
  }

  function handleStage() {
    if (stageReason || !draft || !evaluation) return;
    void perform(
      'stage',
      () => stageDraft(chapter.id, evaluation.id, draft.contentHash),
      (result) => {
        setNotice({
          tone: 'success',
          title: '草稿已进入隔离暂存区',
          body: `暂存 ${result.stagedDraft.wordCount} 字 · ${shortHash(result.stagedDraft.contentHash)}；确认后再写入正典。`,
        });
      },
    );
  }

  function handleUnstage() {
    if (!isStaged) return;
    void perform('unstage', () => unstageDraft(chapter.id), () => {
      setNotice({ tone: 'info', title: '已撤回暂存', body: '章节回到写作中；暂存稿仍保留在隔离区历史里。' });
    });
  }

  function handleDemoFill() {
    if (content.trim() && content.trim() !== DEMO_DRAFT.trim()) {
      if (!window.confirm('将用演示草稿覆盖编辑区当前内容（尚未保存）。继续？')) return;
    }
    setContent(DEMO_DRAFT);
    dirtyRef.current = true;
    setDirty(true);
    setAuditReport(null);
    setNotice({
      tone: 'info',
      title: '演示草稿已填入编辑区',
      body: '这不是 AI 生成，只用于验证主流程；点击“保存草稿”后才会落盘。',
    });
  }

  function handleContentChange(value: string) {
    setContent(value);
    dirtyRef.current = true;
    setDirty(true);
    setAuditReport(null);
    if (notice?.tone === 'error') setNotice(null);
  }

  function handleAdoptAiProposal(text: string, mode: AiProposalMode) {
    const proposal = text.trim();
    if (!proposal) return;
    const base = content.replace(/\s+$/, '');
    const next = mode === 'continue' && base ? `${base}\n\n${proposal}` : proposal;
    setContent(next);
    dirtyRef.current = true;
    setDirty(true);
    setAuditReport(null);
    setNotice({
      tone: 'info',
      title: mode === 'continue' ? 'AI 续写已追加到编辑区' : 'AI 加厚稿已替换编辑区',
      body: '尚未保存、未过门禁。请检查改动后保存草稿，再跑五门禁；AI 没有直接写入正典。',
    });
  }

  function handleCommitted(result: CommitResponse) {
    setCommitOpen(false);
    setNotice({
      tone: 'success',
      title: result.alreadyCommitted
        ? `幂等重放：仍指向 v${result.versionNo}`
        : `已写入正典 v${result.versionNo}`,
      body:
        result.indexStatus.status === 'not_configured'
          ? '提交与索引状态已同事务落库；嵌入服务未配置，索引如实标记为“未配置”。'
          : result.indexStatus.status === 'pending'
            ? '索引任务已随提交进入 outbox；处理状态见右侧索引卡片，正文提交不被索引阻塞。'
            : `索引状态：${result.indexStatus.status}`,
    });
    void queryClient.invalidateQueries({ queryKey: ['chapters'] });
    void queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] });
  }

  const planEntities = (chapter.plan.requiredEntities ?? []).join('、');
  const planGoals = (chapter.plan.goalKeywords ?? []).join('、');
  const planObstacles = (chapter.plan.obstacleKeywords ?? []).join('、');

  const leaseTone = isCanon
    ? 'is-closed'
    : chapter.lease
      ? leaseMine
        ? 'is-mine'
        : 'is-other'
      : 'is-free';

  const flow = buildFlowState(chapter, dirty);
  const canFillDemo =
    chapter.number === DEMO_CHAPTER_NUMBER && canEditNow && !busy;

  return (
    <section className="chapter-studio">
      <header className="studio-header">
        <div className="chapter-heading">
          <p className="eyebrow">第 {chapter.number} 章 · 单章闭环</p>
          <h1>{chapter.title}</h1>
          <div className="chapter-heading-meta">
            <ChapterStatusBadge status={chapter.status} />
            <span>
              正典 {chapter.wordCount != null ? `${chapter.wordCount} 字` : '尚无'}
              {chapter.currentVersion ? ` · v${chapter.currentVersion.versionNo}` : ''}
            </span>
            {chapter.currentVersion ? (
              <span>门禁：{VERSION_GATE_TEXT[chapter.currentVersion.gateStatus]}</span>
            ) : null}
          </div>
        </div>
        <div className="plan-card">
          <div className="plan-card-head">
            <p className="eyebrow">本章计划 r{chapter.planRevision} · 门禁上下文</p>
            {canEditPlan ? (
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setPlanDialogTab('plan')}
                title="改计划不需要编辑租约，也不会改正文"
              >
                {planHasContent ? '编辑计划' : '填写计划'}
              </button>
            ) : null}
          </div>
          <p className={`plan-summary${planHasContent ? '' : ' is-empty'}`}>
            {planSummaryHeadline(chapter.plan)}
          </p>
          <p>
            核心人物 <strong>{planEntities || '未设置'}</strong>
          </p>
          <p>
            目标 <strong>{planGoals || '未设置'}</strong> · 阻碍{' '}
            <strong>{planObstacles || '未设置'}</strong>
          </p>
          <button
            type="button"
            className="plan-history-link"
            onClick={() => setPlanDialogTab('history')}
          >
            查看计划历史与差异
          </button>
        </div>
      </header>

      <div className={`lease-bar ${leaseTone}`}>
        <div className="lease-state">
          <span className="lease-dot" aria-hidden="true" />
          <div>
            <strong>{leaseTitle(chapter, leaseMine)}</strong>
            <span>{leaseSubtitle(chapter, leaseMine)}</span>
          </div>
        </div>
        <div className="lease-actions">
          {isCanon ? (
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => chapter.currentVersion && onOpenVersion(chapter.currentVersion.id)}
              disabled={!chapter.currentVersion}
            >
              查看当前正典
            </button>
          ) : !roleCanWrite ? (
            <span className="muted">当前角色只读</span>
          ) : chapter.lease && !leaseMine ? (
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] })}
            >
              刷新租约状态
            </button>
          ) : leaseMine ? (
            <>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={handleAcquireLease}
                disabled={busy !== null}
              >
                {busy === 'lease' ? '续租中……' : '续租 15 分钟'}
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={handleReleaseLease}
                disabled={busy !== null || isStaged || isCommitFailed}
                title={
                  isStaged || isCommitFailed
                    ? '提交前不能释放租约'
                    : '释放后其他编辑可以接手'
                }
              >
                {busy === 'release' ? '释放中……' : '释放租约'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button button-primary button-small"
              onClick={handleAcquireLease}
              disabled={busy !== null}
            >
              {busy === 'lease' ? '取得中……' : '取得编辑租约 · 15 分钟'}
            </button>
          )}
        </div>
      </div>

      {notice ? (
        <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <strong>{notice.title}</strong>
          {notice.body ? <p>{notice.body}</p> : null}
        </div>
      ) : null}

      <ol className="flow-strip" aria-label="单章提交链进度">
        {flow.map((step) => (
          <li key={step.label} className={`flow-step flow-${step.state}`}>
            <span className="flow-index">{step.index}</span>
            <span className="flow-copy">
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      {isCanon ? (
        <div className="studio-banner canon-banner">
          <strong>本章已进入正典</strong>
          <p>
            编辑区展示当前正典正文（只读）。可开始修订生成新版本，或从右侧版本历史回滚到旧版本；
            回滚豁免必须由申请人之外的所有者或主笔批准。
          </p>
        </div>
      ) : isStaged ? (
        <div className="studio-banner staged-banner">
          <strong>暂存稿与正典隔离</strong>
          <p>
            暂存正文已绑定门禁证据。提交前请核对目标章节；提交事务失败不会改变当前正典。
          </p>
        </div>
      ) : isCommitFailed ? (
        <div className="studio-banner failed-banner">
          <strong>上次提交失败</strong>
          <p>正典未被改动。请核对暂存稿与门禁证据后重试提交。</p>
        </div>
      ) : null}

      {chapter.bodyNeedsRevision ? (
        <div className="studio-banner plan-mark-banner">
          <strong>
            计划 r{chapter.markedPlanRevision ?? '?'} 已改，正典 v
            {chapter.currentVersion?.versionNo ?? '?'} 尚未处理
          </strong>
          <p>
            正文仍是标记前的正典；确认已处理只会清除待改稿标记，不改正文。
            {canonUnchangedSinceMark ? ' 正典自标记后未产生新版本。' : ''}
          </p>
          <div className="plan-mark-actions">
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => setPlanDialogTab('history')}
            >
              查看差异
            </button>
            {roleCanWrite ? (
              <button
                type="button"
                className="button button-primary button-small"
                onClick={handleResolveBodyRevision}
                disabled={busy !== null || !isCanon}
                title={isCanon ? '清除待改稿标记，不改正文' : '需要章节处于正典状态'}
              >
                {busy === 'resolve' ? '确认中……' : '确认已处理'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {stagedPlanChanged ? (
        <div className="studio-banner plan-stale-banner">
          <strong>门禁结论已失效，提交会返回 CONTEXT_CHANGED</strong>
          <p>暂存之后计划被改动，门禁证据绑定的上下文已过期；请重跑门禁后再提交。</p>
        </div>
      ) : null}

      <div className="studio-grid">
        <div className="studio-main">
          <div className="editor-shell">
            <div className="editor-toolbar">
              <div>
                <p className="eyebrow">
                  {isCanon
                    ? '正典正文 · 只读'
                    : isStaged || isCommitFailed
                      ? '暂存正文 · 只读'
                      : '正文草稿'}
                </p>
                <strong>
                  {isCanon
                    ? `v${chapter.currentVersion?.versionNo ?? '?'}`
                    : draft
                      ? `已保存 ${draft.wordCount} 字`
                      : '尚未落盘'}
                </strong>
              </div>
              <div className="editor-toolbar-actions">
                {canFillDemo ? (
                  <button
                    type="button"
                    className="button button-quiet button-small demo-fill"
                    onClick={handleDemoFill}
                  >
                    填入演示草稿（非 AI 生成）
                  </button>
                ) : null}
                <span className={`save-state ${dirty ? 'is-dirty' : 'is-saved'}`}>
                  {editableStatus
                    ? dirty
                      ? '有未保存修改'
                      : content.trim()
                        ? '编辑区与已保存草稿一致'
                        : '等待写作'
                    : isCanon
                      ? '只读'
                      : '已暂存锁定'}
                </span>
              </div>
            </div>

            {editableStatus ? (
              <textarea
                className="manuscript-editor"
                value={content}
                onChange={(event) => handleContentChange(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    if (!saveReason) handleSave();
                  }
                }}
                readOnly={!canEditNow}
                spellCheck={false}
                placeholder={
                  canEditNow
                    ? '在这里写下本章正文。保存后，门禁只评估已落盘草稿。'
                    : leaseMine
                      ? '当前状态不允许编辑。'
                      : '取得编辑租约后即可写作。'
                }
              />
            ) : (
              <div className="manuscript-readonly in-editor">
                {isCanon && currentVersionQuery.isLoading ? (
                  <p className="empty-state">正在读取正典正文……</p>
                ) : readonlyContent.trim() ? (
                  readonlyContent
                    .split(/\n+/)
                    .filter((paragraph) => paragraph.trim().length > 0)
                    .map((paragraph, index) => <p key={`${chapter.id}-ro-${index}`}>{paragraph}</p>)
                ) : (
                  <p className="empty-state">
                    当前视图没有可展示的正文草稿。草稿按作者隔离，跨作者正文共享尚未接入。
                  </p>
                )}
              </div>
            )}

            <div className="editor-footer">
              <span className={`editor-count ${editableStatus && displayChars < 300 ? 'is-low' : ''}`}>
                {displayChars} 字
                {editableStatus && displayChars < 300 ? ' · 低于 dev-v0 演示下限 300' : ''}
              </span>
              <span className="muted">
                {isCanon ? '正典哈希' : '已保存草稿哈希'} {shortHash(currentHash)}
              </span>
            </div>
          </div>

          {dirty ? (
            <div className="inline-warning">
              编辑区有未保存内容。门禁、审计与暂存都只认已落盘草稿；按 Ctrl/Cmd + S 保存。
            </div>
          ) : null}

          <div className="action-bar">
            {isCanon ? (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => chapter.currentVersion && onOpenVersion(chapter.currentVersion.id)}
                  disabled={!chapter.currentVersion}
                >
                  查看当前正典与证据
                </button>
                {roleCanWrite ? (
                  <button
                    type="button"
                    className="button button-vermilion"
                    onClick={handleStartRevision}
                    disabled={busy !== null || !chapter.currentVersion}
                    title="从当前正典复制草稿并取得编辑租约"
                  >
                    {busy === 'revision' ? '进入修订中……' : '开始修订'}
                  </button>
                ) : null}
                <span className="action-note">
                  {roleCanWrite
                    ? '开始修订会自动取得 15 分钟租约；回滚入口在右侧版本历史。'
                    : '当前角色只读；修订需所有者、主笔或作者。'}
                </span>
              </>
            ) : (
              <>
                {editableStatus ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={handleSave}
                    disabled={busy !== null || Boolean(saveReason)}
                    title={saveReason ?? '保存草稿（Ctrl/Cmd + S）'}
                  >
                    {busy === 'save' ? '保存中……' : '保存草稿'}
                  </button>
                ) : null}

                <button
                  type="button"
                  className="button button-secondary"
                  onClick={handleGates}
                  disabled={busy !== null || Boolean(gatesReason)}
                  title={gatesReason ?? '对已保存草稿运行五道硬门禁'}
                >
                  {busy === 'gates' ? '门禁运行中……' : '跑五门禁'}
                </button>

                {chapter.status === 'writing' || chapter.status === 'revision' ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={handleStage}
                    disabled={busy !== null || Boolean(stageReason)}
                    title={stageReason ?? '把已通过门禁的草稿放入隔离暂存区'}
                  >
                    {busy === 'stage' ? '暂存中……' : '暂存草稿'}
                  </button>
                ) : null}

                {isStaged ? (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={handleUnstage}
                    disabled={busy !== null || !leaseMine}
                    title={leaseMine ? '撤回暂存，回到写作中' : '需要持有编辑租约'}
                  >
                    {busy === 'unstage' ? '撤回中……' : '撤回暂存'}
                  </button>
                ) : null}

                {isStaged || isCommitFailed ? (
                  <button
                    type="button"
                    className="button button-vermilion"
                    onClick={() => setCommitOpen(true)}
                    disabled={busy !== null || Boolean(commitReason)}
                    title={commitReason ?? '确认目标章节后写入正典'}
                  >
                    {isCommitFailed ? '重试提交至正典' : '写入正典…'}
                  </button>
                ) : null}

                {chapter.currentVersion &&
                (chapter.status === 'revision' || chapter.status === 'writing') ? (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={handleAbandonRevision}
                    disabled={busy !== null || !leaseMine}
                    title={
                      leaseMine
                        ? '放弃本次修订，回到当前正典'
                        : '需要持有编辑租约才能放弃修订'
                    }
                  >
                    {busy === 'abandon' ? '退出修订中……' : '放弃修订'}
                  </button>
                ) : null}
              </>
            )}
          </div>
          <p className="action-hint">{actionHint(chapter, leaseMine, dirty, evaluationMatchesDraft, evaluation?.status === 'passed')}</p>

          {editableStatus && roleCanWrite ? (
            <AiProposalPanel
              chapter={chapter}
              content={content}
              dirty={dirty}
              canEditNow={canEditNow}
              onAdopt={handleAdoptAiProposal}
            />
          ) : null}

          <div className="honesty-note studio-honesty">
            <strong>本页如何避免“假成功”</strong>
            <p>
              门禁证据绑定正文哈希、规则集版本与上下文指纹；暂存与提交都要求租约，提交以单事务写入并带幂等键。
              未接入的审计与索引如实显示“未接入 / 未配置”。
            </p>
          </div>
        </div>

        <aside className="inspector">
          <GatePanel
            evaluation={evaluation}
            draftHash={draft?.contentHash ?? null}
            isDirty={dirty}
          />
          <AuditPanel
            report={auditReport}
            onRun={() => void handleAudits()}
            busy={busy === 'audit'}
            disabledReason={auditsReason}
            draftHash={draft?.contentHash ?? null}
            isDirty={dirty}
          />
          <CharacterContextCard chapterId={chapter.id} />
          <ForeshadowingReminderCard chapterId={chapter.id} />
          <ChapterLedgerLinksCard
            chapterId={chapter.id}
            workId={chapter.workId}
            canEdit={roleCanWrite}
          />
          <IndexStatusCard
            chapterId={chapter.id}
            role={me.role}
            status={chapter.indexStatus}
            onQueued={() => {
              void queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] });
            }}
          />
          <RetrievalPanel
            workId={chapter.workId}
            chapterId={chapter.id}
            onOpenChapter={onOpenChapter}
          />
          {isCanon || chapter.waivers.length > 0 ? (
            <WaiverPanel me={me} chapter={chapter} />
          ) : null}
          <VersionList
            versions={chapter.versions}
            currentVersionId={chapter.currentVersion?.id ?? null}
            onOpen={onOpenVersion}
            canRollback={me.role === 'owner' || me.role === 'lead'}
            onRollback={setRollbackTarget}
          />
        </aside>
      </div>

      {commitOpen && (isStaged || isCommitFailed) ? (
        <CommitDialog
          chapter={chapter}
          onClose={() => setCommitOpen(false)}
          onCommitted={handleCommitted}
        />
      ) : null}

      {rollbackTarget ? (
        <RollbackDialog
          chapter={chapter}
          target={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
          onRolledBack={handleRolledBack}
        />
      ) : null}

      {planDialogTab ? (
        <PlanDialog
          me={me}
          chapter={chapter}
          initialTab={planDialogTab}
          onClose={() => setPlanDialogTab(null)}
          onSaved={(state) => {
            setNotice({
              tone: 'success',
              title: `计划已保存为 r${state.planRevision}`,
              body: state.bodyNeedsRevision
                ? `已标记正文待改：正典 v${chapter.currentVersion?.versionNo ?? '?'} 未改写，写作台会出现待改稿横幅。`
                : '正文、草稿与正典均未改动。',
            });
          }}
        />
      ) : null}
    </section>
  );
}

const VERSION_GATE_TEXT = {
  passed: '通过',
  waived: '已豁免',
  not_evaluated: '未评估',
} as const;

interface FlowStep {
  index: string;
  label: string;
  detail: string;
  state: 'done' | 'current' | 'todo' | 'attention';
}

function buildFlowState(chapter: ChapterDetail, dirty: boolean): FlowStep[] {
  const isCanon = chapter.status === 'canon';
  const isStaged = chapter.status === 'staged';
  const isCommitFailed = chapter.status === 'commit_failed';
  const draftDone = Boolean(chapter.draft || chapter.currentVersion);
  const evaluation = chapter.latestEvaluation;
  const evaluationFresh = Boolean(
    evaluation && chapter.draft && evaluation.contentHash === chapter.draft.contentHash,
  );
  const gatesPassed = evaluationFresh && evaluation?.status === 'passed';
  const stageReady = gatesPassed && !dirty;
  const canonGate = chapter.currentVersion?.gateStatus;

  const gateState: FlowStep['state'] = isCanon
    ? canonGate === 'passed' || canonGate === 'waived'
      ? 'done'
      : 'attention'
    : gatesPassed
      ? 'done'
      : evaluation
        ? evaluationFresh
          ? 'attention'
          : 'attention'
        : chapter.draft
          ? 'current'
          : 'todo';
  const gateDetail = isCanon
    ? canonGate
      ? VERSION_GATE_TEXT[canonGate]
      : '无版本'
    : gatesPassed
      ? '已通过'
      : evaluation
        ? evaluationFresh
          ? '未全部通过'
          : '结论已过期'
        : chapter.draft
          ? '待运行'
          : '待草稿';

  return [
    {
      index: '壹',
      label: '草稿落盘',
      detail: dirty
        ? '有未保存修改'
        : chapter.draft
          ? `${chapter.draft.wordCount} 字`
          : chapter.currentVersion
            ? '来自正典'
            : '未开始',
      state: draftDone && !dirty ? 'done' : 'current',
    },
    {
      index: '贰',
      label: '五门禁',
      detail: gateDetail,
      state: gateState,
    },
    {
      index: '叁',
      label: '隔离暂存',
      detail: isCanon
        ? chapter.currentVersion?.source === 'import'
          ? '迁移导入 · 未经过暂存'
          : '已入库'
        : isStaged
          ? '已暂存'
          : isCommitFailed
            ? '暂存待重试'
            : stageReady
              ? '可暂存'
              : dirty
                ? '待保存'
                : '待门禁',
      state: isStaged || isCommitFailed || isCanon ? 'done' : stageReady ? 'current' : 'todo',
    },
    {
      index: '肆',
      label: '写入正典',
      detail: isCanon ? `已入库 ${chapter.currentVersion ? `v${chapter.currentVersion.versionNo}` : ''}` : '待提交',
      state: isCanon ? 'done' : isStaged || isCommitFailed ? 'current' : 'todo',
    },
  ];
}

function leaseTitle(chapter: ChapterDetail, leaseMine: boolean): string {
  if (chapter.status === 'canon') return '正典只读';
  if (chapter.lease) {
    return leaseMine ? '你持有本章编辑租约' : `${chapter.lease.userName} 正在编辑本章`;
  }
  return '本章尚未分配编辑租约';
}

function leaseSubtitle(chapter: ChapterDetail, leaseMine: boolean): string {
  if (chapter.status === 'canon') {
    return '正典只读；开始修订会自动取得租约，回滚入口在版本历史。';
  }
  if (chapter.lease) {
    return leaseMine
      ? `有效至 ${formatClock(chapter.lease.expiresAt)}；保存、暂存与提交都要求持租约。`
      : `有效至 ${formatClock(chapter.lease.expiresAt)}；等待释放或到期后才能接手。`;
  }
  return '同一时间只允许一名人类编辑；保存、暂存与提交都要求租约。';
}

function actionHint(
  chapter: ChapterDetail,
  leaseMine: boolean,
  dirty: boolean,
  evaluationMatchesDraft: boolean,
  evaluationPassed: boolean,
): string {
  if (chapter.status === 'canon') {
    return '正典已锁定。可开始修订，或在版本历史中回滚到旧版本。';
  }
  if (!leaseMine) {
    return '先取得编辑租约，再写正文；所有写入动作都要求租约。';
  }
  if (dirty) {
    return '先保存草稿，再运行门禁；暂存与提交都不会接受编辑区里未落盘的内容。';
  }
  if (chapter.status === 'staged') {
    return '暂存稿已绑定门禁证据。确认目标章节后写入正典。';
  }
  if (chapter.status === 'commit_failed') {
    return '正典未改变。核对暂存稿与证据后重试提交。';
  }
  if (chapter.currentVersion && (chapter.status === 'revision' || chapter.status === 'writing')) {
    return '修订中：草稿来自当前正典；提交会生成新版本，旧版本保留。也可放弃修订回到正典。';
  }
  if (evaluationMatchesDraft) {
    return evaluationPassed
      ? '门禁已通过并绑定当前正文哈希，可以暂存。'
      : '门禁结论绑定当前正文，但未全部通过；修正后重跑门禁。';
  }
  return '流程：保存草稿 → 跑五门禁 → 暂存 → 写入正典。';
}
