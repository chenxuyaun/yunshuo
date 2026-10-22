import { randomBytes, randomUUID } from 'node:crypto';
import { jsonValue, sql } from '@yunshuo/db';
import type { ChangePasswordResponse, PasswordResetRequestResponse } from '@yunshuo/contracts';
import { sha256 } from '@yunshuo/domain';
import type { AuthContext } from '../auth.js';
import { env } from '../env.js';
import { badRequest, conflict } from '../errors.js';
import {
  assertLoginAllowed,
  assertRateLimit,
  clearLoginFailures,
  clearRateLimit,
  recordLoginFailure,
  recordRateLimitHit,
} from '../login-rate-limit.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { sendMail } from './mail-service.js';

export interface RequestSecurityContext {
  ip: string | null;
  userAgent: string | null;
}

const RESET_TTL_MS = 30 * 60 * 1000;
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const RESET_COMPLETE_WINDOW_MS = 15 * 60 * 1000;

const GENERIC_RESET_MESSAGE =
  '如果该邮箱对应可登录账号，我们已发送重置链接；链接 30 分钟内有效。';

function userAgentOf(request: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const raw = request.headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value.trim().slice(0, 300) : null;
}

export function requestSecurityContext(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): RequestSecurityContext {
  return { ip: request.ip || null, userAgent: userAgentOf(request) };
}

async function recordEvent(input: {
  userId: string | null;
  action: 'password.change' | 'password.reset.request' | 'password.reset.complete';
  result: 'success' | 'failure';
  context: RequestSecurityContext;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO auth_events (user_id, action, result, ip, user_agent, metadata)
    VALUES (
      ${input.userId}, ${input.action}, ${input.result}, ${input.context.ip},
      ${input.context.userAgent}, ${sql.json(jsonValue(input.metadata ?? {}))}
    )
  `.catch(() => undefined);
}

export async function changePassword(
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string },
  context: RequestSecurityContext,
): Promise<ChangePasswordResponse> {
  const limitKey = `password-change|${auth.user.id}|${context.ip ?? 'unknown'}`;
  assertLoginAllowed(limitKey, '当前密码尝试次数过多，请稍后再试');

  const rows = await sql<{ password_hash: string | null }[]>`
    SELECT password_hash FROM users WHERE id = ${auth.user.id} AND kind = 'human'
  `;
  const stored = rows[0]?.password_hash;
  if (!stored) {
    throw conflict(
      'PASSWORD_NOT_SET',
      '该账号尚未设置密码；请使用邀请链接或密码重置来设置密码',
    );
  }

  const valid = await verifyPassword(input.currentPassword, stored);
  if (!valid) {
    recordLoginFailure(limitKey);
    await recordEvent({
      userId: auth.user.id,
      action: 'password.change',
      result: 'failure',
      context,
      metadata: { reason: 'current_password_invalid' },
    });
    throw badRequest('CURRENT_PASSWORD_INVALID', '当前密码不正确');
  }
  if (input.newPassword === input.currentPassword) {
    throw badRequest('PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
  }

  clearLoginFailures(limitKey);
  const nextHash = await hashPassword(input.newPassword);

  const revokedOtherSessions = await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE users
      SET password_hash = ${nextHash}, password_updated_at = now()
      WHERE id = ${auth.user.id} AND kind = 'human' AND password_hash = ${stored}
      RETURNING id
    `;
    if (updated.length === 0) {
      throw conflict('PASSWORD_CHANGED_CONCURRENTLY', '密码已被其他会话修改，请重新登录');
    }

    const deleted = await tx`
      DELETE FROM sessions
      WHERE user_id = ${auth.user.id} AND id <> ${auth.sessionId}
      RETURNING id
    `;
    await tx`
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE user_id = ${auth.user.id} AND used_at IS NULL
    `;
    await tx`
      INSERT INTO auth_events (user_id, action, result, ip, user_agent, metadata)
      VALUES (
        ${auth.user.id}, 'password.change', 'success', ${context.ip},
        ${context.userAgent},
        ${tx.json(jsonValue({ revokedOtherSessions: deleted.length }))}
      )
    `;
    return deleted.length;
  });

  return { ok: true, revokedOtherSessions };
}

export async function requestPasswordReset(
  emailInput: string,
  context: RequestSecurityContext,
): Promise<PasswordResetRequestResponse> {
  const email = emailInput.trim().toLowerCase();
  const ip = context.ip ?? 'unknown';
  const ipKey = `password-reset-ip|${ip}`;
  const accountKey = `password-reset|${email}|${ip}`;
  assertRateLimit(
    ipKey,
    30,
    RESET_REQUEST_WINDOW_MS,
    'RESET_RATE_LIMITED',
    '重置请求过于频繁，请稍后再试',
  );
  assertRateLimit(
    accountKey,
    5,
    RESET_REQUEST_WINDOW_MS,
    'RESET_RATE_LIMITED',
    '该邮箱重置请求过于频繁，请稍后再试',
  );
  recordRateLimitHit(ipKey, RESET_REQUEST_WINDOW_MS);
  recordRateLimitHit(accountKey, RESET_REQUEST_WINDOW_MS);

  const rows = await sql<{ id: string; email: string }[]>`
    SELECT u.id, u.email
    FROM users u
    WHERE lower(u.email) = ${email}
      AND u.kind = 'human'
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
    LIMIT 1
  `;
  const account = rows[0];
  const devMailbox = env.devAuth && env.mail.mode === 'memory';
  if (!account) {
    return { ok: true, message: GENERIC_RESET_MESSAGE, devMailbox };
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await sql.begin(async (tx) => {
    await tx`
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE user_id = ${account.id} AND used_at IS NULL
    `;
    await tx`
      INSERT INTO password_reset_tokens (id, user_id, token_hash, requested_ip, expires_at)
      VALUES (${randomUUID()}, ${account.id}, ${tokenHash}, ${context.ip}, ${expiresAt})
    `;
  });

  const resetUrl = `${env.webOrigin.replace(/\/+$/, '')}/reset/${token}`;
  let mailStatus = 'failed';
  let mailProvider = env.mail.mode;
  try {
    const delivery = await sendMail({
      to: account.email,
      subject: '重置你的云说密码',
      text: [
        '我们收到了重置该账号密码的请求。',
        `重置链接（30 分钟内有效）：${resetUrl}`,
        '',
        '如果这不是你本人操作，请忽略本邮件，密码不会改变。',
      ].join('\n'),
      template: 'password_reset',
      userId: account.id,
    });
    mailStatus = delivery.status;
    mailProvider = delivery.provider;
  } catch {
    mailStatus = 'failed';
  }

  await recordEvent({
    userId: account.id,
    action: 'password.reset.request',
    result: 'success',
    context,
    metadata: { mailStatus, mailProvider },
  });

  return { ok: true, message: GENERIC_RESET_MESSAGE, devMailbox };
}

export async function completePasswordReset(
  token: string,
  newPassword: string,
  context: RequestSecurityContext,
): Promise<{ ok: true }> {
  const limitKey = `password-reset-complete|${context.ip ?? 'unknown'}`;
  assertRateLimit(
    limitKey,
    20,
    RESET_COMPLETE_WINDOW_MS,
    'RESET_RATE_LIMITED',
    '重置尝试过于频繁，请稍后再试',
  );

  const tokenHash = sha256(token);
  const rows = await sql<
    { id: string; user_id: string; expires_at: Date | string; used_at: Date | string | null }[]
  >`
    SELECT t.id, t.user_id, t.expires_at, t.used_at
    FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${tokenHash} AND u.kind = 'human'
    LIMIT 1
  `;
  const found = rows[0];
  if (!found || found.used_at || new Date(found.expires_at).getTime() <= Date.now()) {
    recordRateLimitHit(limitKey, RESET_COMPLETE_WINDOW_MS);
    if (found && !found.used_at) {
      await sql`
        UPDATE password_reset_tokens SET used_at = now()
        WHERE id = ${found.id} AND used_at IS NULL
      `;
    }
    throw badRequest('RESET_TOKEN_INVALID', '重置链接无效或已过期');
  }

  const nextHash = await hashPassword(newPassword);

  await sql.begin(async (tx) => {
    const locked = await tx<
      {
        id: string;
        user_id: string;
        expires_at: Date | string;
        used_at: Date | string | null;
        kind: string;
      }[]
    >`
      SELECT t.id, t.user_id, t.expires_at, t.used_at, u.kind
      FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
      FOR UPDATE OF t
    `;
    const tokenRow = locked[0];
    if (
      !tokenRow ||
      tokenRow.kind !== 'human' ||
      tokenRow.used_at ||
      new Date(tokenRow.expires_at).getTime() <= Date.now()
    ) {
      throw badRequest('RESET_TOKEN_INVALID', '重置链接无效或已过期');
    }

    await tx`
      UPDATE users
      SET password_hash = ${nextHash}, password_updated_at = now()
      WHERE id = ${tokenRow.user_id} AND kind = 'human'
    `;
    await tx`
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE user_id = ${tokenRow.user_id} AND used_at IS NULL
    `;
    const deleted = await tx`
      DELETE FROM sessions WHERE user_id = ${tokenRow.user_id} RETURNING id
    `;
    await tx`
      INSERT INTO auth_events (user_id, action, result, ip, user_agent, metadata)
      VALUES (
        ${tokenRow.user_id}, 'password.reset.complete', 'success', ${context.ip},
        ${context.userAgent},
        ${tx.json(jsonValue({ revokedSessions: deleted.length }))}
      )
    `;
  });

  clearRateLimit(limitKey);
  return { ok: true };
}
