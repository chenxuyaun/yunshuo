import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateInviteResponse,
  InviteStatus,
  InviteView,
  MeResponse,
  MemberView,
} from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import {
  ApiError,
  createInvite,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from '../api.js';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';

interface Props {
  me: MeResponse;
  onClose: () => void;
  onSessionRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}

const HUMAN_ROLES: HumanRole[] = ['owner', 'lead', 'author', 'reviewer', 'viewer', 'billing'];

const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  pending: '待接受',
  accepted: '已接受',
  expired: '已过期',
  revoked: '已撤销',
};

function inviteTone(status: InviteStatus): BadgeTone {
  switch (status) {
    case 'pending':
      return 'amber';
    case 'accepted':
      return 'green';
    default:
      return 'muted';
  }
}

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

export function TeamDialog({ me, onClose, onSessionRefresh, onLogout }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const membersQuery = useQuery({ queryKey: ['members'], queryFn: listMembers });
  const invitesQuery = useQuery({ queryKey: ['invites'], queryFn: listInvites });

  const isOwner = me.role === 'owner';
  const invitableRoles = isOwner
    ? HUMAN_ROLES
    : HUMAN_ROLES.filter((role) => role !== 'owner' && role !== 'lead');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<HumanRole>('author');
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyMemberIds, setBusyMemberIds] = useState<Set<string>>(() => new Set());
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  function markMemberBusy(userId: string, busy: boolean) {
    setBusyMemberIds((current) => {
      const next = new Set(current);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

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

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members'] }),
      queryClient.invalidateQueries({ queryKey: ['invites'] }),
    ]);
  }

  const createMutation = useMutation({
    mutationFn: createInvite,
    onSuccess: async (response) => {
      setCreated(response);
      setCopied(false);
      setEmail('');
      setError(null);
      setNotice(`已邀请 ${response.invite.email}；${response.mail.message}。`);
      await refreshAll();
    },
    onError: (createError) => setError(errorText(createError)),
  });

  const roleMutation = useMutation({
    mutationFn: (input: { userId: string; role: HumanRole }) =>
      updateMemberRole(input.userId, input.role),
    onSuccess: async (member, variables) => {
      setError(null);
      setNotice(`已将 ${member.name} 设为「${ROLE_LABELS[member.role]}」。`);
      await refreshAll();
      if (variables.userId === me.user.id) await onSessionRefresh();
    },
    onError: (roleError) => setError(errorText(roleError)),
    onSettled: (_member, _error, variables) => markMemberBusy(variables.userId, false),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(userId),
    onSuccess: async (_result, userId) => {
      setConfirmRemoveId(null);
      setError(null);
      setNotice(userId === me.user.id ? '你已退出该工作区。' : '已移除该成员。');
      await refreshAll();
      if (userId === me.user.id) await onLogout();
    },
    onError: (removeError) => setError(errorText(removeError)),
    onSettled: (_result, _error, userId) => markMemberBusy(userId, false),
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(inviteId),
    onSuccess: async () => {
      setError(null);
      setNotice('已撤销邀请，链接立即失效。');
      await refreshAll();
    },
    onError: (revokeError) => setError(errorText(revokeError)),
    onSettled: () => setBusyInviteId(null),
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError('请填写受邀邮箱。');
      return;
    }
    setError(null);
    setNotice(null);
    setCreated(null);
    createMutation.mutate({ email: trimmed, role, expiresInHours });
  }

  async function handleCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.acceptUrl);
      setCopied(true);
    } catch {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
      setError('浏览器未允许直接写入剪贴板，链接已选中，请按 Ctrl+C 复制。');
    }
  }

  function handleRoleChange(member: MemberView, nextRole: HumanRole) {
    if (member.role === nextRole) return;
    markMemberBusy(member.userId, true);
    setError(null);
    setNotice(null);
    roleMutation.mutate({ userId: member.userId, role: nextRole });
  }

  const members = membersQuery.data?.members ?? [];
  const invites = invitesQuery.data?.invites ?? [];
  const loading = membersQuery.isLoading || invitesQuery.isLoading;
  const loadError = membersQuery.error ?? invitesQuery.error;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-team"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">{me.workspace.name} · 成员与邀请</p>
            <h2 id="team-title">团队</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <p className="team-intro">
            {isOwner
              ? '所有者可邀请成员、调整角色与移除成员。至少保留一名所有者；AI 服务主体由系统管理，不能在此修改。'
              : '主笔可查看成员并邀请作者、审阅者、读者或计费管理员；角色调整与移除仅限所有者。'}
          </p>

          {notice ? <div className="provider-notice provider-notice-success">{notice}</div> : null}
          {error ? <div className="modal-error">{error}</div> : null}

          {loading ? (
            <p className="empty-state">正在读取成员与邀请……</p>
          ) : loadError ? (
            <div className="modal-error">读取失败：{errorText(loadError)}</div>
          ) : (
            <>
              <section className="team-section">
                <div className="team-section-head">
                  <h3>成员 · {members.length}</h3>
                  <span className="muted">会话按工作区绑定；切换工作区后权限随之变化。</span>
                </div>
                <ul className="team-member-list">
                  {members.map((member) => {
                    const isSelf = member.userId === me.user.id;
                    const busy = busyMemberIds.has(member.userId);
                    return (
                      <li key={member.userId} className="team-member">
                        <div className="team-member-main">
                          <div className="team-member-name">
                            <strong>{member.name}</strong>
                            {isSelf ? <span className="team-self">你</span> : null}
                            {member.kind === 'ai' ? <Badge tone="ink">AI 主体</Badge> : null}
                          </div>
                          <span className="team-member-email mono">{member.email}</span>
                          <span className="muted team-member-meta">
                            加入于 {formatDateTime(member.joinedAt)} ·{' '}
                            {ROLE_DESCRIPTIONS[member.role]}
                          </span>
                        </div>
                        <div className="team-member-actions">
                          {isOwner && member.kind === 'human' ? (
                            <label className="team-role-select">
                              <span className="sr-only">修改角色</span>
                              <select
                                value={member.role}
                                disabled={busy}
                                onChange={(event) =>
                                  handleRoleChange(member, event.target.value as HumanRole)
                                }
                              >
                                {HUMAN_ROLES.map((option) => (
                                  <option key={option} value={option}>
                                    {ROLE_LABELS[option]}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <Badge tone={member.kind === 'ai' ? 'ink' : 'neutral'}>
                              {ROLE_LABELS[member.role]}
                            </Badge>
                          )}
                          {isOwner && member.kind === 'human' ? (
                            confirmRemoveId === member.userId ? (
                              <span className="team-confirm">
                                确认移除？
                                <button
                                  type="button"
                                  className="button button-danger button-small"
                                  disabled={busy}
                                  onClick={() => {
                                    markMemberBusy(member.userId, true);
                                    removeMutation.mutate(member.userId);
                                  }}
                                >
                                  {busy ? '移除中…' : '确认移除'}
                                </button>
                                <button
                                  type="button"
                                  className="button button-quiet button-small"
                                  onClick={() => setConfirmRemoveId(null)}
                                >
                                  取消
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="button button-quiet button-small"
                                disabled={busy}
                                onClick={() => {
                                  setConfirmRemoveId(member.userId);
                                  setError(null);
                                }}
                              >
                                移除
                              </button>
                            )
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="team-section">
                <div className="team-section-head">
                  <h3>发出邀请</h3>
                  <span className="muted">链接一次性使用 · 邮件状态如实显示</span>
                </div>
                <form className="team-invite-form" onSubmit={handleCreate}>
                  <label className="field team-invite-email">
                    <span>受邀邮箱</span>
                    <input
                      type="email"
                      value={email}
                      maxLength={320}
                      placeholder="teammate@example.com"
                      spellCheck={false}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>角色</span>
                    <select
                      value={role}
                      onChange={(event) => setRole(event.target.value as HumanRole)}
                    >
                      {invitableRoles.map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABELS[option]} · {ROLE_DESCRIPTIONS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>有效期</span>
                    <select
                      value={expiresInHours}
                      onChange={(event) => setExpiresInHours(Number(event.target.value))}
                    >
                      <option value={24}>24 小时</option>
                      <option value={72}>72 小时</option>
                      <option value={168}>7 天</option>
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending ? '生成中…' : '生成邀请并发送邮件'}
                  </button>
                </form>

                {created ? (
                  <div className="team-invite-created">
                    <div>
                      <strong>邀请链接已生成</strong>
                      <p className="muted">
                        服务端只保存令牌哈希，此链接关闭后不再显示。请通过可信渠道发给{' '}
                        {created.invite.email}。
                      </p>
                      <p className="muted">
                        邮件状态：{created.mail.message}
                        {created.mail.provider === 'memory'
                          ? '（开发内存邮箱，仅用于本机验证）'
                          : ''}
                        {created.mail.errorCode ? ` · ${created.mail.errorCode}` : ''}
                      </p>
                    </div>
                    <div className="team-invite-link">
                      <input
                        ref={linkInputRef}
                        readOnly
                        value={created.acceptUrl}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() => void handleCopy()}
                      >
                        {copied ? '已复制' : '复制链接'}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="team-invite-list-head">
                  <h4>最近邀请 · {invites.length}</h4>
                  <span className="muted">仅显示最近 50 条</span>
                </div>
                {invites.length === 0 ? (
                  <p className="empty-state">还没有发出邀请。</p>
                ) : (
                  <ul className="team-invite-list">
                    {invites.map((invite: InviteView) => (
                      <li key={invite.id} className="team-invite-row">
                        <div className="team-invite-main">
                          <span className="mono">{invite.email}</span>
                          <span className="muted">
                            {ROLE_LABELS[invite.role]} · 由 {invite.invitedBy.name} 邀请于{' '}
                            {formatDateTime(invite.createdAt)} · 到期{' '}
                            {formatDateTime(invite.expiresAt)}
                          </span>
                        </div>
                        <div className="team-invite-actions">
                          <Badge tone={inviteTone(invite.status)}>
                            {INVITE_STATUS_LABELS[invite.status]}
                          </Badge>
                          {invite.status === 'pending' ? (
                            <button
                              type="button"
                              className="button button-quiet button-small"
                              disabled={busyInviteId === invite.id}
                              onClick={() => {
                                setBusyInviteId(invite.id);
                                setError(null);
                                setNotice(null);
                                revokeMutation.mutate(invite.id);
                              }}
                            >
                              {busyInviteId === invite.id ? '撤销中…' : '撤销'}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <span className="commit-foot-hint">
            邀请令牌以 SHA-256 哈希存库；邮件只记录投递元数据，正文与令牌不入库。
          </span>
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
