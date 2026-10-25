import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChapterListItem, LedgerEntrySnapshot } from '@yunshuo/contracts';
import { LedgerEntryForm } from './LedgerEntryForm.js';

const WORKS = [
  { id: 'work-1', title: '雾港' },
  { id: 'work-2', title: '北境' },
];

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    workTitle: '雾港',
    number: 1,
    title: '灯塔',
    status: 'writing',
    volumeTitle: '第一卷',
    wordCount: 1200,
    currentVersionNo: null,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

const CHAPTERS: ChapterListItem[] = [
  chapter({ id: 'ch-1', number: 1, title: '灯塔' }),
  chapter({ id: 'ch-2', workId: 'work-2', workTitle: '北境', number: 2, title: '潮汐' }),
  chapter({ id: 'ch-3', number: 3, title: '归航' }),
];

function snapshot(overrides: Partial<LedgerEntrySnapshot> = {}): LedgerEntrySnapshot {
  return {
    name: '北境王城',
    aliases: ['白城', '旧都'],
    summary: '北境的政治中心。',
    sourceChapterId: 'ch-2',
    payload: {
      category: 'location',
      details: '城墙以黑石砌成。',
      tags: ['地理', '王权'],
      verification: 'verified',
    },
    ...overrides,
  };
}

function render(options: {
  initial?: LedgerEntrySnapshot | null;
  initialWorkId?: string | null;
  submitting?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <LedgerEntryForm
      initial={options.initial ?? null}
      initialWorkId={options.initialWorkId ?? null}
      works={WORKS}
      chapters={CHAPTERS}
      submitting={options.submitting ?? false}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe('LedgerEntryForm', () => {
  it('新建设定默认落在工作区通用，章节列全部作品', () => {
    const html = render();

    expect(html).toContain('<form class="ledger-form">');
    expect(html).toContain('<p class="eyebrow">新建设定</p>');
    expect(html).toContain('<h3>登记一条世界观事实</h3>');
    expect(html).toContain('<span class="badge badge-ink">设定</span>');
    expect(html).toContain('<option value="workspace" selected="">工作区通用 · 所有作品共享</option>');
    expect(html).toContain('<option value="work-1">作品专属 · 雾港</option>');
    expect(html).toContain('<option value="work-2">作品专属 · 北境</option>');
    expect(html).toContain('<option value="ch-1">雾港 · 第 1 章 · 灯塔</option>');
    expect(html).toContain('<option value="ch-2">北境 · 第 2 章 · 潮汐</option>');
    expect(html).toContain('<option value="ch-3">雾港 · 第 3 章 · 归航</option>');
    expect(html).toContain('世界观');
    expect(html).toContain('待设计');
    expect(html).toContain('<button type="submit" class="button button-primary">创建草稿</button>');
    expect(html).not.toContain('本次修改说明（可选）');
  });

  it('带着作品进入时归属预选该作品，章节只剩这本书', () => {
    const html = render({ initialWorkId: 'work-2' });

    expect(html).toContain('<option value="workspace">工作区通用 · 所有作品共享</option>');
    expect(html).toContain('<option value="work-2" selected="">作品专属 · 北境</option>');
    expect(html).toContain('<option value="ch-2">第 2 章 · 潮汐</option>');
    expect(html).not.toContain('<option value="ch-1">');
    expect(html).not.toContain('<option value="ch-3">');
    expect(html).not.toContain('不可更改');
  });

  it('编辑已有设定时回填快照并锁住归属', () => {
    const html = render({ initial: snapshot() });

    expect(html).toContain('<p class="eyebrow">编辑设定草稿</p>');
    expect(html).toContain('<h3>北境王城</h3>');
    expect(html).toContain('value="北境王城"');
    expect(html).toContain('value="白城，旧都"');
    expect(html).toContain('value="北境的政治中心。"');
    expect(html).toContain('<option value="ch-2" selected="">北境 · 第 2 章 · 潮汐</option>');
    expect(html).toContain('<option value="location" selected="">地点</option>');
    expect(html).toContain('<option value="verified" selected="">已核实</option>');
    expect(html).toContain('城墙以黑石砌成。');
    expect(html).toContain('value="地理，王权"');
    expect(html).toContain('归属在条目创建后不可更改；工作区通用。');
    expect(html).toContain('本次修改说明（可选）');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('保存草稿');
    // 未提交时只有归属下拉被锁；来源章节、分类与核实状态仍可改。
    expect(html.match(/<select disabled=""/g) ?? []).toHaveLength(1);
  });

  it('编辑作品专属条目时归属说明写作品专属', () => {
    const html = render({ initial: snapshot(), initialWorkId: 'work-1' });

    expect(html).toContain('归属在条目创建后不可更改；作品专属。');
    expect(html).toContain('<option value="ch-1">第 1 章 · 灯塔</option>');
    expect(html).not.toContain('<option value="ch-2">');
  });

  it('非设定载荷不会被当成设定编辑', () => {
    const html = render({
      initial: snapshot({
        name: '林默',
        aliases: [],
        summary: '主角。',
        sourceChapterId: null,
        payload: {
          role: '主角',
          appearance: '',
          personality: '',
          goals: '',
          faction: '',
          abilities: '',
          speechStyle: '',
          relationships: [],
          states: [],
        },
      }),
    });

    expect(html).toContain('<h3>林默</h3>');
    expect(html).toContain('<option value="world" selected="">世界观</option>');
    expect(html).toContain('<option value="unverified" selected="">未核实</option>');
    expect(html).toContain('<option value="" selected="">不关联章节</option>');
    expect(html).not.toContain('城墙以黑石砌成。');
  });

  it('提交中锁住取消、保存与所有下拉', () => {
    const html = render({ initial: snapshot(), submitting: true });

    expect(html).toContain('<button type="button" class="button button-quiet" disabled="">取消</button>');
    expect(html).toContain('<button type="submit" class="button button-primary" disabled="">保存中…</button>');
    // 归属、来源章节、分类、核实状态四个下拉全部锁住。
    expect(html.match(/<select disabled=""/g) ?? []).toHaveLength(4);
  });

  it('新建设定的字段上限与占位逐项就位', () => {
    const html = render();

    expect(html).toContain('maxLength="120"');
    expect(html).toContain('required=""');
    expect(html).toContain('placeholder="例如：北境王城"');
    expect(html).toContain('placeholder="例如：白城，旧都"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('placeholder="给写作者看的一句话说明"');
    expect(html).toContain('rows="9"');
    expect(html).toContain('maxLength="20000"');
    expect(html).toContain('placeholder="记录这个世界观事实的边界、例证与禁止事项；不要写入未确认的推测。"');
    expect(html).toContain('placeholder="例如：地理，王权，第一卷"');
    expect(html).toContain('创建与编辑只写入草稿；发布后才会成为生效版本。已发布版本不可修改，回滚会生成新的草稿。');
    expect(html).not.toContain('modal-error');
  });
});
