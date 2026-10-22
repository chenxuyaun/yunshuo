import type { VersionSummary } from '@yunshuo/contracts';
import { formatDateTime, SOURCE_LABELS } from '../format.js';
import { Badge, VersionGateBadge } from './Badge.js';

interface Props {
  versions: VersionSummary[];
  currentVersionId: string | null;
  onOpen: (versionId: string) => void;
  canRollback?: boolean;
  onRollback?: (version: VersionSummary) => void;
}

export function VersionList({
  versions,
  currentVersionId,
  onOpen,
  canRollback = false,
  onRollback,
}: Props) {
  return (
    <section className="panel version-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">正典留痕</p>
          <h2>版本历史</h2>
        </div>
        <span className="muted">{versions.length} 个版本</span>
      </header>

      {versions.length === 0 ? (
        <div className="empty-state">
          <p>本章尚无正典版本。</p>
          <p className="muted">第一次提交会生成 v1，此前所有过程都留在隔离区。</p>
        </div>
      ) : (
        <ul className="version-list">
          {versions.map((version) => (
            <li key={version.id} className="version-entry">
              <button
                type="button"
                className="version-item"
                onClick={() => onOpen(version.id)}
              >
                <span className="version-top">
                  <span className="version-no">v{version.versionNo}</span>
                  {version.id === currentVersionId ? (
                    <Badge tone="ink">当前正典</Badge>
                  ) : null}
                  <VersionGateBadge status={version.gateStatus} />
                </span>
                <span className="version-preview">{version.contentPreview}</span>
                <span className="version-facts">
                  {SOURCE_LABELS[version.source]} · {version.wordCount} 字 ·{' '}
                  {version.actorName ?? '系统导入'} · {formatDateTime(version.createdAt)}
                </span>
              </button>
              {canRollback && version.id !== currentVersionId && onRollback ? (
                <button
                  type="button"
                  className="version-rollback"
                  onClick={() => onRollback(version)}
                >
                  回滚到此版本…
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
