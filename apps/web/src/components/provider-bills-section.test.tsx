import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BillingProviderPriceView,
  ProviderBillStatus,
  ProviderBillView,
} from '@yunshuo/contracts';
import { ProviderBillsSection } from './ProviderBillsSection.js';

function priceProvider(overrides: Partial<BillingProviderPriceView> = {}): BillingProviderPriceView {
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

function bill(status: ProviderBillStatus, overrides: Partial<ProviderBillView> = {}): ProviderBillView {
  return {
    id: `bill-${status}`,
    providerId: 'prov-1',
    providerName: 'Atria',
    invoiceNo: `INV-${status}`,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    currency: 'CNY',
    declaredTotal: 99,
    linesTotal: 12.5,
    lineCount: 12,
    status,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    importedBy: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function render(options: {
  providers?: BillingProviderPriceView[];
  bills?: ProviderBillView[];
  canManage?: boolean;
  loaded?: boolean;
} = {}): string {
  const {
    providers = [priceProvider()],
    bills = [],
    canManage = true,
    loaded = true,
  } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) client.setQueryData(['providerBills'], { bills });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProviderBillsSection providers={providers} canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe('ProviderBillsSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T18:07:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('账单缓存缺失时只报读取中，表单与列表标题仍在', () => {
    const html = render({ loaded: false });

    expect(html).toContain('发票导入与估算对账');
    expect(html).toContain('正在读取账单……');
    expect(html).not.toContain('尚未导入供应商账单。');
    expect(html).toContain('已导入账单');
    expect(html).toContain('选择一张账单查看逐模型对账结果。');
  });

  it('导入表单默认本月账期、首个服务商币种与 CSV 口径', () => {
    const html = render();

    expect(html).toContain('<option value="prov-1" selected="">Atria · 生成</option>');
    expect(html).toContain('placeholder="供应商账单唯一编号"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('<input type="date" value="2026-10-01"/>');
    expect(html).toContain('<input type="date" value="2026-10-31"/>');
    expect(html).toContain('<option value="CNY" selected="">CNY</option>');
    expect(html).toContain('placeholder="留空表示账单只提供明细"');
    expect(html).toContain('accept=".csv,text/csv"');
    expect(html).toContain(
      'placeholder="model,input_tokens,output_tokens,amount,note\nstub-model,120000,80000,12.345678,10月生成"',
    );
    expect(html).toContain('表头必须是 <code>model,input_tokens,output_tokens,amount,note</code>');
    expect(html).toContain('CSV 只用于本次导入，不会写入服务商配置或调用记录。');
    expect(html).toContain('>导入账单</button>');
  });

  it('服务商下拉带用途，首个服务商的币种成为表单默认值', () => {
    const html = render({
      providers: [
        priceProvider({ id: 'prov-usd', name: 'OpenAI', purpose: 'chat', priceCurrency: 'USD' }),
        priceProvider({ id: 'prov-2', name: 'Ollama', model: 'bge-m3', purpose: 'embedding' }),
      ],
    });

    expect(html).toContain('<option value="prov-usd" selected="">OpenAI · 生成</option>');
    expect(html).toContain('<option value="prov-2">Ollama · 嵌入</option>');
    expect(html).toContain('<option value="USD" selected="">USD</option>');
    expect(html).not.toContain('尚无服务商');

    const none = render({ providers: [] });
    expect(none).toContain('<option value="" selected="">尚无服务商</option>');
  });

  it('账单列表逐张给出状态、行数、金额与可选的复核说明', () => {
    const html = render({
      bills: [
        bill('imported'),
        bill('reviewed', {
          id: 'bill-reviewed',
          declaredTotal: null,
          reviewNote: '金额待供应商确认',
          reviewedBy: { id: 'user-1', name: '林默', email: 'lin@example.com' },
          reviewedAt: '2026-10-20T10:00:00.000Z',
        }),
        bill('disputed', {
          id: 'bill-disputed',
          providerName: 'Ollama',
          currency: 'USD',
          declaredTotal: 5,
          linesTotal: 4.25,
          lineCount: 3,
        }),
      ],
    });

    expect(html.match(/class="billing-bill-item"/g)?.length).toBe(3);
    expect(html.match(/badge badge-amber">待复核/g)?.length).toBe(1);
    expect(html.match(/badge badge-green">已复核/g)?.length).toBe(1);
    expect(html.match(/badge badge-red">有争议/g)?.length).toBe(1);
    expect(html.match(/INV-/g)?.length).toBe(3);
    expect(html.match(/<strong>Atria<\/strong>/g)?.length).toBe(2);
    expect(html.match(/<strong>Ollama<\/strong>/g)?.length).toBe(1);
    expect(html.match(/12 行/g)?.length).toBe(2);
    expect(html).toContain('3 行');
    expect(html).toContain('¥12.50');
    expect(html).toContain('¥99.00');
    expect(html).toContain('· 账单未提供总额');
    expect(html.match(/账单总额 ¥/g)?.length).toBe(1);
    expect(html).toContain('US$4.25');
    expect(html).toContain('账单总额 US$5.00');
    expect(html).toContain('复核说明：金额待供应商确认');
    expect(html.match(/复核说明：/g)?.length).toBe(1);
    expect(html).toContain('选择一张账单查看逐模型对账结果。');
  });

  it('主笔只能看历史账单与只读说明，导入与复核表单都不出现', () => {
    const html = render({
      canManage: false,
      bills: [bill('reviewed', { reviewNote: '已核对' })],
    });

    expect(html).not.toContain('>导入账单</button>');
    expect(html).not.toContain('placeholder="供应商账单唯一编号"');
    expect(html).not.toContain('type="file"');
    expect(html).toContain('计费管理员与所有者可以导入供应商账单；主笔可查看历史账单与对账结果。');
    expect(html).toContain('INV-reviewed');
    expect(html).toContain('已导入账单');
    expect(html).toContain('选择一张账单查看逐模型对账结果。');
  });

  it('没有账单时只说尚未导入，不伪造对账区', () => {
    const html = render();

    expect(html).toContain('尚未导入供应商账单。');
    expect(html).not.toContain('billing-bill-detail');
    expect(html).not.toContain('账单明细合计');
    expect(html).not.toContain('保存复核');
  });
});
