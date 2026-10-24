import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  BillingBreakdownView,
  BillingBudgetState,
  BillingBudgetUsageView,
  BillingProviderPriceView,
  BillingReportResponse,
  BillingUnknownCallView,
  MeResponse,
} from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import { BillingPanel } from './BillingPanel.js';

const ME = (role: HumanRole): MeResponse => ({
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role,
});

function usage(overrides: Partial<BillingBudgetUsageView> = {}): BillingBudgetUsageView {
  return {
    state: 'ok',
    currency: 'CNY',
    monthlyLimit: 5000,
    knownSpent: 1.2345,
    reserved: 0.5,
    remaining: 4998.2655,
    unknownGenerationCalls: 2,
    otherCurrencyGenerationCalls: 1,
    note: '本月费用仍在预算内。',
    ...overrides,
  };
}

function breakdown(overrides: Partial<BillingBreakdownView> = {}): BillingBreakdownView {
  return {
    key: 'chapter_generation',
    label: '章节生成',
    detail: '第 12 章 · 初稿',
    costs: [
      { currency: 'CNY', knownCost: 0.1234, calls: 7, reservedCost: 0.0042, activeCalls: 2 },
      { currency: 'USD', knownCost: 0.5, calls: 1, reservedCost: 0, activeCalls: 0 },
    ],
    unknownCalls: 3,
    ...overrides,
  };
}

function provider(overrides: Partial<BillingProviderPriceView> = {}): BillingProviderPriceView {
  return {
    id: 'prov-1',
    name: 'Atria',
    model: 'atria-chat-1',
    purpose: 'chat',
    isEnabled: true,
    priority: 10,
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    priceCurrency: 'CNY',
    pricingStatus: 'complete',
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function unknownCall(overrides: Partial<BillingUnknownCallView> = {}): BillingUnknownCallView {
  return {
    id: 'call-1',
    createdAt: '2026-10-23T18:07:00.000Z',
    purpose: 'chapter_generation',
    purposeLabel: '章节生成',
    providerName: null,
    model: 'stub-model',
    status: 'failed',
    errorCode: null,
    actorName: null,
    chapterId: null,
    chapterNumber: 12,
    chapterTitle: '旧城',
    jobId: null,
    ...overrides,
  };
}

function report(overrides: Partial<BillingReportResponse> = {}): BillingReportResponse {
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
    budgetUsage: usage(),
    providers: [provider()],
    totals: [
      { currency: 'CNY', knownCost: 0.1234, calls: 7, reservedCost: 0.01, activeCalls: 2 },
      { currency: 'USD', knownCost: 0.5, calls: 3, reservedCost: 0, activeCalls: 0 },
    ],
    totalCalls: 42,
    unknownCallTotal: 3,
    blockedCallTotal: 1,
    byPurpose: [breakdown()],
    byMember: [],
    byJob: [],
    byChapter: [],
    unknownCalls: [unknownCall()],
    ...overrides,
  };
}

function render(options: {
  role?: HumanRole;
  value?: BillingReportResponse;
  loaded?: boolean;
  billsLoaded?: boolean;
} = {}): string {
  const { role = 'owner', value = report(), loaded = true, billsLoaded = true } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) client.setQueryData(['billingReport'], value);
  if (billsLoaded) client.setQueryData(['providerBills'], { bills: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BillingPanel me={ME(role)} />
    </QueryClientProvider>,
  );
}

describe('BillingPanel', () => {
  it('缓存缺失时只报正在读取，不画任何卡片', () => {
    const html = render({ loaded: false, billsLoaded: false });

    expect(html).toContain('正在读取本月计费报表……');
    expect(html).not.toContain('归属报表');
    expect(html).not.toContain('生成预算闸门');
    expect(html).not.toContain('费用归属');
    expect(html).not.toContain('服务商价格');
    expect(html).not.toContain('费用未知的调用');
  });

  it('汇总卡按币种分别合计已计与预留，事实行与统计窗口如实', () => {
    const html = render();

    expect(html).toContain('归属报表 · 2026-10');
    expect(html).toContain('生成于 10/23 18:07 · 每 20 秒刷新');
    expect(html).toContain('<span>CNY 估算总额</span>');
    expect(html).toContain('<strong>¥0.1334</strong>');
    expect(html).toContain('已计 ¥0.1234 · 预留 ¥0.0100');
    expect(html).toContain('7 次已计调用 · 2 次进行中');
    expect(html).toContain('<span>USD 估算总额</span>');
    expect(html).toContain('<strong>US$0.5000</strong>');
    expect(html).toContain('已计 US$0.5000 · 预留 US$0.0000');
    expect(html.match(/3 次已计调用/g)?.length).toBe(1);
    expect(html).not.toContain('3 次已计调用 ·');
    expect(html).toContain('总调用记录 42');
    expect(html).toContain('费用未知 3');
    expect(html).toContain('预算阻断 1');
    expect(html).toContain('统计窗口：10/01 00:00 至 11/01 00:00（服务器本地自然月）');
    expect(html).toContain('阻断调用不产生费用，也不计入上方费用合计。');
  });

  it('预算四态各说各话，上限与剩余为空时不下结论', () => {
    const cases: Array<{ state: BillingBudgetState; label: string; tone: string }> = [
      { state: 'not_configured', label: '未设置预算', tone: 'muted' },
      { state: 'ok', label: '额度正常', tone: 'green' },
      { state: 'exhausted', label: '额度耗尽', tone: 'red' },
      { state: 'unpriced_calls', label: '存在未定价调用', tone: 'amber' },
    ];
    for (const item of cases) {
      const html = render({
        value: report({
          budget: { monthlyLimit: null, currency: 'CNY', updatedAt: null, updatedBy: null },
          budgetUsage: usage({
            state: item.state,
            monthlyLimit: null,
            remaining: null,
            note: `${item.label}的说明。`,
          }),
        }),
      });
      expect(html).toContain(`badge badge-${item.tone}">${item.label}</span>`);
      expect(html).toContain('月度上限</span><strong>未设置</strong>');
      expect(html).toContain('剩余额度</span><strong>—</strong>');
      expect(html).toContain(`${item.label}的说明。`);
      expect(html).not.toContain('最近更新：');
    }
  });

  it('预算卡片对所有者与计费管理员开放编辑，对主笔只读', () => {
    const owner = render({ role: 'owner' });
    expect(owner).toContain('保存预算');
    expect(owner).toContain('清除预算');
    expect(owner).toContain('placeholder="留空表示不设预算"');
    expect(owner).toContain('最近更新：林默 · 10/22 09:30');
    expect(owner).not.toContain('计费报表对所有所有者、主笔与计费管理员可见');

    const billing = render({ role: 'billing' });
    expect(billing).toContain('保存预算');

    const lead = render({ role: 'lead' });
    expect(lead).not.toContain('保存预算');
    expect(lead).not.toContain('清除预算');
    expect(lead).not.toContain('placeholder="留空表示不设预算"');
    expect(lead).toContain('计费报表对所有所有者、主笔与计费管理员可见');

    const unset = render({
      value: report({ budget: { monthlyLimit: null, currency: 'USD', updatedAt: null, updatedBy: null } }),
    });
    expect(unset).not.toContain('清除预算');
    expect(unset).toContain('保存预算');
  });

  it('拆分表默认按用途，逐行给出费用、进行中后缀与未知次数徽标', () => {
    const html = render();

    expect(html.match(/billing-tab is-active/g)?.length).toBe(1);
    expect(html).toContain('按用途');
    expect(html).toContain('按成员');
    expect(html).toContain('按作业');
    expect(html).toContain('按章节');
    expect(html).toContain('<strong>章节生成</strong>');
    expect(html).toContain('<span class="billing-row-detail">第 12 章 · 初稿</span>');
    expect(html).toContain('¥0.1234');
    expect(html).toContain('进行中预留 ¥0.0042');
    expect(html).toContain('US$0.5000');
    expect(html).toContain('8 + 2 进行中');
    expect(html).toContain('badge badge-amber">3 次</span>');

    const zero = render({
      value: report({
        byPurpose: [
          breakdown({
            detail: null,
            costs: [{ currency: 'CNY', knownCost: 0, calls: 0, reservedCost: 0, activeCalls: 0 }],
            unknownCalls: 0,
          }),
        ],
      }),
    });
    expect(zero).toContain('<span class="muted">—</span>');
    expect(zero).not.toContain('<small>进行中预留');
    expect(zero).not.toContain(' 进行中</td>');
    expect(zero).not.toContain('badge-amber">0 次');
  });

  it('四个维度都为空时只说本月暂无记录', () => {
    const html = render({
      value: report({ byPurpose: [], byMember: [], byJob: [], byChapter: [] }),
    });

    expect(html.match(/本月暂无记录。<\/p>/g)?.length).toBe(1);
    expect(html).not.toContain('billing-money-list');
  });

  it('价表逐行标注启用、用途与完整度，所有者可改价，主笔只读', () => {
    const html = render();

    expect(html).toContain('<strong>Atria</strong>');
    expect(html).toContain('badge badge-green">已启用</span>');
    expect(html).toContain('badge badge-neutral">生成</span>');
    expect(html).toContain('badge badge-green">价表完整</span>');
    expect(html).toContain('atria-chat-1');
    expect(html).toContain('当前：输入 ¥0.50 / 百万 tokens · 输出 ¥1.50 / 百万 tokens');
    expect(html.match(/保存价表/g)?.length).toBe(1);
    expect(html.match(/placeholder="留空即未填写"/g)?.length).toBe(2);
    expect(html).toContain('<option value="CNY" selected="">CNY</option>');

    const embed = render({
      value: report({
        providers: [
          provider({
            id: 'prov-2',
            name: 'Ollama',
            model: 'bge-m3',
            purpose: 'embedding',
            isEnabled: false,
            promptPricePer1m: null,
            completionPricePer1m: null,
            pricingStatus: 'incomplete',
          }),
        ],
      }),
    });
    expect(embed).toContain('badge badge-muted">已停用</span>');
    expect(embed).toContain('badge badge-neutral">嵌入</span>');
    expect(embed).toContain('badge badge-amber">价表不完整</span>');
    expect(embed).toContain('当前：输入 未填写 · 嵌入仅按输入计价');
    expect(embed.match(/placeholder="留空即未填写"/g)?.length).toBe(1);

    const lead = render({ role: 'lead' });
    expect(lead).not.toContain('保存价表');
    expect(lead).not.toContain('placeholder="留空即未填写"');
    expect(lead).toContain('当前：输入 ¥0.50 / 百万 tokens');

    const none = render({ value: report({ providers: [] }) });
    expect(none).toContain('尚未登记模型服务商。');
    expect(none).toContain('<option value="" selected="">尚无服务商</option>');
  });

  it('费用未知的调用逐列兜底，缺章节与缺错误码不猜测', () => {
    const html = render({
      value: report({
        unknownCalls: [
          unknownCall(),
          unknownCall({
            id: 'call-2',
            chapterNumber: null,
            chapterId: 'abcdef1234567890',
            errorCode: 'MODEL_TIMEOUT',
            providerName: 'Atria',
            actorName: '沈舟',
          }),
          unknownCall({
            id: 'call-3',
            chapterNumber: null,
            chapterId: null,
            status: 'blocked',
            model: 'mystery',
          }),
        ],
      }),
    });

    expect(html.match(/<td class="mono">10\/23 18:07<\/td>/g)?.length).toBe(3);
    expect(html.match(/<td>章节生成<\/td>/g)?.length).toBe(3);
    expect(html.match(/未绑定服务商/g)?.length).toBe(2);
    expect(html.match(/系统 \/ 未绑定成员/g)?.length).toBe(2);
    expect(html).toContain('<strong>Atria</strong>');
    expect(html).toContain('沈舟');
    expect(html).toContain('<td>第12章</td>');
    expect(html).toContain('<td>abcdef12</td>');
    expect(html).toContain('<td>—</td>');
    expect(html).toContain('>failed</td>');
    expect(html).toContain('>MODEL_TIMEOUT</td>');
    expect(html).toContain('>blocked</td>');
    expect(html).toContain('仅列出最近 50 条；总额未估算。');
    expect(html).toContain('系统不会猜测费用');

    const empty = render({ value: report({ unknownCalls: [] }) });
    expect(empty).toContain('本月没有费用未知的调用。');
  });

  it('供应商账单卡片随面板渲染，未导入时给出空态而不留白', () => {
    const html = render();

    expect(html).toContain('供应商账单');
    expect(html).toContain('发票导入与估算对账');
    expect(html).toContain('账单金额来自人工导入');
    expect(html).toContain('尚未导入供应商账单。');
    expect(html).toContain('选择一张账单查看逐模型对账结果。');
    expect(html).toContain('>导入账单</button>');

    const lead = render({ role: 'lead' });
    expect(lead).not.toContain('>导入账单</button>');
    expect(lead).toContain('计费管理员与所有者可以导入供应商账单');

    const loading = render({ billsLoaded: false });
    expect(loading).toContain('正在读取账单……');
  });

  it('两项合计都为空时各自给出空态', () => {
    const html = render({
      value: report({ totals: [], byPurpose: [], unknownCalls: [] }),
    });

    expect(html).toContain('本月暂无已计费调用。');
    expect(html).not.toContain('估算总额</span>');
    expect(html).toContain('本月没有费用未知的调用。');
  });
});
