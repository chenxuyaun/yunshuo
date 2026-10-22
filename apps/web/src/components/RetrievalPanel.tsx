import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@yunshuo/contracts';
import { ApiError, searchCanon } from '../api.js';
import { LEDGER_KIND_LABELS, LEDGER_SCOPE_LABELS } from '../ledger.js';
import { Badge } from './Badge.js';

interface Props {
  workId: string;
  chapterId: string;
  onOpenChapter: (chapterId: string) => void;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

export function RetrievalPanel({ workId, chapterId, onOpenChapter }: Props) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  const searchQuery = useQuery<SearchResponse>({
    queryKey: ['canonSearch', workId, query],
    queryFn: () => searchCanon({ q: query, workId, limit: 8 }),
    enabled: query.length > 0,
    retry: false,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (next.length === 0) return;
    setQuery(next);
    if (next === query) void searchQuery.refetch();
  }

  const result = searchQuery.data;
  const coverage = result?.coverage;
  const ledgerCoverage = result?.ledgerCoverage;

  return (
    <section className="panel retrieval-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">跨章检索</p>
          <h2>正典与账本检索</h2>
        </div>
        {result ? (
          <Badge tone={result.mode === 'hybrid' ? 'green' : 'amber'}>
            {result.mode === 'hybrid' ? '混合检索' : '仅词法'}
          </Badge>
        ) : null}
      </header>

      <form className="retrieval-form" onSubmit={handleSubmit}>
        <input
          value={input}
          maxLength={200}
          placeholder="检索当前正典，例如：封印 追兵"
          aria-label="检索正典"
          onChange={(event) => setInput(event.target.value)}
        />
        <button
          type="submit"
          className="button button-primary button-small"
          disabled={input.trim().length === 0 || searchQuery.isFetching}
        >
          {searchQuery.isFetching ? '检索中…' : '检索'}
        </button>
      </form>

      {searchQuery.isError ? (
        <p className="index-error">检索失败：{formatError(searchQuery.error)}</p>
      ) : null}

      {result ? (
        <>
          {coverage ? (
            <div className="retrieval-coverage">
              <span>
                正典就绪 {coverage.ready}/{coverage.totalCanonChapters} 章
              </span>
              <span>可检索 {coverage.chunks} 块</span>
              <span>向量 {coverage.vectorModel ?? '未建立'}</span>
              {coverage.pending + coverage.indexing > 0 ? (
                <span>排队/进行中 {coverage.pending + coverage.indexing}</span>
              ) : null}
              {coverage.failed > 0 ? <span>失败 {coverage.failed}</span> : null}
              {coverage.notConfigured > 0 ? <span>未配置 {coverage.notConfigured}</span> : null}
              {coverage.stale > 0 ? <span>过期 {coverage.stale}</span> : null}
            </div>
          ) : null}

          {ledgerCoverage ? (
            <div className="retrieval-coverage retrieval-ledger-coverage">
              <span>
                账本可检索 {ledgerCoverage.indexedEntries}/{ledgerCoverage.activeEntries} 条
              </span>
              <span>可检索 {ledgerCoverage.chunks} 块</span>
              <span>向量 {ledgerCoverage.vectorModel ?? '未建立'}</span>
            </div>
          ) : null}

          {result.mode === 'lexical' && result.semanticReason ? (
            <p className="retrieval-reason">本次未使用语义通道：{result.semanticReason}</p>
          ) : null}

          {result.ledgerReason ? (
            <p className="retrieval-reason">账本检索：{result.ledgerReason}</p>
          ) : null}

          {result.results.length === 0 && result.ledgerResults.length === 0 ? (
            <p className="muted">
              {coverage && coverage.chunks === 0
                ? '当前没有可检索的正典片段。请先在服务商设置中配置“嵌入”用途的服务商，再重建索引。'
                : '没有命中的正典片段或账本条目。可以换一个关键词，或确认相关章节与账本已完成索引。'}
            </p>
          ) : (
            <>
              {result.results.length === 0 ? (
                <p className="muted">没有命中的正典片段。</p>
              ) : (
                <ul className="retrieval-results">
                  {result.results.map((item) => (
                    <li key={item.chunkId}>
                      <button
                        type="button"
                        className={`retrieval-item${item.chapterId === chapterId ? ' retrieval-item-current' : ''}`}
                        onClick={() => onOpenChapter(item.chapterId)}
                        title={
                          item.chapterId === chapterId
                            ? '当前章节'
                            : '切换到该章节（显示其当前正典）'
                        }
                      >
                        <span className="retrieval-item-head">
                          <strong>
                            第 {item.chapterNumber} 章 · {item.chapterTitle}
                          </strong>
                          <span className="retrieval-item-meta">
                            v{item.versionNo} · 第 {item.paragraphStart}-{item.paragraphEnd} 段
                          </span>
                        </span>
                        <span className="retrieval-excerpt">{item.excerpt}</span>
                        <span className="retrieval-channels">
                          {item.lexicalRank !== null ? (
                            <Badge tone="ink">词法 #{item.lexicalRank}</Badge>
                          ) : null}
                          {item.vectorRank !== null ? (
                            <Badge tone="green">向量 #{item.vectorRank}</Badge>
                          ) : null}
                          <span className="muted">RRF {item.rrfScore.toFixed(4)}</span>
                          {item.chapterId === chapterId ? (
                            <span className="muted">当前章</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {result.ledgerResults.length > 0 ? (
                <div className="retrieval-ledger-block">
                  <p className="eyebrow retrieval-ledger-title">设定、角色与伏笔</p>
                  <ul className="retrieval-results">
                    {result.ledgerResults.map((item) => (
                      <li key={item.chunkId}>
                        <div className="retrieval-item retrieval-ledger-item">
                          <span className="retrieval-item-head">
                            <strong>
                              {LEDGER_KIND_LABELS[item.kind]} · {item.name}
                            </strong>
                            <span className="retrieval-item-meta">
                              v{item.versionNo} · {LEDGER_SCOPE_LABELS[item.scope]}
                              {item.sourceChapterNumber !== null
                                ? ` · 源自第 ${item.sourceChapterNumber} 章`
                                : ''}
                            </span>
                          </span>
                          <span className="retrieval-excerpt">{item.excerpt}</span>
                          <span className="retrieval-channels">
                            {item.lexicalRank !== null ? (
                              <Badge tone="ink">词法 #{item.lexicalRank}</Badge>
                            ) : null}
                            {item.vectorRank !== null ? (
                              <Badge tone="green">向量 #{item.vectorRank}</Badge>
                            ) : null}
                            <span className="muted">RRF {item.rrfScore.toFixed(4)}</span>
                            {item.aliases.length > 0 ? (
                              <span className="muted">别名：{item.aliases.join('、')}</span>
                            ) : null}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className="muted">
          只检索当前正典版本，草稿与旧版本不会出现。配置嵌入服务后为混合检索；嵌入不可用或最高向量相似度低于阈值时自动降级为词法检索并说明原因。
        </p>
      )}

      <p className="retrieval-hint">
        查询文本会发送给启用的嵌入服务商以生成查询向量（不发送草稿）；未配置嵌入时只在本机做词法匹配。
      </p>
    </section>
  );
}
