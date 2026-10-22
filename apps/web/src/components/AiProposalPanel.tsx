import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiProposalMeta,
  AiProposalMode,
  AiProposalView,
  ChapterDetail,
} from '@yunshuo/contracts';
import { ApiError, listAiProposals, streamAiProposal } from '../api.js';
import { formatDateTime } from '../format.js';
import { LEDGER_KIND_LABELS, LEDGER_SCOPE_LABELS } from '../ledger.js';

interface Props {
  chapter: ChapterDetail;
  content: string;
  dirty: boolean;
  canEditNow: boolean;
  onAdopt: (text: string, mode: AiProposalMode) => void;
}

interface Notice {
  tone: 'success' | 'error' | 'info';
  text: string;
}

const MODE_LABELS: Record<AiProposalMode, string> = {
  continue: '续写',
  expand: '加厚',
};

const STATUS_LABELS: Record<AiProposalView['status'], string> = {
  generating: '生成中',
  ready: '已生成',
  failed: '失败',
};

const RETRIEVAL_LABELS = {
  ok: '语义 + 词法',
  lexical: '仅词法（语义不可用）',
  unavailable: '不可用',
} as const;

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

function formatCost(proposal: AiProposalView): string {
  if (proposal.cost === null) return '成本未知';
  const symbol =
    proposal.costCurrency === 'USD' ? '$' : proposal.costCurrency === 'CNY' ? '¥' : '';
  const amount = `${symbol}${proposal.cost.toFixed(4)}`;
  return `成本 ${proposal.costCurrency && !symbol ? `${amount} ${proposal.costCurrency}` : amount}`;
}

export function AiProposalPanel({ chapter, content, dirty, canEditNow, onAdopt }: Props) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AiProposalMode>('continue');
  const [instruction, setInstruction] = useState('');
  const [targetWords, setTargetWords] = useState(1200);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState('');
  const [previewMode, setPreviewMode] = useState<AiProposalMode>('continue');
  const [meta, setMeta] = useState<AiProposalMeta | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [awaitingSave, setAwaitingSave] = useState(false);

  useEffect(() => {
    if (!awaitingSave || dirty) return;
    setAwaitingSave(false);
    setNotice({ tone: 'success', text: '采用后的正文已保存；仍需跑五门禁、暂存与提交。' });
  }, [awaitingSave, dirty]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const historyQuery = useQuery({
    queryKey: ['aiProposals', chapter.id],
    queryFn: () => listAiProposals(chapter.id),
  });

  useEffect(() => {
    runSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setPreview('');
    setPreviewMode('continue');
    setMeta(null);
    setNotice(null);
    setError(null);
    setInstruction('');
  }, [chapter.id]);

  useEffect(() => {
    return () => {
      runSeqRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [preview]);

  const effectiveTarget = Math.min(4000, Math.max(300, targetWords || 1200));
  const generateBlocker = !canEditNow
    ? '需要先取得编辑租约'
    : dirty
      ? '请先保存草稿；AI 只读取已落盘正文'
      : mode === 'expand' && !chapter.draft
        ? '加厚模式需要先保存一份草稿'
        : null;

  async function handleGenerate() {
    if (generating || generateBlocker) return;
    const seq = ++runSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setPreview('');
    setPreviewMode(mode);
    setMeta(null);
    setError(null);
    setNotice(null);
    setAwaitingSave(false);

    const isCurrent = () => runSeqRef.current === seq;
    const update = (action: () => void) => {
      if (isCurrent()) action();
    };

    try {
      await streamAiProposal(
        chapter.id,
        {
          mode,
          instruction: instruction.trim(),
          targetWords: effectiveTarget,
        },
        {
          onMeta: (nextMeta) =>
            update(() => {
              setMeta(nextMeta);
              setPreviewMode(nextMeta.mode);
            }),
          onDelta: (text) => update(() => setPreview((previous) => previous + text)),
          onAttempt: (attempt) =>
            update(() => {
              setNotice({
                tone: 'info',
                text:
                  attempt.status === 'retrying'
                    ? `第 ${attempt.attempt} 次调用失败（${attempt.errorCode}），正在重试 ${attempt.nextProviderName}。`
                    : `第 ${attempt.attempt} 次调用失败（${attempt.errorCode}），已切换到 ${attempt.nextProviderName} · ${attempt.nextModel}。`,
              });
            }),
          onDone: (proposal) =>
            update(() => {
              setPreview(proposal.content);
              setPreviewMode(proposal.mode);
              setMeta((current) =>
                current
                  ? {
                      ...current,
                      providerName: proposal.providerName,
                      model: proposal.model,
                    }
                  : current,
              );
              setNotice({
                tone: 'success',
                text: `提案已生成：${proposal.wordCount} 字 · ${
                  proposal.latencyMs ?? '—'
                }ms · 尝试 ${proposal.attempts} 次 · ${formatCost(proposal)}。未写入编辑器，也未落入正典。`,
              });
              void queryClient.invalidateQueries({ queryKey: ['aiProposals', chapter.id] });
            }),
          onError: (streamError) =>
            update(() => {
              setError(`${streamError.message}（${streamError.code}）`);
              void queryClient.invalidateQueries({ queryKey: ['aiProposals', chapter.id] });
            }),
        },
        controller.signal,
      );
    } catch (streamError) {
      if (!controller.signal.aborted) {
        update(() => setError(formatError(streamError)));
      } else {
        update(() => {
          setPreview('');
          setMeta(null);
          setNotice({ tone: 'info', text: '已停止生成；编辑器一字未动。' });
          void queryClient.invalidateQueries({ queryKey: ['aiProposals', chapter.id] });
        });
      }
    } finally {
      update(() => setGenerating(false));
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleDiscard() {
    setPreview('');
    setMeta(null);
    setError(null);
    setNotice(null);
    setAwaitingSave(false);
  }

  function handleAdopt() {
    if (!preview.trim() || generating || error) return;
    if (dirty) {
      const action = previewMode === 'continue' ? '追加到' : '替换';
      if (!window.confirm(`编辑区有未保存内容，采用提案将${action}当前编辑区。仍要继续？`)) return;
    }
    if (meta?.baseDraftHash && chapter.draft && meta.baseDraftHash !== chapter.draft.contentHash) {
      if (!window.confirm('这份提案基于旧版草稿生成；当前已保存草稿已变化。仍要采用？')) return;
    }
    onAdopt(preview, previewMode);
    setAwaitingSave(true);
    setNotice({
      tone: 'info',
      text: '已采用到编辑区，但尚未保存、未过门禁。请检查后保存草稿并跑五门禁。',
    });
  }

  function loadHistorical(proposal: AiProposalView) {
    if (proposal.status !== 'ready' || !proposal.content) return;
    abortRef.current?.abort();
    runSeqRef.current += 1;
    setGenerating(false);
    setPreview(proposal.content);
    setPreviewMode(proposal.mode);
    setMeta({
      proposalId: proposal.id,
      providerName: proposal.providerName,
      model: proposal.model,
      mode: proposal.mode,
      context: proposal.context,
      baseDraftHash: proposal.baseDraftHash,
      candidateCount: 1,
      skippedProviderCount: 0,
      startedAt: proposal.createdAt,
    });
    setError(null);
    setAwaitingSave(false);
    setNotice({
      tone: 'info',
      text: `已载入 ${formatDateTime(proposal.createdAt)} 的提案；采用后仍需保存与门禁。`,
    });
  }

  const history = historyQuery.data ?? [];
  const editorChars = content.replace(/\s/g, '').length;

  return (
    <section className="ai-panel">
      <div className="ai-panel-head">
        <div>
          <p className="eyebrow">AI 提案 · 不自动落盘</p>
          <h3>续写与加厚</h3>
        </div>
        <span className="ai-model-tag">
          {meta
            ? `${meta.providerName} · ${meta.model}${
                meta.candidateCount > 1 ? ` · 候选 ${meta.candidateCount}` : ''
              }${meta.skippedProviderCount > 0 ? ` · 跳过 ${meta.skippedProviderCount}` : ''}`
            : '按优先级选择已启用的服务商'}
        </span>
      </div>

      <div className="ai-controls">
        <div className="ai-mode-toggle" role="group" aria-label="生成模式">
          {(['continue', 'expand'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`ai-mode-button${mode === value ? ' ai-mode-active' : ''}`}
              onClick={() => setMode(value)}
              disabled={generating}
            >
              {MODE_LABELS[value]}
            </button>
          ))}
        </div>
        <label className="ai-number">
          <span>目标字数</span>
          <input
            type="number"
            min={300}
            max={4000}
            step={100}
            value={targetWords}
            onChange={(event) => setTargetWords(Number(event.target.value))}
            disabled={generating}
          />
        </label>
        <button
          type="button"
          className="button button-primary button-small"
          onClick={() => void handleGenerate()}
          disabled={generating || Boolean(generateBlocker)}
          title={generateBlocker ?? '调用已启用服务商生成提案'}
        >
          {generating ? '生成中……' : '生成 AI 提案'}
        </button>
      </div>

      <textarea
        className="ai-instruction"
        value={instruction}
        maxLength={2000}
        onChange={(event) => setInstruction(event.target.value)}
        disabled={generating}
        placeholder="补充要求（可选）：例如加强雨夜压迫感、让林默更被动、结尾停在追兵破门前。"
      />

      <div className="ai-honesty">
        <span>编辑器现有 {editorChars} 字；生成只读取已保存草稿。</span>
        <span>采用后仍走：保存草稿 → 五门禁 → 暂存 → 正典。</span>
        <span>未输出正文前的失败会自动重试或切换服务商；已输出后不再重试。</span>
      </div>

      {generateBlocker ? <p className="ai-blocker">{generateBlocker}</p> : null}
      {error ? (
        <div className="ai-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? <div className={`ai-notice ai-notice-${notice.tone}`}>{notice.text}</div> : null}

      {generating || preview ? (
        <div className="ai-preview">
          <div className="ai-preview-head">
            <strong>
              {generating
                ? '模型输出中…'
                : error
                  ? '提案未完成 · 不可采用'
                  : `AI 提案 · ${MODE_LABELS[previewMode]}`}
            </strong>
            <span>{meta ? `${meta.providerName} · ${meta.model}` : '等待元信息'}</span>
          </div>
          <div className="ai-preview-body" ref={previewRef}>
            {preview || (generating ? '等待首个增量……' : '暂无内容')}
          </div>
          <div className="ai-preview-actions">
            {generating ? (
              <button type="button" className="button button-quiet button-small" onClick={handleStop}>
                停止生成
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-primary button-small"
                  onClick={handleAdopt}
                  disabled={!preview.trim() || Boolean(error)}
                  title={
                    error
                      ? '失败或不完整的提案不能采用'
                      : previewMode === 'continue'
                        ? '把提案追加到编辑区末尾'
                        : '用提案替换编辑区正文'
                  }
                >
                  {previewMode === 'continue' ? '追加到编辑器' : '替换编辑器'}
                </button>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={handleDiscard}
                >
                  丢弃预览
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {meta ? (
        <div className="ai-context">
          <p className="ai-context-title">上下文包 · {meta.context.promptVersion}</p>
          <div className="ai-context-sections">
            {meta.context.sections.map((section) => (
              <span key={section.key} className="ai-context-chip">
                {section.label} {section.usedChars}/{section.chars}
                {section.truncated ? ' · 截断' : ''}
              </span>
            ))}
          </div>
          {meta.context.unavailable.length > 0 ? (
            <p className="ai-context-missing">
              未使用：{meta.context.unavailable.join('；')}
            </p>
          ) : null}

          {meta.context.ledger ? (
            <div className="ai-ledger">
              <p className="ai-context-title">
                设定、角色与伏笔 ·{' '}
                {meta.context.ledger.status === 'ok' ? '已注入' : '不可用'} ·{' '}
                {meta.context.ledger.citations.length} 条引用
                {meta.context.ledger.truncated ? ' · 已按预算截断' : ''}
              </p>
              {meta.context.ledger.reason ? (
                <p className="ai-context-missing">{meta.context.ledger.reason}</p>
              ) : null}
              {meta.context.ledger.usedCharacters.length > 0 ? (
                <p className="ai-context-missing">
                  已使用角色：{meta.context.ledger.usedCharacters.join('、')}
                </p>
              ) : null}
              {meta.context.ledger.citations.length > 0 ? (
                <ul className="ai-retrieval-list">
                  {meta.context.ledger.citations.map((citation) => (
                    <li key={citation.ref}>
                      <span className="ai-retrieval-ref">[{citation.ref}]</span>
                      <span>
                        {LEDGER_KIND_LABELS[citation.kind]} · {citation.name} · v
                        {citation.versionNo} · {LEDGER_SCOPE_LABELS[citation.scope]} ·{' '}
                        {citation.chars} 字
                        {citation.truncated ? ' · 本条截断' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {meta.context.retrieval ? (
            <div className="ai-retrieval">
              <p className="ai-context-title">
                正典检索 · {RETRIEVAL_LABELS[meta.context.retrieval.status]} ·{' '}
                {meta.context.retrieval.citations.length} 条引用
              </p>
              {meta.context.retrieval.reason ? (
                <p className="ai-context-missing">{meta.context.retrieval.reason}</p>
              ) : null}
              {meta.context.retrieval.citations.length > 0 ? (
                <ul className="ai-retrieval-list">
                  {meta.context.retrieval.citations.map((citation) => (
                    <li key={citation.ref}>
                      <span className="ai-retrieval-ref">[{citation.ref}]</span>
                      <span>
                        第 {citation.chapterNumber} 章 · {citation.chapterTitle} · v
                        {citation.versionNo} · 第 {citation.paragraphStart}-{citation.paragraphEnd} 段
                        · {citation.chars} 字
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {meta.context.retrieval.coverage ? (
                <p className="ai-context-missing">
                  覆盖：就绪 {meta.context.retrieval.coverage.ready}/
                  {meta.context.retrieval.coverage.totalCanonChapters} 章 · 可检索{' '}
                  {meta.context.retrieval.coverage.chunks} 块
                  {meta.context.retrieval.coverage.vectorModel
                    ? ` · ${meta.context.retrieval.coverage.vectorModel}`
                    : ' · 向量未建立'}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="ai-history">
        <summary>
          历史提案 {history.length > 0 ? `(${history.length})` : ''}
          {historyQuery.isLoading ? ' · 读取中…' : ''}
        </summary>
        {historyQuery.isError ? (
          <p className="ai-history-empty">历史提案读取失败：{formatError(historyQuery.error)}</p>
        ) : history.length === 0 ? (
          <p className="ai-history-empty">还没有提案。生成成功后，提案会留在这里供重新载入。</p>
        ) : (
          <ul className="ai-history-list">
            {history.map((proposal) => (
              <li key={proposal.id} className="ai-history-item">
                <div>
                  <strong>
                    {MODE_LABELS[proposal.mode]} · {proposal.wordCount} 字 ·{' '}
                    {STATUS_LABELS[proposal.status]}
                  </strong>
                  <span>
                    {proposal.providerName} · {proposal.model} ·{' '}
                    {formatDateTime(proposal.createdAt)} · {proposal.createdByName}
                  </span>
                  <span>
                    {proposal.attempts > 0 ? `尝试 ${proposal.attempts} 次` : '尝试次数未知'}
                    {proposal.status === 'ready' ? ` · ${formatCost(proposal)}` : ''}
                  </span>
                  {proposal.status === 'failed' && proposal.errorMessage ? (
                    <span className="ai-history-error">{proposal.errorMessage}</span>
                  ) : null}
                </div>
                {proposal.status === 'ready' ? (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => loadHistorical(proposal)}
                  >
                    载入预览
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
