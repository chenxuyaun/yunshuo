import type { FastifyInstance } from 'fastify';
import { sql } from '@yunshuo/db';
import { loginSchema, switchWorkspaceSchema } from '@yunshuo/contracts';
import type { DevMailboxResponse } from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import {
  clearSessionCookie,
  createDevSession,
  createSessionForUser,
  deleteSession,
  listUserWorkspaces,
  readSessionId,
  requireAuth,
  setSessionCookie,
  switchSessionWorkspace,
} from '../auth.js';
import { env } from '../env.js';
import { AppError, notFound } from '../errors.js';
import {
  assertLoginAllowed,
  clearLoginFailures,
  loginRateLimitKey,
  recordLoginFailure,
} from '../login-rate-limit.js';
import { verifyDummyPassword, verifyPassword } from '../passwords.js';
import { listMemoryMailbox } from '../services/mail-service.js';
import {
  beginOidcLogin,
  completeOidcLogin,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
} from '../services/oidc-service.js';

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function webRedirect(code?: string): string {
  const url = new URL('/', env.webOrigin);
  if (code) url.searchParams.set('oidc_error', code);
  return url.toString();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      oidcEnabled: env.oidc.enabled,
      oidcProviderName: env.oidc.providerName,
      oidcAutoProvision: env.oidc.autoProvision,
    };
  });

  app.get('/api/auth/oidc/start', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const { authorizationUrl, stateCookie } = await beginOidcLogin();
    reply.setCookie(OIDC_STATE_COOKIE, stateCookie, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: OIDC_STATE_COOKIE_PATH,
      maxAge: 600,
      secure: env.cookieSecure,
    });
    return reply.redirect(authorizationUrl);
  });

  app.get('/api/auth/oidc/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const rawState = request.cookies[OIDC_STATE_COOKIE];
    const unsigned = rawState ? request.unsignCookie(rawState) : null;
    reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_STATE_COOKIE_PATH });

    const query = request.query as Record<string, unknown>;
    try {
      const { sessionId } = await completeOidcLogin({
        code: queryString(query.code),
        state: queryString(query.state),
        error: queryString(query.error),
        stateCookie: unsigned?.valid ? unsigned.value : null,
      });
      setSessionCookie(reply, sessionId);
      return reply.redirect(webRedirect());
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'OIDC_LOGIN_FAILED';
      request.log.warn({ code }, 'OIDC 登录失败');
      return reply.redirect(webRedirect(code));
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    if (body.password !== undefined) {
      const email = body.email.trim().toLowerCase();
      const key = loginRateLimitKey(email, request.ip);
      assertLoginAllowed(key);

      const rows = await sql<{ id: string; password_hash: string | null }[]>`
        SELECT id, password_hash
        FROM users
        WHERE lower(email) = ${email} AND kind = 'human'
        LIMIT 1
      `;
      const account = rows[0];
      const valid = account?.password_hash
        ? await verifyPassword(body.password, account.password_hash)
        : (await verifyDummyPassword(body.password), false);
      if (!valid || !account) {
        recordLoginFailure(key);
        throw new AppError(401, 'LOGIN_FAILED', '邮箱或密码不正确');
      }

      clearLoginFailures(key);
      const { sessionId, me } = await createSessionForUser(account.id, null, 'password');
      setSessionCookie(reply, sessionId);
      return me;
    }

    if (!env.devAuth) {
      throw new AppError(400, 'PASSWORD_REQUIRED', '此部署未启用开发登录，请填写邮箱和密码');
    }
    const { sessionId, me } = await createDevSession(body.email);
    setSessionCookie(reply, sessionId);
    return me;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = readSessionId(request);
    if (sessionId) await deleteSession(sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const auth = await requireAuth(request);
    return { user: auth.user, workspace: auth.workspace, role: auth.role };
  });

  app.get('/api/auth/workspaces', async (request) => {
    const auth = await requireAuth(request);
    return { workspaces: await listUserWorkspaces(auth.user.id) };
  });

  app.post('/api/auth/workspace', async (request) => {
    const auth = await requireAuth(request);
    const body = switchWorkspaceSchema.parse(request.body);
    return switchSessionWorkspace(auth.sessionId, auth.user.id, body.workspaceId);
  });

  app.get('/api/dev/mailbox', async (): Promise<DevMailboxResponse> => {
    if (!env.devAuth || env.mail.mode !== 'memory') {
      throw notFound('DEV_MAILBOX_DISABLED', '开发内存邮箱未启用');
    }
    // 内存里那条是完整投递入参（还带工作区与用户的内部 id，服务层用例要用），接口面只给
    // 契约声明的六个键：多出去的内部 id 对这个"登录页也能读"的端点没有任何用处。
    return {
      mode: 'memory' as const,
      delivered: false as const,
      messages: listMemoryMailbox().map(({ id, to, subject, text, template, createdAt }) => ({
        id,
        to,
        subject,
        text,
        template,
        createdAt,
      })),
    };
  });

  app.get('/api/dev/users', async () => {
    if (!env.devAuth) {
      throw notFound('DEV_AUTH_DISABLED', '开发登录未启用');
    }
    const rows = await sql<{ id: string; email: string; name: string; role: Role }[]>`
      SELECT u.id, u.email, u.name, m.role
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      WHERE u.kind = 'human'
      ORDER BY m.created_at ASC, u.email ASC
    `;
    return rows;
  });
}
