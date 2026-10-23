import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  ChapterLedgerLinkView,
  ChapterLedgerLinksResponse,
  LedgerEntryListResponse,
  LedgerEntrySummary,
} from '@yunshuo/contracts';
import { ChapterLedgerLinksCard } from './ChapterLedgerLinksCard.js';

const CHAPTER_ID = 'chapter-1';
const WORK_ID = 'work-1';

function entry(overrides: Partial<LedgerEntrySummary> = {}): LedgerEntrySummary {
  return {
    id: 'entry-char',
    workId: WORK_ID,
    kind: 'character',
    scope: 'work',
    name: '林默',
    aliases: [],
    summary: '',
    status: 'active',
    sourceChapterId: null,
    currentVersionNo: 2,
    draftVersionNo: null,
    updatedAt: '2026-10-23T18:00:00.000Z',
    ...overrides,
  };
}

function link(overrides: Partial<ChapterLedgerLinkView> = {}): ChapterLedgerLinkView {
  return {
    id: 'link-1',
    chapterId: CHAPTER_ID,
    entryId: 'entry-char',
    kind: 'character',
    name: '林默',
    status: 'active',
    scope: 'work',
    workId: WORK_ID,
    versionId: 'version-2',
    versionNo: 2,
    note: '',
    createdByName: '张三',
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function links(items: ChapterLedgerLinkView[], note = ''): ChapterLedgerLinksResponse {
  return { links: items, note };
}

function options(entries: LedgerEntrySummary[]): LedgerEntryListResponse {
  return { entries };
}

function render(
  linksResponse: ChapterLedgerLinksResponse | null,
  optionsResponse: LedgerEntryListResponse | null = null,
  canEdit = true,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (linksResponse) {
    client.setQueryData(['chapterLedgerLinks', CHAPTER_ID], linksResponse);
  }
  if (optionsResponse) {
    client.setQueryData(['chapterLedgerLinkOptions', WORK_ID], optionsResponse);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChapterLedgerLinksCard chapterId={CHAPTER_ID} workId={WORK_ID} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

describe('ChapterLedgerLinksCard', () => {
  it('没有缓存时只说正在读取，不显示条数徽标', () => {
    const html = render(null);
    expect(html).toContain('正在读取本章关联……');
    expect(html).not.toContain('chapter-ledger-link-foot');
    expect(html).not.toContain('badge-');
    expect(html).not.toContain('0 条');
  });

  it('零关联时给出空态、脚注与仍可用的选择表单', () => {
    const html = render(
      links([], '关联仅供参考，不改变正典与门禁。'),
      options([
        entry(),
        entry({ id: 'entry-setting', kind: 'setting', name: '铜钉' }),
        entry({ id: 'entry-foreshadow', kind: 'foreshadowing', name: '井底' }),
      ]),
    );

    expect(html).toContain('badge-muted">0 条');
    expect(html).toContain('本章还没有关联设定、角色或伏笔。');
    expect(html).toContain('关联仅供参考，不改变正典与门禁。');
    expect(html).toContain('选择已发布的账本条目');
    expect(html).toContain('>角色 · 林默<');
    expect(html).toContain('>设定 · 铜钉<');
    expect(html).toContain('>伏笔 · 井底<');
    expect(html).toContain('placeholder="关联备注（可选，最多 500 字）"');
    expect(html).toContain('maxLength="500"');
    expect(html).not.toContain('读取账本条目…');
    expect(html).not.toContain('index-error');
  });

  it('有记录时逐条写出版本、作用域、人数与备注', () => {
    const html = render(
      links([
        link({ id: 'link-1', note: '本章首次出场' }),
        link({
          id: 'link-2',
          entryId: 'entry-setting',
          kind: 'setting',
          name: '铜钉',
          scope: 'workspace',
          workId: null,
          versionId: null,
          versionNo: null,
          createdByName: null,
          createdAt: '2026-10-22T09:00:00.000Z',
        }),
      ], '共 2 条'),
    );

    expect(html).toContain('badge-green">2 条');
    expect(html).toContain('badge-ink">角色');
    expect(html).toContain('<strong>林默</strong>');
    expect(html).toContain('v2 · 作品专属');
    expect(html).toContain('本章首次出场');
    expect(html).toContain('张三 · 2026/10/23 18:07:00');
    expect(html).toContain('badge-ink">设定');
    expect(html).toContain('<strong>铜钉</strong>');
    expect(html).toContain('无生效版本 · 工作区通用');
    expect(html).toContain('未知成员 · 2026/10/22 09:00:00');
    expect(html.split('chapter-ledger-link-note').length - 1).toBe(1);
    expect(html).toContain('共 2 条');
  });

  it('已关联的条目不再出现在下拉里', () => {
    const linked = entry();
    const html = render(
      links([link({ entryId: linked.id })]),
      options([
        linked,
        entry({ id: 'entry-setting', kind: 'setting', name: '铜钉' }),
      ]),
    );

    expect(html).toContain('>设定 · 铜钉<');
    expect(html).not.toContain('>角色 · 林默<');
    expect(html).not.toContain('value="entry-char"');
  });

  it('只读角色看不到表单与移除按钮', () => {
    const html = render(links([link()]), options([entry()]), false);

    expect(html).not.toContain('chapter-ledger-link-form');
    expect(html).not.toContain('>移除<');
    expect(html).not.toContain('关联备注');
    expect(html).toContain('badge-green">1 条');
  });

  it('可编辑角色能看到移除按钮，关联按钮在未选择时禁用', () => {
    const html = render(links([link()]), options([entry()]), true);

    expect(html).toContain('>移除<');
    const formAt = html.indexOf('chapter-ledger-link-form');
    const submitAt = html.indexOf('>关联<', formAt);
    const submitTag = html.slice(html.lastIndexOf('<button', submitAt), submitAt);
    expect(submitTag).toContain('disabled=""');
    expect(html).not.toContain('读取账本条目…');
  });

  it('账本条目还在读取时下拉禁用并提示正在读取', () => {
    const html = render(links([]), null, true);

    expect(html).toContain('读取账本条目…');
    const selectAt = html.indexOf('<select');
    const selectTag = html.slice(selectAt, html.indexOf('>', selectAt) + 1);
    expect(selectTag).toContain('disabled=""');
  });
});
