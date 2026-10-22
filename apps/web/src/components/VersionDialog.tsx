import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getVersion } from '../api.js';
import { formatDateTime, shortHash, SOURCE_LABELS } from '../format.js';
import { Badge, GateStatusBadge, VersionGateBadge, WaiverStatusBadge } from './Badge.js';

interface Props {
  versionId: string;
  chapterNumber: number;
  chapterTitle: string;
  onClose: () => void;
}

export function VersionDialog({ versionId, chapterNumber, chapterTitle, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['version', versionId],
    queryFn: () => getVersion(versionId),
  });

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

  const version = query.data;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-version"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">
              正典留痕 · 第 {chapterNumber} 章
            </p>
            <h2 id="version-title">
              {chapterTitle}
              {version ? ` · v${version.versionNo}` : ''}
            </h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          {query.isLoading ? (
            <p className="empty-state">正在读取版本与证据……</p>
          ) : query.isError ? (
            <div className="modal-error">
              读取失败：
              {query.error instanceof Error ? query.error.message : String(query.error)}
            </div>
          ) : version ? (
            <>
              <div className="version-meta">
                <span>{SOURCE_LABELS[version.source]}</span>
                <span>{version.wordCount} 字</span>
                <span>{version.actorName ?? '系统导入'}</span>
                <span>{formatDateTime(version.createdAt)}</span>
                <VersionGateBadge status={version.gateStatus} />
                {!version.evaluation && version.source === 'import' ? (
                  <Badge tone="neutral">迁移导入 · 无门禁证据</Badge>
                ) : null}
              </div>

              <div className="hash-lines">
                <p>
                  <span>正文哈希</span>
                  <code>{version.contentHash}</code>
                </p>
                {version.parentVersionId ? (
                  <p>
                    <span>父版本</span>
                    <code>{shortHash(version.parentVersionId)}</code>
                  </p>
                ) : null}
              </div>

              {!version.evaluation ? (
                <div className="inline-warning">
                  该版本没有门禁评估记录。系统如实标记为“未评估”，不补造通过结论。
                  {version.source === 'import'
                    ? '迁移导入正文保留原样，后续修订需重新走门禁。'
                    : ''}
                </div>
              ) : null}

              <article className="manuscript-readonly">
                {version.content
                  .split(/\n+/)
                  .filter((paragraph) => paragraph.trim().length > 0)
                  .map((paragraph, index) => (
                    <p key={`${version.id}-${index}`}>{paragraph}</p>
                  ))}
              </article>

              {version.evaluation ? (
                <section className="version-evidence">
                  <div className="version-evidence-head">
                    <div>
                      <p className="eyebrow">门禁证据</p>
                      <h3>
                        {version.evaluation.ruleset.key} v{version.evaluation.ruleset.version}
                      </h3>
                    </div>
                    <Badge tone={version.evaluation.ruleset.isProduction ? 'green' : 'amber'}>
                      {version.evaluation.ruleset.isProduction ? '生产规则集' : '开发规则集 · 非生产'}
                    </Badge>
                  </div>
                  <p className="muted">
                    评估时间 {formatDateTime(version.evaluation.createdAt)} · 上下文指纹{' '}
                    {shortHash(version.evaluation.contextHash)}
                  </p>
                  <ul className="evidence-list">
                    {version.evaluation.results.map((gate) => (
                      <li key={gate.key}>
                        <div className="evidence-list-head">
                          <span>{gate.label}</span>
                          <GateStatusBadge status={gate.status} />
                        </div>
                        <p>{gate.message}</p>
                        <details className="evidence-details">
                          <summary>查看证据</summary>
                          <pre>{JSON.stringify(gate.evidence, null, 2)}</pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {version.waiver ? (
                <section className="waiver-box">
                  <div className="waiver-box-head">
                    <p className="eyebrow">显式豁免 · 不等于门禁通过</p>
                    <WaiverStatusBadge status={version.waiver.status} />
                  </div>
                  <h3>
                    回滚豁免 · 由 {version.waiver.requestedByName} 申请
                  </h3>
                  <p>{version.waiver.reason}</p>
                  <p className="muted">
                    审批：
                    {version.waiver.decidedByName ??
                      version.waiver.approvedByName ??
                      '未记录'}
                    {version.waiver.decidedAt
                      ? ` · ${formatDateTime(version.waiver.decidedAt)}`
                      : version.waiver.approvedAt
                        ? ` · ${formatDateTime(version.waiver.approvedAt)}`
                        : ''}
                    {version.waiver.decisionNote
                      ? ` · 备注：${version.waiver.decisionNote}`
                      : ''}
                  </p>
                  <p className="muted">
                    该豁免一次性、绑定具体目标版本；它解除的是指定回滚动作的证据要求，
                    不会改写任何门禁结论。
                  </p>
                </section>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="modal-foot">
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
