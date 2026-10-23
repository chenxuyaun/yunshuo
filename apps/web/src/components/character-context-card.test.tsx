import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  LedgerCharacterContext,
  LedgerCharacterContextItem,
} from '@yunshuo/contracts';
import { CharacterContextCard } from './CharacterContextCard.js';

const CHAPTER_ID = 'chapter-5';

function state(
  overrides: Partial<LedgerCharacterContextItem['state']> = {},
): LedgerCharacterContextItem['state'] {
  return {
    chapter: { id: 'chapter-3', number: 3, title: '雨夜' },
    life: 'alive',
    location: '',
    knowledge: '',
    possessions: '',
    relationshipChanges: '',
    ...overrides,
  };
}

function character(
  overrides: Partial<LedgerCharacterContextItem> = {},
): LedgerCharacterContextItem {
  return {
    id: 'character-1',
    name: '林默',
    state: state(),
    stale: false,
    ...overrides,
  };
}

function context(overrides: Partial<LedgerCharacterContext> = {}): LedgerCharacterContext {
  return {
    chapterId: CHAPTER_ID,
    chapter: { id: CHAPTER_ID, number: 5, title: '渡口' },
    asOfChapter: { id: 'chapter-4', number: 4, title: '出发' },
    characters: [],
    omittedCharacters: 0,
    note: '只读取已发布状态；草稿与后续章节不参与。',
    ...overrides,
  };
}

function render(value: LedgerCharacterContext | null): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (value) {
    client.setQueryData(['characterContext', CHAPTER_ID], value);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CharacterContextCard chapterId={CHAPTER_ID} />
    </QueryClientProvider>,
  );
}

describe('CharacterContextCard', () => {
  it('没有缓存时只说正在读取，不显示角色数徽标', () => {
    const html = render(null);
    expect(html).toContain('正在读取已发布角色档案……');
    expect(html).not.toContain('badge-');
    expect(html).not.toContain('character-context-foot');
  });

  it('开篇没有上一章且没有角色时如实说明', () => {
    const html = render(
      context({ asOfChapter: null, characters: [], omittedCharacters: 0 }),
    );

    expect(html).toContain('badge-muted">0 个角色');
    expect(html).toContain('本章为开篇第 5 章，没有上一章。');
    expect(html).toContain('还没有已发布的角色档案。');
    expect(html).toContain('只读取已发布状态；草稿与后续章节不参与。');
    expect(html).not.toContain('已隐藏');
  });

  it('有上一章但全员无状态时归因到人工确认', () => {
    const html = render(context({ omittedCharacters: 3 }));

    expect(html).toContain(
      '已发布的角色在上一章及之前都没有登记状态，因此没有可展示的状态；写作者需要人工确认。',
    );
    expect(html).not.toContain('还没有已发布的角色档案。');
    expect(html).not.toContain('已隐藏');
  });

  it('开篇且全员无状态时用开篇口径，不说上一章', () => {
    const html = render(
      context({ asOfChapter: null, omittedCharacters: 1 }),
    );

    expect(html).toContain('开篇没有上一章，因此不展示角色状态；写作者需要人工确认。');
    expect(html).not.toContain('已发布的角色在上一章');
  });

  it('逐角色写出生死色调、来源章节与四项细节', () => {
    const html = render(
      context({
        characters: [
          character({
            id: 'character-1',
            name: '林默',
            stale: true,
            state: state({
              chapter: { id: 'chapter-2', number: 2, title: '入镇' },
              life: 'alive',
              location: '镇西客栈',
              knowledge: '知道铜钉的来历',
              possessions: '铜钉',
              relationshipChanges: '与沈舟结盟',
            }),
          }),
          character({
            id: 'character-2',
            name: '沈舟',
            state: state({
              chapter: { id: 'chapter-4', number: 4, title: '出发' },
              life: 'dead',
            }),
          }),
          character({
            id: 'character-3',
            name: '无名氏',
            state: state({
              chapter: { id: 'chapter-4', number: 4, title: '出发' },
              life: 'unknown',
            }),
          }),
        ],
        omittedCharacters: 2,
      }),
    );

    expect(html).toContain('badge-ink">3 个角色');
    expect(html).toContain('本章为第 5 章；状态截至第 4 章 · 出发。');
    expect(html).toContain('<strong>林默</strong>');
    expect(html).toContain('badge-green">存活');
    expect(html).toContain('badge-red">死亡');
    expect(html).toContain('badge-neutral">未知');
    expect(html).toContain('截至第 2 章');
    expect(html).toContain('<dt>地点</dt><dd>镇西客栈</dd>');
    expect(html).toContain('<dt>已知</dt><dd>知道铜钉的来历</dd>');
    expect(html).toContain('<dt>持有</dt><dd>铜钉</dd>');
    expect(html).toContain('<dt>关系变化</dt><dd>与沈舟结盟</dd>');
    expect(html).toContain('状态停在更早的章节，上一章没有新的状态记录。');
    expect(html.split('character-context-stale').length - 1).toBe(1);
    expect(html).toContain('另有 2 个已发布角色在该时点前没有状态记录，已隐藏。');
  });

  it('只有生死时给出兜底说明，不渲染空细节', () => {
    const html = render(context({ characters: [character()] }));

    expect(html).toContain('该状态只登记了生死，没有其它细节。');
    expect(html).not.toContain('<dt>地点</dt>');
    expect(html).not.toContain('<dt>已知</dt>');
    expect(html).not.toContain('<dt>持有</dt>');
    expect(html).not.toContain('<dt>关系变化</dt>');
    expect(html).toContain('badge-ink">1 个角色');
  });
});
