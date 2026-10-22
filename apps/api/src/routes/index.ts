import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reindexWorkspaceSchema } from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth } from '../auth.js';
import { reindexChapter, reindexWorkspace } from '../services/index-service.js';

const idParams = z.object({ id: z.string().uuid() });

export async function indexRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/chapters/:id/reindex', async (request) => {
    const auth = await requireAuth(request);
    assertCanReadManuscript(auth.role);
    const { id } = idParams.parse(request.params);
    return reindexChapter(auth, id);
  });

  app.post('/api/index/reindex', async (request) => {
    const auth = await requireAuth(request);
    assertCanReadManuscript(auth.role);
    const input = reindexWorkspaceSchema.parse(request.body ?? {});
    return reindexWorkspace(auth, input.workId);
  });
}
