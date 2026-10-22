import { useEffect, useState } from 'react';
import type { AutomationJobView, AutomationMandateView, PriceCurrency } from '@yunshuo/contracts';
import { formatDateTime } from '../format.js';
import {
  AutomationChapterStatusBadge,
  AutomationJobStatusBadge,
  AutomationMandateStatusBadge,
} from './Badge.js';

interface Props {
  job: AutomationJobView;
  mandate: AutomationMandateView | null;
  busyAction: 'pause' | 'resume' | 'stop' | 'revoke' | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRevoke: () => void;
  onOpenChapter: (chapterId: string) => void;
}

function money(value: number, currency: PriceCurrency): string {
  return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(4)}`;
}

export function AutomationJobDetail({
  job,
  mandate,
  busyAction,
  onPause,
  onResume,
  onStop,
  onRevoke,
  onOpenChapter,
}: Props) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    setConfirmStop(false);
    setConfirmRevoke(false);
  }, [job.id]);

  const active = job.status === 'queued' || job.status === 'running';
  const pausable = active && !job.pauseRequested;
  const resumable = job.status === 'paused' || job.status === 'interrupted';
  const stoppable = active || job.status === 'paused' || job.status === 'interrupted';
  const finished = job.committedChapters + job.stagedChapters + job.failedChapters + job.skippedChapters;
  const percent = job.totalChapters > 0 ? Math.round((finished / job.totalChapters) * 100) : 0;
  const autoCommit =
    mandate?.allowAutoCommit ??
    job.preflight.checks.find((check) => check.key === 'auto_commit')?.status === 'pass';
  const busy = busyAction !== null;

  return (
    <article className="automation-detail">
      <header className="automation-detail-head">
        <div>
          <p className="eyebrow">
            {job.workTitle} · 授权「{job.mandateName}」
          </p>
          <h3>{job.totalChapters} 章无人值守作业</h3>
          <p className="muted">
            由 {job.createdByName} 创建于 {formatDateTime(job.createdAt)}
            {job.startedAt ? ` · 开始于 ${formatDateTime(job.startedAt)}` : ''}
            {job.completedAt ? ` · 结束于 ${formatDateTime(job.completedAt)}` : ''}
          </p>
        </div>
        <AutomationJobStatusBadge status={job.status} />
      </header>

      {job.lastError ? <div className="automation-alert">{job.lastError}</div> : null}

      {job.status === 'running' && job.pauseRequested ? (
        <div className="automation-info">已请求暂停：runner 会在当前章节结束后停下。</div>
      ) : null}
      {job.status === 'running' && job.stopRequested ? (
        <div className="automation-info">已请求停止：runner 会在当前章节结束后停止，不再处理后续章节。</div>
      ) : null}
      {job.status === 'interrupted' ? (
        <div className="automation-info">
          作业已中断（runner 心跳超过 5 分钟或服务关闭）。中断不会自动恢复，只能人工恢复。
        </div>
      ) : null}

      <div className="automation-progress">
        <div className="automation-progress-head">
          <span>{percent}% 已到检查点</span>
          <span className="muted">
            {finished} / {job.totalChapters} 章已处理
          </span>
        </div>
        <div
          className="automation-progress-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>

      <dl className="automation-stats">
        <div>
          <dt>已入库</dt>
          <dd>{job.committedChapters}</dd>
        </div>
        <div>
          <dt>已暂存</dt>
          <dd>{job.stagedChapters}</dd>
        </div>
        <div>
          <dt>门禁/生成失败</dt>
          <dd>{job.failedChapters}</dd>
        </div>
        <div>
          <dt>已跳过</dt>
          <dd>{job.skippedChapters}</dd>
        </div>
        <div>
          <dt>累计费用</dt>
          <dd>
            {money(job.spent, job.costCurrency)}
            {job.costUnknown ? <small>含未知费用</small> : null}
          </dd>
        </div>
        <div>
          <dt>入库策略</dt>
          <dd>{autoCommit ? '自动入库 · batch' : '仅暂存'}</dd>
        </div>
      </dl>

      <div className="automation-meta">
        <span>
          授权：
          {mandate ? (
            <>
              <AutomationMandateStatusBadge status={mandate.status} />
              {mandate.budgetLimit !== null
                ? ` · 预算 ${money(mandate.budgetLimit, mandate.budgetCurrency)}`
                : ' · 未设预算'}
            </>
          ) : (
            '读取中…'
          )}
        </span>
        <span>远程模型：{mandate?.allowRemoteModels ? '已授权' : '未授权'}</span>
        <span>
          执行心跳：
          {job.heartbeatAt ? formatDateTime(job.heartbeatAt) : '—'}
          {job.runnerId ? ` · ${job.runnerId.slice(0, 8)}` : ''}
        </span>
      </div>

      <div className="automation-actions">
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={!pausable || busy}
          onClick={onPause}
        >
          {busyAction === 'pause'
            ? '提交中…'
            : job.status === 'running'
              ? '请求暂停（章节结束后生效）'
              : '暂停作业'}
        </button>
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={!resumable || busy}
          onClick={onResume}
        >
          {busyAction === 'resume' ? '恢复中…' : '人工恢复'}
        </button>
        {confirmStop ? (
          <span className="provider-confirm">
            停止后不再处理后续章节，确认？
            <button
              type="button"
              className="button button-danger button-small"
              disabled={busy}
              onClick={() => {
                setConfirmStop(false);
                onStop();
              }}
            >
              {busyAction === 'stop' ? '停止中…' : '确认停止'}
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => setConfirmStop(false)}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={!stoppable || busy}
            onClick={() => setConfirmStop(true)}
          >
            停止作业
          </button>
        )}
        {mandate?.status === 'active' ? (
          confirmRevoke ? (
            <span className="provider-confirm">
              撤销授权会同时停止该授权下的作业，确认？
              <button
                type="button"
                className="button button-danger button-small"
                disabled={busy}
                onClick={() => {
                  setConfirmRevoke(false);
                  onRevoke();
                }}
              >
                {busyAction === 'revoke' ? '撤销中…' : '确认撤销'}
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setConfirmRevoke(false)}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy}
              onClick={() => setConfirmRevoke(true)}
            >
              撤销授权
            </button>
          )
        ) : null}
        {!pausable && job.status === 'running' && job.pauseRequested ? (
          <span className="muted">暂停请求已记录。</span>
        ) : null}
      </div>

      <ol className="automation-chapter-list">
        {job.chapters.map((chapter) => (
          <li key={chapter.chapterId} className="automation-chapter-row">
            <button
              type="button"
              className="automation-chapter-open"
              onClick={() => onOpenChapter(chapter.chapterId)}
              title="在写作台打开该章节"
            >
              <span className="chapter-no">第 {chapter.chapterNumber} 章</span>
              <strong>{chapter.chapterTitle}</strong>
            </button>
            <AutomationChapterStatusBadge status={chapter.status} />
            <span className="automation-chapter-cost">
              {chapter.cost !== null && chapter.costCurrency
                ? money(chapter.cost, chapter.costCurrency)
                : '—'}
            </span>
            <p className="automation-chapter-reason">
              {chapter.reason ??
                (chapter.status === 'committed'
                  ? '五门禁通过并已写入正典。'
                  : chapter.status === 'pending'
                    ? '等待 runner 处理。'
                    : chapter.status === 'running'
                      ? '正在生成或评估。'
                      : '—')}
            </p>
          </li>
        ))}
      </ol>

      <div className="automation-honesty">
        <p>
          <strong>预算</strong>
          只在章节检查点累计费用，不会实时中断正在进行的模型调用；费用未知时会暂停作业。
        </p>
        <p>
          <strong>备份</strong>
          备份/快照尚未接入，自动入库前不会自动备份，请自行确认恢复手段。
        </p>
        <p>
          <strong>门禁与豁免</strong>
          AI 不申请、不批准豁免；任一门禁失败只保留草稿与评估，不会入库。
        </p>
        <p>
          <strong>并发</strong>
          同一工作区一次只运行一个作业；暂停、停止与恢复都由人工操作。
        </p>
      </div>
    </article>
  );
}
