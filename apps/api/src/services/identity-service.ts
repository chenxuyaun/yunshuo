import { randomBytes, randomUUID } from 'node:crypto';
import { jsonValue, sql } from '@yunshuo/db';
import {
  canInviteRole,
  canManageMembers,
  canViewMembers,
  sha256,
  type HumanRole,
  type Role,
} from '@yunshuo/domain';
import type {
  CreateInviteResponse,
  InviteStatus,
  InviteView,
  MailDeliveryView,
  MemberView,
  MeResponse,
} from '@yunshuo/contracts';
import type { AuthContext } from '../auth.js';
import { createSessionForUser, findSession } from '../auth.js';
import { env } from '../env.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../passwords.js';
import { mailDeliveryMessage, sendMail } from './mail-service.js';

interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: HumanRole;
  token_hash: string;
  invited_by: string;
  inviter_name: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface MemberRow {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  kind: string;
  joined_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function inviteStatus(row: InviteRow): InviteStatus {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function mapInvite(row: InviteRow): InviteView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: inviteStatus(row),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
    invitedBy: { id: row.invited_by, name: row.inviter_name },
  };
}

function mapMember(row: MemberRow): MemberView {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    kind: row.kind === 'ai' ? 'ai' : 'human',
    joinedAt: toIso(row.joined_at),
  };
}

function requireMemberManagement(auth: AuthContext, action: string): void {
  if (!canViewMembers(auth.role)) {
    throw forbidden(`${action}仅限所有者或主笔`);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

export async function createInvite(
  auth: AuthContext,
  input: { email: string; role: HumanRole; expiresInHours: number },
): Promise<CreateInviteResponse> {
  requireMemberManagement(auth, '邀请成员');
  if (!canInviteRole(auth.role, input.role)) {
    throw forbidden('主笔只能邀请作者、审阅者、读者或计费管理员');
  }

  const email = normalizeEmail(input.email);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const inviteId = randomUUID();
  const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);

  const row = await sql.begin(async (tx) => {
    const existing = await tx<{ id: string; kind: string; role: Role | null }[]>`
      SELECT u.id, u.kind, m.role
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ${auth.workspace.id}
      WHERE lower(u.email) = ${email}
      LIMIT 1
    `;
    const account = existing[0];
    if (account?.kind === 'ai') {
      throw conflict('AI_ACCOUNT_NOT_INVITABLE', '该邮箱属于 AI 服务主体，不能被邀请为人类成员');
    }
    if (account?.role) {
      throw conflict('ALREADY_MEMBER', '该邮箱已是本工作区成员');
    }

    await tx`
      UPDATE workspace_invites
      SET revoked_at = now(), revoked_by = ${auth.user.id}
      WHERE workspace_id = ${auth.workspace.id}
        AND lower(email) = ${email}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at <= now()
    `;

    const pending = await tx<{ id: string }[]>`
      SELECT id FROM workspace_invites
      WHERE workspace_id = ${auth.workspace.id}
        AND lower(email) = ${email}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
      LIMIT 1
    `;
    if (pending.length > 0) {
      throw conflict('INVITE_PENDING', '该邮箱已有待接受的邀请；可先撤销再重新邀请');
    }

    const inserted = await tx<Omit<InviteRow, 'inviter_name'>[]>`
      INSERT INTO workspace_invites (
        id, workspace_id, email, role, token_hash, invited_by, expires_at
      )
      VALUES (
        ${inviteId}, ${auth.workspace.id}, ${email}, ${input.role}, ${tokenHash},
        ${auth.user.id}, ${expiresAt}
      )
      RETURNING
        id, workspace_id, email, role, token_hash, invited_by, expires_at,
        accepted_at, revoked_at, created_at
    `;

    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'member.invite.create',
        'workspace_invite', ${inviteId}, 'success',
        ${tx.json(jsonValue({ email, role: input.role, expiresAt: expiresAt.toISOString() }))}
      )
    `;

    return { ...inserted[0]!, inviter_name: auth.user.name };
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw conflict('INVITE_PENDING', '该邮箱已有待接受的邀请；可先撤销再重新邀请');
    }
    throw error;
  });

  const acceptUrl = `${env.webOrigin.replace(/\/+$/, '')}/invite/${token}`;
  const roleLabel: Record<HumanRole, string> = {
    owner: '所有者',
    lead: '主笔',
    author: '作者',
    reviewer: '审阅者',
    viewer: '读者',
    billing: '计费管理员',
  };
  let mail: MailDeliveryView;
  try {
    const delivery = await sendMail({
      to: email,
      subject: `邀请你加入「${auth.workspace.name}」· 云说`,
      text: [
        `${auth.user.name} 邀请你以「${roleLabel[input.role]}」身份加入「${auth.workspace.name}」。`,
        `邀请有效期至 ${expiresAt.toISOString()}。`,
        '',
        `接受邀请：${acceptUrl}`,
        '',
        '若你不认识这次邀请，可以忽略本邮件。',
      ].join('\n'),
      template: 'workspace_invite',
      workspaceId: auth.workspace.id,
      userId: null,
    });
    mail = {
      id: delivery.id,
      provider: delivery.provider,
      status: delivery.status,
      errorCode: delivery.errorCode,
      message: mailDeliveryMessage(delivery),
      sentAt: delivery.sentAt,
    };
  } catch {
    mail = {
      id: '',
      provider: env.mail.mode,
      status: 'failed',
      errorCode: 'MAIL_RECORD_FAILED',
      message: '邀请邮件投递记录失败，链接仍可手动复制',
      sentAt: null,
    };
  }

  return {
    invite: mapInvite(row),
    acceptUrl,
    mail,
  };
}

export async function listInvites(auth: AuthContext): Promise<InviteView[]> {
  requireMemberManagement(auth, '查看邀请');
  const rows = await sql<InviteRow[]>`
    SELECT
      i.id, i.workspace_id, i.email, i.role, i.token_hash, i.invited_by, i.expires_at,
      i.accepted_at, i.revoked_at, i.created_at,
      u.name AS inviter_name
    FROM workspace_invites i
    JOIN users u ON u.id = i.invited_by
    WHERE i.workspace_id = ${auth.workspace.id}
    ORDER BY i.created_at DESC
    LIMIT 50
  `;
  return rows.map(mapInvite);
}

export async function revokeInvite(auth: AuthContext, inviteId: string): Promise<void> {
  requireMemberManagement(auth, '撤销邀请');
  const updated = await sql`
    UPDATE workspace_invites
    SET revoked_at = now(), revoked_by = ${auth.user.id}
    WHERE id = ${inviteId}
      AND workspace_id = ${auth.workspace.id}
      AND accepted_at IS NULL
      AND revoked_at IS NULL
    RETURNING id
  `;
  if (updated.length === 0) {
    throw notFound('INVITE_NOT_FOUND', '邀请不存在、已接受或已撤销');
  }
  await sql`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'member.invite.revoke',
      'workspace_invite', ${inviteId}, 'success', ${sql.json(jsonValue({}))}
    )
  `;
}

export async function previewInvite(token: string): Promise<{
  workspaceName: string;
  email: string;
  role: HumanRole;
  expiresAt: string;
  accountExists: boolean;
}> {
  const rows = await sql<
    (InviteRow & { workspace_name: string; account_exists: boolean })[]
  >`
    SELECT
      i.id, i.workspace_id, i.email, i.role, i.token_hash, i.invited_by, i.expires_at,
      i.accepted_at, i.revoked_at, i.created_at,
      w.name AS workspace_name,
      EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)) AS account_exists
    FROM workspace_invites i
    JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ${sha256(token)}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw notFound('INVITE_INVALID', '邀请链接无效');
  const status = inviteStatus(row);
  if (status === 'accepted' || status === 'revoked') {
    throw new AppError(410, 'INVITE_USED', '邀请已被使用或撤销');
  }
  if (status === 'expired') {
    throw new AppError(410, 'INVITE_EXPIRED', '邀请已过期，请联系管理员重新邀请');
  }
  return {
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    expiresAt: toIso(row.expires_at),
    accountExists: row.account_exists,
  };
}

export async function acceptInvite(
  token: string,
  input: { name?: string; password?: string },
  session: { userId: string; sessionId: string } | null,
): Promise<{ sessionId: string; me: MeResponse }> {
  const tokenHash = sha256(token);

  const result = await sql.begin(async (tx) => {
    const rows = await tx<InviteRow[]>`
      SELECT
        i.id, i.workspace_id, i.email, i.role, i.token_hash, i.invited_by, i.expires_at,
        i.accepted_at, i.revoked_at, i.created_at,
        u.name AS inviter_name
      FROM workspace_invites i
      JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = ${tokenHash}
      FOR UPDATE OF i
    `;
    const invite = rows[0];
    if (!invite) throw notFound('INVITE_INVALID', '邀请链接无效');
    const status = inviteStatus(invite);
    if (status === 'accepted' || status === 'revoked') {
      throw conflict('INVITE_USED', '邀请已被使用或撤销');
    }
    if (status === 'expired') {
      throw new AppError(410, 'INVITE_EXPIRED', '邀请已过期，请联系管理员重新邀请');
    }

    let userId: string;
    let accountCreated = false;

    if (session) {
      const users = await tx<{ id: string; email: string; kind: string }[]>`
        SELECT id, email, kind FROM users WHERE id = ${session.userId}
      `;
      const user = users[0];
      if (!user || user.kind !== 'human') throw forbidden('当前账号不能接受邀请');
      if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
        throw forbidden('当前登录账号与邀请邮箱不一致，请先退出');
      }
      userId = user.id;
    } else {
      const existing = await tx<{ id: string; password_hash: string | null }[]>`
        SELECT id, password_hash FROM users
        WHERE lower(email) = lower(${invite.email}) AND kind = 'human'
        LIMIT 1
      `;
      if (existing.length > 0) {
        const account = existing[0]!;
        if (!input.password) {
          throw conflict('ACCOUNT_EXISTS', '该邮箱已有账号，请先登录后再打开邀请链接');
        }
        const valid = account.password_hash
          ? await verifyPassword(input.password, account.password_hash)
          : (await verifyDummyPassword(input.password), false);
        if (!valid) throw new AppError(401, 'LOGIN_FAILED', '邮箱或密码不正确');
        userId = account.id;
      } else {
        if (!input.name || !input.password) {
          throw badRequest('INVITE_PROFILE_REQUIRED', '请填写称呼和至少 10 位密码');
        }
        const initialHash = await hashPassword(input.password);
        userId = randomUUID();
        try {
          await tx`
            INSERT INTO users (id, email, name, password_hash, password_updated_at)
            VALUES (${userId}, ${normalizeEmail(invite.email)}, ${input.name}, ${initialHash}, now())
          `;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw conflict('ACCOUNT_EXISTS', '该邮箱已有账号，请先登录后再打开邀请链接');
          }
          throw error;
        }
        accountCreated = true;
      }
    }

    const workspaceId = invite.workspace_id;
    const already = await tx<{ role: Role }[]>`
      SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId} LIMIT 1
    `;
    if (already.length > 0) {
      throw conflict('ALREADY_MEMBER', `该账号已是本工作区成员（${already[0]!.role}）`);
    }

    try {
      await tx`
        INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${workspaceId}, ${userId}, ${invite.role})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('ALREADY_MEMBER', '该账号已是本工作区成员');
      }
      throw error;
    }
    await tx`
      UPDATE workspace_invites
      SET accepted_at = now(), accepted_by = ${userId}
      WHERE id = ${invite.id}
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${workspaceId}, ${userId}, 'human', ${invite.role}, 'member.invite.accept',
        'workspace_invite', ${invite.id}, 'success',
        ${tx.json(jsonValue({ email: invite.email, role: invite.role, accountCreated }))}
      )
    `;

    return { userId, workspaceId, role: invite.role };
  });

  if (session) {
    await sql`
      UPDATE sessions SET workspace_id = ${result.workspaceId}
      WHERE id = ${session.sessionId} AND user_id = ${session.userId}
    `;
    const me = await findSession(session.sessionId);
    if (!me) throw forbidden('会话已失效，请重新登录');
    return { sessionId: session.sessionId, me };
  }

  return createSessionForUser(result.userId, result.workspaceId, 'password');
}

export async function listMembers(auth: AuthContext): Promise<MemberView[]> {
  requireMemberManagement(auth, '查看成员');
  const rows = await sql<MemberRow[]>`
    SELECT u.id AS user_id, u.email, u.name, m.role, u.kind, m.created_at AS joined_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${auth.workspace.id}
    ORDER BY m.created_at ASC, u.email ASC
  `;
  return rows.map(mapMember);
}

export async function updateMemberRole(
  auth: AuthContext,
  userId: string,
  role: HumanRole,
): Promise<MemberView> {
  if (!canManageMembers(auth.role)) throw forbidden('只有所有者可以修改成员角色');

  const member = await sql.begin(async (tx) => {
    // 串行化会改变所有者数量的操作，避免并发降级/移除让所有者归零。
    await tx`SELECT id FROM workspaces WHERE id = ${auth.workspace.id} FOR UPDATE`;
    const rows = await tx<MemberRow[]>`
      SELECT u.id AS user_id, u.email, u.name, m.role, u.kind, m.created_at AS joined_at
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${auth.workspace.id} AND m.user_id = ${userId}
      FOR UPDATE OF m
    `;
    const current = rows[0];
    if (!current) throw notFound('MEMBER_NOT_FOUND', '成员不存在');
    if (current.kind === 'ai') throw conflict('AI_MEMBER_IMMUTABLE', 'AI 服务主体由系统管理，不能修改角色');
    if (current.role === role) return current;

    if (current.role === 'owner' && role !== 'owner') {
      const owners = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM memberships
        WHERE workspace_id = ${auth.workspace.id} AND role = 'owner'
      `;
      if (Number(owners[0]!.count) <= 1) {
        throw conflict('LAST_OWNER', '工作区至少需要一名所有者，不能降级最后一名所有者');
      }
    }

    await tx`
      UPDATE memberships SET role = ${role}
      WHERE workspace_id = ${auth.workspace.id} AND user_id = ${userId}
    `;

    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'member.role.update',
        'membership', ${userId}, 'success',
        ${tx.json(jsonValue({ before: current.role, after: role }))}
      )
    `;
    return { ...current, role };
  });

  return mapMember(member);
}

export async function removeMember(auth: AuthContext, userId: string): Promise<void> {
  if (!canManageMembers(auth.role)) throw forbidden('只有所有者可以移除成员');

  await sql.begin(async (tx) => {
    // 串行化会改变所有者数量的操作，避免并发降级/移除让所有者归零。
    await tx`SELECT id FROM workspaces WHERE id = ${auth.workspace.id} FOR UPDATE`;
    const rows = await tx<MemberRow[]>`
      SELECT u.id AS user_id, u.email, u.name, m.role, u.kind, m.created_at AS joined_at
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${auth.workspace.id} AND m.user_id = ${userId}
      FOR UPDATE OF m
    `;
    const member = rows[0];
    if (!member) throw notFound('MEMBER_NOT_FOUND', '成员不存在');
    if (member.kind === 'ai') throw conflict('AI_MEMBER_IMMUTABLE', 'AI 服务主体由系统管理，不能移除');

    if (member.role === 'owner') {
      const owners = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM memberships
        WHERE workspace_id = ${auth.workspace.id} AND role = 'owner'
      `;
      if (Number(owners[0]!.count) <= 1) {
        throw conflict('LAST_OWNER', '工作区至少需要一名所有者，不能移除最后一名所有者');
      }
    }

    await tx`
      DELETE FROM memberships
      WHERE workspace_id = ${auth.workspace.id} AND user_id = ${userId}
    `;
    await tx`
      DELETE FROM sessions
      WHERE user_id = ${userId} AND workspace_id = ${auth.workspace.id}
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'member.remove',
        'membership', ${userId}, 'success',
        ${tx.json(jsonValue({ email: member.email, role: member.role }))}
      )
    `;
  });
}
