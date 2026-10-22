import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  completePasswordResetSchema,
  requestPasswordResetSchema,
} from '@yunshuo/contracts';
import { requireAuth } from '../auth.js';
import {
  changePassword,
  completePasswordReset,
  requestPasswordReset,
  requestSecurityContext,
} from '../services/account-security-service.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/password/change', async (request) => {
    const auth = await requireAuth(request);
    const body = changePasswordSchema.parse(request.body);
    return changePassword(auth, body, requestSecurityContext(request));
  });

  app.post('/api/auth/password/reset-request', async (request, reply) => {
    const body = requestPasswordResetSchema.parse(request.body);
    reply.code(202);
    return requestPasswordReset(body.email, requestSecurityContext(request));
  });

  app.post('/api/auth/password/reset', async (request) => {
    const body = completePasswordResetSchema.parse(request.body);
    return completePasswordReset(body.token, body.newPassword, requestSecurityContext(request));
  });
}
