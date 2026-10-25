import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  MeResponse,
  ModelProviderListResponse,
  ModelProviderView,
} from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import { ApiError } from '../api.js';
import { ProviderSettingsDialog } from './ProviderSettingsDialog.js';

const ME = (role: HumanRole = 'owner'): MeResponse => ({
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role,
});

function provider(overrides: Partial<ModelProviderView> = {}): ModelProviderView {
  return {
    id: 'prov-1',
    name: '本机 llama.cpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3-14b',
    purpose: 'chat',
    isEnabled: true,
    priority: 20,
    promptPricePer1m: 1.5,
    completionPricePer1m: 6,
    priceCurrency: 'CNY',
    hasKey: true,
    keyHint: '…abcd',
    lastTest: {
      status: 'ok',
      message: '连接正常，模型可用。',
      latencyMs: 128,
      testedAt: '2026-10-23T18:07:00.000Z',
    },
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function list(
  providers: ModelProviderView[],
  secretSource: 'dedicated' | 'session' = 'dedicated',
): ModelProviderListResponse {
  return { providers, keyEncryption: { algorithm: 'aes-256-gcm', secretSource } };
}

function render(
  options: {
    role?: HumanRole;
    providers?: ModelProviderView[];
    secretSource?: 'dedicated' | 'session';
    loaded?: boolean;
  } = {},
): string {
  const { role = 'owner', providers = [], secretSource = 'dedicated', loaded = true } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) {
    client.setQueryData(['modelProviders'], list(providers, secretSource));
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProviderSettingsDialog me={ME(role)} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

function renderWithError(message: string): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  // 有缓存数据时查询不会被判定为 stale，挂载时才不会立刻重取、把错误态冲回读取态。
  client.setQueryData(['modelProviders'], list([]));
  client
    .getQueryCache()
    .find({ queryKey: ['modelProviders'] })
    ?.setState({
      status: 'error',
      fetchStatus: 'idle',
      error: new ApiError(500, 'INTERNAL', message),
    });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProviderSettingsDialog me={ME()} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ProviderSettingsDialog', () => {
  it('弹窗外壳、眉标与标题', () => {
    const html = render();

    expect(html.startsWith('<div class="modal-backdrop">')).toBe(true);
    expect(html).toContain('class="modal modal-provider"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="provider-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<header class="modal-head">');
    expect(html).toContain('<p class="eyebrow">工作区设置 · 仅登记与测试</p>');
    expect(html).toContain('<h2 id="provider-title">模型服务商</h2>');
    expect(html).toContain('<footer class="modal-foot">');
    expect(html.match(/>关闭</g)?.length).toBe(2);
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<button type="button" class="button button-quiet">关闭</button>');
  });

  it('正文开头写明服务商用途与数据发送范围', () => {
    const html = render();

    expect(html).toContain('<p class="provider-intro">');
    expect(html).toContain('这里登记 OpenAI 兼容端点、用途、路由顺序与计价。');
    expect(html).toContain('聊天服务商用于生成正文， 按优先级路由');
    expect(html).toContain('会把正典片段和检索查询发送到该端点');
  });

  it('配置未读到时只显示读取态，不渲染列表头与加密说明', () => {
    const html = render({ loaded: false });

    expect(html).toContain('<p class="empty-state">正在读取服务商配置……</p>');
    expect(html).not.toContain('provider-list-head');
    expect(html).not.toContain('provider-encryption-note');
    expect(html).not.toContain('新增服务商');
  });

  it('读取失败时把错误原文放在读取位的错误框里', () => {
    const html = renderWithError('读取服务商配置失败');

    expect(html).toContain('<div class="modal-error">');
    expect(html).toContain('读取失败：读取服务商配置失败');
    expect(html).not.toContain('empty-state');
    expect(html).not.toContain('provider-list-head');
  });

  it('所有者看空列表：新增入口、空态说明与加密说明都在', () => {
    const html = render();

    expect(html).toContain('<h3>已登记 0 个服务商</h3>');
    expect(html).toContain('仅所有者可新增、修改与删除。');
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">新增服务商</button>',
    );
    expect(html).toContain('<div class="provider-empty">');
    expect(html).toContain('尚未登记模型服务商。');
    expect(html).toContain('先准备一个 OpenAI 兼容端点（llama.cpp、Ollama、vLLM 或远程 API），');
    expect(html).toContain('再填写基础地址、模型 ID 与 API Key。');
    expect(html).toContain('<div class="provider-encryption-note">');
    expect(html).toContain('密钥保护：AES-256-GCM · 使用 MODEL_KEY_SECRET');
    expect(html).toContain('连接测试不消耗生成额度。');
    expect(html).not.toContain('SESSION_SECRET');
    expect(html).not.toContain('provider-card');
  });

  it('非所有者只读：没有新增与编辑删除入口', () => {
    const html = render({ role: 'author' });

    expect(html).toContain('当前身份只读；所有者可修改配置。');
    expect(html).not.toContain('新增服务商');
    expect(html).not.toContain('>编辑<');
    expect(html).not.toContain('>删除<');
    expect(html).not.toContain('>测试连接<');
    expect(html).toContain('尚未登记模型服务商。');
  });

  it('聊天服务商卡片：徽标、连接结果与双边价表', () => {
    const html = render({ providers: [provider()] });

    expect(html).toContain('<h3>已登记 1 个服务商</h3>');
    expect(html).toContain('<li class="provider-card">');
    expect(html).toContain('<div class="provider-badges">');
    expect(html).toContain('<div class="provider-test-line">');
    expect(html).toContain('<p class="provider-price-line">');
    expect(html).toContain('<h4>本机 llama.cpp</h4>');
    expect(html).toContain('<code>http://127.0.0.1:8080/v1</code>');
    expect(html).toContain('<code>qwen3-14b</code>');
    expect(html).toContain('<span class="badge badge-neutral">聊天生成</span>');
    expect(html).toContain('<span class="badge badge-green">已启用</span>');
    expect(html).toContain('<span class="badge badge-neutral">优先级 20</span>');
    expect(html).toContain('<span class="badge badge-ink">密钥 …abcd</span>');
    expect(html).toContain('<span class="badge badge-green">连接正常</span>');
    expect(html).toContain('连接正常，模型可用。');
    expect(html).toContain('<span class="muted">10/23 18:07 · 128ms</span>');
    expect(html).toContain('价表：输入 ¥1.5 / 输出 ¥6 · 每百万 token');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small">测试连接</button>',
    );
    expect(html.match(/>编辑</g)?.length).toBe(1);
    expect(html.match(/>删除</g)?.length).toBe(1);
    expect(html).not.toContain('确认删除？');
    expect(html).not.toContain('disabled');
  });

  it('嵌入服务商卡片：停用、无密钥、未测试与单边价表', () => {
    const html = render({
      providers: [
        provider({
          id: 'prov-2',
          name: '本机 Ollama 嵌入',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'bge-m3',
          purpose: 'embedding',
          isEnabled: false,
          promptPricePer1m: 0.02,
          completionPricePer1m: null,
          priceCurrency: 'USD',
          hasKey: false,
          keyHint: null,
          lastTest: null,
          priority: 300,
        }),
      ],
    });

    expect(html).toContain('<span class="badge badge-ink">嵌入检索</span>');
    expect(html).toContain('<span class="badge badge-muted">已停用</span>');
    expect(html).toContain('<span class="badge badge-neutral">无密钥</span>');
    expect(html).toContain('<span class="badge badge-neutral">优先级 300</span>');
    expect(html).toContain('<span class="muted">尚未测试连接。</span>');
    expect(html).not.toContain('badge-green');
    expect(html).toContain('嵌入价表：输入 $0.02 · 每百万 token；');
    expect(html).toContain('会把正典片段发送到该端点。');
    expect(html).not.toContain('输出 $');
  });

  it('价表缺失与连接失败：未知成本文案、红徽标与不带耗时的测试时间', () => {
    const html = render({
      providers: [
        provider({
          id: 'prov-3',
          name: '单边价聊天',
          promptPricePer1m: 0.02,
          completionPricePer1m: null,
          priceCurrency: 'USD',
          keyHint: null,
        }),
        provider({
          id: 'prov-4',
          name: '待探测嵌入',
          purpose: 'embedding',
          promptPricePer1m: null,
          completionPricePer1m: null,
          hasKey: false,
          keyHint: null,
          lastTest: {
            status: 'failed',
            message: '连接超时。',
            latencyMs: null,
            testedAt: '2026-10-23T18:07:00.000Z',
          },
        }),
      ],
    });

    expect(html).toContain('未配置价表；生成成本将显示为未知。');
    expect(html).toContain(
      '未配置嵌入输入价；索引成本将显示为未知。会把正典片段发送到该端点。',
    );
    expect(html).toContain('密钥 已保存');
    expect(html).toContain('<span class="badge badge-red">连接失败</span>');
    expect(html).toContain('连接超时。');
    expect(html).toContain('<span class="muted">10/23 18:07</span>');
    expect(html).not.toContain('18:07 · null');
  });

  it('会话密钥来源时额外标注派生来源与生产建议', () => {
    const session = render({ secretSource: 'session' });
    expect(session).toContain('密钥保护：AES-256-GCM · 当前从 SESSION_SECRET 派生加密密钥');
    expect(session).toContain(
      '生产部署请在 .env 设置独立的 MODEL_KEY_SECRET；轮换该密钥后需重新录入 API Key。',
    );

    const dedicated = render({ secretSource: 'dedicated' });
    expect(dedicated).not.toContain('生产部署请在 .env');
  });
});
