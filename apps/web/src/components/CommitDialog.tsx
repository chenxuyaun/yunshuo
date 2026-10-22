import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ChapterDetail, CommitResponse } from '@yunshuo/contracts';
import { ApiError, commitChapter } from '../api.js';
import { shortHash } from '../format.js';
import { Badge, GateStatusBadge } from './Badge.js';

interface Props {
  chapter: ChapterDetail;
  onClose: () => void;
  onCommitted: (result: CommitResponse) => void;
}

export function CommitDialog({ chapter, onClose, onCommitted }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const staged = chapter.stagedDraft;
  const evaluation = chapter.latestEvaluation;
  const idempotencyKey = staged ? `commit-${staged.id}` : '';

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
      if (!staged) throw new Error('没有可提交的暂存草稿');
      return commitChapter(chapter.id, {
        idempotencyKey,
        targetChapterId: chapter.id,
        expectedCurrentVersionId: chapter.currentVersion?.id ?? null,
        stagedDraftId: staged.id,
      });
    },
    onSuccess: (result) => onCommitted(result),
    onError: (mutationError) => {
      setError(
        mutationError instanceof ApiError
          ? `${mutationError.message}（${mutationError.code}）`
          : mutationError instanceof Error
            ? mutationError.message
            : String(mutationError),
      );
    },
  });

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !mutation.isPending) onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdrop}>
      <div
        className="modal modal-commit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">不可逆操作 · 单事务写入</p>
            <h2 id="commit-title">把暂存稿写入正典</h2>
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
            <p className="eyebrow">提交目标</p>
            <p className="commit-target-title">
              第 {chapter.number} 章 · {chapter.title}
            </p>
            <p className="muted">
              当前正典：
              {chapter.currentVersion
                ? `v${chapter.currentVersion.versionNo}`
                : '无（本章首次入库）'}
            </p>
          </div>

          <dl className="summary-grid">
            <div>
              <dt>暂存正文</dt>
              <dd>
                {staged?.wordCount ?? 0} 字 · {shortHash(staged?.contentHash)}
              </dd>
            </div>
            <div>
              <dt>门禁证据</dt>
              <dd>
                {evaluation ? (
                  <span className="summary-inline">
                    <Badge tone={evaluation.status === 'passed' ? 'green' : 'red'}>
                      {evaluation.status === 'passed' ? '全部通过' : '未全部通过'}
                    </Badge>
                    <span>{shortHash(evaluation.id)}</span>
                  </span>
                ) : (
                  <Badge tone="red">缺少门禁证据</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt>规则集</dt>
              <dd>
                {evaluation
                  ? `${evaluation.ruleset.key} v${evaluation.ruleset.version}`
                  : chapter.ruleset
                    ? `${chapter.ruleset.key} v${chapter.ruleset.version}`
                    : '—'}
                {evaluation && !evaluation.ruleset.isProduction ? (
                  <span className="muted"> · 非生产</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>幂等键</dt>
              <dd className="mono">{idempotencyKey || '—'}</dd>
            </div>
          </dl>

          {evaluation ? (
            <ul className="commit-gates">
              {evaluation.results.map((gate) => (
                <li key={gate.key}>
                  <span>{gate.label}</span>
                  <GateStatusBadge status={gate.status} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="modal-error">
              暂存草稿缺少门禁证据，提交会在服务端被拒绝。请撤回暂存并重新跑门禁。
            </div>
          )}

          <div className="commit-transaction-note">
            <strong>写入范围</strong>
            <p>
              新版本、当前正典指针、章节状态、字数元数据、事件、审计、outbox 与索引状态在同一个事务里提交；
              任一步失败都会整体回滚，不会留下半截正典。
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
              我确认目标是第 {chapter.number} 章《{chapter.title}》，并已核对暂存正文与门禁证据。
            </span>
          </label>

          {error ? <div className="modal-error">{error}</div> : null}
        </div>

        <footer className="modal-foot">
          {!confirmed && staged && !mutation.isPending ? (
            <span className="commit-foot-hint">请先勾选上方确认项，确认按钮才会启用。</span>
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
            disabled={!confirmed || !staged || mutation.isPending}
          >
            {mutation.isPending ? '正在提交……' : '确认写入正典'}
          </button>
        </footer>
      </div>
    </div>
  );
}
