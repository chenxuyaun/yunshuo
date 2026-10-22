import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from '@yunshuo/db';
import type { Role } from '@yunshuo/domain';
import type { MeResponse, WorkspaceMembershipView } from '@yunshuo/contracts';
import { AppError, forbidden, unauthorized } from './errors.js';
import { env } from './env.js';

export const SESSION_COOKIE = 'yunshuo_session';
const SESSION_DAYS = 7;

export interface AutomationActor {
  jobId: string;
  mandateId: string;
}

export interface AuthContext extends MeResponse {
  sessionId: string;
  automation?: AutomationActor;
}

export function actorKindOf(auth: AuthContext): 'human' | 'ai' {
  return auth.automation ? 'ai' : 'human';
}

interface AuthRow {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  workspace_id: string;
  workspace_name: string;
  settings_version: number;
  ledger_version: number;
}

function toMe(row: AuthRow): MeResponse {
  return {
    user: { id: row.user_id, email: row.email, name: row.name },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      settingsVersion: row.settings_version,
      ledgerVersion: row.ledger_version,
    },
    role: row.role,
  };
}

export function readSessionId(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return unsigned.value;
}

async function identityForUser(userId: string): Promise<AuthRow | null> {
  const rows = await sql<AuthRow[]>`
    SELECT
      u.id AS user_id, u.email, u.name, m.role,
      w.id AS workspace_id, w.name AS workspace_name,
      w.settings_version, w.ledger_version
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE u.id = ${userId} AND u.kind = 'human'
    ORDER BY m.created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function identityForUserInWorkspace(
  userId: string,
  workspaceId: string,
): Promise<AuthRow | null> {
  const rows = await sql<AuthRow[]>`
    SELECT
      u.id AS user_id, u.email, u.name, m.role,
      w.id AS workspace_id, w.name AS workspace_name,
      w.settings_version, w.ledger_version
    FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ${workspaceId}
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE u.id = ${userId} AND u.kind = 'human'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createSessionForUser(
  userId: string,
  workspaceId: string | null,
  authMethod: 'dev' | 'password' | 'oidc',
): Promise<{ sessionId: string; me: MeResponse }> {
  const row = workspaceId
    ? await identityForUserInWorkspace(userId, workspaceId)
    : await identityForUser(userId);
  if (!row) {
    throw unauthorized('该账号不属于任何工作区，请使用邀请链接加入');
  }

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO sessions (id, user_id, workspace_id, auth_method, expires_at)
      VALUES (${sessionId}, ${row.user_id}, ${row.workspace_id}, ${authMethod}, ${expiresAt})
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${row.workspace_id}, ${row.user_id}, 'human', ${row.role}, 'auth.login',
        'session', NULL, 'success', ${tx.json({ method: authMethod })}
      )
    `;
  });

  return { sessionId, me: toMe(row) };
}

export async function createDevSession(email: string): Promise<{ sessionId: string; me: MeResponse }> {
  const rows = await sql<{ id: string }[]>`
    SELECT u.id
    FROM users u
    WHERE lower(u.email) = lower(${email}) AND u.kind = 'human'
    LIMIT 1
  `;
  const userId = rows[0]?.id;
  if (!userId) {
    throw new AppError(401, 'LOGIN_FAILED', '该开发账号不存在或不属于任何工作区');
  }
  return createSessionForUser(userId, null, 'dev');
}

export async function findSession(sessionId: string): Promise<MeResponse | null> {
  const rows = await sql<AuthRow[]>`
    SELECT
      u.id AS user_id, u.email, u.name, m.role,
      w.id AS workspace_id, w.name AS workspace_name,
      w.settings_version, w.ledger_version
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE s.id = ${sessionId} AND s.expires_at > now() AND u.kind = 'human'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? toMe(row) : null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}

export async function listUserWorkspaces(userId: string): Promise<WorkspaceMembershipView[]> {
  const rows = await sql<{ id: string; name: string; role: Role }[]>`
    SELECT w.id, w.name, m.role
    FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${userId} AND m.role <> 'ai'
    ORDER BY m.created_at ASC
  `;
  return rows
    .filter((row) => row.role !== 'ai')
    .map((row) => ({ id: row.id, name: row.name, role: row.role as WorkspaceMembershipView['role'] }));
}

export async function switchSessionWorkspace(
  sessionId: string,
  userId: string,
  workspaceId: string,
): Promise<MeResponse> {
  const row = await identityForUserInWorkspace(userId, workspaceId);
  if (!row) throw forbidden('你不属于该工作区');
  const updated = await sql`
    UPDATE sessions SET workspace_id = ${workspaceId}
    WHERE id = ${sessionId} AND user_id = ${userId}
    RETURNING id
  `;
  if (updated.length === 0) throw unauthorized('会话已过期，请重新登录');
  return toMe(row);
}

export async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const sessionId = readSessionId(req);
  if (!sessionId) throw unauthorized();
  const me = await findSession(sessionId);
  if (!me) throw unauthorized('会话已过期，请重新登录');
  return { ...me, sessionId };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    secure: env.cookieSecure,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function assertCanReadManuscript(role: Role): void {
  if (role === 'billing') {
    throw forbidden('计费管理员只能访问计费报表、预算与价表，不能读取作品正文、草稿或检索内容');
  }
}

export function canWrite(role: Role): boolean {
  return role === 'owner' || role === 'lead' || role === 'author' || role === 'ai';
}

export function assertCanWrite(role: Role): void {
  if (!canWrite(role)) {
    throw new AppError(403, 'FORBIDDEN', '当前角色只能阅读或审阅，不能写入');
  }
}
