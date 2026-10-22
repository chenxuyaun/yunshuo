import type { AuditReport } from '@yunshuo/contracts';
import { shortHash } from '../format.js';
import { Badge } from './Badge.js';

interface Props {
  report: AuditReport | null;
  onRun: () => void;
  busy: boolean;
  disabledReason: string | null;
  draftHash: string | null;
  isDirty: boolean;
}

const AUDIT_STATUS_LABEL = {
  ok: '未命中',
  warning: '提示',
  not_connected: '未接入',
} as const;

const AUDIT_TONE = {
  ok: 'green',
  warning: 'amber',
  not_connected: 'neutral',
} as const;

export function AuditPanel({
  report,
  onRun,
  busy,
  disabledReason,
  draftHash,
  isDirty,
}: Props) {
  return (
    <section className="panel audit-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">辅助检查</p>
          <h2>五类审计</h2>
        </div>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={onRun}
          disabled={busy || Boolean(disabledReason)}
          title={disabledReason ?? '审计只提示，不改写正文'}
        >
          {busy ? '运行中…' : '运行审计'}
        </button>
      </header>

      <div className="advisory-note">
        审计只提示，不自动改写正文。未接入的检测器如实显示“未接入”，不以“通过”冒充。
      </div>

      {report ? (
        <>
          <p className="audit-scope">
            对象：已保存草稿 {shortHash(draftHash)} · 审计不产生门禁证据
          </p>
          {isDirty ? (
            <div className="inline-warning">编辑区有未保存内容，这次审计不包含这些修改。</div>
          ) : null}
          <ul className="audit-list">
            {report.audits.map((audit) => (
              <li key={audit.key} className={`audit-row audit-${audit.status}`}>
                <div className="audit-row-head">
                  <span className="audit-name">{audit.label}</span>
                  <Badge tone={AUDIT_TONE[audit.status]}>{AUDIT_STATUS_LABEL[audit.status]}</Badge>
                </div>
                <p>{audit.message}</p>
                {audit.examples && audit.examples.length > 0 ? (
                  <p className="audit-examples">{audit.examples.join('、')}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="empty-state">
          <p>尚未运行审计。</p>
          <p className="muted">{disabledReason ?? '点击右上角运行；结果只作提示。'}</p>
        </div>
      )}
    </section>
  );
}
