import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  commitSchema,
  createWaiverSchema,
  decideWaiverSchema,
  importChaptersSchema,
  rollbackSchema,
  saveDraftSchema,
  stageDraftSchema,
} from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth, type AuthContext } from '../auth.js';
import {
  abandonRevision,
  acquireLease,
  evaluateChapterGates,
  getAudits,
  getChapter,
  getVersion,
  listChapters,
  listVersions,
  releaseLease,
  saveDraft,
  stageDraft,
  startRevision,
  unstageDraft,
} from '../services/chapter-service.js';
import { importChapters } from '../services/chapter-import-service.js';
import { commitChapter } from '../services/commit-service.js';
import { rollbackChapter } from '../services/rollback-service.js';
import { decideWaiver, requestWaiver } from '../services/waiver-service.js';

const idParams = z.object({ id: z.string().uuid() });
const versionParams = z.object({ versionId: z.string().uuid() });
const waiverParams = z.object({ id: z.string().uuid(), waiverId: z.string().uuid() });

async function chapterAuth(request: FastifyRequest): Promise<AuthContext> {
  const auth = await requireAuth(request);
  assertCanReadManuscript(auth.role);
  return auth;
}

export async function chapterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chapters', async (request) => {
    const auth = await chapterAuth(request);
    return listChapters(auth);
  });

  app.post(
    '/api/chapters/import',
    { bodyLimit: 20 * 1024 * 1024 },
    async (request) => {
      const auth = await chapterAuth(request);
      const body = importChaptersSchema.parse(request.body);
      return importChapters(auth, body);
    },
  );

  app.get('/api/chapters/:id', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return getChapter(auth, id);
  });

  app.get('/api/chapters/:id/versions', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return listVersions(auth, id);
  });

  app.get('/api/versions/:versionId', async (request) => {
    const auth = await chapterAuth(request);
    const { versionId } = versionParams.parse(request.params);
    return getVersion(auth, versionId);
  });

  app.post('/api/chapters/:id/lease', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return acquireLease(auth, id);
  });

  app.delete('/api/chapters/:id/lease', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    await releaseLease(auth, id);
    return { ok: true };
  });

  app.put('/api/chapters/:id/draft', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = saveDraftSchema.parse(request.body);
    return saveDraft(auth, id, body.content);
  });

  app.post('/api/chapters/:id/gates', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return evaluateChapterGates(auth, id);
  });

  app.get('/api/chapters/:id/audits', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return getAudits(auth, id);
  });

  app.post('/api/chapters/:id/stage', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = stageDraftSchema.parse(request.body);
    return stageDraft(auth, id, body.evaluationId, body.expectedContentHash);
  });

  app.delete('/api/chapters/:id/stage', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    await unstageDraft(auth, id);
    return { ok: true, status: 'writing' };
  });

  app.post('/api/chapters/:id/commit', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = commitSchema.parse(request.body);
    return commitChapter(auth, id, body);
  });

  app.post('/api/chapters/:id/revision', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return startRevision(auth, id);
  });

  app.post('/api/chapters/:id/revision/abandon', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    return abandonRevision(auth, id);
  });

  app.post('/api/chapters/:id/rollback', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = rollbackSchema.parse(request.body);
    return rollbackChapter(auth, id, body);
  });

  app.post('/api/chapters/:id/waivers', async (request) => {
    const auth = await chapterAuth(request);
    const { id } = idParams.parse(request.params);
    const body = createWaiverSchema.parse(request.body);
    return requestWaiver(auth, id, body);
  });

  app.post('/api/chapters/:id/waivers/:waiverId/approve', async (request) => {
    const auth = await chapterAuth(request);
    const { id, waiverId } = waiverParams.parse(request.params);
    const body = decideWaiverSchema.parse(request.body ?? {});
    return decideWaiver(auth, id, waiverId, 'approved', body.note);
  });

  app.post('/api/chapters/:id/waivers/:waiverId/reject', async (request) => {
    const auth = await chapterAuth(request);
    const { id, waiverId } = waiverParams.parse(request.params);
    const body = decideWaiverSchema.parse(request.body ?? {});
    return decideWaiver(auth, id, waiverId, 'rejected', body.note);
  });
}
