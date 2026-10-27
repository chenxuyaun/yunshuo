import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChapterListItem } from '@yunshuo/contracts';
import { ChapterList } from './ChapterList.js';

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    workTitle: '作品甲',
    number: 1,
    title: '第一章 起',
    status: 'canon',
    volumeId: 'volume-1',
    volumeTitle: '上卷',
    planRevision: 0,
    bodyNeedsRevision: false,
    wordCount: 1200,
    currentVersionNo: 1,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function render(chapters: ChapterListItem[], selectedId: string | null = null): string {
  return renderToStaticMarkup(
    <ChapterList chapters={chapters} selectedId={selectedId} onSelect={() => {}} />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('ChapterList', () => {
  it('按作品加卷分组，并保持输入顺序', () => {
    const html = render([
      chapter({ id: 'c1', number: 1 }),
      chapter({ id: 'c2', number: 2, title: '第二章 承' }),
      chapter({ id: 'c3', number: 3, volumeId: 'volume-2', volumeTitle: '下卷', title: '第三章 转' }),
    ]);
    expect(count(html, 'class="volume-group"')).toBe(2);
    expect(count(html, 'class="volume-title"')).toBe(2);
    expect(count(html, 'class="chapter-item"')).toBe(3);
    expect(count(html, '<h3 class="volume-title">上卷</h3>')).toBe(1);
    expect(count(html, '<h3 class="volume-title">下卷</h3>')).toBe(1);
    expect(html.indexOf('第 1 章')).toBeLessThan(html.indexOf('第 2 章'));
    expect(html.indexOf('第 2 章')).toBeLessThan(html.indexOf('第 3 章'));
  });

  it('单作品时直接用作品名做标题，不重复渲染作品分组名', () => {
    const html = render([chapter({ id: 'c1' }), chapter({ id: 'c2', number: 2 })]);
    expect(html).toContain('<h2>作品甲</h2>');
    expect(html).not.toContain('work-group-title');
  });

  it('多作品未选中时标题为全部作品，选中后显示该章作品名', () => {
    const chapters = [
      chapter({ id: 'c1', workId: 'work-1', workTitle: '作品甲' }),
      chapter({ id: 'c2', workId: 'work-2', workTitle: '作品乙' }),
    ];
    const none = render(chapters);
    expect(none).toContain('<h2>全部作品</h2>');
    expect(count(none, 'class="work-group-title"')).toBe(2);
    expect(none).toContain('<p class="work-group-title">作品甲</p>');
    expect(none).toContain('<p class="work-group-title">作品乙</p>');

    const selected = render(chapters, 'c2');
    expect(selected).toContain('<h2>作品乙</h2>');
    expect(selected).not.toContain('<h2>全部作品</h2>');
  });

  it('字数与版本事实按有无正典分别展示', () => {
    const html = render([
      chapter({ id: 'c1', number: 1, wordCount: 1234, currentVersionNo: 2 }),
      chapter({ id: 'c2', number: 2, wordCount: null, currentVersionNo: null }),
      chapter({ id: 'c3', number: 3, wordCount: 567, currentVersionNo: null }),
    ]);
    expect(count(html, '1234 字 · v2')).toBe(1);
    expect(count(html, '尚无正典')).toBe(1);
    expect(count(html, 'vnull')).toBe(0);
    expect(count(html, '567 字')).toBe(1);
  });

  it('选中章节高亮，侧栏底部显示标题与更新日期', () => {
    const html = render([chapter({ id: 'c1' }), chapter({ id: 'c2', number: 2 })], 'c2');
    expect(count(html, 'chapter-item is-active')).toBe(1);
    expect(html).toContain('当前：第一章 起');
    expect(html).toContain('最近更新 2026/10/23');
  });

  it('没有选中章节时不渲染侧栏底部当前项', () => {
    const html = render([chapter({ id: 'c1' })]);
    expect(count(html, 'chapter-item is-active')).toBe(0);
    expect(html).not.toContain('sidebar-current');
    expect(html).not.toContain('当前：');
  });

  it('状态徽标随章节状态变化', () => {
    const html = render([
      chapter({ id: 'c1', number: 1, status: 'canon' }),
      chapter({ id: 'c2', number: 2, status: 'writing' }),
      chapter({ id: 'c3', number: 3, status: 'commit_failed' }),
    ]);
    expect(html).toContain('<span class="badge badge-green">正典</span>');
    expect(html).toContain('<span class="badge badge-ink">写作中</span>');
    expect(html).toContain('<span class="badge badge-red">提交待修复</span>');
  });

  it('卷按 volumeId 分组：同名卷不会被合并', () => {
    const html = render([
      chapter({ id: 'c1', number: 1, volumeId: 'volume-1', volumeTitle: '上卷' }),
      chapter({ id: 'c2', number: 2, volumeId: 'volume-2', volumeTitle: '上卷' }),
    ]);
    expect(count(html, 'class="volume-group"')).toBe(2);
    expect(count(html, '<h3 class="volume-title">上卷</h3>')).toBe(2);
    expect(count(html, 'class="chapter-item"')).toBe(2);
  });

  it('待改稿标记只跟随 bodyNeedsRevision', () => {
    const html = render([
      chapter({ id: 'c1', number: 1, bodyNeedsRevision: true }),
      chapter({ id: 'c2', number: 2, bodyNeedsRevision: false }),
      chapter({ id: 'c3', number: 3, bodyNeedsRevision: true }),
    ]);
    expect(count(html, '<span class="chapter-flag">待改稿</span>')).toBe(2);
  });

  it('没有章节时给出开书与导入两条路径', () => {
    const html = render([]);
    expect(html).toContain('<p>还没有章节。</p>');
    expect(html).toContain('先在“作品与卷”里新建作品、卷与章节，或导入旧稿。');
    expect(html).not.toContain('class="volume-group"');
    expect(html).not.toContain('sidebar-current');
  });
});
