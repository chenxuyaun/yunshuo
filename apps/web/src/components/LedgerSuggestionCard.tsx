import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChapterListItem,
  LedgerEntryDetail,
  LedgerSuggestionProposal,
  LedgerSuggestionView,
} from '@yunshuo/contracts';
import {
  ApiError,
  acceptLedgerSuggestion,
  createLedgerSuggestion,
  listLedgerSuggestions,
  rejectLedgerSuggestion,
} from '../api.js';
import {
  CHARACTER_LIFE_LABELS,
  FORESHADOWING_STATE_LABELS,
} from '../ledger.js';
import { formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';

const SUGGESTION_STATUS_LABELS: Record<LedgerSuggestionView['status'], string> = {
  generating: '生成中',
  ready: '待人工确认',
  failed: '生成失败',
  applying: '写入草稿中',
  accepted: '已采纳（仅草稿）',
  rejected: '已拒绝',
};

const SUGGESTION_KIND_LABELS: Record<LedgerSuggestionView['kind'], string> = {
  character_state: '角色状态变更',
  foreshadowing_state: '伏笔回收状态',
};

function statusTone(status: LedgerSuggestionView['status']): BadgeTone {
  switch (status) {
    case 'ready':
      return 'ink';
    case 'accepted':
      return 'green';
    case 'failed':
      return 'red';
    case 'rejected':
      return 'muted';
    default:
      return 'amber';
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

function hasReportedUsage(suggestion: LedgerSuggestionView): boolean {
  return suggestion.usage.promptTokens !== null || suggestion.usage.completionTokens !== null;
}

// 未计价有两种原因，不能混为一谈：有用量但缺价表条目，还是模型根本没上报用量。
function costLabel(suggestion: LedgerSuggestionView): string {
  if (suggestion.cost !== null) {
    return `${suggestion.cost.toFixed(4)} ${suggestion.costCurrency ?? 'CNY'}`;
  }
  return hasReportedUsage(suggestion)
    ? '未计价（该服务商没有价表条目，用量已上报）'
    : '未计价（本次没有上报用量）';
}

function usageLabel(suggestion: LedgerSuggestionView): string {
  const { promptTokens, completionTokens } = suggestion.usage;
  return hasReportedUsage(suggestion)
    ? `用量 ${promptTokens ?? '?'} / ${completionTokens ?? '?'} tokens`
    : '用量未上报';
}

function proposalRows(proposal: LedgerSuggestionProposal): [string, string][] {
  if (proposal.kind === 'character_state') {
    return [
      ['截至章节', `第 ${proposal.asOfChapterNumber} 章`],
      ['生死', CHARACTER_LIFE_LABELS[proposal.life]],
      ['地点', proposal.location || '未提及'],
      ['已知信息', proposal.knowledge || '未提及'],
      ['持有物', proposal.possessions || '未提及'],
      ['关系变化', proposal.relationshipChanges || '未提及'],
    ];
  }
  return [
    ['回收状态', FORESHADOWING_STATE_LABELS[proposal.state]],
    [
      '回收章节',
      proposal.payoffChapterNumber === null ? '未指定' : `第 ${proposal.payoffChapterNumber} 章`,
    ],
    ['说明', proposal.resolutionNote || '未提及'],
  ];
}

interface Props {
  entry: LedgerEntryDetail;
  chapters: ChapterListItem[];
  canWrite: boolean;
}

export function LedgerSuggestionCard({ entry, chapters, canWrite }: Props) {
  const queryClient = useQueryClient();
  const [basisChapterId, setBasisChapterId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidateChapters = [...chapters]
    .filter((chapter) => !entry.workId || chapter.workId === entry.workId)
    .sort((left, right) => right.number - left.number);

  const suggestionsQuery = useQuery({
    queryKey: ['ledgerSuggestions', entry.id],
    queryFn: () => listLedgerSuggestions(entry.id),
  });

  const suggestions = suggestionsQuery.data?.suggestions ?? [];

  async function refreshAfterDecision(entryId: string) {
    setDecidingId(null);
    setDecisionNote('');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ledgerSuggestions', entryId] }),
      queryClient.invalidateQueries({ queryKey: ['ledgerEntry', entryId] }),
      queryClient.invalidateQueries({ queryKey: ['ledgerVersions', entryId] }),
      queryClient.invalidateQueries({ queryKey: ['ledgerEntries'] }),
      queryClient.invalidateQueries({ queryKey: ['ledgerCharacterTimeline'] }),
      queryClient.invalidateQueries({ queryKey: ['foreshadowingReport'] }),
    ]);
  }

  const createMutation = useMutation({
    mutationFn: (input: { basisChapterId: string; instruction: string }) =>
      createLedgerSuggestion(entry.id, input),
    onSuccess: async (created) => {
      setError(null);
      if (created.status === 'ready') {
        setNotice(`建议已生成（${created.providerName}）；采纳只会写入草稿，发布仍需人工确认。`);
      } else {
        setNotice(`建议未生成（${created.errorCode ?? '未知原因'}）；原因见下方记录。`);
      }
      await queryClient.invalidateQueries({ queryKey: ['ledgerSuggestions', entry.id] });
    },
    onError: async (createError) => {
      setError(errorText(createError));
      await queryClient.invalidateQueries({ queryKey: ['ledgerSuggestions', entry.id] });
    },
  });

  const acceptMutation = useMutation({
    mutationFn: (suggestionId: string) =>
      acceptLedgerSuggestion(suggestionId, { note: decisionNote.trim() }),
    onSuccess: async (result) => {
      setError(null);
      const draftNo = result.suggestion.resultDraftVersionNo;
      setNotice(
        `已采纳：${draftNo === null ? '未发布草稿' : `草稿 v${draftNo}`} 已写入。` +
          '生效版本、检索结果与门禁提示都未改变，发布后才进入账本。',
      );
      await refreshAfterDecision(result.entry.id);
    },
    onError: async (acceptError) => {
      setError(errorText(acceptError));
      await refreshAfterDecision(entry.id);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (suggestionId: string) =>
      rejectLedgerSuggestion(suggestionId, { note: decisionNote.trim() }),
    onSuccess: async () => {
      setError(null);
      setNotice('已拒绝该建议；账本未做任何写入。');
      await refreshAfterDecision(entry.id);
    },
    onError: async (rejectError) => {
      setError(errorText(rejectError));
      await refreshAfterDecision(entry.id);
    },
  });

  return (
    <section className="ledger-section">
      <div className="ledger-section-head">
        <div>
          <p className="eyebrow">AI 建议（人工确认）</p>
          <h4>状态变更与伏笔回收建议 · {suggestions.length}</h4>
        </div>
        <Badge tone="neutral">只写草稿</Badge>
      </div>

      {notice ? <div className="provider-notice provider-notice-success">{notice}</div> : null}
      {error ? <div className="modal-error">{error}</div> : null}

      {canWrite ? (
        <div className="ledger-suggestion-create">
          <div className="ledger-suggestion-create-row">
            <label className="field">
              <span>依据章节（须已有正典正文）</span>
              <select
                value={basisChapterId}
                onChange={(event) => setBasisChapterId(event.target.value)}
              >
                <option value="">选择章节</option>
                {candidateChapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    第 {chapter.number} 章 · {chapter.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button button-primary button-small"
              disabled={
                !basisChapterId ||
                createMutation.isPending ||
                suggestions.some((item) => item.status === 'generating')
              }
              onClick={() => {
                setError(null);
                setNotice(null);
                createMutation.mutate({
                  basisChapterId,
                  instruction: instruction.trim(),
                });
              }}
            >
              {createMutation.isPending ? '正在调用模型…' : '生成建议'}
            </button>
          </div>
          <label className="field">
            <span>补充说明（可选，最多 500 字）</span>
            <textarea
              value={instruction}
              rows={2}
              maxLength={500}
              placeholder="例如：注意本章只写到离镇，不要提前判定死亡"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <p className="muted">
            模型只能读依据章节的正典正文与当前生效版本，输出仅作为建议；
            采纳写入草稿，发布仍由人工完成。生成会占用工作区月度模型预算，单次最长约 45 秒。
          </p>
        </div>
      ) : (
        <p className="muted">
          当前角色只读：可以查看历史建议，但不能生成、采纳或拒绝。只有所有者、主笔与作者可以操作。
        </p>
      )}

      {suggestionsQuery.isLoading ? (
        <p className="empty-state">正在读取建议记录……</p>
      ) : suggestionsQuery.isError ? (
        <div className="modal-error">建议读取失败：{errorText(suggestionsQuery.error)}</div>
      ) : suggestions.length === 0 ? (
        <p className="empty-state">
          {canWrite
            ? '还没有生成过建议。选择依据章节后点击“生成建议”。'
            : '还没有建议记录。'}
        </p>
      ) : (
        <ul className="ledger-suggestion-list">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id} className="ledger-suggestion-row">
              <div className="ledger-suggestion-head">
                <Badge tone={statusTone(suggestion.status)}>
                  {SUGGESTION_STATUS_LABELS[suggestion.status]}
                </Badge>
                <Badge tone="neutral">{SUGGESTION_KIND_LABELS[suggestion.kind]}</Badge>
                <span className="muted">
                  {suggestion.providerName || '未记录服务商'} · {suggestion.model || '未记录模型'} ·{' '}
                  {formatDateTime(suggestion.createdAt)}
                </span>
              </div>
              <div className="ledger-suggestion-facts">
                <span>
                  依据：
                  {suggestion.basisChapter
                    ? `第 ${suggestion.basisChapter.number} 章 · ${suggestion.basisChapter.title}`
                    : '未记录'}
                </span>
                <span>
                  基准：{suggestion.baseVersionNo ? `生效 v${suggestion.baseVersionNo}` : '尚无生效版本'}
                </span>
                <span>{costLabel(suggestion)}</span>
                <span>{usageLabel(suggestion)}</span>
                <span>
                  尝试 {suggestion.attempts} 次
                  {suggestion.latencyMs !== null ? ` · 耗时 ${suggestion.latencyMs} ms` : ''}
                </span>
                <span>发起人：{suggestion.createdByName ?? '未知'}</span>
              </div>
              {suggestion.instruction ? (
                <p className="ledger-suggestion-instruction">补充说明：{suggestion.instruction}</p>
              ) : null}

              {suggestion.status === 'failed' ? (
                <div className="modal-error">
                  生成失败（{suggestion.errorCode ?? '未知错误码'}）：
                  {suggestion.errorMessage ?? '模型未返回可用结果'}
                </div>
              ) : suggestion.proposal ? (
                <div className="ledger-suggestion-proposal">
                  <dl className="ledger-suggestion-proposal-grid">
                    {proposalRows(suggestion.proposal).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {suggestion.rationale ? (
                    <p className="ledger-suggestion-rationale">依据说明：{suggestion.rationale}</p>
                  ) : (
                    <p className="muted">模型未给出依据说明。</p>
                  )}
                  {suggestion.evidence.length > 0 ? (
                    <ul className="ledger-suggestion-evidence">
                      {suggestion.evidence.map((item, index) => (
                        <li key={`${item.type}-${index}`}>
                          <span>
                            {item.type === 'chapter' ? '正文' : '账本版本'}：{item.label}
                          </span>
                          {item.detail ? <span className="muted">{item.detail}</span> : null}
                          {item.truncated ? <Badge tone="amber">已截断</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">模型未给出可核验的引用。</p>
                  )}
                </div>
              ) : suggestion.status === 'generating' ? (
                <p className="empty-state">仍在生成中；若请求中断，稍后列表会自动标记为已中断。</p>
              ) : null}

              {suggestion.status === 'accepted' ? (
                <div className="provider-notice provider-notice-success">
                  已由 {suggestion.decidedByName ?? '未知'} 于{' '}
                  {suggestion.decidedAt ? formatDateTime(suggestion.decidedAt) : '未记录'} 采纳，
                  写入草稿 v{suggestion.resultDraftVersionNo ?? '?'}。
                  生效版本未被修改；如需生效请人工发布该草稿。
                  {suggestion.decisionNote ? ` 确认说明：${suggestion.decisionNote}` : ''}
                </div>
              ) : null}

              {suggestion.status === 'rejected' ? (
                <p className="muted">
                  已由 {suggestion.decidedByName ?? '未知'} 拒绝
                  {suggestion.decisionNote ? `：${suggestion.decisionNote}` : ''}。账本未做任何写入。
                </p>
              ) : null}

              {suggestion.status === 'applying' ? (
                <div className="inline-warning">
                  该建议正在写入草稿。若长时间停留在这一状态，系统会在 5 分钟后把它退回“待人工确认”，
                  请先检查版本历史确认草稿是否已经生成，避免重复采纳。
                </div>
              ) : null}

              {canWrite && suggestion.status === 'ready' ? (
                decidingId === suggestion.id ? (
                  <div className="ledger-action-box">
                    <strong>采纳这条{SUGGESTION_KIND_LABELS[suggestion.kind]}建议？</strong>
                    <p>
                      采纳只新建未发布草稿，不会改变生效版本、检索结果与门禁提示。
                      若条目已存在草稿或生效版本已变化，采纳会被拒绝，以免覆盖人工修改。
                    </p>
                    <label className="field">
                      <span>确认说明（可选，写入决策记录）</span>
                      <textarea
                        value={decisionNote}
                        rows={2}
                        maxLength={1000}
                        placeholder="例如：与正文一致，接受该状态变更"
                        onChange={(event) => setDecisionNote(event.target.value)}
                      />
                    </label>
                    <div className="ledger-action-buttons">
                      <button
                        type="button"
                        className="button button-quiet"
                        onClick={() => {
                          setDecidingId(null);
                          setDecisionNote('');
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={rejectMutation.isPending}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          rejectMutation.mutate(suggestion.id);
                        }}
                      >
                        {rejectMutation.isPending ? '拒绝中…' : '拒绝建议'}
                      </button>
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={acceptMutation.isPending}
                        onClick={() => {
                          setError(null);
                          setNotice(null);
                          acceptMutation.mutate(suggestion.id);
                        }}
                      >
                        {acceptMutation.isPending ? '写入草稿中…' : '采纳并写入草稿'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ledger-version-actions">
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setDecidingId(suggestion.id);
                        setDecisionNote('');
                      }}
                    >
                      确认或拒绝
                    </button>
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {suggestionsQuery.data?.note ? (
        <p className="muted">{suggestionsQuery.data.note}</p>
      ) : null}
    </section>
  );
}
