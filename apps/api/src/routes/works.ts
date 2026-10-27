import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createChapterSchema,
  createVolumeSchema,
  createWorkSchema,
  renameVolumeSchema,
  renameWorkSchema,
  reorderVolumesSchema,
  updateChapterMetaSchema,
} from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth, type AuthContext } from '../auth.js';
import {
  createChapter,
  createVolume,
  createWork,
  listWorks,
  renameVolume,
  renameWork,
  reorderVolumes,
  updateChapterMeta,
} from '../services/work-structure-service.js';

const idParams = z.object({ id: z.string().uuid() });

async function manuscriptAuth(request: FastifyRequest): Promise<AuthContext> {
  const auth = await requireAuth(request);
  assertCanReadManuscript(auth.role);
  return auth;
}

export async function workRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/works', async (request) => {
    const auth = await manuscriptAuth(request);
    return listWorks(auth);
  });

  app.post('/api/works', async (request) => {
    const auth = await manuscriptAuth(request);
    const body = createWorkSchema.parse(request.body);
    return createWork(auth, body);
  });

  app.patch('/api/works/:id', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = renameWorkSchema.parse(request.body);
    return renameWork(auth, id, body);
  });

  app.post('/api/works/:id/volumes', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = createVolumeSchema.parse(request.body);
    return createVolume(auth, id, body);
  });

  app.patch('/api/volumes/:id', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = renameVolumeSchema.parse(request.body);
    return renameVolume(auth, id, body);
  });

  app.put('/api/works/:id/volumes/order', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = reorderVolumesSchema.parse(request.body);
    return reorderVolumes(auth, id, body);
  });

  app.post('/api/works/:id/chapters', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = createChapterSchema.parse(request.body);
    return createChapter(auth, id, body);
  });

  app.patch('/api/chapters/:id', async (request) => {
    const auth = await manuscriptAuth(request);
    const { id } = idParams.parse(request.params);
    const body = updateChapterMetaSchema.parse(request.body);
    return updateChapterMeta(auth, id, body);
  });
}
