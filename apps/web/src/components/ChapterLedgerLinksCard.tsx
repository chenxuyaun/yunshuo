import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createChapterLedgerLink,
  deleteChapterLedgerLink,
  listChapterLedgerLinks,
  listLedgerEntries,
} from '../api.js';
import { LEDGER_KIND_LABELS, LEDGER_SCOPE_LABELS } from '../ledger.js';
import { Badge } from './Badge.js';

interface Props {
  chapterId: string;
  workId: string;
  canEdit: boolean;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

export function ChapterLedgerLinksCard({ chapterId, workId, canEdit }: Props) {
  const queryClient = useQueryClient();
  const [entryId, setEntryId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const linksQuery = useQuery({
    queryKey: ['chapterLedgerLinks', chapterId],
    queryFn: () => listChapterLedgerLinks(chapterId),
    retry: false,
  });

  const optionsQuery = useQuery({
    queryKey: ['chapterLedgerLinkOptions', workId],
    queryFn: () => listLedgerEntries({ status: 'active', workId, limit: 200 }),
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['chapterLedgerLinks', chapterId] });

  const addMutation = useMutation({
    mutationFn: () => createChapterLedgerLink(chapterId, entryId, note.trim()),
    onSuccess: () => {
      setEntryId('');
      setNote('');
      setError(null);
      void invalidate();
    },
    onError: (mutationError) => setError(formatError(mutationError)),
  });

  const removeMutation = useMutation({
    mutationFn: (linkId: string) => deleteChapterLedgerLink(chapterId, linkId),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (mutationError) => setError(formatError(mutationError)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entryId || addMutation.isPending) return;
    addMutation.mutate();
  }

  const data = linksQuery.data;
  const options = optionsQuery.data?.entries ?? [];
  const linkedIds = new Set((data?.links ?? []).map((link) => link.entryId));
  const available = options.filter((entry) => !linkedIds.has(entry.id));

  return (
    <section className="panel chapter-ledger-links-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">人工标注</p>
          <h2>关联账本</h2>
        </div>
        {data ? <Badge tone={data.links.length > 0 ? 'green' : 'muted'}>{data.links.length} 条</Badge> : null}
      </header>

      {linksQuery.isLoading ? (
        <p className="muted">正在读取本章关联……</p>
      ) : linksQuery.isError ? (
        <p className="index-error">读取失败：{formatError(linksQuery.error)}</p>
      ) : data ? (
        <>
          {data.links.length === 0 ? (
            <p className="muted">本章还没有关联设定、角色或伏笔。</p>
          ) : (
            <ul className="chapter-ledger-link-list">
              {data.links.map((link) => (
                <li key={link.id} className="chapter-ledger-link-item">
                  <div className="chapter-ledger-link-head">
                    <Badge tone="ink">{LEDGER_KIND_LABELS[link.kind]}</Badge>
                    <strong>{link.name}</strong>
                    <span className="muted">
                      {link.versionNo !== null ? `v${link.versionNo}` : '无生效版本'} ·{' '}
                      {LEDGER_SCOPE_LABELS[link.scope]}
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        disabled={removeMutation.isPending}
                        onClick={() => removeMutation.mutate(link.id)}
                      >
                        移除
                      </button>
                    ) : null}
                  </div>
                  {link.note ? <p className="chapter-ledger-link-note">{link.note}</p> : null}
                  <p className="chapter-ledger-link-meta">
                    {link.createdByName ?? '未知成员'} ·{' '}
                    {new Date(link.createdAt).toLocaleString('zh-CN')}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {canEdit ? (
            <form className="chapter-ledger-link-form" onSubmit={handleSubmit}>
              <select
                value={entryId}
                onChange={(event) => setEntryId(event.target.value)}
                aria-label="选择要关联的账本条目"
                disabled={optionsQuery.isLoading || addMutation.isPending}
              >
                <option value="">
                  {optionsQuery.isLoading ? '读取账本条目…' : '选择已发布的账本条目'}
                </option>
                {available.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {LEDGER_KIND_LABELS[entry.kind]} · {entry.name}
                  </option>
                ))}
              </select>
              <input
                value={note}
                maxLength={500}
                placeholder="关联备注（可选，最多 500 字）"
                aria-label="关联备注"
                onChange={(event) => setNote(event.target.value)}
                disabled={addMutation.isPending}
              />
              <button
                type="submit"
                className="button button-primary button-small"
                disabled={!entryId || addMutation.isPending}
              >
                {addMutation.isPending ? '关联中…' : '关联'}
              </button>
            </form>
          ) : null}

          {error ? <p className="index-error">{error}</p> : null}
          <p className="muted chapter-ledger-link-foot">{data.note}</p>
        </>
      ) : null}
    </section>
  );
}
