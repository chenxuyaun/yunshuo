import { describe, expect, it } from 'vitest';
import type {
  LedgerRetrievalCoverageView,
  RetrievalCoverageView,
  SearchLedgerResultView,
  SearchResponse,
  SearchResultView,
} from '@yunshuo/contracts';
import { projectSearchOutcome } from './search-projection.js';

const EMPTY_CANON_COVERAGE: RetrievalCoverageView = {
  totalCanonChapters: 0,
  ready: 0,
  indexing: 0,
  pending: 0,
  failed: 0,
  notConfigured: 0,
  stale: 0,
  chunks: 0,
  vectorChunks: 0,
  vectorModel: null,
};

const EMPTY_LEDGER_COVERAGE: LedgerRetrievalCoverageView = {
  activeEntries: 0,
  indexedEntries: 0,
  chunks: 0,
  vectorChunks: 0,
  vectorModel: null,
};

function canonHit(overrides: {
  chunkId: string;
  chapterId: string;
  chapterNumber?: number;
}): SearchResultView {
  return {
    chunkId: overrides.chunkId,
    chapterId: overrides.chapterId,
    chapterNumber: overrides.chapterNumber ?? 1,
    chapterTitle: `第${overrides.chapterNumber ?? 1}章`,
    versionId: 'version-1',
    versionNo: 1,
    paragraphStart: 0,
    paragraphEnd: 1,
    excerpt: '摘要',
    lexicalRank: 1,
    vectorRank: null,
    lexicalScore: 0.5,
    vectorScore: null,
    rrfScore: 0.032,
  };
}

function ledgerHit(overrides: { chunkId: string; entryId: string }): SearchLedgerResultView {
  return {
    chunkId: overrides.chunkId,
    entryId: overrides.entryId,
    kind: 'setting',
    name: '封印',
    aliases: [],
    scope: 'work',
    workId: 'work-1',
    sourceChapterId: 'chapter-1',
    sourceChapterNumber: 1,
    sourceChapterTitle: '第一章',
    versionId: 'ledger-version-1',
    versionNo: 1,
    excerpt: '账本摘要',
    lexicalRank: 1,
    vectorRank: null,
    lexicalScore: 0.4,
    vectorScore: null,
    rrfScore: 0.03,
  };
}

function response(
  results: SearchResultView[],
  ledgerResults: SearchLedgerResultView[] = [],
): SearchResponse {
  return {
    query: '雨',
    mode: 'lexical',
    semanticReason: '本次仅用词法检索',
    results,
    coverage: { ...EMPTY_CANON_COVERAGE, chunks: results.length },
    ledgerResults,
    ledgerCoverage: { ...EMPTY_LEDGER_COVERAGE, chunks: ledgerResults.length },
    ledgerReason: null,
  };
}

const NO_SCOPE = { workId: null, excludeChapterId: null, asOfChapterNumber: null };

describe('search 投影：元数据 + 展开正文 + 步级预算', () => {
  it('正典命中从 contents 展开正文，预算按实际字数记账', () => {
    const hit = canonHit({ chunkId: 'chunk-1', chapterId: 'chapter-1' });
    const result = projectSearchOutcome({
      response: response([hit]),
      contents: new Map([['chunk-1', '雨夜封印之门，林默按住门框。']]),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });

    expect(result.results).toHaveLength(1);
    const first = result.results[0];
    expect(first?.text).toBe('雨夜封印之门，林默按住门框。');
    expect(first?.textStatus).toBe('expanded');
    expect(first?.textChars).toBe(14);
    expect(first?.chunkChars).toBe(14);
    expect(first?.textTruncated).toBe(false);
    // 元数据原样保留（版本身份 + 名次分数）
    expect(first?.versionId).toBe('version-1');
    expect(first?.versionNo).toBe(1);
    expect(first?.rrfScore).toBe(0.032);
    expect(result.budget.canon.usedChars).toBe(14);
    expect(result.budget.totalUsedChars).toBe(14);
  });

  it('单块超过 500 字被截断并标记，chunkChars 保留原文长度', () => {
    const content = '雨'.repeat(800);
    const result = projectSearchOutcome({
      response: response([canonHit({ chunkId: 'chunk-1', chapterId: 'chapter-1' })]),
      contents: new Map([['chunk-1', content]]),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });
    expect(result.results[0]?.text).toHaveLength(500);
    expect(result.results[0]?.textChars).toBe(500);
    expect(result.results[0]?.chunkChars).toBe(800);
    expect(result.results[0]?.textTruncated).toBe(true);
    expect(result.budget.canon.truncated).toBe(true);
    expect(result.budget.canon.usedChars).toBe(500);
  });

  it('正文缺失时命中仍返回，但标 unavailable、不记预算', () => {
    const result = projectSearchOutcome({
      response: response([canonHit({ chunkId: 'chunk-1', chapterId: 'chapter-1' })]),
      contents: new Map(),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });
    expect(result.results[0]?.textStatus).toBe('unavailable');
    expect(result.results[0]?.text).toBe('');
    expect(result.budget.canon.hits).toBe(1);
    expect(result.budget.canon.expanded).toBe(0);
    expect(result.budget.canon.usedChars).toBe(0);
  });

  it('每章最多 2 条：同章第 3 条被丢弃并计 dropped', () => {
    const hits = [
      canonHit({ chunkId: 'c1', chapterId: 'chapter-1' }),
      canonHit({ chunkId: 'c2', chapterId: 'chapter-1' }),
      canonHit({ chunkId: 'c3', chapterId: 'chapter-1' }),
    ];
    const result = projectSearchOutcome({
      response: response(hits),
      contents: new Map([
        ['c1', '雨一'],
        ['c2', '雨二'],
        ['c3', '雨三'],
      ]),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });
    expect(result.results.map((hit) => hit.chunkId)).toEqual(['c1', 'c2']);
    expect(result.budget.canon.dropped).toBe(1);
    expect(result.budget.canon.perChapter).toBe(2);
  });

  it('条数上限 6：第 7 条起被丢弃', () => {
    const hits = Array.from({ length: 8 }, (_, index) =>
      canonHit({ chunkId: `c${index}`, chapterId: `chapter-${index}` }),
    );
    const result = projectSearchOutcome({
      response: response(hits),
      contents: new Map(hits.map((hit) => [hit.chunkId, '雨'])),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });
    expect(result.results).toHaveLength(6);
    expect(result.budget.canon.resultLimit).toBe(6);
    expect(result.budget.canon.dropped).toBe(2);
  });

  it('总字数上限 2400：装不下的命中整条丢弃（与整章装配同口径，不切半截）', () => {
    const hits = Array.from({ length: 5 }, (_, index) =>
      canonHit({ chunkId: `c${index}`, chapterId: `chapter-${index}` }),
    );
    const long = '雨'.repeat(500);
    const result = projectSearchOutcome({
      response: response(hits),
      contents: new Map(hits.map((hit) => [hit.chunkId, long])),
      ledgerContents: new Map(),
      scope: NO_SCOPE,
    });
    // 4 × 500 = 2000，第 5 条会到 2500 > 2400
    expect(result.results).toHaveLength(4);
    expect(result.budget.canon.usedChars).toBe(2000);
    expect(result.budget.canon.totalChars).toBe(2400);
    expect(result.budget.canon.dropped).toBe(1);
  });

  it('账本半单独记预算，正文来自 ledgerContents，来源章标注不是状态时点', () => {
    const ledger = ledgerHit({ chunkId: 'lchunk-1', entryId: 'entry-1' });
    const result = projectSearchOutcome({
      response: response([], [ledger]),
      contents: new Map(),
      ledgerContents: new Map([['lchunk-1', '封印：历代掌门以血封门。']]),
      scope: NO_SCOPE,
    });
    const hit = result.ledgerResults[0];
    expect(hit?.text).toBe('封印：历代掌门以血封门。');
    expect(hit?.textStatus).toBe('expanded');
    expect(hit?.sourceChapterNumber).toBe(1);
    expect(hit?.sourceChapterMeaning).toBe('entry-source-not-state-time');
    expect(result.budget.ledger.perChapter).toBeNull();
    expect(result.budget.ledger.usedChars).toBe(12);
    expect(result.budget.canon.usedChars).toBe(0);
    expect(result.budget.totalUsedChars).toBe(12);
  });

  it('scope 如实回显：asOfChapterNumber 与账本不提供 as-of 都写进返回', () => {
    const result = projectSearchOutcome({
      response: response([canonHit({ chunkId: 'c1', chapterId: 'chapter-1' })]),
      contents: new Map([['c1', '雨']]),
      ledgerContents: new Map(),
      scope: { workId: 'work-1', excludeChapterId: 'chapter-9', asOfChapterNumber: 12 },
    });
    expect(result.scope).toEqual({
      workId: 'work-1',
      excludeChapterId: 'chapter-9',
      excludeChapterScope: 'canon-only',
      asOfChapterNumber: 12,
      ledgerAsOf: 'not-supported',
    });
    expect(result.notes.join('')).toContain('章号 <= 12');
    expect(result.notes.join('')).toContain('不是状态时点');
    expect(result.budget.borrowedFrom).toBe('chapter-assembly');
    expect(result.budget.note).toContain('不是为单次工具调用标定的');
  });

  it('excludeChapterId 的作用域写进 scope：只排除正典半', () => {
    const result = projectSearchOutcome({
      response: response([], [ledgerHit({ chunkId: 'lchunk-1', entryId: 'entry-1' })]),
      contents: new Map(),
      ledgerContents: new Map([['lchunk-1', '封印：历代掌门以血封门。']]),
      scope: { workId: 'work-1', excludeChapterId: 'chapter-9', asOfChapterNumber: null },
    });
    // 传了 excludeChapterId 时账本半仍照常返回，scope 里如实标注它只管正典半
    expect(result.ledgerResults).toHaveLength(1);
    expect(result.scope.excludeChapterId).toBe('chapter-9');
    expect(result.scope.excludeChapterScope).toBe('canon-only');
  });
});
