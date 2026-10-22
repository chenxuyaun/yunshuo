import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutomationMandateInput,
  AutomationMandateView,
  AutomationPreflightCheck,
  AutomationPreflightView,
  ChapterListItem,
  MeResponse,
  PriceCurrency,
} from '@yunshuo/contracts';
import {
  ApiError,
  automationPreflight,
  createAutomationJob,
  createAutomationMandate,
  getAutomationJob,
  listAutomationJobs,
  listAutomationMandates,
  pauseAutomationJob,
  resumeAutomationJob,
  revokeAutomationMandate,
  stopAutomationJob,
} from '../api.js';
import { formatDateTime } from '../format.js';
import { AutomationJobDetail } from './AutomationJobDetail.js';
import {
  AutomationJobStatusBadge,
  AutomationMandateStatusBadge,
  Badge,
  type BadgeTone,
} from './Badge.js';

interface Props {
  me: MeResponse;
  chapters: ChapterListItem[];
  onClose: () => void;
  onOpenChapter: (chapterId: string) => void;
}

interface WorkOption {
  id: string;
  title: string;
  chapters: ChapterListItem[];
}

interface MandateFormState {
  workId: string;
  name: string;
  chapterMin: string;
  chapterMax: string;
  maxChapters: string;
  targetWords: string;
  instruction: string;
  allowAutoCommit: boolean;
  allowRemoteModels: boolean;
  allowNonProductionGates: boolean;
  budgetEnabled: boolean;
  budgetLimit: string;
  budgetCurrency: PriceCurrency;
  expiresInHours: string;
}

const CHECK_TONES: Record<AutomationPreflightCheck['status'], BadgeTone> = {
  pass: 'green',
  warn: 'amber',
  fail: 'red',
};

const CHECK_LABELS: Record<AutomationPreflightCheck['status'], string> = {
  pass: '通过',
  warn: '提醒',
  fail: '阻止',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueWorks(chapters: ChapterListItem[]): WorkOption[] {
  const map = new Map<string, WorkOption>();
  for (const chapter of chapters) {
    let work = map.get(chapter.workId);
    if (!work) {
      work = { id: chapter.workId, title: chapter.workTitle, chapters: [] };
      map.set(chapter.workId, work);
    }
    work.chapters.push(chapter);
  }
  return [...map.values()];
}

function suggestedRange(chapters: ChapterListItem[], workId: string): { min: number; max: number } {
  const numbers = chapters
    .filter((chapter) => chapter.workId === workId)
    .map((chapter) => chapter.number);
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return { min: next, max: next + 9 };
}

function defaultForm(chapters: ChapterListItem[], workId: string): MandateFormState {
  const range = suggestedRange(chapters, workId);
  return {
    workId,
    name: '',
    chapterMin: String(range.min),
    chapterMax: String(range.max),
    maxChapters: '5',
    targetWords: '800',
    instruction: '',
    allowAutoCommit: true,
    allowRemoteModels: false,
    allowNonProductionGates: false,
    budgetEnabled: false,
    budgetLimit: '',
    budgetCurrency: 'CNY',
    expiresInHours: '24',
  };
}

function positiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function money(value: number, currency: PriceCurrency): string {
  return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(4)}`;
}

function PreflightPanel({ view }: { view: AutomationPreflightView }) {
  return (
    <div className="automation-preflight">
      <div className="automation-preflight-head">
        <Badge tone={view.ok ? 'green' : 'red'}>
          {view.ok ? '预检通过，可以启动' : '预检未通过，不能启动'}
        </Badge>
        <span className="muted">
          生成于 {formatDateTime(view.generatedAt)} · 预检只读数据库，不发起模型调用
        </span>
      </div>
      <ul className="automation-check-list">
        {view.checks.map((check) => (
          <li key={check.key} className={`automation-check automation-check-${check.status}`}>
            <Badge tone={CHECK_TONES[check.status]}>{CHECK_LABELS[check.status]}</Badge>
            <div>
              <strong>{check.label}</strong>
              <p>{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="automation-preflight-foot">
        服务商：{view.providerNames.length > 0 ? view.providerNames.join('、') : '无可用服务商'}
        {view.budgetRemaining !== null
          ? ` · 预算剩余 ${money(view.budgetRemaining, view.budgetCurrency)}`
          : ' · 未设置预算'}
        {view.unknownCost ? ' · 存在未定价服务商' : ''}
      </p>
    </div>
  );
}

export function AutomationDialog({ me, chapters, onClose, onOpenChapter }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'jobs' | 'mandates'>('jobs');
  const [launching, setLaunching] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedMandateId, setSelectedMandateId] = useState('');
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<AutomationPreflightView | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyAction, setBusyAction] = useState<'pause' | 'resume' | 'stop' | 'revoke' | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<MandateFormState>(() =>
    defaultForm(chapters, uniqueWorks(chapters)[0]?.id ?? ''),
  );
  const [savingMandate, setSavingMandate] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);

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

  const mandatesQuery = useQuery({
    queryKey: ['automationMandates'],
    queryFn: () => listAutomationMandates(),
  });

  const jobsQuery = useQuery({
    queryKey: ['automationJobs'],
    queryFn: () => listAutomationJobs(),
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs ?? [];
      return jobs.some((job) => job.status === 'queued' || job.status === 'running')
        ? 3000
        : false;
    },
  });

  const mandates = mandatesQuery.data?.mandates ?? [];
  const activeMandates = useMemo(
    () => mandates.filter((mandate) => mandate.status === 'active'),
    [mandates],
  );
  const selectedMandate =
    mandates.find(
      (mandate) => mandate.id === selectedMandateId && mandate.status === 'active',
    ) ??
    activeMandates[0] ??
    null;

  const jobs = jobsQuery.data?.jobs ?? [];
  const effectiveJobId = launching ? null : (selectedJobId ?? jobs[0]?.id ?? null);
  const jobQuery = useQuery({
    queryKey: ['automationJob', effectiveJobId],
    queryFn: () => getAutomationJob(effectiveJobId!),
    enabled: Boolean(effectiveJobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2000 : false;
    },
  });
  const selectedJob = effectiveJobId
    ? (jobQuery.data ?? jobs.find((job) => job.id === effectiveJobId) ?? null)
    : null;
  const selectedJobMandate =
    mandates.find((mandate) => mandate.id === selectedJob?.mandateId) ?? null;
  const showLauncher = launching || jobs.length === 0;

  const workOptions = useMemo(() => uniqueWorks(chapters), [chapters]);

  useEffect(() => {
    setSelectedChapterIds([]);
    setPreflight(null);
  }, [selectedMandate?.id]);

  useEffect(() => {
    const status = selectedJob?.status;
    if (!status) return;
    if (status !== 'queued' && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['chapters'] });
    }
  }, [selectedJob?.status, queryClient]);

  const workChapters = selectedMandate
    ? chapters.filter((chapter) => chapter.workId === selectedMandate.workId)
    : [];
  const eligibleChapters = selectedMandate
    ? workChapters.filter(
        (chapter) =>
          (chapter.status === 'planned' || chapter.status === 'writing') &&
          chapter.number >= selectedMandate.chapterMin &&
          chapter.number <= selectedMandate.chapterMax,
      )
    : [];

  function resetFeedback() {
    setError(null);
    setNotice(null);
  }

  function toggleChapter(chapterIdValue: string) {
    if (!selectedMandate) return;
    setPreflight(null);
    setSelectedChapterIds((previous) => {
      if (previous.includes(chapterIdValue)) {
        return previous.filter((id) => id !== chapterIdValue);
      }
      if (previous.length >= selectedMandate.maxChapters) return previous;
      return [...previous, chapterIdValue];
    });
  }

  function selectEligible() {
    if (!selectedMandate) return;
    setPreflight(null);
    setSelectedChapterIds(
      eligibleChapters.slice(0, selectedMandate.maxChapters).map((chapter) => chapter.id),
    );
  }

  async function refreshAfterJobChange() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['automationJobs'] }),
      queryClient.invalidateQueries({ queryKey: ['automationJob'] }),
      queryClient.invalidateQueries({ queryKey: ['automationMandates'] }),
      queryClient.invalidateQueries({ queryKey: ['chapters'] }),
      queryClient.invalidateQueries({ queryKey: ['chapter'] }),
    ]);
  }

  async function handlePreflight() {
    if (!selectedMandate || selectedChapterIds.length === 0) return;
    setPreflighting(true);
    resetFeedback();
    try {
      const view = await automationPreflight({
        mandateId: selectedMandate.id,
        chapterIds: selectedChapterIds,
      });
      setPreflight(view);
    } catch (preflightError) {
      setPreflight(null);
      setError(errorMessage(preflightError));
    } finally {
      setPreflighting(false);
    }
  }

  async function handleStartJob() {
    if (!selectedMandate || !preflight?.ok || selectedChapterIds.length === 0) return;
    setStarting(true);
    resetFeedback();
    try {
      const job = await createAutomationJob({
        mandateId: selectedMandate.id,
        chapterIds: selectedChapterIds,
      });
      setSelectedJobId(job.id);
      setLaunching(false);
      setSelectedChapterIds([]);
      setPreflight(null);
      await refreshAfterJobChange();
      setNotice({
        tone: 'success',
        text: `作业已排队：${job.totalChapters} 章将逐章生成；runner 在门禁全部通过后自动入库。`,
      });
    } catch (startError) {
      if (startError instanceof ApiError && startError.code === 'AUTOMATION_PRECHECK_FAILED') {
        const details = startError.details as { preflight?: AutomationPreflightView } | null;
        if (details?.preflight) setPreflight(details.preflight);
      }
      setError(errorMessage(startError));
    } finally {
      setStarting(false);
    }
  }

  async function handleJobAction(
    action: 'pause' | 'resume' | 'stop',
    jobId: string,
  ): Promise<void> {
    setBusyAction(action);
    resetFeedback();
    try {
      if (action === 'pause') {
        const job = await pauseAutomationJob(jobId);
        setNotice({
          tone: 'info',
          text:
            job.status === 'paused'
              ? '作业已暂停；恢复需要人工操作。'
              : '已请求暂停：runner 会在当前章节结束后停下。',
        });
      } else if (action === 'resume') {
        await resumeAutomationJob(jobId);
        setNotice({ tone: 'success', text: '作业已重新排队，runner 会继续处理待办章节。' });
      } else {
        await stopAutomationJob(jobId);
        setNotice({ tone: 'info', text: '作业已停止，不再处理后续章节。' });
      }
      await refreshAfterJobChange();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRevokeMandate(mandateId: string): Promise<void> {
    setBusyAction('revoke');
    resetFeedback();
    try {
      await revokeAutomationMandate(mandateId);
      setConfirmRevokeId(null);
      await refreshAfterJobChange();
      setNotice({ tone: 'info', text: '授权已撤销，该授权下的排队或暂停作业已停止。' });
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    } finally {
      setBusyAction(null);
    }
  }

  function startCreateMandate() {
    setForm(defaultForm(chapters, workOptions[0]?.id ?? ''));
    setFormOpen(true);
    resetFeedback();
  }

  function handleFormWorkChange(workId: string) {
    const range = suggestedRange(chapters, workId);
    setForm((previous) => ({
      ...previous,
      workId,
      chapterMin: String(range.min),
      chapterMax: String(range.max),
    }));
  }

  async function handleCreateMandate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = form.name.trim();
    const chapterMin = positiveInt(form.chapterMin);
    const chapterMax = positiveInt(form.chapterMax);
    const maxChapters = positiveInt(form.maxChapters);
    const targetWords = positiveInt(form.targetWords);
    const expiresInHours = positiveInt(form.expiresInHours);

    if (!form.workId) {
      setError('请选择作品。');
      return;
    }
    if (!name) {
      setError('请填写授权名称。');
      return;
    }
    if (chapterMin === null || chapterMax === null || chapterMax < chapterMin) {
      setError('章节范围必须是有效的起止章号，且结束章号不小于起始章号。');
      return;
    }
    if (maxChapters === null || maxChapters < 1 || maxChapters > 50) {
      setError('单次最多章节数必须是 1–50 的整数。');
      return;
    }
    if (targetWords === null || targetWords < 300 || targetWords > 4000) {
      setError('每章目标字数必须是 300–4000 的整数。');
      return;
    }
    if (expiresInHours === null || expiresInHours < 1 || expiresInHours > 720) {
      setError('有效期必须是 1–720 小时。');
      return;
    }
    let budgetLimit: number | null = null;
    if (form.budgetEnabled) {
      const parsed = Number(form.budgetLimit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError('启用预算时必须填写大于 0 的金额。');
        return;
      }
      budgetLimit = parsed;
    }

    const payload: AutomationMandateInput = {
      workId: form.workId,
      name,
      mode: 'continue',
      chapterMin,
      chapterMax,
      maxChapters,
      targetWords,
      instruction: form.instruction.trim(),
      allowAutoCommit: form.allowAutoCommit,
      allowRemoteModels: form.allowRemoteModels,
      allowNonProductionGates: form.allowNonProductionGates,
      budgetLimit,
      budgetCurrency: form.budgetCurrency,
      expiresInHours,
    };

    setSavingMandate(true);
    resetFeedback();
    try {
      const created = await createAutomationMandate(payload);
      await queryClient.invalidateQueries({ queryKey: ['automationMandates'] });
      setSelectedMandateId(created.id);
      setFormOpen(false);
      setNotice({
        tone: 'success',
        text: `已创建授权「${created.name}」；可立即选择章节并预检。`,
      });
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setSavingMandate(false);
    }
  }

  function useMandate(mandate: AutomationMandateView) {
    setSelectedMandateId(mandate.id);
    setTab('jobs');
    setLaunching(true);
    resetFeedback();
  }

  const busy = busyAction !== null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-automation"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">M4-B · 显式授权下的无人值守续写</p>
            <h2 id="automation-title">自动作业</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="automation-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'jobs'}
            className={`automation-tab${tab === 'jobs' ? ' is-active' : ''}`}
            onClick={() => setTab('jobs')}
          >
            作业
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mandates'}
            className={`automation-tab${tab === 'mandates' ? ' is-active' : ''}`}
            onClick={() => setTab('mandates')}
          >
            授权与预检
          </button>
        </div>

        <div className="modal-body automation-body">
          {notice ? (
            <div className={`provider-notice provider-notice-${notice.tone}`}>{notice.text}</div>
          ) : null}
          {error ? <div className="modal-error">{error}</div> : null}

          {tab === 'mandates' ? (
            <div className="automation-mandates">
              <div className="provider-list-head">
                <div>
                  <h3>自动化授权</h3>
                  <p className="muted">
                    仅所有者与主笔可创建；授权限定作品、章节范围、章数、预算与远程模型策略。
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-primary button-small"
                  onClick={startCreateMandate}
                >
                  {formOpen ? '重置表单' : '新建授权'}
                </button>
              </div>

              {formOpen ? (
                <form className="automation-mandate-form" onSubmit={(event) => void handleCreateMandate(event)}>
                  <div className="provider-form-head">
                    <h3>新建授权</h3>
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => setFormOpen(false)}
                    >
                      收起
                    </button>
                  </div>

                  <div className="field-grid">
                    <label className="field">
                      <span>作品</span>
                      <select
                        value={form.workId}
                        onChange={(event) => handleFormWorkChange(event.target.value)}
                      >
                        {workOptions.length === 0 ? <option value="">没有作品</option> : null}
                        {workOptions.map((work) => (
                          <option key={work.id} value={work.id}>
                            {work.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>授权名称</span>
                      <input
                        value={form.name}
                        maxLength={80}
                        placeholder="例如：第三卷续写"
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="field-grid">
                    <label className="field">
                      <span>起始章号</span>
                      <input
                        type="number"
                        min={1}
                        value={form.chapterMin}
                        onChange={(event) => setForm({ ...form, chapterMin: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>结束章号</span>
                      <input
                        type="number"
                        min={1}
                        value={form.chapterMax}
                        onChange={(event) => setForm({ ...form, chapterMax: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="field-grid">
                    <label className="field">
                      <span>单次最多章节数</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={form.maxChapters}
                        onChange={(event) => setForm({ ...form, maxChapters: event.target.value })}
                      />
                      <small>1–50 章；作业只能选择范围内的规划中/写作中章节。</small>
                    </label>
                    <label className="field">
                      <span>每章目标字数</span>
                      <input
                        type="number"
                        min={300}
                        max={4000}
                        value={form.targetWords}
                        onChange={(event) => setForm({ ...form, targetWords: event.target.value })}
                      />
                      <small>300–4000 字；低于门禁字数下限时预检会提醒。</small>
                    </label>
                  </div>

                  <label className="field">
                    <span>续写指令</span>
                    <textarea
                      value={form.instruction}
                      maxLength={2000}
                      rows={3}
                      placeholder="例如：延续冷静克制的叙述，保持林默的视角，不引入新设定。"
                      onChange={(event) => setForm({ ...form, instruction: event.target.value })}
                    />
                    <small>会加入每章生成上下文；不能指定绕过门禁或自动批准豁免。</small>
                  </label>

                  <div className="field-grid">
                    <label className="field">
                      <span>有效期 · 小时</span>
                      <input
                        type="number"
                        min={1}
                        max={720}
                        value={form.expiresInHours}
                        onChange={(event) =>
                          setForm({ ...form, expiresInHours: event.target.value })
                        }
                      />
                      <small>1–720 小时；过期后不能创建或恢复作业。</small>
                    </label>
                    <div className="field">
                      <span>预算上限</span>
                      <div className="automation-budget-row">
                        <label className="provider-check">
                          <input
                            type="checkbox"
                            checked={form.budgetEnabled}
                            onChange={(event) =>
                              setForm({ ...form, budgetEnabled: event.target.checked })
                            }
                          />
                          <span>启用</span>
                        </label>
                        <input
                          type="number"
                          min={0}
                          step="0.0001"
                          disabled={!form.budgetEnabled}
                          value={form.budgetLimit}
                          placeholder="例如 5"
                          onChange={(event) =>
                            setForm({ ...form, budgetLimit: event.target.value })
                          }
                        />
                        <select
                          value={form.budgetCurrency}
                          disabled={!form.budgetEnabled}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              budgetCurrency: event.target.value as PriceCurrency,
                            })
                          }
                        >
                          <option value="CNY">CNY</option>
                          <option value="USD">USD</option>
                        </select>
                      </div>
                      <small>
                        每次调用按剩余预算与服务商价表限制 max_tokens，并在章节检查点累计；
                        服务商未定价或币种不一致时预检失败。费用仍是估算，不是供应商账单。
                      </small>
                    </div>
                  </div>

                  <label className="provider-check">
                    <input
                      type="checkbox"
                      checked={form.allowAutoCommit}
                      onChange={(event) =>
                        setForm({ ...form, allowAutoCommit: event.target.checked })
                      }
                    />
                    <span>
                      五门禁全部通过后自动提交正典（来源记为 batch）；关闭时只暂存，等待人工提交。
                      AI 不申请、不批准豁免。
                    </span>
                  </label>
                  <label className="provider-check">
                    <input
                      type="checkbox"
                      checked={form.allowNonProductionGates}
                      onChange={(event) =>
                        setForm({ ...form, allowNonProductionGates: event.target.checked })
                      }
                    />
                    <span>
                      接受非生产门禁规则集：当前唯一规则集 dev-v0 仅用于验证链路。开启自动入库时，
                      不勾选此项会被预检阻止；关闭自动入库时不勾选只会得到提醒。
                    </span>
                  </label>
                  <label className="provider-check">
                    <input
                      type="checkbox"
                      checked={form.allowRemoteModels}
                      onChange={(event) =>
                        setForm({ ...form, allowRemoteModels: event.target.checked })
                      }
                    />
                    <span>
                      允许把章节上下文与正文发送到非本机模型端点；不勾选时预检会阻止远程服务商。
                    </span>
                  </label>

                  <div className="provider-form-note">
                    本版只支持「续写」模式：逐章生成、逐章评估五门禁，任一失败都不入库。同一工作区一次只运行
                    一个作业；暂停/停止在章节边界生效；自动备份尚未接入，请先运行
                    scripts/backup-db.sh 并验证恢复。
                  </div>

                  <div className="provider-form-actions">
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={savingMandate}
                      onClick={() => setFormOpen(false)}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="button button-primary"
                      disabled={savingMandate || workOptions.length === 0}
                    >
                      {savingMandate ? '创建中…' : '创建授权'}
                    </button>
                  </div>
                </form>
              ) : null}

              {mandatesQuery.isLoading ? (
                <p className="empty-state">正在读取授权……</p>
              ) : mandatesQuery.isError ? (
                <div className="modal-error">读取授权失败：{errorMessage(mandatesQuery.error)}</div>
              ) : mandates.length === 0 ? (
                <div className="provider-empty">
                  <p>尚未创建自动化授权。</p>
                  <p className="muted">
                    授权必须显式限定作品、章节范围、章数、有效期与预算；没有有效授权不能启动作业。
                  </p>
                </div>
              ) : (
                <ul className="automation-mandate-list">
                  {mandates.map((mandate) => (
                    <li key={mandate.id} className="automation-mandate-card">
                      <div className="automation-mandate-head">
                        <div>
                          <p className="eyebrow">{mandate.workTitle}</p>
                          <h4>{mandate.name}</h4>
                        </div>
                        <AutomationMandateStatusBadge status={mandate.status} />
                      </div>
                      <div className="automation-mandate-facts">
                        <span>
                          续写第 {mandate.chapterMin}–{mandate.chapterMax} 章
                        </span>
                        <span>
                          最多 {mandate.maxChapters} 章 · 每章约 {mandate.targetWords} 字
                        </span>
                        <span>截止 {formatDateTime(mandate.expiresAt)}</span>
                        <span>
                          {mandate.createdByName} 创建
                          {mandate.revokedAt
                            ? ` · ${mandate.revokedByName ?? '—'} 撤销于 ${formatDateTime(mandate.revokedAt)}`
                            : ''}
                        </span>
                      </div>
                      <div className="provider-badges">
                        <Badge tone={mandate.allowAutoCommit ? 'green' : 'amber'}>
                          {mandate.allowAutoCommit ? '通过即自动入库' : '仅暂存'}
                        </Badge>
                        <Badge tone={mandate.allowRemoteModels ? 'amber' : 'neutral'}>
                          {mandate.allowRemoteModels ? '允许远程模型' : '仅本机模型'}
                        </Badge>
                        <Badge tone={mandate.allowNonProductionGates ? 'amber' : 'neutral'}>
                          {mandate.allowNonProductionGates
                            ? '已接受非生产门禁'
                            : '未确认非生产门禁'}
                        </Badge>
                        <Badge tone="neutral">
                          {mandate.budgetLimit !== null
                            ? `预算 ${money(mandate.budgetLimit, mandate.budgetCurrency)}`
                            : '未设预算'}
                        </Badge>
                      </div>
                      {mandate.instruction ? (
                        <p className="automation-mandate-instruction">{mandate.instruction}</p>
                      ) : null}
                      <div className="provider-card-actions">
                        {mandate.status === 'active' ? (
                          <>
                            <button
                              type="button"
                              className="button button-primary button-small"
                              onClick={() => useMandate(mandate)}
                            >
                              用此授权启动作业
                            </button>
                            {confirmRevokeId === mandate.id ? (
                              <span className="provider-confirm">
                                撤销授权会停止其作业，确认？
                                <button
                                  type="button"
                                  className="button button-danger button-small"
                                  disabled={busy}
                                  onClick={() => void handleRevokeMandate(mandate.id)}
                                >
                                  {busyAction === 'revoke' ? '撤销中…' : '确认撤销'}
                                </button>
                                <button
                                  type="button"
                                  className="button button-quiet button-small"
                                  onClick={() => setConfirmRevokeId(null)}
                                >
                                  取消
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="button button-quiet button-small"
                                disabled={busy}
                                onClick={() => setConfirmRevokeId(mandate.id)}
                              >
                                撤销授权
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="muted">
                            该授权已{mandate.status === 'revoked' ? '撤销' : '过期'}，不能启动作业。
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="automation-layout">
              <aside className="automation-side">
                <div className="automation-side-head">
                  <div>
                    <p className="eyebrow">最近作业</p>
                    <p className="muted">共 {jobs.length} 个</p>
                  </div>
                  <button
                    type="button"
                    className="button button-primary button-small"
                    onClick={() => {
                      setLaunching(true);
                      resetFeedback();
                    }}
                  >
                    新建作业
                  </button>
                </div>
                {jobsQuery.isLoading ? (
                  <p className="empty-state">正在读取作业……</p>
                ) : jobsQuery.isError ? (
                  <p className="automation-side-empty">
                    读取失败：{errorMessage(jobsQuery.error)}
                  </p>
                ) : jobs.length === 0 ? (
                  <p className="automation-side-empty">
                    还没有作业。创建授权后，选择章节并预检即可启动。
                  </p>
                ) : (
                  <ul className="automation-job-list">
                    {jobs.map((job) => (
                      <li key={job.id}>
                        <button
                          type="button"
                          className={`automation-job-item${
                            effectiveJobId === job.id ? ' is-active' : ''
                          }`}
                          onClick={() => {
                            setLaunching(false);
                            setSelectedJobId(job.id);
                            resetFeedback();
                          }}
                        >
                          <span className="automation-job-top">
                            <strong>{job.mandateName}</strong>
                            <AutomationJobStatusBadge status={job.status} />
                          </span>
                          <span className="automation-job-facts">
                            {job.workTitle} · 作业 {job.totalChapters} 章
                          </span>
                          <span className="automation-job-facts">
                            入库 {job.committedChapters} · 暂存 {job.stagedChapters} · 失败{' '}
                            {job.failedChapters}
                          </span>
                          <span className="automation-job-time">
                            {formatDateTime(job.updatedAt)}
                            {job.costUnknown ? ' · 费用未知' : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>

              <section className="automation-main">
                {showLauncher ? (
                  <div className="automation-launcher">
                    <div className="provider-form-head">
                      <div>
                        <p className="eyebrow">新建无人值守作业</p>
                        <h3>选择授权与章节</h3>
                      </div>
                      {jobs.length > 0 ? (
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          onClick={() => setLaunching(false)}
                        >
                          返回作业
                        </button>
                      ) : null}
                    </div>

                    {activeMandates.length === 0 ? (
                      <div className="provider-empty">
                        <p>没有有效授权，不能启动作业。</p>
                        <p className="muted">
                          授权必须由所有者或主笔显式创建，并限定章节范围、章数与有效期。
                        </p>
                        <button
                          type="button"
                          className="button button-primary button-small"
                          onClick={() => {
                            setTab('mandates');
                            startCreateMandate();
                          }}
                        >
                          去创建授权
                        </button>
                      </div>
                    ) : (
                      <>
                        <label className="field">
                          <span>授权</span>
                          <select
                            value={selectedMandate?.id ?? ''}
                            onChange={(event) => setSelectedMandateId(event.target.value)}
                          >
                            {activeMandates.map((mandate) => (
                              <option key={mandate.id} value={mandate.id}>
                                {mandate.name} · {mandate.workTitle} · 第 {mandate.chapterMin}–
                                {mandate.chapterMax} 章
                              </option>
                            ))}
                          </select>
                        </label>

                        {selectedMandate ? (
                          <>
                            <div className="automation-mandate-summary">
                              <span>
                                作品：<strong>{selectedMandate.workTitle}</strong>
                              </span>
                              <span>
                                范围：第 {selectedMandate.chapterMin}–
                                {selectedMandate.chapterMax} 章
                              </span>
                              <span>
                                最多 {selectedMandate.maxChapters} 章 · 每章约{' '}
                                {selectedMandate.targetWords} 字
                              </span>
                              <span>
                                截止 {formatDateTime(selectedMandate.expiresAt)}
                              </span>
                              <Badge tone={selectedMandate.allowAutoCommit ? 'green' : 'amber'}>
                                {selectedMandate.allowAutoCommit ? '通过即自动入库' : '仅暂存'}
                              </Badge>
                              <Badge tone={selectedMandate.allowRemoteModels ? 'amber' : 'neutral'}>
                                {selectedMandate.allowRemoteModels ? '允许远程模型' : '仅本机模型'}
                              </Badge>
                              <Badge
                                tone={
                                  selectedMandate.allowNonProductionGates ? 'amber' : 'neutral'
                                }
                              >
                                {selectedMandate.allowNonProductionGates
                                  ? '已接受非生产门禁'
                                  : '未确认非生产门禁'}
                              </Badge>
                            </div>

                            <div className="field">
                              <div className="field-head">
                                <span>
                                  章节 · 已选 {selectedChapterIds.length} / 最多{' '}
                                  {selectedMandate.maxChapters}
                                </span>
                                <span className="field-head-actions">
                                  <button
                                    type="button"
                                    className="button button-quiet button-small"
                                    disabled={eligibleChapters.length === 0}
                                    onClick={selectEligible}
                                  >
                                    全选可续写章节
                                  </button>
                                </span>
                              </div>
                              {workChapters.length === 0 ? (
                                <p className="automation-side-empty">该作品还没有章节。</p>
                              ) : (
                                <div className="automation-chapter-picker">
                                  {workChapters.map((chapter) => {
                                    const inRange =
                                      chapter.number >= selectedMandate.chapterMin &&
                                      chapter.number <= selectedMandate.chapterMax;
                                    const writable =
                                      chapter.status === 'planned' || chapter.status === 'writing';
                                    const checked = selectedChapterIds.includes(chapter.id);
                                    const limitReached =
                                      !checked &&
                                      selectedChapterIds.length >= selectedMandate.maxChapters;
                                    const disabled = !inRange || !writable || limitReached;
                                    return (
                                      <label
                                        key={chapter.id}
                                        className={`automation-chapter-option${
                                          disabled ? ' is-disabled' : ''
                                        }${checked ? ' is-checked' : ''}`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          disabled={disabled}
                                          onChange={() => toggleChapter(chapter.id)}
                                        />
                                        <span className="chapter-no">第 {chapter.number} 章</span>
                                        <span className="automation-chapter-title">
                                          {chapter.title}
                                        </span>
                                        <span className="muted">
                                          {inRange
                                            ? writable
                                              ? chapter.status === 'planned'
                                                ? '规划中'
                                                : '写作中'
                                              : chapter.status === 'canon'
                                                ? '已入正典'
                                                : '当前不可续写'
                                            : '超出授权范围'}
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                              )}
                              <small>
                                只有规划中/写作中且在授权范围内的章节可选；同一工作区一次只运行一个作业。
                              </small>
                            </div>

                            {eligibleChapters.length === 0 ? (
                              <p className="automation-side-empty">
                                当前授权范围内没有可续写章节。已入正典的章节不会被重复生成。
                              </p>
                            ) : null}

                            {preflight ? <PreflightPanel view={preflight} /> : null}

                            <div className="automation-honesty automation-honesty-compact">
                              <p>
                                <strong>执行边界</strong>
                                暂停、停止在章节边界生效；runner 心跳超过 5 分钟会标记中断，只能人工恢复。
                              </p>
                              <p>
                                <strong>预算与备份</strong>
                                每次调用按剩余预算与价表限制 max_tokens，并在章节检查点累计；费用仍是估算。
                                自动备份尚未接入，启动前请运行 scripts/backup-db.sh 并验证恢复。
                              </p>
                              <p>
                                <strong>门禁</strong>
                                自动入库必须显式接受非生产规则集（当前为 dev-v0）；AI 不申请、不批准豁免；
                                任一门禁失败只保留草稿与评估，不会入库。
                              </p>
                            </div>

                            <div className="automation-launch-actions">
                              <button
                                type="button"
                                className="button button-secondary"
                                disabled={
                                  preflighting ||
                                  starting ||
                                  selectedChapterIds.length === 0
                                }
                                onClick={() => void handlePreflight()}
                              >
                                {preflighting ? '预检中…' : '运行预检（不调用模型）'}
                              </button>
                              <button
                                type="button"
                                className="button button-primary"
                                disabled={
                                  starting ||
                                  preflighting ||
                                  !preflight?.ok ||
                                  selectedChapterIds.length === 0
                                }
                                onClick={() => void handleStartJob()}
                              >
                                {starting ? '启动中…' : '启动无人值守作业'}
                              </button>
                            </div>
                            {!preflight ? (
                              <p className="muted">
                                启动前必须先运行预检；预检只读取数据库与授权，不发起任何模型调用。
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : selectedJob ? (
                  <AutomationJobDetail
                    job={selectedJob}
                    mandate={selectedJobMandate}
                    busyAction={busyAction}
                    onPause={() => void handleJobAction('pause', selectedJob.id)}
                    onResume={() => void handleJobAction('resume', selectedJob.id)}
                    onStop={() => void handleJobAction('stop', selectedJob.id)}
                    onRevoke={() => {
                      if (selectedJobMandate) void handleRevokeMandate(selectedJobMandate.id);
                    }}
                    onOpenChapter={onOpenChapter}
                  />
                ) : (
                  <div className="empty-state">
                    <p>请选择左侧作业，或点击「新建作业」。</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <span className="commit-foot-hint">
            当前身份：{me.user.name} · AI 无豁免权 · 门禁失败不入库 · 预算=调用级 max_tokens +
            章节检查点
          </span>
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
