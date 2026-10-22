import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type {
  ChapterDetail,
  RollbackResponse,
  VersionSummary,
} from '@yunshuo/contracts';
import { ApiError, rollbackChapter } from '../api.js';
import { formatDateTime, shortHash, VERSION_GATE_LABELS } from '../format.js';
import { VersionGateBadge } from './Badge.js';

interface Props {
  chapter: ChapterDetail;
  target: VersionSummary;
  onClose: () => void;
  onRolledBack: (result: RollbackResponse, target: VersionSummary) => void;
}

export function RollbackDialog({ chapter, target, onClose, onRolledBack }: Props) {
  const [reason, setReason] = useState('');
  const [waiverId, setWaiverId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const currentVersion = chapter.currentVersion;
  const usedWaiverIds = new Set(
    chapter.versions
      .map((version) => version.waiverId)
      .filter((id): id is string => Boolean(id)),
  );
  const approvedWaivers = chapter.waivers.filter(
    (waiver) =>
      waiver.targetVersionId === target.id &&
      waiver.status === 'approved' &&
      !usedWaiverIds.has(waiver.id),
  );
  const idempotencyKey = `rollback-${chapter.id}-${currentVersion?.id ?? 'none'}-${target.id}`;
  const evidenceMayBeStale = target.gateStatus !== 'passed';
  const noApprovedWaiver = approvedWaivers.length === 0;

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

  const mutation = useMutation({
    mutationFn: () => {
      if (!currentVersion) throw new Error('章节没有当前正典，不能回滚');
      return rollbackChapter(chapter.id, {
        idempotencyKey,
        targetVersionId: target.id,
        expectedCurrentVersionId: currentVersion.id,
        reason,
        waiverId: waiverId || undefined,
      });
    },
    onSuccess: (result) => onRolledBack(result, target),
    onError: (mutationError) => {
      if (mutationError instanceof ApiError) {
        setError(
          mutationError.code === 'ROLLBACK_EVIDENCE_REQUIRED'
            ? `${mutationError.message}。请在右侧“豁免与审批”中申请，并由另一位所有者或主笔批准后再回滚。`
            : `${mutationError.message}（${mutationError.code}）`,
        );
      } else {
        setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      }
    },
  });

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <div
        className="modal modal-rollback"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rollback-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">正典回滚 · 生成新版本</p>
            <h2 id="rollback-title">回滚到 v{target.versionNo}</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            关闭
          </button>
        </header>

        <div className="modal-body">
          <div className="commit-target">
            <p className="eyebrow">回滚目标</p>
            <p className="commit-target-title">
              第 {chapter.number} 章 · {chapter.title}
            </p>
            <p className="muted">
              当前正典：{currentVersion ? `v${currentVersion.versionNo}` : '无'} · 目标：v
              {target.versionNo}（{VERSION_GATE_LABELS[target.gateStatus]}）
            </p>
          </div>

          <dl className="summary-grid">
            <div>
              <dt>目标正文</dt>
              <dd>
                {target.wordCount} 字 · {shortHash(target.contentHash)}
              </dd>
            </div>
            <div>
              <dt>目标门禁</dt>
              <dd>
                <span className="summary-inline">
                  <VersionGateBadge status={target.gateStatus} />
                  {target.actorName ? <span>{target.actorName}</span> : null}
                </span>
              </dd>
            </div>
            <div>
              <dt>原始入库时间</dt>
              <dd>{formatDateTime(target.createdAt)}</dd>
            </div>
            <div>
              <dt>幂等键</dt>
              <dd className="mono">{idempotencyKey}</dd>
            </div>
          </dl>

          {evidenceMayBeStale ? (
            <div className="inline-warning">
              目标版本的门禁状态是“{VERSION_GATE_LABELS[target.gateStatus]}”。若没有可复用的通过门禁证据，
              服务端会拒绝直接回滚，必须使用已批准且未使用的回滚豁免。
            </div>
          ) : (
            <p className="muted">
              目标版本曾通过门禁。若规则集与设定上下文至今未变化，回滚会直接复用该证据；
              否则仍需已批准的回滚豁免。
            </p>
          )}

          <label className="rollback-field">
            <span>证据来源</span>
            <select
              value={waiverId}
              onChange={(event) => setWaiverId(event.target.value)}
              disabled={mutation.isPending}
            >
              <option value="">自动：优先复用通过的门禁证据</option>
              {approvedWaivers.map((waiver) => (
                <option key={waiver.id} value={waiver.id}>
                  使用已批准豁免 · {waiver.requestedByName} 申请 · {waiver.reason.slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
          {noApprovedWaiver ? (
            <p className="waiver-meta rollback-waiver-hint">
              该目标暂无已批准且未使用的回滚豁免。
            </p>
          ) : null}

          <label className="rollback-field">
            <span>回滚原因</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="写明为什么需要回到该版本（至少 4 个字，会写入事件、审计与新版本记录）"
              rows={3}
              maxLength={2000}
              disabled={mutation.isPending}
            />
          </label>

          <div className="commit-transaction-note">
            <strong>回滚不是删除</strong>
            <p>
              系统会用目标正文生成一个来源为“回滚”的新正典版本，并更新当前正典指针；
              现有版本全部保留。新版本、指针、事件、审计、outbox 与索引状态在同一事务内写入。
            </p>
          </div>

          <label className="commit-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={mutation.isPending}
            />
            <span>
              我确认把第 {chapter.number} 章《{chapter.title}》回滚到 v{target.versionNo}，
              并理解这会生成新版本而不是删除历史。
            </span>
          </label>

          {error ? <div className="modal-error">{error}</div> : null}
        </div>

        <footer className="modal-foot">
          {!confirmed && !mutation.isPending ? (
            <span className="commit-foot-hint">请先勾选上方确认项。</span>
          ) : null}
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            取消
          </button>
          <button
            type="button"
            className="button button-vermilion"
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
            disabled={!confirmed || reason.trim().length < 4 || mutation.isPending}
          >
            {mutation.isPending ? '正在回滚……' : '确认回滚'}
          </button>
        </footer>
      </div>
    </div>
  );
}
