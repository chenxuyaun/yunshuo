import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ChapterListItem,
  LedgerEntrySnapshot,
  LedgerForeshadowingPayload,
} from '@yunshuo/contracts';
import { ForeshadowingEntryForm } from './ForeshadowingEntryForm.js';

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

function foreshadowPayload(
  overrides: Partial<LedgerForeshadowingPayload> = {},
): LedgerForeshadowingPayload {
  return {
    seedChapterId: 'ch-2',
    payoffChapterMin: 3,
    payoffChapterMax: 5,
    importance: 'high',
    state: 'reinforced',
    payoffChapterId: null,
    note: '纹章内侧刻着北境军编号。',
    resolutionNote: '',
    ...overrides,
  };
}

function snapshot(overrides: Partial<LedgerEntrySnapshot> = {}): LedgerEntrySnapshot {
  return {
    name: '旧徽章的纹章',
    aliases: ['王室徽记', '旧纹章'],
    summary: '林默在灯塔捡到。',
    sourceChapterId: 'ch-2',
    payload: foreshadowPayload(),
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
    <ForeshadowingEntryForm
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

function controlByPlaceholder(html: string, placeholder: string): string {
  return (
    html.match(new RegExp(`<input[^>]*placeholder="${placeholder}"[^>]*>`))?.[0] ??
    html.match(
      new RegExp(`<textarea[^>]*placeholder="${placeholder}"[^>]*>[^<]*</textarea>`),
    )?.[0] ??
    ''
  );
}

function selectBlock(html: string, marker: string): string {
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const end = html.indexOf('</select>', start);
  return end < 0 ? '' : html.slice(start, end);
}

describe('ForeshadowingEntryForm', () => {
  it('新建默认落在首个作品的第一个埋设章节', () => {
    const html = render();

    expect(html).toContain('<p class="eyebrow">新建伏笔</p>');
    expect(html).toContain('<h3>登记一条需要回收的伏笔</h3>');
    expect(html).toContain('<span class="badge badge-ink">伏笔</span>');
    expect(html).toContain('<option value="work-1" selected="">雾港</option>');
    expect(html).toContain('<option value="work-2">北境</option>');

    const source = selectBlock(html, '<span>来源章节（可选）</span>');
    expect(source).toContain('<option value="" selected="">不关联章节</option>');

    const seed = selectBlock(html, '<span>埋设章节</span>');
    expect(seed).toContain('<option value="">请选择章节</option>');
    expect(seed).toContain('<option value="ch-1" selected="">第 1 章 · 灯塔</option>');
    expect(seed).toContain('<option value="ch-2">第 2 章 · 潮汐</option>');
    expect(seed).not.toContain('ch-3');
    expect(seed.indexOf('ch-1')).toBeLessThan(seed.indexOf('ch-2'));

    const importance = selectBlock(html, '<span>重要度</span>');
    expect(importance).toContain('<option value="low">低</option>');
    expect(importance).toContain('<option value="medium" selected="">中</option>');
    expect(importance).toContain('<option value="high">高</option>');

    const state = selectBlock(html, '<span>伏笔状态</span>');
    expect(state).toContain('<option value="planted" selected="">已埋设</option>');
    expect(state).toContain('<option value="reinforced">已强化</option>');
    expect(state).toContain('<option value="paid_off">已回收</option>');
    expect(state).toContain('<option value="abandoned">已放弃</option>');
    expect(state).not.toContain('不允许从当前状态流转');
    expect(state).not.toContain('disabled=""');

    expect(html).toContain('伏笔必须归属作品；归属在创建后不可更改。切换作品会清空埋设章节与计划窗口。');
    expect(html).toContain(
      '计划窗口只用于提醒与逾期判断，不会自动改写章节；结束章留空时不会判定逾期。',
    );
    expect(html).toContain(
      '状态只能向前流转：已埋设 → 已强化 → 已回收 / 已放弃；已回收与已放弃不能再打开。 需要恢复历史状态只能通过版本回滚。',
    );
    expect(html).not.toContain('<span>回收章节</span>');
    expect(html).not.toContain('回收说明（至少 4 个字）');
    expect(html).not.toContain('放弃原因（至少 4 个字）');
    expect(html).not.toContain('当前生效状态');
    expect(html).not.toContain('本次修改说明（可选）');
    expect(html).toContain(
      '<button type="submit" class="button button-primary">创建草稿</button>',
    );
  });

  it('带着作品进入时预选该作品，章节只剩这本书', () => {
    const html = render({ initialWorkId: 'work-2' });

    expect(html).toContain('<option value="work-2" selected="">北境</option>');
    const seed = selectBlock(html, '<span>埋设章节</span>');
    expect(seed).toContain('<option value="ch-3" selected="">第 3 章 · 归航</option>');
    expect(seed).not.toContain('ch-1');
    expect(seed).not.toContain('ch-2');
    expect(html).toContain('切换作品会清空埋设章节与计划窗口。');
  });

  it('编辑时回填埋设章节、计划窗口与状态，并锁住作品', () => {
    const html = render({ initial: snapshot() });

    expect(html).toContain('<p class="eyebrow">编辑伏笔草稿</p>');
    expect(html).toContain('<h3>旧徽章的纹章</h3>');
    expect(controlTag(html, '旧徽章的纹章')).toContain('maxLength="120"');
    expect(controlTag(html, '王室徽记，旧纹章')).toContain('value="王室徽记，旧纹章"');
    expect(controlTag(html, '林默在灯塔捡到。')).toContain('value="林默在灯塔捡到。"');

    const work = selectBlock(html, '<span>所属作品</span>');
    expect(work).toContain('雾港');
    expect(work).toContain('disabled=""');
    expect((html.match(/<select[^>]*disabled=""/g) ?? []).length).toBe(1);
    expect(html).toContain('伏笔必须归属作品；归属在创建后不可更改。');
    expect(html).not.toContain('切换作品会清空埋设章节与计划窗口。');

    const source = selectBlock(html, '<span>来源章节（可选）</span>');
    expect(source).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');

    const seed = selectBlock(html, '<span>埋设章节</span>');
    expect(seed).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');
    expect(seed).toContain('<option value="ch-1">第 1 章 · 灯塔</option>');

    expect(controlTag(html, '3')).toContain('value="3"');
    expect(controlTag(html, '3')).toContain('inputMode="numeric"');
    expect(controlTag(html, '5')).toContain('value="5"');

    const importance = selectBlock(html, '<span>重要度</span>');
    expect(importance).toContain('<option value="high" selected="">高</option>');

    const state = selectBlock(html, '<span>伏笔状态</span>');
    expect(state).toContain(
      '<option value="planted" disabled="">已埋设（不允许从当前状态流转）</option>',
    );
    expect(state).toContain('<option value="reinforced" selected="">已强化</option>');
    expect(state).toContain('<option value="paid_off">已回收</option>');
    expect(state).toContain('<option value="abandoned">已放弃</option>');
    expect(html).toContain(
      '当前生效状态：已强化。 服务端会再次校验状态流转。',
    );

    expect(controlTag(html, '纹章内侧刻着北境军编号。')).toContain('rows="3"');
    expect(html).not.toContain('<span>回收章节</span>');
    expect(html).not.toContain('回收说明（至少 4 个字）');
    expect(html).not.toContain('放弃原因（至少 4 个字）');

    expect(html).toContain('<span>本次修改说明（可选）</span>');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('placeholder="例如：第 12 章已回收旧徽章"');
    expect(html).toContain(
      '<button type="submit" class="button button-primary">保存草稿</button>',
    );
  });

  it('已回收状态要求回收章节并显示回收说明', () => {
    const html = render({
      initial: snapshot({
        payload: foreshadowPayload({
          seedChapterId: 'ch-1',
          state: 'paid_off',
          payoffChapterMin: 2,
          payoffChapterMax: 4,
          payoffChapterId: 'ch-2',
          resolutionNote: '第 2 章林默把纹章交给苏晚。',
        }),
      }),
    });

    const payoff = selectBlock(html, '<span>回收章节</span>');
    expect(payoff).toContain('<option value="">请选择回收章节</option>');
    expect(payoff).toContain('<option value="ch-2" selected="">第 2 章 · 潮汐</option>');
    expect(html).toContain('回收章节必须在计划窗口内；当前选择：第 2 章 · 潮汐。');

    expect(html).toContain('<span>回收说明（至少 4 个字）</span>');
    const note = controlTag(html, '第 2 章林默把纹章交给苏晚。');
    expect(note).toContain('rows="3"');
    expect(note).toContain('maxLength="5000"');
    expect(note).toContain('placeholder="说明这一章如何回收了伏笔，避免只写“已回收”"');
    expect(html).not.toContain('放弃原因（至少 4 个字）');

    const state = selectBlock(html, '<span>伏笔状态</span>');
    expect(state).toContain('<option value="paid_off" selected="">已回收</option>');
    expect(state).toContain(
      '<option value="planted" disabled="">已埋设（不允许从当前状态流转）</option>',
    );
    expect(state).toContain(
      '<option value="reinforced" disabled="">已强化（不允许从当前状态流转）</option>',
    );
    expect(state).toContain(
      '<option value="abandoned" disabled="">已放弃（不允许从当前状态流转）</option>',
    );
    expect(html).toContain('当前生效状态：已回收。 服务端会再次校验状态流转。');
  });

  it('已放弃状态显示放弃原因且不再出现回收章节', () => {
    const html = render({
      initial: snapshot({
        payload: foreshadowPayload({
          state: 'abandoned',
          payoffChapterId: null,
          resolutionNote: '林默线被砍，纹章不再回收。',
        }),
      }),
    });

    expect(html).toContain('<span>放弃原因（至少 4 个字）</span>');
    const note = controlTag(html, '林默线被砍，纹章不再回收。');
    expect(note).toContain('placeholder="说明为什么放弃这条伏笔，便于以后回溯"');
    expect(html).not.toContain('<span>回收章节</span>');
    expect(html).not.toContain('回收说明（至少 4 个字）');

    const state = selectBlock(html, '<span>伏笔状态</span>');
    expect(state).toContain('<option value="abandoned" selected="">已放弃</option>');
    expect(state).toContain(
      '<option value="planted" disabled="">已埋设（不允许从当前状态流转）</option>',
    );
    expect(state).toContain(
      '<option value="reinforced" disabled="">已强化（不允许从当前状态流转）</option>',
    );
    expect(state).toContain(
      '<option value="paid_off" disabled="">已回收（不允许从当前状态流转）</option>',
    );
    expect(html).toContain('当前生效状态：已放弃。 服务端会再次校验状态流转。');
  });

  it('非伏笔载荷按新建默认值渲染，但保留条目通用字段', () => {
    const html = render({
      initial: {
        name: '林默',
        aliases: [],
        summary: '',
        sourceChapterId: null,
        payload: {
          role: '斥候',
          appearance: '',
          personality: '',
          goals: '',
          faction: '',
          abilities: '',
          speechStyle: '',
          relationships: [],
          states: [],
        },
      },
    });

    expect(html).toContain('<p class="eyebrow">编辑伏笔草稿</p>');
    expect(html).toContain('<h3>林默</h3>');
    const seed = selectBlock(html, '<span>埋设章节</span>');
    expect(seed).toContain('<option value="ch-1" selected="">第 1 章 · 灯塔</option>');
    const importance = selectBlock(html, '<span>重要度</span>');
    expect(importance).toContain('<option value="medium" selected="">中</option>');
    const state = selectBlock(html, '<span>伏笔状态</span>');
    expect(state).toContain('<option value="planted" selected="">已埋设</option>');
    expect(state).not.toContain('不允许从当前状态流转');
    expect(html).not.toContain('当前生效状态');
    expect(html).not.toContain('<span>回收章节</span>');
    expect(html).not.toContain('放弃原因（至少 4 个字）');
    expect(html).toContain('<span>本次修改说明（可选）</span>');
    expect(html).toContain(
      '<button type="submit" class="button button-primary">保存草稿</button>',
    );
  });

  it('提交中禁用全部下拉与按钮', () => {
    const html = render({ submitting: true });

    expect((html.match(/<select[^>]*disabled=""/g) ?? []).length).toBe(5);
    expect(html).toContain(
      '<button type="button" class="button button-quiet" disabled="">取消</button>',
    );
    expect(html).toContain(
      '<button type="submit" class="button button-primary" disabled="">保存中…</button>',
    );
  });

  it('字段上限、占位与说明文案固定', () => {
    const html = render();

    expect(controlByPlaceholder(html, '例如：旧徽章的纹章')).toContain('maxLength="120"');
    expect(controlByPlaceholder(html, '例如：旧徽章的纹章')).toContain('required=""');
    expect(controlByPlaceholder(html, '例如：王室徽记')).toContain('value=""');

    expect(controlByPlaceholder(html, '给写作者看的一句话提醒')).toContain(
      'maxLength="2000"',
    );
    expect(controlByPlaceholder(html, '可留空')).toContain('inputMode="numeric"');
    expect(controlByPlaceholder(html, '可留空；填写后用于逾期判断')).toContain(
      'inputMode="numeric"',
    );

    const note = controlByPlaceholder(html, '记录伏笔的具体内容、线索和注意事项');
    expect(html).toContain('<span>伏笔说明</span>');
    expect(note).toContain('rows="3"');
    expect(note).toContain('maxLength="10000"');
    expect(html).toContain(
      '创建与编辑只写入草稿；发布后才会进入提醒与报告。已回收/已放弃状态必须填写说明，服务端会校验。',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet">取消</button>',
    );
  });

  it('作品没有章节时埋设章节保持未选', () => {
    const html = render({ chapters: [] });

    const seed = selectBlock(html, '<span>埋设章节</span>');
    expect(seed).toContain('<option value="" selected="">请选择章节</option>');
    expect(seed).not.toContain('第 1 章');
    const source = selectBlock(html, '<span>来源章节（可选）</span>');
    expect(source).toContain('<option value="" selected="">不关联章节</option>');
    expect(source).not.toContain('第 1 章');
  });
});
