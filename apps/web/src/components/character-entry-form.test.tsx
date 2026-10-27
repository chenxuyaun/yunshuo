import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChapterListItem, LedgerEntrySnapshot } from '@yunshuo/contracts';
import { CharacterEntryForm } from './CharacterEntryForm.js';

const WORKS = [
  { id: 'work-1', title: '雾港' },
  { id: 'work-2', title: '北境' },
];

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'ch-1',
    workId: 'work-1',
    workTitle: '雾港',
    number: 1,
    title: '灯塔',
    status: 'writing',
    volumeId: 'volume-1',
    volumeTitle: '第一卷',
    planRevision: 0,
    bodyNeedsRevision: false,
    wordCount: 1200,
    currentVersionNo: null,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

// 故意乱序：断言章节下拉按章号排序，而不是照输入顺序。
const CHAPTERS: ChapterListItem[] = [
  chapter({ id: 'ch-2', number: 2, title: '潮汐' }),
  chapter({ id: 'ch-3', workId: 'work-2', workTitle: '北境', number: 3, title: '归航' }),
  chapter({ id: 'ch-1', number: 1, title: '灯塔' }),
];

function snapshot(overrides: Partial<LedgerEntrySnapshot> = {}): LedgerEntrySnapshot {
  return {
    name: '林默',
    aliases: ['默哥', '林七'],
    summary: '北境军斥候。',
    sourceChapterId: 'ch-2',
    payload: {
      role: '主角 / 斥候',
      appearance: '瘦高，左眉有疤。',
      personality: '话少。',
      goals: '查明旧案。',
      faction: '北境军',
      abilities: '追踪。',
      speechStyle: '常用短句。',
      relationships: [
        { name: '苏晚', relation: '同门', notes: '互相照应。' },
        { name: '贺川', relation: '上下级', notes: '' },
      ],
      states: [
        {
          asOfChapterId: 'ch-1',
          life: 'alive',
          location: '灯塔',
          knowledge: '知道潮汐规律。',
          possessions: '旧徽章',
          relationshipChanges: '',
        },
        {
          asOfChapterId: 'ch-2',
          life: 'dead',
          location: '王城',
          knowledge: '',
          possessions: '',
          relationshipChanges: '与苏晚决裂',
        },
      ],
    },
    ...overrides,
  };
}

function render(options: {
  initial?: LedgerEntrySnapshot | null;
  initialWorkId?: string | null;
  chapters?: ChapterListItem[];
  submitting?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <CharacterEntryForm
      initial={options.initial ?? null}
      initialWorkId={options.initialWorkId ?? null}
      works={WORKS}
      chapters={options.chapters ?? CHAPTERS}
      submitting={options.submitting ?? false}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
  );
}

// 只取内容/值等于 marker 的那一个控件，避免同上限字段互相顶替。
function controlTag(html: string, marker: string): string {
  const input = html.match(new RegExp(`<input[^>]*value="${marker}"[^>]*>`))?.[0];
  if (input) return input;
  return html.match(new RegExp(`<textarea[^>]*>[^<]*${marker}[^<]*</textarea>`))?.[0] ?? '';
}

describe('CharacterEntryForm', () => {
  it('新建默认落在首个作品，章节按章号排序且只列本书', () => {
    const html = render();

    expect(html).toContain('<p class="eyebrow">新建角色档案</p>');
    expect(html).toContain('<h3>登记一个会随时间变化的角色</h3>');
    expect(html).toContain('<span class="badge badge-ink">角色</span>');
    expect(html).toContain('<option value="work-1" selected="">雾港</option>');
    expect(html).toContain('<option value="work-2">北境</option>');
    expect(html).toContain('<option value="ch-1">第 1 章 · 灯塔</option>');
    expect(html).toContain('<option value="ch-2">第 2 章 · 潮汐</option>');
    expect(html).not.toContain('<option value="ch-3">');
    expect(html.indexOf('<option value="ch-1">')).toBeLessThan(
      html.indexOf('<option value="ch-2">'),
    );
    expect(html).toContain('角色档案必须归属作品；归属在创建后不可更改。切换作品会清空已填写的状态时间线。');
    expect(html).toContain('还没有登记关系。留空不会写入。');
    expect(html).toContain(
      '还没有状态记录。没有时间线的角色仍可作为档案发布，但写作台不会显示其状态。',
    );
    expect(html).toContain('<button type="button" class="button button-quiet button-small">添加关系</button>');
    expect(html).toContain('<button type="button" class="button button-quiet button-small">添加状态</button>');
    expect(html).toContain('<button type="submit" class="button button-primary">创建草稿</button>');
    expect(html).not.toContain('本次修改说明（可选）');
  });

  it('带着作品进入时预选该作品，章节只剩这本书', () => {
    const html = render({ initialWorkId: 'work-2' });

    expect(html).toContain('<option value="work-2" selected="">北境</option>');
    expect(html).toContain('<option value="ch-3">第 3 章 · 归航</option>');
    expect(html).not.toContain('<option value="ch-1">');
    expect(html).not.toContain('<option value="ch-2">');
    expect(html).toContain('切换作品会清空已填写的状态时间线。');
  });

  it('作品没有章节时说明无法登记时间线并禁用添加状态', () => {
    const html = render({ chapters: [] });

    expect(html).toContain('该作品还没有章节，无法登记状态时间线。');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" disabled="">添加状态</button>',
    );
    expect(html).toContain('<button type="button" class="button button-quiet button-small">添加关系</button>');
  });

  it('编辑已有角色时回填静态档案、关系与状态时间线', () => {
    const html = render({ initial: snapshot() });

    expect(html).toContain('<p class="eyebrow">编辑角色草稿</p>');
    expect(html).toContain('<h3>林默</h3>');
    expect(html).toContain('value="林默"');
    expect(html).toContain('value="默哥，林七"');
    expect(html).toContain('value="北境军斥候。"');
    // 摘要输入的上限必须单独定位：语言风格与关系变化也是 2000。
    const summaryTag = html.match(/<input[^>]*value="北境军斥候。"[^>]*>/)?.[0] ?? '';
    expect(summaryTag).toContain('maxLength="2000"');
    expect(html).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');
    // 状态行里也会出现 ch-2 selected，这里单独取“来源章节”那段下拉。
    const sourceStart = html.indexOf('<span>来源章节（可选）</span>');
    const sourceSelect = html.slice(sourceStart, html.indexOf('</select>', sourceStart));
    expect(sourceSelect).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');
    expect(sourceSelect).not.toContain('selected="">不关联章节');
    expect(html).toContain('value="主角 / 斥候"');
    expect(html).toContain('value="北境军"');
    expect(html).toContain('瘦高，左眉有疤。');
    expect(html).toContain('话少。');
    expect(html).toContain('查明旧案。');
    expect(html).toContain('追踪。');
    expect(html).toContain('value="常用短句。"');
    expect(html).toContain('value="苏晚"');
    // 逐字段定位：外貌/性格/能力/语言风格各有自己的上限与行数。
    expect(controlTag(html, '瘦高，左眉有疤。')).toContain('rows="2"');
    expect(controlTag(html, '瘦高，左眉有疤。')).toContain('maxLength="5000"');
    expect(controlTag(html, '话少。')).toContain('maxLength="5000"');
    expect(controlTag(html, '追踪。')).toContain('maxLength="5000"');
    expect(controlTag(html, '常用短句。')).toContain('maxLength="2000"');
    expect(controlTag(html, '苏晚')).toContain('placeholder="例如：苏晚"');
    expect(controlTag(html, '苏晚')).toContain('maxLength="200"');
    expect(html).toContain('<span>截至章节</span>');
    expect(controlTag(html, '灯塔')).toContain('maxLength="200"');
    expect(controlTag(html, '灯塔')).toContain('placeholder="例如：王城"');
    expect(controlTag(html, '旧徽章')).toContain('maxLength="2000"');
    expect(controlTag(html, '旧徽章')).toContain('placeholder="例如：一枚旧徽章"');
    expect(controlTag(html, '知道潮汐规律。')).toContain('rows="2"');
    expect(controlTag(html, '知道潮汐规律。')).toContain('maxLength="5000"');
    expect(controlTag(html, '知道潮汐规律。')).toContain(
      'placeholder="截至这一章，角色已经知道什么；不要写入后续章节才揭示的信息。"',
    );
    expect(controlTag(html, '与苏晚决裂')).toContain('rows="2"');
    expect(controlTag(html, '与苏晚决裂')).toContain('maxLength="2000"');
    expect(controlTag(html, '与苏晚决裂')).toContain('placeholder="例如：与苏晚决裂"');
    expect(html).toContain('value="同门"');
    expect(html).toContain('value="互相照应。"');
    expect(html).toContain('value="贺川"');
    expect(html).toContain('value="上下级"');
    expect(html).toContain('<option value="alive" selected="">存活</option>');
    expect(html).toContain('<option value="dead" selected="">死亡</option>');
    expect(html).toContain('value="灯塔"');
    expect(html).toContain('value="旧徽章"');
    expect(html).toContain('value="王城"');
    expect(html).toContain('知道潮汐规律。');
    expect(html).toContain('与苏晚决裂');
    expect(html).toContain('角色档案必须归属作品；归属在创建后不可更改。');
    expect(html).not.toContain('切换作品会清空已填写的状态时间线。');
    expect(html).toContain('本次修改说明（可选）');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('placeholder="例如：补充第 3 章后的伤势与所在地"');
    expect(html).toContain('保存草稿');
    expect(html).toContain('maxLength="1000"');
    expect(html).toContain('placeholder="可选"');
    // 未提交时只有归属下拉被锁。
    expect(html.match(/<select disabled=""/g) ?? []).toHaveLength(1);
  });

  it('已登记章节在每条状态下都标出且不可重复选择', () => {
    const html = render({ initial: snapshot() });

    expect(html).toContain('<option value="ch-1" selected="">第 1 章 · 灯塔</option>');
    expect(html).toContain('<option value="ch-2" disabled="">第 2 章 · 潮汐（已登记）</option>');
    expect(html).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');
    expect(html).toContain('<option value="ch-1" disabled="">第 1 章 · 灯塔（已登记）</option>');
    // 每条状态一行、每行两个下拉。
    expect(html.match(/<option value="ch-2"/g) ?? []).toHaveLength(3);
  });

  it('非角色载荷不会被当成角色编辑', () => {
    const html = render({
      initial: snapshot({
        name: '北境王城',
        aliases: [],
        summary: '北境的政治中心。',
        sourceChapterId: null,
        payload: {
          category: 'location',
          details: '城墙以黑石砌成。',
          tags: ['地理'],
          verification: 'verified',
        },
      }),
    });

    expect(html).toContain('<h3>北境王城</h3>');
    expect(html).toContain('<option value="" selected="">不关联章节</option>');
    expect(html).not.toContain('value="主角 / 斥候"');
    expect(html).not.toContain('城墙以黑石砌成。');
    expect(html).toContain('还没有登记关系。留空不会写入。');
    expect(html).toContain(
      '还没有状态记录。没有时间线的角色仍可作为档案发布，但写作台不会显示其状态。',
    );
  });

  it('提交中锁住归属、来源章节、每条状态的下拉与增删按钮', () => {
    const html = render({ initial: snapshot(), submitting: true });

    expect(html).toContain('<button type="button" class="button button-quiet" disabled="">取消</button>');
    expect(html).toContain('<button type="submit" class="button button-primary" disabled="">保存中…</button>');
    // 归属 + 来源章节 + 两条状态各两个。
    expect(html.match(/<select disabled=""/g) ?? []).toHaveLength(6);
    expect(
      html.match(/<button type="button" class="button button-quiet button-small" disabled="">/g) ?? [],
    ).toHaveLength(2);
    expect(
      html.match(
        /<button type="button" class="button button-quiet button-small ledger-row-remove" disabled="">移除<\/button>/g,
      ) ?? [],
    ).toHaveLength(4);
  });

  it('各段说明只陈述边界，不把未生成的分析说成已有', () => {
    const html = render();

    expect(html).toContain('<h4>角色卡</h4>');
    expect(html).toContain('<span class="muted">静态档案，不随时间线变化</span>');
    expect(html).toContain('<h4>人物关系</h4>');
    expect(html).toContain(
      '同名对象可以记录多种关系，时间线里说明变化时点；系统会对冲突给出警告，但不会阻断发布。',
    );
    expect(html).toContain('<h4>状态时间线</h4>');
    expect(html).toContain(
      '每条状态绑定「截至第 N 章」。写作台只展示上一章之前的最新状态，后续章节的状态不会提前出现。',
    );
    expect(html).toContain(
      '创建与编辑只写入草稿；发布后才会成为生效版本。角色时间线、出场扫描与矛盾警告都在发布后生成。',
    );
    expect(html).not.toContain('modal-error');
  });

  it('字段上限与占位逐项就位', () => {
    const html = render();

    expect(html).toContain('placeholder="例如：林默"');
    expect(html).toContain('required=""');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('placeholder="例如：默哥，林七"');
    expect(html).toContain('placeholder="给写作者看的一句话说明"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('placeholder="例如：主角 / 北境军斥候"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('placeholder="例如：北境军"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('placeholder="例如：话少，常用短句"');
    expect(html).toContain('maxLength="5000"');
    // 新建且无状态时，角色卡里恰好四个两行文本域。
    expect(html.match(/rows="2"/g) ?? []).toHaveLength(4);
  });
});
