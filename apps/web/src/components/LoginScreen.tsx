import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { DevMailboxResponse, MeResponse } from '@yunshuo/contracts';
import {
  ApiError,
  getAuthConfig,
  getDevMailbox,
  listDevUsers,
  login,
  requestPasswordReset,
} from '../api.js';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../format.js';

const OIDC_ERROR_MESSAGES: Record<string, string> = {
  OIDC_DISABLED: '此部署未启用企业 SSO。',
  OIDC_ACCOUNT_NOT_FOUND: '该企业身份尚未关联本地账号，请先接受工作区邀请或联系管理员。',
  OIDC_INVITE_REQUIRED: '没有待接受的工作区邀请，无法自动开通账号。',
  OIDC_EMAIL_UNVERIFIED: '企业身份邮箱未验证，不能登录或绑定账号。',
  OIDC_EMAIL_REQUIRED: '企业身份未提供邮箱，无法匹配本地账号。',
  OIDC_IDENTITY_CONFLICT: '该企业身份已绑定其他本地账号，请联系管理员。',
  OIDC_STATE_INVALID: '登录状态不匹配，请重新发起企业登录。',
  OIDC_STATE_EXPIRED: '登录状态已过期，请重新发起企业登录。',
  OIDC_PROVIDER_ERROR: '企业身份服务返回了登录错误，请重试。',
  OIDC_CODE_REJECTED: '授权码已失效，请重新登录。',
  OIDC_TOKEN_INVALID: '企业身份令牌校验失败，请重新登录。',
  OIDC_NONCE_MISMATCH: '企业身份令牌与本次登录不匹配，请重新登录。',
  OIDC_DISCOVERY_FAILED: '无法连接企业身份服务，请联系管理员。',
  OIDC_DISCOVERY_INVALID: '企业身份服务配置不合法，请联系管理员。',
};

function errorText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}

function readOidcError(): string | null {
  const code = new URLSearchParams(window.location.search).get('oidc_error');
  if (!code) return null;
  return OIDC_ERROR_MESSAGES[code] ?? `企业登录失败（${code}）。`;
}

function extractedLink(text: string): string | null {
  return /https?:\/\/\S+/.exec(text)?.[0] ?? null;
}

function DevMailboxPanel() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; mailbox: DevMailboxResponse }
  >({ status: 'idle' });

  async function load() {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', mailbox: await getDevMailbox() });
    } catch (error) {
      setState({ status: 'error', message: errorText(error) });
    }
  }

  return (
    <div className="dev-mailbox">
      <div className="dev-mailbox-head">
        <strong>开发内存邮箱</strong>
        <span className="muted">未真实投递 · 仅 DEV_AUTH 本机可读</span>
        <button type="button" className="button button-quiet button-small" onClick={() => void load()}>
          {state.status === 'ready' ? '刷新' : '读取邮件'}
        </button>
      </div>
      {state.status === 'error' ? (
        <p className="login-hint muted">读取失败：{state.message}</p>
      ) : state.status === 'ready' ? (
        state.mailbox.messages.length === 0 ? (
          <p className="login-hint muted">内存邮箱还没有邮件。</p>
        ) : (
          <ul className="dev-mailbox-list">
            {state.mailbox.messages.slice(0, 5).map((message) => {
              const link = extractedLink(message.text);
              return (
                <li key={message.id}>
                  <div>
                    <strong>{message.subject}</strong>
                    <span className="muted">
                      {' '}
                      · {message.to} · {new Date(message.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {link ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => window.location.assign(link)}
                    >
                      打开链接
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <p className="login-hint muted">
          内存邮箱只在开发模式启用；读取后可直接打开邀请或重置链接，不会真实发信。
        </p>
      )}
    </div>
  );
}

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (me: MeResponse) => void }) {
  const usersQuery = useQuery({
    queryKey: ['devUsers'],
    queryFn: listDevUsers,
    retry: false,
  });
  const authConfigQuery = useQuery({
    queryKey: ['authConfig'],
    queryFn: getAuthConfig,
    retry: false,
    staleTime: 60_000,
  });
  const [oidcError] = useState<string | null>(readOidcError);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [resetEmail, setResetEmail] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [showDevMailbox, setShowDevMailbox] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('oidc_error')) return;
    url.searchParams.delete('oidc_error');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const passwordLogin = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      login(input.email, input.password),
    onSuccess: (me) => {
      setFormError(null);
      onLoggedIn(me);
    },
    onError: (error) => setFormError(errorText(error)),
  });

  const devLogin = useMutation({
    mutationFn: (userEmail: string) => login(userEmail),
    onSuccess: (me) => {
      setFormError(null);
      onLoggedIn(me);
    },
    onError: (error) => setFormError(errorText(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setFormError('请填写邮箱与密码。');
      return;
    }
    setFormError(null);
    passwordLogin.mutate({ email: trimmedEmail, password });
  }

  async function handleForgot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = resetEmail.trim();
    if (!trimmed) {
      setResetError('请填写账号邮箱。');
      return;
    }
    setResetSubmitting(true);
    setResetError(null);
    setResetMessage(null);
    setShowDevMailbox(false);
    try {
      const result = await requestPasswordReset(trimmed);
      setResetMessage(result.message);
      setShowDevMailbox(result.devMailbox);
    } catch (error) {
      setResetError(errorText(error));
    } finally {
      setResetSubmitting(false);
    }
  }

  function switchMode(next: 'login' | 'forgot') {
    setMode(next);
    setFormError(null);
    setResetError(null);
    setResetMessage(null);
    setShowDevMailbox(false);
    if (next === 'forgot') setResetEmail(email);
  }

  const seenDevEmails = new Set<string>();
  const devUsers = (usersQuery.data ?? []).filter((user) => {
    if (seenDevEmails.has(user.email)) return false;
    seenDevEmails.add(user.email);
    return true;
  });

  return (
    <div className="login-page">
      <div className="login-ornament" aria-hidden="true" />
      <main className="login-card">
        <div className="login-brand">
          <div className="brand-seal brand-seal-large" aria-hidden="true">
            说
          </div>
          <div>
            <p className="eyebrow">YUNSHUO · 长篇小说协作工坊</p>
            <h1>云说</h1>
            <p className="login-lead">先让一条提交链站住，再谈十二个工位。</p>
          </div>
        </div>

        <div className="login-manifesto">
          <p>
            人工闭环：取得租约 → 写草稿 → 五门禁 → 审计提示 → 隔离暂存 →
            单事务写入正典 → 版本留痕；支持修订、证据复用回滚、一次性豁免与 AI 提案。
            所有者/主笔还可显式授权无人值守续写：逐章生成、逐章过五门禁，全部通过才入库。
          </p>
          <p className="muted">
            门禁使用 <strong>dev-v0 开发规则集</strong>，阈值仅用于验证链路，不是生产标准。
            迁移导入的章节显示“未评估”，不伪造通过。
          </p>
        </div>

        <div className="login-section-head">
          <h2>{mode === 'login' ? '账号登录' : '找回密码'}</h2>
          <span className="muted">
            {mode === 'login'
              ? '本地邮箱密码 · 会话绑定当前工作区'
              : '一次性链接 · 30 分钟内有效'}
          </span>
        </div>

        {mode === 'login' ? (
          <>
            {oidcError ? (
              <div className="notice notice-error">
                <strong>企业登录未完成</strong>
                <p>{oidcError}</p>
              </div>
            ) : null}

            {authConfigQuery.data?.oidcEnabled ? (
              <div className="login-sso">
                <a className="button button-primary login-submit" href="/api/auth/oidc/start">
                  使用 {authConfigQuery.data.oidcProviderName} 登录
                </a>
                <p className="login-hint muted">
                  {authConfigQuery.data.oidcAutoProvision
                    ? '首次登录需已有待接受的工作区邀请；邮箱验证通过后会自动开通账号。'
                    : '企业身份需已关联本地账号；账号由工作区邀请创建，管理员不会看到你的密码。'}
                </p>
                <div className="login-divider">
                  <span>或使用本地密码</span>
                </div>
              </div>
            ) : null}

            <form className="login-form" onSubmit={handleSubmit}>
              <label className="field">
                <span>邮箱</span>
                <input
                  type="email"
                  value={email}
                  maxLength={320}
                  autoComplete="username"
                  placeholder="you@example.com"
                  spellCheck={false}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field">
                <span>密码</span>
                <input
                  type="password"
                  value={password}
                  maxLength={200}
                  autoComplete="current-password"
                  placeholder="至少 10 位"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="button button-primary login-submit"
                disabled={passwordLogin.isPending}
              >
                {passwordLogin.isPending ? '登录中……' : '登录'}
              </button>
              <div className="login-form-links">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => switchMode('forgot')}
                >
                  忘记密码？
                </button>
                <span className="muted">重置链接 30 分钟内有效</span>
              </div>
            </form>

            <p className="login-hint muted">
              没有账号？请联系工作区所有者或主笔发出邀请，再打开邀请链接完成注册。
              密码由本机服务使用 scrypt 校验，不保存明文。
            </p>

            {formError ? (
              <div className="notice notice-error">
                <strong>登录失败</strong>
                <p>{formError}</p>
              </div>
            ) : null}

            {usersQuery.isLoading ? (
              <p className="empty-state login-dev-loading">正在检查开发身份……</p>
            ) : devUsers.length > 0 ? (
              <>
                <div className="login-section-head login-dev-head">
                  <h2>开发身份</h2>
                  <span className="muted">DEV_AUTH 已开启 · 仅限本机验证角色差异</span>
                </div>
                <div className="login-users">
                  {devUsers.map((user) => (
                    <button
                      key={user.id}
                      className="login-user"
                      type="button"
                      onClick={() => {
                        setFormError(null);
                        devLogin.mutate(user.email);
                      }}
                      disabled={devLogin.isPending || passwordLogin.isPending}
                    >
                      <span className="login-user-role">{ROLE_LABELS[user.role]}</span>
                      <span className="login-user-name">{user.name}</span>
                      <span className="login-user-desc">{ROLE_DESCRIPTIONS[user.role]}</span>
                      <span className="login-user-email">{user.email}</span>
                      <span className="login-user-enter">
                        {devLogin.isPending && devLogin.variables === user.email
                          ? '进入中……'
                          : '以此身份进入'}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : usersQuery.isError ? (
              <p className="login-hint muted">
                开发身份列表不可用
                {usersQuery.error instanceof ApiError &&
                usersQuery.error.code !== 'DEV_AUTH_DISABLED'
                  ? `（${usersQuery.error.code}）`
                  : ''}
                ；仍可使用上方邮箱密码登录。
              </p>
            ) : null}
          </>
        ) : (
          <>
            <form className="login-form login-form-forgot" onSubmit={handleForgot}>
              <label className="field">
                <span>账号邮箱</span>
                <input
                  type="email"
                  value={resetEmail}
                  maxLength={320}
                  autoComplete="username"
                  placeholder="you@example.com"
                  spellCheck={false}
                  onChange={(event) => setResetEmail(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="button button-primary login-submit"
                disabled={resetSubmitting}
              >
                {resetSubmitting ? '发送中……' : '发送重置链接'}
              </button>
              <div className="login-form-links">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => switchMode('login')}
                >
                  返回登录
                </button>
              </div>
            </form>

            {resetMessage ? (
              <div className="notice notice-success">
                <strong>请求已受理</strong>
                <p>{resetMessage}</p>
              </div>
            ) : null}
            {resetError ? (
              <div className="notice notice-error">
                <strong>发送失败</strong>
                <p>{resetError}</p>
              </div>
            ) : null}

            {showDevMailbox ? <DevMailboxPanel /> : null}

            <p className="login-hint muted">
              为避免泄露账号是否存在，无论邮箱是否注册，提示相同。重置链接只能使用一次；
              修改密码或再次申请都会作废旧链接。
            </p>
          </>
        )}

        <footer className="login-foot">
          <span>密码登录 · scrypt</span>
          <span>提交与回滚 · dev-v0</span>
          <span>正文与证据同库</span>
        </footer>
      </main>
    </div>
  );
}
