import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MeResponse } from '@yunshuo/contracts';
import { ApiError, changePassword } from '../api.js';
import { ROLE_LABELS } from '../format.js';

interface Props {
  me: MeResponse;
  onClose: () => void;
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export function AccountDialog({ me, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!currentPassword) {
      setError('请填写当前密码。');
      return;
    }
    if (newPassword.length < 10) {
      setError('新密码至少 10 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    if (newPassword === currentPassword) {
      setError('新密码不能与当前密码相同。');
      return;
    }
    setSubmitting(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice(
        result.revokedOtherSessions > 0
          ? `密码已修改；已撤销其他 ${result.revokedOtherSessions} 个会话，当前会话保留。`
          : '密码已修改；当前没有其他会话需要撤销。',
      );
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-account"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">{me.workspace.name} · 账号安全</p>
            <h2 id="account-title">账号</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <div className="account-summary">
            <div>
              <span className="eyebrow">邮箱</span>
              <strong className="mono">{me.user.email}</strong>
            </div>
            <div>
              <span className="eyebrow">当前工作区角色</span>
              <strong>{ROLE_LABELS[me.role]}</strong>
            </div>
          </div>

          {notice ? <div className="provider-notice provider-notice-success">{notice}</div> : null}
          {error ? <div className="modal-error">{error}</div> : null}

          <section className="account-section">
            <div className="team-section-head">
              <h3>修改密码</h3>
              <span className="muted">至少 10 位 · scrypt 哈希 · 不存明文</span>
            </div>
            <form className="account-form" onSubmit={handleSubmit}>
              <label className="field">
                <span>当前密码</span>
                <input
                  type="password"
                  value={currentPassword}
                  maxLength={200}
                  autoComplete="current-password"
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
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
                {submitting ? '修改中……' : '修改密码'}
              </button>
            </form>
            <p className="account-hint muted">
              修改密码会撤销该账号在其他工作区的全部会话，并作废未使用的重置链接；当前会话保留。
              若账号尚未设置密码（例如种子账号），请先在登录页使用“忘记密码”设置。
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          <span className="commit-foot-hint">
            安全事件写入账号级 auth_events，不记录密码或密码哈希。
          </span>
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
