import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  acceptInviteSchema,
  createInviteSchema,
  updateMemberRoleSchema,
} from '@yunshuo/contracts';
import { findSession, readSessionId, requireAuth, setSessionCookie } from '../auth.js';
import { AppError, badRequest } from '../errors.js';
import {
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from '../login-rate-limit.js';
import {
  acceptInvite,
  createInvite,
  listInvites,
  listMembers,
  previewInvite,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from '../services/identity-service.js';

function checkedToken(request: FastifyRequest): string {
  const token = (request.params as { token?: string }).token ?? '';
  if (token.length < 20 || token.length > 200) {
    throw badRequest('INVITE_INVALID', '邀请链接无效');
  }
  return token;
}

async function optionalSession(
  request: FastifyRequest,
): Promise<{ userId: string; sessionId: string } | null> {
  const sessionId = readSessionId(request);
  if (!sessionId) return null;
  const me = await findSession(sessionId);
  return me ? { userId: me.user.id, sessionId } : null;
}

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/invites/:token', async (request) => {
    return previewInvite(checkedToken(request));
  });

  app.post('/api/invites/:token/accept', async (request, reply) => {
    const body = acceptInviteSchema.parse(request.body ?? {});
    const token = checkedToken(request);
    const session = await optionalSession(request);
    const passwordAttempt = !session && body.password !== undefined;
    const rateLimitKey = `invite-accept|${token}|${request.ip}`;
    if (passwordAttempt) assertLoginAllowed(rateLimitKey);
    try {
      const result = await acceptInvite(token, body, session);
      if (passwordAttempt) clearLoginFailures(rateLimitKey);
      setSessionCookie(reply, result.sessionId);
      return result.me;
    } catch (error) {
      if (passwordAttempt && error instanceof AppError && error.code === 'LOGIN_FAILED') {
        recordLoginFailure(rateLimitKey);
      }
      throw error;
    }
  });

  app.get('/api/workspace/members', async (request) => {
    const auth = await requireAuth(request);
    return { members: await listMembers(auth) };
  });

  app.patch('/api/workspace/members/:userId', async (request) => {
    const auth = await requireAuth(request);
    const body = updateMemberRoleSchema.parse(request.body);
    const userId = (request.params as { userId: string }).userId;
    return updateMemberRole(auth, userId, body.role);
  });

  app.delete('/api/workspace/members/:userId', async (request) => {
    const auth = await requireAuth(request);
    const userId = (request.params as { userId: string }).userId;
    await removeMember(auth, userId);
    return { ok: true };
  });

  app.get('/api/workspace/invites', async (request) => {
    const auth = await requireAuth(request);
    return { invites: await listInvites(auth) };
  });

  app.post('/api/workspace/invites', async (request, reply) => {
    const auth = await requireAuth(request);
    const body = createInviteSchema.parse(request.body);
    reply.code(201);
    return createInvite(auth, body);
  });

  app.delete('/api/workspace/invites/:inviteId', async (request) => {
    const auth = await requireAuth(request);
    const inviteId = (request.params as { inviteId: string }).inviteId;
    await revokeInvite(auth, inviteId);
    return { ok: true };
  });
}
