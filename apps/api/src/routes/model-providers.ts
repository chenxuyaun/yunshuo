import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createModelProviderSchema,
  discoverModelsSchema,
  probeEmbeddingSchema,
  updateModelProviderSchema,
} from '@yunshuo/contracts';
import { requireAuth } from '../auth.js';
import {
  createProvider,
  deleteProvider,
  discoverModels,
  listProviders,
  probeEmbedding,
  testProvider,
  updateProvider,
} from '../services/provider-service.js';

const idParams = z.object({ id: z.string().uuid() });

export async function modelProviderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/model-providers', async (request) => {
    const auth = await requireAuth(request);
    return listProviders(auth);
  });

  app.post('/api/model-providers', async (request) => {
    const auth = await requireAuth(request);
    const input = createModelProviderSchema.parse(request.body);
    return createProvider(auth, input);
  });

  app.post('/api/model-providers/discover-models', async (request) => {
    const auth = await requireAuth(request);
    const input = discoverModelsSchema.parse(request.body);
    return discoverModels(auth, input);
  });

  app.post('/api/model-providers/probe-embedding', async (request) => {
    const auth = await requireAuth(request);
    const input = probeEmbeddingSchema.parse(request.body);
    return probeEmbedding(auth, input);
  });

  app.patch('/api/model-providers/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = updateModelProviderSchema.parse(request.body);
    return updateProvider(auth, id, input);
  });

  app.delete('/api/model-providers/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    await deleteProvider(auth, id);
    return { ok: true };
  });

  app.post('/api/model-providers/:id/test', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return testProvider(auth, id);
  });
}
