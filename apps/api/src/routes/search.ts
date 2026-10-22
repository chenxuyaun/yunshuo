import type { FastifyInstance } from 'fastify';
import { searchCanonSchema } from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth } from '../auth.js';
import { searchCanon } from '../services/search-service.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (request) => {
    const auth = await requireAuth(request);
    assertCanReadManuscript(auth.role);
    const input = searchCanonSchema.parse(request.query ?? {});
    const outcome = await searchCanon({
      workspaceId: auth.workspace.id,
      query: input.q,
      workId: input.workId,
      excludeChapterId: input.excludeChapterId,
      mode: input.mode,
      limit: input.limit,
    });
    return outcome.response;
  });
}
