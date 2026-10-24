import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  ChapterListItem,
  LedgerEntryDetail,
  LedgerSuggestionListResponse,
  LedgerSuggestionProposal,
  LedgerSuggestionView,
} from '@yunshuo/contracts';
import { LedgerSuggestionCard } from './LedgerSuggestionCard.js';

const ENTRY_ID = 'entry-1';

function entry(overrides: Partial<LedgerEntryDetail> = {}): LedgerEntryDetail {
  return {
    id: ENTRY_ID,
    workId: 'work-1',
    kind: 'character',
    scope: 'work',
    name: '林默',
    aliases: [],
    summary: '',
    status: 'active',
    sourceChapterId: null,
    currentVersionNo: 2,
    draftVersionNo: null,
    foreshadowing: null,
    updatedAt: '2026-10-23T18:00:00.000Z',
    currentVersion: null,
    draftVersion: null,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    workTitle: '作品甲',
    number: 1,
    title: '起',
    status: 'canon',
    volumeTitle: '上卷',
    wordCount: 1200,
    currentVersionNo: 1,
    updatedAt: '2026-10-23T18:00:00.000Z',
    ...overrides,
  };
}

const CHAPTERS: ChapterListItem[] = [
  chapter({ id: 'chapter-1', number: 1, title: '起' }),
  chapter({ id: 'chapter-2', workId: 'work-2', workTitle: '作品乙', number: 2, title: '别作' }),
  chapter({ id: 'chapter-3', number: 3, title: '出发' }),
];

function proposal(overrides: Partial<LedgerSuggestionProposal> = {}): LedgerSuggestionProposal {
  return {
    kind: 'character_state',
    asOfChapterNumber: 3,
    life: 'alive',
    location: '',
    knowledge: '',
    possessions: '',
    relationshipChanges: '',
    ...overrides,
  } as LedgerSuggestionProposal;
}

function suggestion(overrides: Partial<LedgerSuggestionView> = {}): LedgerSuggestionView {
  return {
    id: 'suggestion-1',
    entryId: ENTRY_ID,
    entryName: '林默',
    entryKind: 'character',
    kind: 'character_state',
    status: 'ready',
    baseVersionNo: 2,
    basisChapter: { id: 'chapter-3', number: 3, title: '出发' },
    instruction: '',
    providerName: 'Atria',
    model: 'gpt-test',
    promptVersion: 'ledger-suggest-v1',
    proposal: proposal(),
    rationale: '',
    evidence: [],
    usage: { promptTokens: 120, completionTokens: 30 },
    cost: 0.1234,
    costCurrency: 'USD',
    latencyMs: 1500,
    attempts: 2,
    errorCode: null,
    errorMessage: null,
    createdByName: '林默',
    createdAt: '2026-10-23T18:07:00.000Z',
    completedAt: '2026-10-23T18:07:02.000Z',
    decidedByName: null,
    decidedAt: null,
    decisionNote: '',
    resultDraftVersionNo: null,
    ...overrides,
  };
}

function render(
  response: LedgerSuggestionListResponse | null,
  options: { canWrite?: boolean; entryValue?: LedgerEntryDetail } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (response) {
    client.setQueryData(['ledgerSuggestions', ENTRY_ID], response);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LedgerSuggestionCard
        entry={options.entryValue ?? entry()}
        chapters={CHAPTERS}
        canWrite={options.canWrite ?? true}
      />
    </QueryClientProvider>,
  );
}

function list(suggestions: LedgerSuggestionView[], note = ''): LedgerSuggestionListResponse {
  return { suggestions, note };
}

describe('LedgerSuggestionCard', () => {
  it('没有缓存数据时显示读取中，而不是空列表', () => {
    const html = render(null);
    expect(html).toContain('正在读取建议记录……');
    expect(html).not.toContain('还没有生成过建议');
  });

  it('只读角色看到说明与空态，没有生成表单', () => {
    const html = render(list([]), { canWrite: false });
    expect(html).toContain('当前角色只读：可以查看历史建议，但不能生成、采纳或拒绝。');
    expect(html).toContain('还没有建议记录。');
    expect(html).not.toContain('class="ledger-suggestion-create"');
    expect(html).not.toContain('生成建议');
  });

  it('可写角色只列本作品章节并按章号倒序，未选章节时生成按钮禁用', () => {
    const html = render(list([]));
    expect(html).toContain('还没有生成过建议。选择依据章节后点击“生成建议”。');
    const options = html.slice(html.indexOf('<select'), html.indexOf('</select>'));
    expect(options).toContain('第 3 章 · 出发');
    expect(options).toContain('第 1 章 · 起');
    expect(options).not.toContain('别作');
    expect(options.indexOf('出发')).toBeLessThan(options.indexOf('起'));
    const labelAt = html.indexOf('>生成建议<');
    const button = html.slice(html.lastIndexOf('<button', labelAt), labelAt);
    expect(button).toContain('disabled=""');
  });

  it('待确认建议显示状态、种类、依据与费用用量', () => {
    const html = render(list([suggestion({ instruction: '不要提前判定死亡' })]));
    expect(html).toContain('badge-ink">待人工确认');
    expect(html).toContain('角色状态变更');
    expect(html).toContain('Atria · gpt-test · 10/23 18:07');
    expect(html).toContain('依据：第 3 章 · 出发');
    expect(html).toContain('基准：生效 v2');
    expect(html).toContain('0.1234 USD');
    expect(html).toContain('用量 120 / 30 tokens');
    expect(html).toContain('尝试 2 次 · 耗时 1500 ms');
    expect(html).toContain('发起人：林默');
    expect(html).toContain('补充说明：不要提前判定死亡');
  });

  it('未计价区分为「缺价表」与「没上报用量」两种原因', () => {
    const html = render(
      list([
        suggestion({ id: 's-1', cost: null, costCurrency: null }),
        suggestion({
          id: 's-2',
          cost: null,
          costCurrency: null,
          usage: { promptTokens: null, completionTokens: null },
        }),
        suggestion({
          id: 's-3',
          cost: null,
          costCurrency: null,
          usage: { promptTokens: 50, completionTokens: null },
        }),
        suggestion({
          id: 's-4',
          cost: null,
          costCurrency: null,
          baseVersionNo: null,
          basisChapter: null,
          createdByName: null,
          latencyMs: null,
          providerName: '',
          model: '',
          attempts: 1,
        }),
      ]),
    );
    expect(html).toContain('未计价（该服务商没有价表条目，用量已上报）');
    expect(html).toContain('未计价（本次没有上报用量）');
    expect(html).toContain('用量未上报');
    expect(html).toContain('用量 50 / ? tokens');
    expect(html).toContain('未记录服务商 · 未记录模型');
    expect(html).toContain('依据：未记录');
    expect(html).toContain('基准：尚无生效版本');
    expect(html).toContain('尝试 1 次<');
    expect(html).toContain('发起人：未知');
  });

  it('角色提案逐项回退「未提及」，缺依据与引用时给回退文案', () => {
    const html = render(list([suggestion()]));
    expect(html).toContain('截至章节');
    expect(html).toContain('第 3 章');
    expect(html).toContain('存活');
    expect(html.split('未提及').length - 1).toBe(4);
    expect(html).toContain('模型未给出依据说明。');
    expect(html).toContain('模型未给出可核验的引用。');
  });

  it('伏笔提案显示回收状态、未指定章节与说明', () => {
    const html = render(
      list([
        suggestion({
          kind: 'foreshadowing_state',
          proposal: {
            kind: 'foreshadowing_state',
            state: 'reinforced',
            payoffChapterNumber: null,
            resolutionNote: '',
          },
          evidence: [
            { type: 'chapter', label: '第 3 章 出发', detail: '正文第 12 段', truncated: false },
            { type: 'ledger_version', label: '伏笔 v2', detail: null, truncated: true },
          ],
          rationale: '本章再次提到铜钉',
        }),
      ]),
    );
    expect(html).toContain('伏笔回收状态');
    expect(html).toContain('回收状态');
    expect(html).toContain('已强化');
    expect(html).toContain('回收章节');
    expect(html).toContain('未指定');
    expect(html).toContain('依据说明：本章再次提到铜钉');
    expect(html).toContain('正文：第 3 章 出发');
    expect(html).toContain('正文第 12 段');
    expect(html).toContain('账本版本：伏笔 v2');
    expect(html.split('已截断').length - 1).toBe(1);
  });

  it('失败、写入中、已采纳与已拒绝各自给出对应说明', () => {
    const html = render(
      list([
        suggestion({
          id: 's-failed',
          status: 'failed',
          proposal: null,
          errorCode: 'AI_TIMEOUT',
          errorMessage: '连接超时',
        }),
        suggestion({ id: 's-applying', status: 'applying' }),
        suggestion({
          id: 's-accepted',
          status: 'accepted',
          decidedByName: '李四',
          decidedAt: '2026-10-23T19:00:00.000Z',
          decisionNote: '与正文一致',
          resultDraftVersionNo: 4,
        }),
        suggestion({
          id: 's-rejected',
          status: 'rejected',
          decidedByName: '王五',
          decisionNote: '会提前剧透',
        }),
        suggestion({ id: 's-generating', status: 'generating', proposal: null }),
      ]),
    );
    expect(html).toContain('生成失败（AI_TIMEOUT）：连接超时');
    expect(html).toContain('该建议正在写入草稿');
    expect(html).toContain('已由 李四 于 10/23 19:00 采纳， 写入草稿 v4。');
    expect(html).toContain('确认说明：与正文一致');
    expect(html).toContain('已由 王五 拒绝：会提前剧透。');
    expect(html).toContain('仍在生成中');
    expect(html).toContain('生成中');
    expect(html).toContain('生成失败');
    expect(html).toContain('写入草稿中');
    expect(html).toContain('已采纳（仅草稿）');
    expect(html).toContain('已拒绝');
  });

  it('只有「可写 + 待确认」才给确认入口，只读时不给', () => {
    const ready = suggestion();
    const writable = render(list([ready]));
    expect(writable).toContain('>确认或拒绝<');
    const readOnly = render(list([ready]), { canWrite: false });
    expect(readOnly).not.toContain('>确认或拒绝<');

    const generating = render(list([suggestion({ status: 'generating' })]));
    expect(generating).not.toContain('>确认或拒绝<');
  });

  it('接口附带的说明追加在列表之后', () => {
    const html = render(list([], '建议只写草稿，不影响生效版本。'));
    expect(html).toContain('建议只写草稿，不影响生效版本。');
  });

  it('条目所属作品缺失时不按作品过滤章节', () => {
    const html = render(list([]), { entryValue: entry({ workId: null }) });
    const options = html.slice(html.indexOf('<select'), html.indexOf('</select>'));
    expect(options).toContain('第 3 章 · 出发');
    expect(options).toContain('第 2 章 · 别作');
    expect(options).toContain('第 1 章 · 起');
  });
});
