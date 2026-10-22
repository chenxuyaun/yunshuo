import type { GateEvaluationView } from '@yunshuo/contracts';
import { formatDateTime, shortHash } from '../format.js';
import { LEDGER_KIND_LABELS, LEDGER_SCOPE_LABELS } from '../ledger.js';
import { GateStatusBadge, Badge } from './Badge.js';

const GATE_HINT_LABELS = {
  core_entity: '核心实体',
  causality: '因果律',
} as const;

interface Props {
  evaluation: GateEvaluationView | null;
  draftHash: string | null;
  isDirty: boolean;
}

export function GatePanel({ evaluation, draftHash, isDirty }: Props) {
  const stale = Boolean(
    evaluation && draftHash && evaluation.contentHash !== draftHash,
  );

  return (
    <section className="panel gate-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">质量闸门</p>
          <h2>五道硬门禁</h2>
        </div>
        {evaluation ? (
          <Badge tone={evaluation.status === 'passed' ? 'green' : evaluation.status === 'failed' ? 'red' : 'amber'}>
            {evaluation.status === 'passed'
              ? '全部通过'
              : evaluation.status === 'failed'
                ? '存在未通过'
                : '存在未配置/错误'}
          </Badge>
        ) : null}
      </header>

      {evaluation ? (
        <>
          <div className="evidence-meta">
            <span className="ruleset-tag">{evaluation.ruleset.key} v{evaluation.ruleset.version}</span>
            {!evaluation.ruleset.isProduction ? (
              <Badge tone="amber">开发规则集 · 非生产</Badge>
            ) : (
              <Badge tone="green">生产规则集</Badge>
            )}
            <span className="muted">正文 {shortHash(evaluation.contentHash)}</span>
            <span className="muted">{formatDateTime(evaluation.createdAt)}</span>
          </div>
          <p className="ruleset-description">{evaluation.ruleset.description}</p>
          {stale ? (
            <div className="inline-warning">
              这份结论对应的是另一版正文，已过期；请保存当前草稿后重跑门禁。
            </div>
          ) : null}
          {isDirty ? (
            <div className="inline-warning">
              编辑区有未保存内容；门禁只认已落盘草稿的哈希。
            </div>
          ) : null}
          <ul className="gate-list">
            {evaluation.results.map((gate) => (
              <li key={gate.key} className={`gate-row gate-${gate.status}`}>
                <div className="gate-row-head">
                  <span className="gate-name">{gate.label}</span>
                  <GateStatusBadge status={gate.status} />
                </div>
                <p className="gate-message">{gate.message}</p>
                <details className="evidence-details">
                  <summary>查看证据</summary>
                  <pre>{JSON.stringify(gate.evidence, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>

          {evaluation.hints.length > 0 ? (
            <div className="gate-hints">
              <div className="gate-hints-head">
                <strong>账本提示</strong>
                <Badge tone="amber">不参与硬门禁结论</Badge>
              </div>
              <p className="gate-hints-note">
                以下信息来自已发布的设定、角色与伏笔，只帮助人工复核；通过或未通过仍以上面的硬门禁为准。
              </p>
              {evaluation.hints.map((hint) => (
                <div key={hint.gate} className="gate-hint">
                  <div className="gate-hint-head">
                    <span className="gate-hint-gate">{GATE_HINT_LABELS[hint.gate]}</span>
                    <span className="muted">提示</span>
                  </div>
                  <p className="gate-hint-message">{hint.message}</p>
                  {hint.entries.length > 0 ? (
                    <ul className="gate-hint-entries">
                      {hint.entries.map((entry) => (
                        <li key={entry.id}>
                          <Badge tone="ink">{LEDGER_KIND_LABELS[entry.kind]}</Badge>
                          <span>{entry.name}</span>
                          <span className="muted">
                            v{entry.versionNo} · {LEDGER_SCOPE_LABELS[entry.scope]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {hint.terms.length > 0 ? (
                    <p className="gate-hint-terms">命中：{hint.terms.join('、')}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state">
          <p>尚无门禁结论。</p>
          <p className="muted">
            结论绑定正文哈希、规则版本与上下文指纹；旧结论不能复用。保存草稿后点击“跑五门禁”。
          </p>
        </div>
      )}
    </section>
  );
}
