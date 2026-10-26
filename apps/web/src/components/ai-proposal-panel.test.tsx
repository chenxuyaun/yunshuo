import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AiProposalView, ChapterDetail, DraftView } from '@yunshuo/contracts';
import { AiProposalPanel } from './AiProposalPanel.js';

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: 'draft-1',
    branchId: 'branch-1',
    content: '已保存的正文',
    contentHash: 'hash-current',
    wordCount: 6,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 1,
    title: '第一章',
    status: 'writing',
    plan: {},
    wordCount: 6,
    currentVersion: null,
    draft: draft(),
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions: [],
    waivers: [],
    indexStatus: null,
    ruleset: null,
    canEdit: true,
    ...overrides,
  };
}

function proposal(overrides: Partial<AiProposalView> = {}): AiProposalView {
  return {
    id: 'proposal-1',
    chapterId: 'chapter-1',
    mode: 'continue',
    providerName: 'Atria',
    model: 'atria-chat-1',
    status: 'ready',
    content: '提案正文',
    contentHash: 'proposal-hash',
    wordCount: 480,
    instruction: '',
    targetWords: 1200,
    context: { promptVersion: 'prompt-v3', sections: [], unavailable: [] },
    usage: { promptTokens: 100, completionTokens: 200 },
    attempts: 1,
    cost: 1.2345,
    costCurrency: 'CNY',
    latencyMs: 3200,
    errorCode: null,
    errorMessage: null,
    baseDraftHash: 'hash-current',
    createdByName: '林默',
    createdAt: '2026-10-23T18:07:00.000Z',
    completedAt: '2026-10-23T18:07:05.000Z',
    ...overrides,
  };
}

function render(options: {
  chapterValue?: ChapterDetail;
  content?: string;
  dirty?: boolean;
  canEditNow?: boolean;
  proposals?: AiProposalView[];
  loaded?: boolean;
} = {}): string {
  const {
    chapterValue = chapter(),
    content = '第一段  \n第二段',
    dirty = false,
    canEditNow = true,
    proposals = [],
    loaded = false,
  } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) client.setQueryData(['aiProposals', chapterValue.id], proposals);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AiProposalPanel
        chapter={chapterValue}
        content={content}
        dirty={dirty}
        canEditNow={canEditNow}
        onAdopt={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('AiProposalPanel', () => {
  it('初始形态：默认续写、1200 字、不落盘提示与编辑器字数', () => {
    const html = render();

    expect(html).toContain('AI 提案 · 不自动落盘');
    expect(html).toContain('<h3>续写与加厚</h3>');
    expect(html).toContain('按优先级选择已启用的服务商');
    expect(html).toContain(
      '<button type="button" class="ai-mode-button ai-mode-active">续写</button>',
    );
    expect(html).toContain('<button type="button" class="ai-mode-button">加厚</button>');
    expect(html).toContain('type="number" min="300" max="4000" step="100" value="1200"');
    expect(html).toContain(
      'class="button button-primary button-small" title="调用已启用服务商生成提案">生成 AI 提案</button>',
    );
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('补充要求（可选）：例如加强雨夜压迫感、让林默更被动、结尾停在追兵破门前。');
    expect(html).toContain('编辑器现有 6 字；生成只读取已保存草稿。');
    expect(html).toContain('采用后仍走：保存草稿 → 五门禁 → 暂存 → 正典。');
    expect(html).toContain('未输出正文前的失败会自动重试或切换服务商；已输出后不再重试。');
    expect(html).not.toContain('class="ai-preview"');
    expect(html).not.toContain('class="ai-context"');
    expect(html).not.toContain('class="ai-blocker"');
    expect(html).toContain('历史提案');
    expect(html).toContain('· 读取中…');
    expect(html).not.toContain('历史提案 (0)');
    expect(html).toContain('还没有提案。生成成功后，提案会留在这里供重新载入。');
  });

  it('没有编辑租约时只报租约阻断，生成按钮禁用', () => {
    const html = render({ canEditNow: false });

    expect(html).toContain('<p class="ai-blocker">需要先取得编辑租约</p>');
    expect(html).not.toContain('请先保存草稿');
    expect(html).toContain('disabled="" title="需要先取得编辑租约">生成 AI 提案</button>');
  });

  it('编辑区脏时要求先保存，阻断文案与标题一致', () => {
    const html = render({ dirty: true });

    expect(html).toContain('<p class="ai-blocker">请先保存草稿；AI 只读取已落盘正文</p>');
    expect(html).toContain('disabled="" title="请先保存草稿；AI 只读取已落盘正文">生成 AI 提案</button>');
    expect(html).not.toContain('需要先取得编辑租约');
  });

  it('历史提案逐条给出模式、状态、服务商、尝试次数与成本，只有就绪项能载入', () => {
    const html = render({
      loaded: true,
      proposals: [
        proposal(),
        proposal({
          id: 'proposal-failed',
          mode: 'expand',
          status: 'failed',
          wordCount: 0,
          attempts: 3,
          cost: null,
          errorCode: 'AI_UPSTREAM_ERROR',
          errorMessage: '上游返回 502',
        }),
        proposal({ id: 'proposal-generating', status: 'generating', attempts: 0, latencyMs: null }),
      ],
    });

    expect(html).toContain('历史提案 (3)');
    expect(html).not.toContain('读取中…');
    expect(html).toContain('续写 · 480 字 · 已生成');
    expect(html).toContain('加厚 · 0 字 · 失败');
    expect(html).toContain('续写 · 480 字 · 生成中');
    expect(html.match(/Atria · atria-chat-1 · 10\/23 18:07 · 林默/g)?.length).toBe(3);
    expect(html).toContain('尝试 1 次 · 成本 ¥1.2345');
    expect(html).toContain('尝试 3 次');
    expect(html).toContain('尝试次数未知');
    expect(html).toContain('上游返回 502');
    expect(html.match(/>载入预览<\/button>/g)?.length).toBe(1);
    expect(html).not.toContain('还没有提案。');
  });

  it('成本按币种三态显示：未知、外币带代码、缺币种只给金额', () => {
    const html = render({
      loaded: true,
      proposals: [
        proposal({ id: 'p-null', cost: null }),
        proposal({ id: 'p-eur', cost: 2.5, costCurrency: 'EUR' }),
        proposal({ id: 'p-none', cost: 0.75, costCurrency: null, attempts: 2 }),
      ],
    });

    expect(html).toContain('成本未知');
    expect(html).toContain('成本 2.5000 EUR');
    expect(html).toContain('成本 0.7500<');
    expect(html).not.toContain('成本 0.7500 EUR');
    expect(html).not.toContain('成本 ¥0.7500');
  });

  it('历史为空且有缓存时不再显示读取中', () => {
    const html = render({ loaded: true, proposals: [] });

    expect(html).toContain('历史提案 ');
    expect(html).not.toContain('读取中…');
    expect(html.match(/还没有提案。生成成功后，提案会留在这里供重新载入。/g)?.length).toBe(1);
    expect(html).not.toContain('ai-history-list');
  });
});
