import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  planRevisionQuerySchema,
  resolveBodyRevisionSchema,
  updateChapterPlanSchema,
} from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth, type AuthContext } from '../auth.js';
import {
  listPlanRevisions,
  resolveBodyRevision,
  updateChapterPlan,
} from '../services/plan-service.js';

const idParams = z.object({ id: z.string().uuid() });

async function chapterAuth(request: FastifyRequest): Promise<AuthContext> {
  const auth = await requireAuth(request);
  assertCanReadManuscript(auth.role);
  return auth;
}

export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/chapters/:id/plan', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = updateChapterPlanSchema.parse(request.body);
    return updateChapterPlan(auth, id, body);
  });

  app.get('/api/chapters/:id/plan/revisions', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const query = planRevisionQuerySchema.parse(request.query ?? {});
    return listPlanRevisions(auth, id, query);
  });

  app.post('/api/chapters/:id/plan/body-revision/resolve', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = resolveBodyRevisionSchema.parse(request.body);
    return resolveBodyRevision(auth, id, body);
  });
}
