import { useState, type FormEvent } from 'react';
import { ApiError, completePasswordReset } from '../api.js';

interface Props {
  token: string;
  onFinished: () => void;
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export function ResetScreen({ token, onFinished }: Props) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (newPassword.length < 10) {
      setError('新密码至少 10 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      await completePasswordReset(token, newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-ornament" aria-hidden="true" />
      <main className="login-card login-card-reset">
        <div className="login-brand">
          <div className="brand-seal brand-seal-large" aria-hidden="true">
            说
          </div>
          <div>
            <p className="eyebrow">YUNSHUO · 账号安全</p>
            <h1>重置密码</h1>
            <p className="login-lead">一次性链接 · 30 分钟有效 · 重置后所有旧会话失效。</p>
          </div>
        </div>

        {done ? (
          <>
            <div className="notice notice-success">
              <strong>密码已重置</strong>
              <p>所有旧会话与未使用的重置链接都已失效。请使用新密码重新登录。</p>
            </div>
            <button type="button" className="button button-primary" onClick={onFinished}>
              返回登录
            </button>
          </>
        ) : (
          <>
            <div className="login-section-head">
              <h2>设置新密码</h2>
              <span className="muted">至少 10 位 · 服务端只存 scrypt 哈希</span>
            </div>
            <form className="reset-form" onSubmit={handleSubmit}>
              <label className="field">
                <span>新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  maxLength={200}
                  autoComplete="new-password"
                  placeholder="至少 10 位"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label className="field">
                <span>确认新密码</span>
                <input
                  type="password"
                  value={confirmPassword}
                  maxLength={200}
                  autoComplete="new-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <button type="submit" className="button button-primary" disabled={submitting}>
                {submitting ? '重置中……' : '重置密码'}
              </button>
            </form>
            {error ? (
              <div className="notice notice-error">
                <strong>无法重置</strong>
                <p>{error}</p>
              </div>
            ) : null}
            <p className="login-hint muted">
              链接只能使用一次。若已过期，请返回登录页重新发送重置请求。
            </p>
            <button type="button" className="link-button" onClick={onFinished}>
              返回登录
            </button>
          </>
        )}

        <footer className="login-foot">
          <span>一次性令牌 · SHA-256 摘要存库</span>
          <span>重置后撤销全部会话</span>
          <span>不记录明文密码</span>
        </footer>
      </main>
    </div>
  );
}
