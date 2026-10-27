import type {
  LedgerEntryKind,
  LedgerEntryScope,
  LedgerRetrievalCoverageView,
  RetrievalCoverageView,
  SearchLedgerResultView,
  SearchResponse,
  SearchResultView,
} from '@yunshuo/contracts';
import {
  RETRIEVAL_CHUNK_CHARS,
  RETRIEVAL_PER_CHAPTER,
  RETRIEVAL_RESULT_LIMIT,
  RETRIEVAL_TOTAL_CHARS,
} from '../services/retrieval-budget.js';

/**
 * search 工具的返回投影。
 *
 * 为什么不能直接回 SearchResponse：它只带 excerpt（约 160 字的摘要），完整切块正文在
 * CanonSearchOutcome.contents / ledgerContents 里（search-service.ts 的 searchCanon 用两半的词法/向量
 * 行分别填充这两个 Map），不过 HTTP。
 * 工具调用要的是"展开后的正文 + 这一步花了多少预算"，所以这里做投影而不是透传。
 */

export interface ToolCanonHit {
  chunkId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  versionId: string;
  versionNo: number;
  paragraphStart: number;
  paragraphEnd: number;
  excerpt: string;
  /** 展开后的切块正文，最多 RETRIEVAL_CHUNK_CHARS 字。 */
  text: string;
  textStatus: 'expanded' | 'unavailable';
  /** text 的实际长度（预算按它累加）。 */
  textChars: number;
  /** 切块原文长度（未截断前的长度）。 */
  chunkChars: number;
  textTruncated: boolean;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

export interface ToolLedgerHit {
  chunkId: string;
  entryId: string;
  kind: LedgerEntryKind;
  name: string;
  aliases: string[];
  scope: LedgerEntryScope;
  workId: string | null;
  sourceChapterId: string | null;
  /** 条目的**来源章**（它从哪一章提炼出来），不是状态时点。 */
  sourceChapterNumber: number | null;
  sourceChapterTitle: string | null;
  /** 机器可读的同一句话，避免调用方把来源章误当时点。 */
  sourceChapterMeaning: 'entry-source-not-state-time';
  versionId: string;
  versionNo: number;
  excerpt: string;
  text: string;
  textStatus: 'expanded' | 'unavailable';
  textChars: number;
  chunkChars: number;
  textTruncated: boolean;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

export interface ToolSearchHalfBudget {
  resultLimit: number;
  chunkChars: number;
  totalChars: number;
  /** 每章最多几条；账本半没有章节概念，为 null。 */
  perChapter: number | null;
  /** 实际返回的命中数（含正文不可用的）。 */
  hits: number;
  /** 其中成功展开正文的条数。 */
  expanded: number;
  usedChars: number;
  /** 因条数/每章/总字数上限被丢弃的命中数。 */
  dropped: number;
  truncated: boolean;
}

export interface ToolSearchBudgetReport {
  /** 这组预算是从整章装配（loadProposalRetrieval）借来的，不是为单次工具调用标定的。 */
  borrowedFrom: 'chapter-assembly';
  note: string;
  canon: ToolSearchHalfBudget;
  ledger: ToolSearchHalfBudget;
  totalUsedChars: number;
}

export interface ToolSearchResult {
  query: string;
  mode: SearchResponse['mode'];
  semanticReason: string | null;
  scope: {
    workId: string | null;
    excludeChapterId: string | null;
    /** excludeChapterId 的作用域：只从正典半排除该章，账本半不受它影响。 */
    excludeChapterScope: 'canon-only';
    /** 正典半的写作位上界；null 表示未传、行为与原来一致。 */
    asOfChapterNumber: number | null;
    /** L1a 的账本半不提供 as-of。 */
    ledgerAsOf: 'not-supported';
  };
  results: ToolCanonHit[];
  ledgerResults: ToolLedgerHit[];
  coverage: RetrievalCoverageView;
  ledgerCoverage: LedgerRetrievalCoverageView;
  ledgerReason: string | null;
  budget: ToolSearchBudgetReport;
  notes: string[];
}

export interface ToolSearchScope {
  workId: string | null;
  excludeChapterId: string | null;
  asOfChapterNumber: number | null;
}

const BUDGET_NOTE =
  `预算借自整章装配（${RETRIEVAL_RESULT_LIMIT} 条 / ${RETRIEVAL_TOTAL_CHARS} 字 / 单块 ${RETRIEVAL_CHUNK_CHARS} 字 / 每章 ${RETRIEVAL_PER_CHAPTER} 条），` +
  '不是为单次工具调用标定的；正典与账本两个半区各套一次，所以一次调用的合计上限是两倍。';

function halfBudget(params: {
  perChapter: number | null;
  hits: number;
  expanded: number;
  usedChars: number;
  dropped: number;
  truncated: boolean;
}): ToolSearchHalfBudget {
  return {
    resultLimit: RETRIEVAL_RESULT_LIMIT,
    chunkChars: RETRIEVAL_CHUNK_CHARS,
    totalChars: RETRIEVAL_TOTAL_CHARS,
    perChapter: params.perChapter,
    hits: params.hits,
    expanded: params.expanded,
    usedChars: params.usedChars,
    dropped: params.dropped,
    truncated: params.truncated,
  };
}

function projectCanonHits(
  results: SearchResultView[],
  contents: Map<string, string>,
): { hits: ToolCanonHit[]; budget: ToolSearchHalfBudget } {
  const perChapter = new Map<string, number>();
  const hits: ToolCanonHit[] = [];
  let usedChars = 0;
  let expanded = 0;
  let dropped = 0;
  let truncated = false;

  for (const [index, result] of results.entries()) {
    if (hits.length >= RETRIEVAL_RESULT_LIMIT) {
      dropped += results.length - index;
      truncated = true;
      break;
    }
    const chapterCount = perChapter.get(result.chapterId) ?? 0;
    if (chapterCount >= RETRIEVAL_PER_CHAPTER) {
      dropped += 1;
      truncated = true;
      continue;
    }
    const full = contents.get(result.chunkId) ?? '';
    const text = full.slice(0, RETRIEVAL_CHUNK_CHARS);
    if (text.length > 0 && usedChars + text.length > RETRIEVAL_TOTAL_CHARS) {
      dropped += 1;
      truncated = true;
      continue;
    }
    const textTruncated = text.length < full.length;
    if (textTruncated) truncated = true;
    // 正文取不到的命中仍然返回（它还有 excerpt），不占每章名额、不计入字数预算；
    // 但它占一个条数名额：上面的条数上限数的是 hits.length，而空正文命中同样会被 push 进来。
    // （整章装配 ai-service 的 loadProposalRetrieval 对空正文是直接 continue，连条数名额也不占。）
    if (text.length > 0) {
      expanded += 1;
      usedChars += text.length;
      perChapter.set(result.chapterId, chapterCount + 1);
    }
    hits.push({
      chunkId: result.chunkId,
      chapterId: result.chapterId,
      chapterNumber: result.chapterNumber,
      chapterTitle: result.chapterTitle,
      versionId: result.versionId,
      versionNo: result.versionNo,
      paragraphStart: result.paragraphStart,
      paragraphEnd: result.paragraphEnd,
      excerpt: result.excerpt,
      text,
      textStatus: text.length > 0 ? 'expanded' : 'unavailable',
      textChars: text.length,
      chunkChars: full.length,
      textTruncated,
      lexicalRank: result.lexicalRank,
      vectorRank: result.vectorRank,
      lexicalScore: result.lexicalScore,
      vectorScore: result.vectorScore,
      rrfScore: result.rrfScore,
    });
  }

  return {
    hits,
    budget: halfBudget({
      perChapter: RETRIEVAL_PER_CHAPTER,
      hits: hits.length,
      expanded,
      usedChars,
      dropped,
      truncated,
    }),
  };
}

function projectLedgerHits(
  results: SearchLedgerResultView[],
  ledgerContents: Map<string, string>,
): { hits: ToolLedgerHit[]; budget: ToolSearchHalfBudget } {
  const hits: ToolLedgerHit[] = [];
  let usedChars = 0;
  let expanded = 0;
  let dropped = 0;
  let truncated = false;

  for (const [index, result] of results.entries()) {
    if (hits.length >= RETRIEVAL_RESULT_LIMIT) {
      dropped += results.length - index;
      truncated = true;
      break;
    }
    const full = ledgerContents.get(result.chunkId) ?? '';
    const text = full.slice(0, RETRIEVAL_CHUNK_CHARS);
    if (text.length > 0 && usedChars + text.length > RETRIEVAL_TOTAL_CHARS) {
      dropped += 1;
      truncated = true;
      continue;
    }
    const textTruncated = text.length < full.length;
    if (textTruncated) truncated = true;
    if (text.length > 0) expanded += 1;
    usedChars += text.length;
    hits.push({
      chunkId: result.chunkId,
      entryId: result.entryId,
      kind: result.kind,
      name: result.name,
      aliases: result.aliases,
      scope: result.scope,
      workId: result.workId,
      sourceChapterId: result.sourceChapterId,
      sourceChapterNumber: result.sourceChapterNumber,
      sourceChapterTitle: result.sourceChapterTitle,
      sourceChapterMeaning: 'entry-source-not-state-time',
      versionId: result.versionId,
      versionNo: result.versionNo,
      excerpt: result.excerpt,
      text,
      textStatus: text.length > 0 ? 'expanded' : 'unavailable',
      textChars: text.length,
      chunkChars: full.length,
      textTruncated,
      lexicalRank: result.lexicalRank,
      vectorRank: result.vectorRank,
      lexicalScore: result.lexicalScore,
      vectorScore: result.vectorScore,
      rrfScore: result.rrfScore,
    });
  }

  return {
    hits,
    budget: halfBudget({
      perChapter: null,
      hits: hits.length,
      expanded,
      usedChars,
      dropped,
      truncated,
    }),
  };
}

export function projectSearchOutcome(params: {
  response: SearchResponse;
  contents: Map<string, string>;
  ledgerContents: Map<string, string>;
  scope: ToolSearchScope;
}): ToolSearchResult {
  const canon = projectCanonHits(params.response.results, params.contents);
  const ledger = projectLedgerHits(params.response.ledgerResults, params.ledgerContents);

  const notes = [
    BUDGET_NOTE,
    '账本命中的 sourceChapterNumber 是条目来源章（它从哪一章提炼出来），不是状态时点；L1a 的账本半不提供 as-of。',
  ];
  if (params.scope.asOfChapterNumber !== null) {
    notes.push(
      `正典半只返回章号 <= ${params.scope.asOfChapterNumber} 的片段；账本半不受这个上界限制。`,
    );
  }

  return {
    query: params.response.query,
    mode: params.response.mode,
    semanticReason: params.response.semanticReason,
    scope: { ...params.scope, excludeChapterScope: 'canon-only', ledgerAsOf: 'not-supported' },
    results: canon.hits,
    ledgerResults: ledger.hits,
    coverage: params.response.coverage,
    ledgerCoverage: params.response.ledgerCoverage,
    ledgerReason: params.response.ledgerReason,
    budget: {
      borrowedFrom: 'chapter-assembly',
      note: BUDGET_NOTE,
      canon: canon.budget,
      ledger: ledger.budget,
      totalUsedChars: canon.budget.usedChars + ledger.budget.usedChars,
    },
    notes,
  };
}
