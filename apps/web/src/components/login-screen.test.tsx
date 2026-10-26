import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfigResponse } from '@yunshuo/contracts';
import { ApiError } from '../api.js';
import type { DevUser } from '../api.js';
import { LoginScreen } from './LoginScreen.js';

const USERS: DevUser[] = [
  { id: 'user-1', email: 'lin@example.com', name: '林默', role: 'owner' },
  { id: 'user-2', email: 'su@example.com', name: '苏晚', role: 'lead' },
  { id: 'user-3', email: 'lin@example.com', name: '林默（重复邮箱）', role: 'author' },
  { id: 'user-4', email: 'guest@example.com', name: '访客', role: 'viewer' },
];

function occur(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function setQueryError(client: QueryClient, queryKey: string[], error: Error): void {
  const query = client.getQueryCache().build(client, { queryKey });
  query.setState({ status: 'error', error, fetchStatus: 'idle', errorUpdatedAt: Date.now() });
}

function render(
  options: {
    search?: string;
    auth?: AuthConfigResponse;
    users?: DevUser[];
    usersError?: Error;
  } = {},
): string {
  vi.stubGlobal('window', { location: { search: options.search ?? '' } });
  const client = new QueryClient({
    // SSR 没有已挂载的 observer；retryOnMount 默认 true 会把预置的错误态重新抹成 pending。
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity },
    },
  });
  if (options.auth) client.setQueryData(['authConfig'], options.auth);
  if (options.users) client.setQueryData(['devUsers'], options.users);
  if (options.usersError) setQueryError(client, ['devUsers'], options.usersError);

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LoginScreen onLoggedIn={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginScreen', () => {
  it('默认登录：品牌、本地密码表单与开发身份读中，没有 SSO 和企业错误横幅', () => {
    const html = render();

    expect(html).toContain('YUNSHUO · 长篇小说协作工坊');
    expect(html).toContain('<h1>云说</h1>');
    expect(html).toContain('先让一条提交链站住，再谈十二个工位。');
    expect(html).toContain('单事务写入正典');
    expect(html).toContain('一次性豁免与 AI 提案');
    expect(html).toContain('<strong>dev-v0 开发规则集</strong>');
    expect(html).toContain('迁移导入的章节显示“未评估”，不伪造通过。');

    expect(html).toContain('<h2>账号登录</h2>');
    expect(html).toContain('本地邮箱密码 · 会话绑定当前工作区');
    expect(html).toContain(
      '<input type="email" maxLength="320" autoComplete="username" placeholder="you@example.com" spellCheck="false" value=""/>',
    );
    expect(html).toContain(
      '<input type="password" maxLength="200" autoComplete="current-password" placeholder="至少 10 位" value=""/>',
    );
    expect(html).toContain(
      '<button type="submit" class="button button-primary login-submit">登录</button>',
    );
    expect(html).toContain('忘记密码？');
    expect(html).toContain('重置链接 30 分钟内有效');
    expect(html).toContain('没有账号？请联系工作区所有者或主笔发出邀请');
    expect(html).toContain('密码由本机服务使用 scrypt 校验，不保存明文。');

    expect(html).not.toContain('login-sso');
    expect(html).not.toContain('企业登录未完成');
    expect(html).not.toContain('notice notice-error');
    expect(html).not.toContain('登录失败');

    expect(html).toContain('<p class="empty-state login-dev-loading">正在检查开发身份……</p>');
    expect(html).not.toContain('开发身份列表不可用');

    expect(html).toContain('密码登录 · scrypt');
    expect(html).toContain('提交与回滚 · dev-v0');
    expect(html).toContain('正文与证据同库');
  });

  it('启用 SSO 且自动开户：链接、自动开户说明与企业错误映射同时出现', () => {
    const html = render({
      search: '?oidc_error=OIDC_STATE_EXPIRED',
      auth: { oidcEnabled: true, oidcProviderName: '企业统一身份', oidcAutoProvision: true },
    });

    expect(html).toContain(
      '<a class="button button-primary login-submit" href="/api/auth/oidc/start">使用 企业统一身份 登录</a>',
    );
    expect(html).toContain(
      '首次登录需已有待接受的工作区邀请；邮箱验证通过后会自动开通账号。',
    );
    expect(html).toContain('或使用本地密码');
    expect(html).toContain('<div class="notice notice-error"><strong>企业登录未完成</strong>');
    expect(html).toContain('<p>登录状态已过期，请重新发起企业登录。</p>');
    expect(html).not.toContain('企业身份需已关联本地账号');
  });

  it('启用 SSO 但不自动开户：说明改走“先关联本地账号”的口径', () => {
    const html = render({
      auth: { oidcEnabled: true, oidcProviderName: 'Atria SSO', oidcAutoProvision: false },
    });

    expect(html).toContain('使用 Atria SSO 登录');
    expect(html).toContain(
      '企业身份需已关联本地账号；账号由工作区邀请创建，管理员不会看到你的密码。',
    );
    expect(html).not.toContain('首次登录需已有待接受的工作区邀请');
    expect(html).not.toContain('企业登录未完成');
  });

  it('未知企业错误码：保留归因码并给出兜底说明，不冒充已知映射', () => {
    const html = render({ search: '?oidc_error=OIDC_SOMETHING_NEW' });

    expect(html).toContain('<strong>企业登录未完成</strong>');
    expect(html).toContain('<p>企业登录失败（OIDC_SOMETHING_NEW）。</p>');
    expect(html).not.toContain('此部署未启用企业 SSO。');
  });

  it('开发身份列表按邮箱去重，角色标签与说明逐项展示', () => {
    const html = render({ users: USERS });

    expect(html).toContain('<h2>开发身份</h2>');
    expect(html).toContain('DEV_AUTH 已开启 · 仅限本机验证角色差异');
    expect(occur(html, 'class="login-user"')).toBe(3);
    expect(occur(html, 'lin@example.com')).toBe(1);
    expect(occur(html, 'su@example.com')).toBe(1);
    expect(occur(html, 'guest@example.com')).toBe(1);

    expect(html).toContain('<span class="login-user-role">所有者</span>');
    expect(html).toContain('<span class="login-user-role">主笔</span>');
    expect(html).toContain('<span class="login-user-role">读者</span>');
    expect(html).toContain('<span class="login-user-name">林默</span>');
    expect(html).toContain('<span class="login-user-name">苏晚</span>');
    expect(html).toContain('<span class="login-user-name">访客</span>');
    expect(html).toContain('<span class="login-user-desc">工作区与预算控制；可写入、可审批</span>');
    expect(html).toContain('<span class="login-user-desc">质量裁决与豁免审批；可写入</span>');
    expect(html).toContain('<span class="login-user-desc">只读</span>');
    expect(occur(html, '>以此身份进入</span>')).toBe(3);
    expect(html).not.toContain('林默（重复邮箱）');

    expect(html).not.toContain('正在检查开发身份……');
  });

  it('开发身份被关闭：只说不可用，不带归因码，并保留邮箱密码入口', () => {
    const html = render({
      usersError: new ApiError(403, 'DEV_AUTH_DISABLED', '开发身份未启用'),
    });

    expect(html).toContain('开发身份列表不可用');
    expect(html).toContain('仍可使用上方邮箱密码登录。');
    expect(html).not.toContain('（DEV_AUTH_DISABLED）');
    expect(html).not.toContain('<h2>开发身份</h2>');
    expect(html).toContain('>登录</button>');
  });

  it('开发身份读取失败但不是关闭：把归因码如实带到提示里', () => {
    const html = render({
      usersError: new ApiError(500, 'INTERNAL', '服务端错误'),
    });

    expect(html).toContain('开发身份列表不可用（INTERNAL）；仍可使用上方邮箱密码登录。');
    expect(html).not.toContain('<h2>开发身份</h2>');
    expect(html).not.toContain('正在检查开发身份……');
  });
});
