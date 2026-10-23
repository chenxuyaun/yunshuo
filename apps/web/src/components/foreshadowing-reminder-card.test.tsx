import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  LedgerChapterRef,
  LedgerForeshadowingReminderItem,
  LedgerForeshadowingReminders,
} from '@yunshuo/contracts';
import { ForeshadowingReminderCard } from './ForeshadowingReminderCard.js';

const CHAPTER_ID = 'chapter-5';

function ref(overrides: Partial<LedgerChapterRef> = {}): LedgerChapterRef {
  return { id: 'chapter-2', number: 2, title: '铜钉', ...overrides };
}

function reminder(
  overrides: Partial<LedgerForeshadowingReminderItem> = {},
): LedgerForeshadowingReminderItem {
  return {
    id: 'reminder-1',
    workId: 'work-1',
    name: '铜钉',
    summary: '井底刻着铜钉',
    note: '',
    versionNo: 2,
    reason: 'in_window',
    message: '本章进入计划回收窗口',
    state: 'planted',
    importance: 'high',
    seedChapter: ref(),
    payoffChapterMin: 20,
    payoffChapterMax: 24,
    payoffChapter: null,
    resolutionNote: '',
    latestCanonChapter: { id: 'chapter-3', number: 3, title: '出发' },
    overdue: false,
    overdueBy: null,
    basis: 'current',
    ...overrides,
  };
}

function data(overrides: Partial<LedgerForeshadowingReminders> = {}): LedgerForeshadowingReminders {
  return {
    chapterId: CHAPTER_ID,
    chapter: { id: CHAPTER_ID, number: 5, title: '夜行' },
    latestCanonChapter: { id: 'chapter-3', number: 3, title: '出发' },
    reminders: [],
    note: '只提示计划窗口，不改变伏笔状态。',
    ...overrides,
  };
}

function render(value: LedgerForeshadowingReminders | null): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (value) {
    client.setQueryData(['foreshadowingReminders', CHAPTER_ID], value);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ForeshadowingReminderCard chapterId={CHAPTER_ID} />
    </QueryClientProvider>,
  );
}

describe('ForeshadowingReminderCard', () => {
  it('没有缓存时只说在读取，不显示条数徽标', () => {
    const html = render(null);
    expect(html).toContain('正在读取已发布伏笔台账……');
    expect(html).not.toContain('class="badge');
  });

  it('没有提醒时显示 0 条、正典进度与两处说明', () => {
    const html = render(data());
    expect(html).toContain('badge-muted">0 条<');
    expect(html).toContain('本章为第 5 章；当前正典已到第 3 章 · 出发。');
    expect(html.split('只提示计划窗口，不改变伏笔状态。').length - 1).toBe(2);
    expect(html).not.toContain('foreshadowing-reminder-list');
  });

  it('还没有正典章节时如实说明', () => {
    const html = render(data({ latestCanonChapter: null, note: '当前没有可提醒的伏笔。' }));
    expect(html).toContain('本章为第 5 章；当前还没有正典章节。');
    expect(html).toContain('当前没有可提醒的伏笔。');
  });

  it('逾期与进入窗口用不同徽标，并给出状态、重要度与计划窗口', () => {
    const html = render(
      data({
        reminders: [
          reminder({ id: 'r-1', reason: 'overdue', name: '铜钉' }),
          reminder({
            id: 'r-2',
            reason: 'in_window',
            name: '断桥',
            state: 'reinforced',
            importance: 'low',
            message: '本章仍在回收窗口内',
            note: '本章只写到离镇',
          }),
        ],
      }),
    );
    expect(html).toContain('badge-amber">2 条<');
    expect(html).toContain('foreshadowing-reminder-overdue');
    expect(html).toContain('badge-red">已逾期<');
    expect(html).toContain('badge-amber">进入回收窗口<');
    expect(html).toContain('已埋设');
    expect(html).toContain('已强化');
    expect(html).toContain('重要度 高');
    expect(html).toContain('重要度 低');
    expect(html).toContain('本章进入计划回收窗口');
    expect(html).toContain('本章仍在回收窗口内');
    expect(html).toContain('埋设于第 2 章 · 铜钉 · 计划回收 第 20–24 章');
    expect(html).toContain('本章只写到离镇');
    expect(html.split('foreshadowing-reminder-text').length - 1).toBe(1);
  });

  it('计划窗口四种形状各自成句', () => {
    const html = render(
      data({
        reminders: [
          reminder({ id: 'r-1', name: '甲', payoffChapterMin: 30, payoffChapterMax: null }),
          reminder({ id: 'r-2', name: '乙', payoffChapterMin: null, payoffChapterMax: 24 }),
          reminder({ id: 'r-3', name: '丙', payoffChapterMin: null, payoffChapterMax: null }),
          reminder({ id: 'r-4', name: '丁', payoffChapterMin: 20, payoffChapterMax: 24 }),
        ],
      }),
    );
    expect(html).toContain('计划回收 第 30 章起');
    expect(html).toContain('计划回收 第 24 章前');
    expect(html).toContain('计划回收 未设置计划窗口');
    expect(html).toContain('计划回收 第 20–24 章');
    expect(html).toContain('badge-amber">4 条<');
  });
});
