import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChapterDetail, MeResponse, WaiverView } from '@yunshuo/contracts';
import { ApiError, decideWaiver, requestWaiver } from '../api.js';
import { formatDateTime, VERSION_GATE_LABELS } from '../format.js';
import { Badge, WaiverStatusBadge } from './Badge.js';

interface Props {
  me: MeResponse;
  chapter: ChapterDetail;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

export function WaiverPanel({ me, chapter }: Props) {
  const queryClient = useQueryClient();
  const [targetVersionId, setTargetVersionId] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roleCanWrite = me.role === 'owner' || me.role === 'lead' || me.role === 'author';
  const canDecide = me.role === 'owner' || me.role === 'lead';
  const currentVersionNo = chapter.currentVersion?.versionNo ?? 0;
  const olderVersions = chapter.versions.filter(
    (version) => version.versionNo < currentVersionNo,
  );
  const usedWaiverIds = new Set(
    chapter.versions
      .map((version) => version.waiverId)
      .filter((id): id is string => Boolean(id)),
  );

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['chapter', chapter.id] });
    await queryClient.invalidateQueries({ queryKey: ['chapters'] });
  }

  const requestMutation = useMutation({
    mutationFn: () =>
      requestWaiver(chapter.id, {
        targetVersionId,
        gateKey: 'rollback',
        reason,
      }),
    onSuccess: async (waiver: WaiverView) => {
      setError(null);
      setNotice(
        `回滚豁免已提交给目标版本 v${versionNoOf(chapter, waiver.targetVersionId)}，等待另一位所有者或主笔审批。`,
      );
      setTargetVersionId('');
      setReason('');
      await refresh();
    },
    onError: (mutationError) => {
      setNotice(null);
      setError(formatError(mutationError));
    },
  });

  const decisionMutation = useMutation({
    mutationFn: ({
      waiver,
      decision,
    }: {
      waiver: WaiverView;
      decision: 'approve' | 'reject';
    }) => decideWaiver(chapter.id, waiver.id, decision, notes[waiver.id] ?? ''),
    onSuccess: async (waiver, variables) => {
      setError(null);
      setNotice(
        variables.decision === 'approve'
          ? `豁免已批准；现在可以在版本历史中对目标版本执行回滚。`
          : `豁免已拒绝；目标版本不能凭该申请回滚。`,
      );
      setNotes((current) => ({ ...current, [waiver.id]: '' }));
      await refresh();
    },
    onError: (mutationError) => {
      setNotice(null);
      setError(formatError(mutationError));
    },
  });

  const pending = chapter.waivers.filter((waiver) => waiver.status === 'pending').length;

  return (
    <section className="panel waiver-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">回滚治理</p>
          <h2>豁免与审批</h2>
        </div>
        <span className="muted">
          {pending > 0 ? `${pending} 项待审批` : `${chapter.waivers.length} 条记录`}
        </span>
      </header>

      <p className="waiver-panel-intro">
        回滚豁免一次性、绑定具体目标版本。申请人不能审批自己的申请，必须由另一位所有者或主笔批准。
      </p>

      {error ? <div className="inline-warning waiver-panel-error">{error}</div> : null}
      {notice ? <div className="waiver-panel-notice">{notice}</div> : null}

      {chapter.waivers.length === 0 ? (
        <p className="empty-state waiver-empty">本章还没有豁免记录。</p>
      ) : (
        <ul className="waiver-list">
          {chapter.waivers.map((waiver) => {
            const used = usedWaiverIds.has(waiver.id);
            const waitingForMe =
              waiver.status === 'pending' && canDecide && waiver.requestedBy !== me.user.id;
            return (
              <li key={waiver.id} className="waiver-item">
                <div className="waiver-item-top">
                  <WaiverStatusBadge status={waiver.status} />
                  <span className="waiver-target">
                    回滚至 v{versionNoOf(chapter, waiver.targetVersionId)}
                  </span>
                  {used ? <Badge tone="ink">已用于回滚</Badge> : null}
                </div>
                <p className="waiver-reason">{waiver.reason}</p>
                <p className="waiver-meta">
                  {waiver.requestedByName} 申请 · {formatDateTime(waiver.createdAt)}
                </p>
                {waiver.status !== 'pending' ? (
                  <p className="waiver-meta">
                    {waiver.status === 'approved' ? '批准' : '拒绝'}：
                    {waiver.decidedByName ?? waiver.approvedByName ?? '未记录'}
                    {waiver.decidedAt
                      ? ` · ${formatDateTime(waiver.decidedAt)}`
                      : waiver.approvedAt
                        ? ` · ${formatDateTime(waiver.approvedAt)}`
                        : ''}
                    {waiver.decisionNote ? ` · 备注：${waiver.decisionNote}` : ''}
                  </p>
                ) : waiver.requestedBy === me.user.id ? (
                  <p className="waiver-meta">等待另一位所有者或主笔审批。</p>
                ) : !canDecide ? (
                  <p className="waiver-meta">仅所有者或主笔可以审批。</p>
                ) : null}

                {waitingForMe ? (
                  <div className="waiver-decision">
                    <input
                      type="text"
                      value={notes[waiver.id] ?? ''}
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [waiver.id]: event.target.value,
                        }))
                      }
                      placeholder="审批备注（可选）"
                      maxLength={1000}
                      disabled={decisionMutation.isPending}
                    />
                    <div className="waiver-decision-actions">
                      <button
                        type="button"
                        className="button button-primary button-small"
                        onClick={() =>
                          decisionMutation.mutate({ waiver, decision: 'approve' })
                        }
                        disabled={decisionMutation.isPending}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() =>
                          decisionMutation.mutate({ waiver, decision: 'reject' })
                        }
                        disabled={decisionMutation.isPending}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {chapter.status === 'canon' && roleCanWrite ? (
        olderVersions.length === 0 ? (
          <p className="waiver-meta">当前没有可回滚的更早版本，暂不能申请回滚豁免。</p>
        ) : (
          <details className="waiver-request">
            <summary>申请回滚豁免</summary>
            <p className="waiver-meta">
              仅当目标版本没有可复用的通过门禁证据时才需要。提交后需另一位所有者或主笔批准。
            </p>
            <label className="waiver-field">
              <span>目标版本</span>
              <select
                value={targetVersionId}
                onChange={(event) => setTargetVersionId(event.target.value)}
                disabled={requestMutation.isPending}
              >
                <option value="">选择要回滚到的版本</option>
                {olderVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.versionNo} · {VERSION_GATE_LABELS[version.gateStatus]} ·{' '}
                    {version.wordCount} 字
                  </option>
                ))}
              </select>
            </label>
            <label className="waiver-field">
              <span>豁免原因</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="说明为什么该回滚必须跳过目标版本的门禁证据（至少 4 个字）"
                maxLength={2000}
                rows={3}
                disabled={requestMutation.isPending}
              />
            </label>
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => {
                setError(null);
                setNotice(null);
                requestMutation.mutate();
              }}
              disabled={
                requestMutation.isPending ||
                !targetVersionId ||
                reason.trim().length < 4
              }
            >
              {requestMutation.isPending ? '提交中……' : '提交豁免申请'}
            </button>
          </details>
        )
      ) : null}

      <p className="waiver-panel-caveat">
        “已豁免”不等于“已通过”。豁免只解除指定回滚动作的证据要求，不会改写门禁结论。
      </p>
    </section>
  );
}

function versionNoOf(chapter: ChapterDetail, versionId: string | null): string {
  if (!versionId) return '?';
  return String(
    chapter.versions.find((version) => version.id === versionId)?.versionNo ?? '?',
  );
}
