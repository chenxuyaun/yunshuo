import { useState } from 'react';
import type { IndexStatusView } from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import { ApiError, reindexChapter } from '../api.js';
import { formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';

const INDEX_LABEL: Record<IndexStatusView['status'], string> = {
  pending: '等待索引 worker',
  indexing: '索引进行中',
  ready: '索引就绪',
  failed: '索引失败',
  not_configured: '未配置嵌入服务',
};

const INDEX_TONE: Record<IndexStatusView['status'], BadgeTone> = {
  pending: 'amber',
  indexing: 'amber',
  ready: 'green',
  failed: 'red',
  not_configured: 'neutral',
};

interface Props {
  chapterId: string;
  role: Role;
  status: IndexStatusView | null;
  onQueued?: () => void;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

export function IndexStatusCard({ chapterId, role, status, onQueued }: Props) {
  const [queueing, setQueueing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const canReindex = role === 'owner' || role === 'lead';
  const busy = queueing || status?.status === 'indexing';

  async function handleReindex() {
    setQueueing(true);
    setNotice(null);
    try {
      const response = await reindexChapter(chapterId);
      setNotice({ tone: 'ok', text: response.message });
      onQueued?.();
    } catch (error) {
      setNotice({ tone: 'error', text: formatError(error) });
    } finally {
      setQueueing(false);
    }
  }

  return (
    <section className="panel index-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">检索侧</p>
          <h2>向量索引</h2>
        </div>
        {status ? (
          <Badge tone={INDEX_TONE[status.status]}>{INDEX_LABEL[status.status]}</Badge>
        ) : (
          <Badge tone="muted">尚未入正典</Badge>
        )}
      </header>

      {status ? (
        <>
          <p className="index-detail">{status.detail ?? '无详情'}</p>

          <dl className="index-meta">
            <div>
              <dt>正典版本</dt>
              <dd>{status.versionNo === null ? '未知' : `v${status.versionNo}`}</dd>
            </div>
            <div>
              <dt>片段</dt>
              <dd>{status.chunkCount}</dd>
            </div>
            <div>
              <dt>嵌入模型</dt>
              <dd>{status.model ?? '未配置'}</dd>
            </div>
            <div>
              <dt>维度</dt>
              <dd>{status.dimensions === null ? '未知' : status.dimensions}</dd>
            </div>
            <div>
              <dt>服务商</dt>
              <dd>{status.providerName ?? '未配置'}</dd>
            </div>
            <div>
              <dt>尝试</dt>
              <dd>{status.attempts} 次</dd>
            </div>
          </dl>

          {status.nextRetryAt ? (
            <p className="muted">预计重试：{formatDateTime(status.nextRetryAt)}</p>
          ) : null}
          {status.lastError ? <p className="index-error">{status.lastError}</p> : null}
          <p className="muted">更新于 {formatDateTime(status.updatedAt)}</p>

          {notice ? (
            <p className={notice.tone === 'ok' ? 'index-notice' : 'index-error'}>{notice.text}</p>
          ) : null}

          <div className="index-actions">
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy || !canReindex}
              onClick={() => void handleReindex()}
              title={canReindex ? '按当前正典重新切块并嵌入' : '仅所有者与主笔可以重建索引'}
            >
              {queueing ? '排队中…' : '重建本章索引'}
            </button>
            {!canReindex ? <span className="muted">仅所有者与主笔可重建</span> : null}
          </div>

          <p className="muted">
            重建只重算检索投影，不会修改正典；旧版本片段保留在库中，但检索只读取当前正典版本。
            提交不会被索引阻塞。
          </p>
        </>
      ) : (
        <p className="muted">正典提交后，索引任务会经 outbox 异步排队。嵌入服务在服务商设置中按“嵌入”用途配置。</p>
      )}
    </section>
  );
}
