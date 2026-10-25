import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { BillingReportResponse, MeResponse } from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import { BillingDialog } from './BillingDialog.js';

const ME = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role: 'owner' as HumanRole,
  ...overrides,
});

function report(): BillingReportResponse {
  return {
    workspaceId: 'ws-1',
    month: '2026-10',
    rangeStart: '2026-10-01T00:00:00.000Z',
    rangeEnd: '2026-11-01T00:00:00.000Z',
    generatedAt: '2026-10-23T18:07:00.000Z',
    budget: {
      monthlyLimit: 5000,
      currency: 'CNY',
      updatedAt: '2026-10-22T09:30:00.000Z',
      updatedBy: { id: 'user-1', name: '林默', email: 'lin@example.com' },
    },
    budgetUsage: {
      state: 'ok',
      currency: 'CNY',
      monthlyLimit: 5000,
      knownSpent: 1.2345,
      reserved: 0.5,
      remaining: 4998.2655,
      unknownGenerationCalls: 0,
      otherCurrencyGenerationCalls: 0,
      note: '本月费用仍在预算内。',
    },
    providers: [],
    totals: [],
    totalCalls: 0,
    unknownCallTotal: 0,
    blockedCallTotal: 0,
    byPurpose: [],
    byMember: [],
    byJob: [],
    byChapter: [],
    unknownCalls: [],
  };
}

function render(options: { loaded?: boolean; me?: MeResponse } = {}): string {
  const { loaded = true, me = ME() } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) {
    client.setQueryData(['billingReport'], report());
    client.setQueryData(['providerBills'], { bills: [] });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BillingDialog me={me} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('BillingDialog', () => {
  it('弹窗骨架与计费面板嵌在同一个对话里', () => {
    const html = render();

    expect(html.startsWith('<div class="modal-backdrop">')).toBe(true);
    expect(html).toContain('class="modal modal-billing"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="billing-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<header class="modal-head">');
    expect(html).toContain('<div class="modal-body billing-modal-body">');
    expect(html).not.toContain('modal-foot');
  });

  it('眉标带工作区名，标题写「归属报表与预算」', () => {
    expect(render()).toContain('<p class="eyebrow">云说工坊 · 计费</p>');
    expect(
      render({ me: ME({ workspace: { id: 'ws-2', name: '夜航工作室', settingsVersion: 3, ledgerVersion: 2 } }) }),
    ).toContain('<p class="eyebrow">夜航工作室 · 计费</p>');
    expect(render()).toContain('<h2 id="billing-title">归属报表与预算</h2>');
  });

  it('只有一个关闭按钮，挂在头部', () => {
    const html = render();
    expect(html.match(/>关闭</g)?.length).toBe(1);
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
  });

  it('报表缓存就绪时正文是计费面板，不是空壳', () => {
    const html = render();
    expect(html).toContain('归属报表 · 2026-10');
    expect(html).toContain('生成预算闸门');
    expect(html).toContain('<form class="billing-budget-form">');
  });

  it('报表未就绪时面板的读取态仍包在弹窗内', () => {
    const html = render({ loaded: false });
    expect(html).toContain('<div class="modal-body billing-modal-body">');
    expect(html).toContain('正在读取本月计费报表……');
    expect(html).not.toContain('归属报表 · 2026-10');
  });
});
