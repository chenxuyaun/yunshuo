import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { InvitePreviewResponse, MeResponse } from '@yunshuo/contracts';
import { ApiError } from '../api.js';
import { InviteAcceptScreen } from './InviteAcceptScreen.js';

const TOKEN = 'invite-token-123';

function preview(overrides: Partial<InvitePreviewResponse> = {}): InvitePreviewResponse {
  return {
    workspaceName: '雾港',
    email: 'lin@example.com',
    role: 'lead',
    expiresAt: '2026-10-30T18:07:00.000Z',
    accountExists: false,
    ...overrides,
  };
}

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
    workspace: { id: 'work-1', name: '雾港', settingsVersion: 1, ledgerVersion: 1 },
    role: 'author',
    ...overrides,
  };
}

function setQueryError(client: QueryClient, queryKey: string[], error: Error): void {
  const query = client.getQueryCache().build(client, { queryKey });
  query.setState({ status: 'error', error, fetchStatus: 'idle', errorUpdatedAt: Date.now() });
}

function render(options: {
  preview?: InvitePreviewResponse;
  previewError?: Error;
  me?: MeResponse | null;
} = {}): string {
  const client = new QueryClient({
    // SSR 没有已挂载的 observer；retryOnMount 默认 true 会把预置的错误态改回 pending。
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  if (options.preview) client.setQueryData(['invitePreview', TOKEN], options.preview);
  if (options.previewError) setQueryError(client, ['invitePreview', TOKEN], options.previewError);
  const noop = () => {};
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <InviteAcceptScreen
        token={TOKEN}
        me={options.me === undefined ? null : options.me}
        onAccepted={noop}
        onExit={noop}
        onLogout={async () => {}}
      />
    </QueryClientProvider>,
  );
}

function apiError(status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, message);
}

describe('InviteAcceptScreen', () => {
  it('校验链接时只画品牌区、读中提示与页脚', () => {
    const html = render();

    expect(html).toContain('<main class="login-card login-card-invite">');
    expect(html).toContain('<p class="eyebrow">YUNSHUO · 工作区邀请</p>');
    expect(html).toContain('<h1>加入协作</h1>');
    expect(html).toContain('<p class="login-lead">接受邀请后，会话会绑定到该工作区。</p>');
    expect(html).toContain('<p class="empty-state">正在校验邀请链接……</p>');
    expect(html).not.toContain('invite-summary');
    expect(html).not.toContain('无法接受邀请');
    expect(html).toContain('<span>邀请链接一次性使用</span>');
    expect(html).toContain('<span>不保存邀请明文</span>');
    expect(html).toContain('<button type="button" class="link-button">返回登录</button>');
  });

  it('邀请无效、已用、过期三码各自翻成一句中文', () => {
    const invalid = render({ previewError: apiError(410, 'INVITE_INVALID', '原始文案') });
    expect(invalid).toContain('<strong>无法接受邀请</strong>');
    expect(invalid).toContain('<div class="notice notice-error invite-error">');
    expect(invalid).toContain('邀请链接无效，请向管理员确认链接是否完整。');
    expect(invalid).not.toContain('（INVITE_INVALID）');

    const used = render({ previewError: apiError(410, 'INVITE_USED', '原始文案') });
    expect(used).toContain('邀请已被使用或撤销，请联系管理员重新发出邀请。');

    const expired = render({ previewError: apiError(410, 'INVITE_EXPIRED', '原始文案') });
    expect(expired).toContain('邀请已过期，请联系管理员重新发出邀请。');
  });

  it('登录失败、已是成员与未知码分别透传或带括号码', () => {
    const login = render({ previewError: apiError(401, 'LOGIN_FAILED', '原始文案') });
    expect(login).toContain('<p>邮箱或密码不正确。</p>');
    expect(login).not.toContain('原始文案');

    const member = render({ previewError: apiError(409, 'ALREADY_MEMBER', '你已经是该工作区成员') });
    expect(member).toContain('<p>你已经是该工作区成员</p>');

    const forbidden = render({ previewError: apiError(403, 'FORBIDDEN', '只有所有者可以查看') });
    expect(forbidden).toContain('<p>只有所有者可以查看</p>');

    const unknown = render({ previewError: apiError(500, 'INTERNAL', '连接中断') });
    expect(unknown).toContain('<p>连接中断（INTERNAL）</p>');
  });

  it('受邀账号已登录且邮箱一致时给出摘要与加入按钮', () => {
    const html = render({ preview: preview(), me: me() });

    expect(html).toContain('<div class="invite-summary">');
    expect(html).toContain('<strong>雾港</strong>');
    expect(html).toContain('<strong class="mono">lin@example.com</strong>');
    expect(html).toContain('<strong>主笔</strong>');
    expect(html).toContain('<strong>2026/10/30 18:07:00</strong>');
    expect(html).toContain('当前登录账号是 林默（lin@example.com）。接受后你的会话将切换到 「雾港」。');
    expect(html).toContain('接受邀请，加入「雾港」');
    expect(html).not.toContain('账号不匹配');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('操作失败');
  });

  it('邮箱比较忽略大小写与首尾空白', () => {
    const html = render({
      preview: preview(),
      me: me({ user: { id: 'user-1', email: ' Lin@Example.com ', name: '林默' } }),
    });

    expect(html).toContain('接受邀请，加入「雾港」');
    expect(html).not.toContain('账号不匹配');
  });

  it('已登录但不是受邀邮箱时只给退出入口', () => {
    const html = render({
      preview: preview(),
      me: me({ user: { id: 'user-2', email: 'other@example.com', name: '周岚' } }),
    });

    expect(html).toContain('<div class="notice notice-warn">');
    expect(html).toContain('<strong>账号不匹配</strong>');
    expect(html).toContain('当前登录的是 other@example.com，邀请发给 lin@example.com。');
    expect(html).toContain('请退出后使用受邀邮箱登录或注册。');
    expect(html).toContain('<button type="button" class="button button-quiet"');
    expect(html).toContain('退出当前账号');
    expect(html).not.toContain('接受邀请，加入「雾港」');
  });

  it('账号已存在时用登录表单，邮箱字段锁定', () => {
    const html = render({ preview: preview({ accountExists: true, role: 'billing' }) });

    expect(html).toContain('<form class="invite-action">');
    expect(html).toContain('<h2>该邮箱已有账号</h2>');
    expect(html).toContain('<span class="muted">登录后直接加入工作区</span>');
    expect(html).toContain('<strong>计费管理员</strong>');
    expect(html).toContain('<input disabled="" readOnly="" value="lin@example.com"/>');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('登录并加入');
    expect(html).toContain('忘记密码？当前版本尚未提供自助重置，请联系工作区所有者。');
    expect(html).not.toContain('创建账号并加入');
  });

  it('账号不存在时用注册表单，称呼与密码各自带上限', () => {
    const html = render({ preview: preview() });

    expect(html).toContain('<h2>创建账号并加入</h2>');
    expect(html).toContain('<span class="muted">本机账号 · scrypt 校验</span>');
    expect(html).toContain('<input disabled="" readOnly="" value="lin@example.com"/>');
    expect(html).toContain('maxLength="40"');
    expect(html).toContain('autoComplete="name"');
    expect(html).toContain('placeholder="在协作中显示的名字"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('placeholder="至少 10 位"');
    expect(html).toContain('>创建账号并加入</button>');
    expect(html).not.toContain('登录并加入');
  });
});
