import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  LedgerRetrievalCoverageView,
  RetrievalCoverageView,
  SearchLedgerResultView,
  SearchResponse,
  SearchResultView,
} from '@yunshuo/contracts';
import { ApiError } from '../api.js';
import { RetrievalPanel } from './RetrievalPanel.js';

const WORK_ID = 'work-1';
const CHAPTER_ID = 'chapter-5';

function coverage(overrides: Partial<RetrievalCoverageView> = {}): RetrievalCoverageView {
  return {
    totalCanonChapters: 10,
    ready: 3,
    indexing: 1,
    pending: 1,
    failed: 1,
    notConfigured: 2,
    stale: 1,
    chunks: 42,
    vectorChunks: 42,
    vectorModel: 'bge-m3',
    ...overrides,
  };
}

function ledgerCoverage(
  overrides: Partial<LedgerRetrievalCoverageView> = {},
): LedgerRetrievalCoverageView {
  return {
    activeEntries: 9,
    indexedEntries: 8,
    chunks: 12,
    vectorChunks: 12,
    vectorModel: 'bge-m3',
    ...overrides,
  };
}

function result(overrides: Partial<SearchResultView> = {}): SearchResultView {
  return {
    chunkId: 'chunk-1',
    chapterId: 'chapter-2',
    chapterNumber: 2,
    chapterTitle: '铜钉',
    versionId: 'version-1',
    versionNo: 3,
    paragraphStart: 4,
    paragraphEnd: 6,
    excerpt: '井底刻着铜钉。',
    lexicalRank: 1,
    vectorRank: 2,
    lexicalScore: 0.5,
    vectorScore: 0.6,
    rrfScore: 0.012345,
    ...overrides,
  };
}

function ledgerResult(overrides: Partial<SearchLedgerResultView> = {}): SearchLedgerResultView {
  return {
    chunkId: 'ledger-chunk-1',
    entryId: 'entry-1',
    kind: 'character',
    name: '林默',
    aliases: ['默哥', '林七'],
    scope: 'work',
    workId: WORK_ID,
    sourceChapterId: 'chapter-2',
    sourceChapterNumber: 2,
    sourceChapterTitle: '铜钉',
    versionId: 'ledger-version-1',
    versionNo: 4,
    excerpt: '林默在灯塔捡到徽章。',
    lexicalRank: 3,
    vectorRank: 5,
    lexicalScore: 0.4,
    vectorScore: 0.3,
    rrfScore: 0.0034,
    ...overrides,
  };
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: '封印',
    mode: 'hybrid',
    semanticReason: null,
    results: [result()],
    coverage: coverage(),
    ledgerResults: [ledgerResult()],
    ledgerCoverage: ledgerCoverage(),
    ledgerReason: null,
    ...overrides,
  };
}

function setQueryError(client: QueryClient, queryKey: string[], error: Error): void {
  const query = client.getQueryCache().build(client, { queryKey });
  query.setState({ status: 'error', error, fetchStatus: 'idle', errorUpdatedAt: Date.now() });
}

function render(options: { value?: SearchResponse; error?: Error } = {}): string {
  const client = new QueryClient({
    // SSR 没有已挂载的 observer；retryOnMount 默认 true 会把预置的错误态改回 pending。
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  if (options.value) {
    client.setQueryData(['canonSearch', WORK_ID, ''], options.value);
  }
  if (options.error) setQueryError(client, ['canonSearch', WORK_ID, ''], options.error);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RetrievalPanel workId={WORK_ID} chapterId={CHAPTER_ID} onOpenChapter={() => {}} />
    </QueryClientProvider>,
  );
}

describe('RetrievalPanel', () => {
  it('没有结果时只显示检索表单与两条边界说明', () => {
    const html = render();

    expect(html).toContain('<p class="eyebrow">跨章检索</p>');
    expect(html).toContain('<h2>正典与账本检索</h2>');
    expect(html).not.toContain('class="badge');
    expect(html).not.toContain('retrieval-coverage');
    expect(html).not.toContain('retrieval-results');
    expect(html).not.toContain('检索失败');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('placeholder="检索当前正典，例如：封印 追兵"');
    expect(html).toContain('aria-label="检索正典"');
    expect(html).toContain(
      '<button type="submit" class="button button-primary button-small" disabled="">检索</button>',
    );
    expect(html).toContain(
      '只检索当前正典版本，草稿与旧版本不会出现。配置嵌入服务后为混合检索；嵌入不可用或最高向量相似度低于阈值时自动降级为词法检索并说明原因。',
    );
    expect(html).toContain(
      '查询文本会发送给启用的嵌入服务商以生成查询向量（不发送草稿）；未配置嵌入时只在本机做词法匹配。',
    );
  });

  it('混合检索显示覆盖度、正典命中与账本命中', () => {
    const html = render({
      value: response({
        results: [
          result(),
          result({
            chunkId: 'chunk-2',
            chapterId: CHAPTER_ID,
            chapterNumber: 5,
            chapterTitle: '夜行',
            versionNo: 7,
            paragraphStart: 10,
            paragraphEnd: 10,
            excerpt: '封印在雨里松了。',
            lexicalRank: null,
            vectorRank: 4,
            rrfScore: 0.5,
          }),
        ],
      }),
    });

    expect(html).toContain('<span class="badge badge-green">混合检索</span>');
    expect(html).toContain('<span>正典就绪 3/10 章</span>');
    expect(html).toContain('<span>可检索 42 块</span>');
    expect(html).toContain('<span>向量 bge-m3</span>');
    expect(html).toContain('<span>排队/进行中 2</span>');
    expect(html).toContain('<span>失败 1</span>');
    expect(html).toContain('<span>未配置 2</span>');
    expect(html).toContain('<span>过期 1</span>');
    expect(html).toContain('<span>账本可检索 8/9 条</span>');
    expect(html).toContain('<span>可检索 12 块</span>');

    expect(html).toContain('<strong>第 2 章 · 铜钉</strong>');
    expect(html).toContain('<span class="retrieval-item-meta">v3 · 第 4-6 段</span>');
    expect(html).toContain('<span class="retrieval-excerpt">井底刻着铜钉。</span>');
    expect(html).toContain('<span class="badge badge-ink">词法 #1</span>');
    expect(html).toContain('<span class="badge badge-green">向量 #2</span>');
    expect(html).toContain('<span class="muted">RRF 0.0123</span>');
    expect(html).toContain('title="切换到该章节（显示其当前正典）"');
    expect(html).toContain('title="当前章节"');
    expect(html).toContain('retrieval-item retrieval-item-current');
    expect(html).toContain('<span class="muted">当前章</span>');
    expect(html).toContain('<strong>第 5 章 · 夜行</strong>');
    expect(html).toContain('<span class="retrieval-item-meta">v7 · 第 10-10 段</span>');
    expect(html).toContain('<span class="badge badge-green">向量 #4</span>');
    expect(html).toContain('<span class="muted">RRF 0.5000</span>');

    expect(html).toContain('<p class="eyebrow retrieval-ledger-title">设定、角色与伏笔</p>');
    expect(html).toContain('<strong>角色 · 林默</strong>');
    expect(html).toContain('<span class="retrieval-item-meta">v4 · 作品专属 · 源自第 2 章</span>');
    expect(html).toContain('<span class="retrieval-excerpt">林默在灯塔捡到徽章。</span>');
    expect(html).toContain('<span class="badge badge-ink">词法 #3</span>');
    expect(html).toContain('<span class="badge badge-green">向量 #5</span>');
    expect(html).toContain('<span class="muted">别名：默哥、林七</span>');
    expect(html).toContain('<span class="muted">RRF 0.0034</span>');
    expect(html).not.toContain('本次未使用语义通道');
    expect(html).not.toContain('账本检索：');
  });

  it('词法检索显示降级徽标与两条原因', () => {
    const html = render({
      value: response({
        mode: 'lexical',
        semanticReason: '嵌入服务未配置，已降级为词法检索。',
        ledgerReason: '账本索引尚未就绪。',
      }),
    });

    expect(html).toContain('<span class="badge badge-amber">仅词法</span>');
    expect(html).toContain(
      '<p class="retrieval-reason">本次未使用语义通道：嵌入服务未配置，已降级为词法检索。</p>',
    );
    expect(html).toContain('<p class="retrieval-reason">账本检索：账本索引尚未就绪。</p>');
  });

  it('两路都空且已有片段时提示换词或确认索引', () => {
    const html = render({
      value: response({ results: [], ledgerResults: [] }),
    });

    expect(html).toContain(
      '没有命中的正典片段或账本条目。可以换一个关键词，或确认相关章节与账本已完成索引。',
    );
    expect(html).not.toContain('当前没有可检索的正典片段');
    expect(html).not.toContain('retrieval-results');
    expect(html).not.toContain('没有命中的正典片段。</p>');
  });

  it('一个可检索片段都没有时指向嵌入服务商配置', () => {
    const html = render({
      value: response({
        results: [],
        ledgerResults: [],
        coverage: coverage({ chunks: 0 }),
      }),
    });

    expect(html).toContain(
      '当前没有可检索的正典片段。请先在服务商设置中配置“嵌入”用途的服务商，再重建索引。',
    );
    expect(html).not.toContain('可以换一个关键词');
  });

  it('只有账本命中时说明正典没有命中，同时列出账本块', () => {
    const html = render({
      value: response({ results: [] }),
    });

    expect(html).toContain('<p class="muted">没有命中的正典片段。</p>');
    expect(html).not.toContain('没有命中的正典片段或账本条目');
    expect(html).toContain('<strong>角色 · 林默</strong>');
  });

  it('缺少覆盖度时只渲染命中列表', () => {
    const html = render({
      value: {
        ...response({ results: [], ledgerResults: [] }),
        coverage: undefined as unknown as RetrievalCoverageView,
        ledgerCoverage: undefined as unknown as LedgerRetrievalCoverageView,
      },
    });

    expect(html).not.toContain('retrieval-coverage');
    expect(html).toContain(
      '没有命中的正典片段或账本条目。可以换一个关键词，或确认相关章节与账本已完成索引。',
    );
  });

  it('错误按 ApiError 归因码与普通错误原文展示', () => {
    const apiError = render({
      error: new ApiError(503, 'SEARCH_FAILED', '检索服务不可用'),
    });
    expect(apiError).toContain(
      '<p class="index-error">检索失败：检索服务不可用（SEARCH_FAILED）</p>',
    );
    expect(apiError).not.toContain('class="badge');
    expect(apiError).toContain('只检索当前正典版本');

    const plainError = render({ error: new Error('网络中断') });
    expect(plainError).toContain('<p class="index-error">检索失败：网络中断</p>');
    expect(plainError).not.toContain('SEARCH_FAILED');
  });

  it('覆盖度为零的分项与空通道按实际数据省略', () => {
    const html = render({
      value: response({
        results: [
          result({
            lexicalRank: null,
            vectorRank: null,
            rrfScore: 0,
          }),
        ],
        ledgerResults: [
          ledgerResult({
            aliases: [],
            sourceChapterNumber: null,
            sourceChapterId: null,
            sourceChapterTitle: null,
            lexicalRank: null,
            vectorRank: null,
          }),
        ],
        coverage: coverage({
          ready: 0,
          indexing: 0,
          pending: 0,
          failed: 0,
          notConfigured: 0,
          stale: 0,
          chunks: 1,
          vectorModel: null,
        }),
        ledgerCoverage: ledgerCoverage({ vectorModel: null }),
      }),
    });

    expect(html).toContain('<span>正典就绪 0/10 章</span>');
    expect(html.split('<span>向量 未建立</span>').length - 1).toBe(2);
    expect(html).not.toContain('排队/进行中');
    expect(html).not.toContain('失败 ');
    expect(html).not.toContain('未配置 ');
    expect(html).not.toContain('过期 ');
    expect(html).toContain('<span class="muted">RRF 0.0000</span>');
    expect(html).not.toContain('词法 #');
    expect(html).not.toContain('向量 #');
    expect(html).toContain('<span class="retrieval-item-meta">v4 · 作品专属</span>');
    expect(html).not.toContain('别名：');
    expect(html).not.toContain('源自第');
  });
});
