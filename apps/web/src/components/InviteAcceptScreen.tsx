import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@yunshuo/contracts';
import { ApiError, acceptInvite, previewInvite } from '../api.js';
import { ROLE_LABELS } from '../format.js';

interface Props {
  token: string;
  me: MeResponse | null;
  onAccepted: (me: MeResponse) => void;
  onExit: () => void;
  onLogout: () => Promise<void>;
}

function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return String(error);
  switch (error.code) {
    case 'INVITE_INVALID':
      return '邀请链接无效，请向管理员确认链接是否完整。';
    case 'INVITE_USED':
      return '邀请已被使用或撤销，请联系管理员重新发出邀请。';
    case 'INVITE_EXPIRED':
      return '邀请已过期，请联系管理员重新发出邀请。';
    case 'ALREADY_MEMBER':
      return error.message;
    case 'LOGIN_FAILED':
      return '邮箱或密码不正确。';
    case 'FORBIDDEN':
      return error.message;
    default:
      return `${error.message}（${error.code}）`;
  }
}

export function InviteAcceptScreen({
  token,
  me,
  onAccepted,
  onExit,
  onLogout,
}: Props) {
  const previewQuery = useQuery({
    queryKey: ['invitePreview', token],
    queryFn: () => previewInvite(token),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const accept = useMutation({
    mutationFn: async (input: { name?: string; password?: string }) =>
      acceptInvite(token, input),
    onSuccess: (next) => {
      setError(null);
      onAccepted(next);
    },
    onError: (acceptError) => setError(errorText(acceptError)),
  });

  const loginAndAccept = useMutation({
    mutationFn: async (input: { password: string }) => acceptInvite(token, input),
    onSuccess: (next) => {
      setError(null);
      onAccepted(next);
    },
    onError: (acceptError) => setError(errorText(acceptError)),
  });

  async function handleSwitchAccount() {
    setSwitching(true);
    setError(null);
    try {
      await onLogout();
    } finally {
      setSwitching(false);
    }
  }

  function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError('请填写称呼。');
      return;
    }
    if (password.length < 10) {
      setError('密码至少 10 位。');
      return;
    }
    setError(null);
    accept.mutate({ name: name.trim(), password });
  }

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!previewQuery.data) return;
    if (!loginPassword) {
      setError('请填写密码。');
      return;
    }
    setError(null);
    loginAndAccept.mutate({ password: loginPassword });
  }

  const preview = previewQuery.data;
  const emailMatches =
    me !== null && preview !== undefined &&
    me.user.email.trim().toLowerCase() === preview.email.trim().toLowerCase();
  const pending = accept.isPending || loginAndAccept.isPending || switching;

  return (
    <div className="login-page">
      <div className="login-ornament" aria-hidden="true" />
      <main className="login-card login-card-invite">
        <div className="login-brand">
          <div className="brand-seal brand-seal-large" aria-hidden="true">
            说
          </div>
          <div>
            <p className="eyebrow">YUNSHUO · 工作区邀请</p>
            <h1>加入协作</h1>
            <p className="login-lead">接受邀请后，会话会绑定到该工作区。</p>
          </div>
        </div>

        {previewQuery.isLoading ? (
          <p className="empty-state">正在校验邀请链接……</p>
        ) : previewQuery.isError ? (
          <div className="notice notice-error invite-error">
            <strong>无法接受邀请</strong>
            <p>{errorText(previewQuery.error)}</p>
            <button type="button" className="button button-quiet button-small" onClick={onExit}>
              返回登录
            </button>
          </div>
        ) : preview ? (
          <>
            <div className="invite-summary">
              <div>
                <span className="eyebrow">工作区</span>
                <strong>{preview.workspaceName}</strong>
              </div>
              <div>
                <span className="eyebrow">受邀邮箱</span>
                <strong className="mono">{preview.email}</strong>
              </div>
              <div>
                <span className="eyebrow">角色</span>
                <strong>{ROLE_LABELS[preview.role]}</strong>
              </div>
              <div>
                <span className="eyebrow">有效期至</span>
                <strong>{new Date(preview.expiresAt).toLocaleString('zh-CN')}</strong>
              </div>
            </div>

            {me && emailMatches ? (
              <div className="invite-action">
                <p className="muted">
                  当前登录账号是 {me.user.name}（{me.user.email}）。接受后你的会话将切换到
                  「{preview.workspaceName}」。
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    accept.mutate({});
                  }}
                >
                  {accept.isPending ? '正在加入……' : `接受邀请，加入「${preview.workspaceName}」`}
                </button>
              </div>
            ) : me ? (
              <div className="invite-action">
                <div className="notice notice-warn">
                  <strong>账号不匹配</strong>
                  <p>
                    当前登录的是 {me.user.email}，邀请发给 {preview.email}。
                    请退出后使用受邀邮箱登录或注册。
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => void handleSwitchAccount()}
                >
                  {switching ? '正在退出……' : '退出当前账号'}
                </button>
              </div>
            ) : preview.accountExists ? (
              <form className="invite-action" onSubmit={handleLogin}>
                <div className="login-section-head">
                  <h2>该邮箱已有账号</h2>
                  <span className="muted">登录后直接加入工作区</span>
                </div>
                <label className="field">
                  <span>邮箱</span>
                  <input value={preview.email} disabled readOnly />
                </label>
                <label className="field">
                  <span>密码</span>
                  <input
                    type="password"
                    value={loginPassword}
                    maxLength={200}
                    autoComplete="current-password"
                    onChange={(event) => setLoginPassword(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={pending}
                >
                  {loginAndAccept.isPending ? '正在验证并加入……' : '登录并加入'}
                </button>
                <p className="muted invite-foot-hint">
                  忘记密码？当前版本尚未提供自助重置，请联系工作区所有者。
                </p>
              </form>
            ) : (
              <form className="invite-action" onSubmit={handleRegister}>
                <div className="login-section-head">
                  <h2>创建账号并加入</h2>
                  <span className="muted">本机账号 · scrypt 校验</span>
                </div>
                <label className="field">
                  <span>邮箱</span>
                  <input value={preview.email} disabled readOnly />
                </label>
                <label className="field">
                  <span>称呼</span>
                  <input
                    value={name}
                    maxLength={40}
                    autoComplete="name"
                    placeholder="在协作中显示的名字"
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>密码</span>
                  <input
                    type="password"
                    value={password}
                    maxLength={200}
                    autoComplete="new-password"
                    placeholder="至少 10 位"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <button type="submit" className="button button-primary" disabled={pending}>
                  {accept.isPending ? '正在创建并加入……' : '创建账号并加入'}
                </button>
              </form>
            )}

            {error ? (
              <div className="notice notice-error">
                <strong>操作失败</strong>
                <p>{error}</p>
              </div>
            ) : null}
          </>
        ) : null}

        <footer className="login-foot">
          <button type="button" className="link-button" onClick={onExit}>
            返回登录
          </button>
          <span>邀请链接一次性使用</span>
          <span>不保存邀请明文</span>
        </footer>
      </main>
    </div>
  );
}
