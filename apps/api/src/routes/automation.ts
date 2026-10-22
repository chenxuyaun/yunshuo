import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  automationJobInputSchema,
  automationMandateInputSchema,
} from '@yunshuo/contracts';
import { requireAuth } from '../auth.js';
import {
  createJob,
  createMandate,
  getJob,
  listJobs,
  listMandates,
  pauseJob,
  preflightAutomation,
  resumeJob,
  revokeMandate,
  stopJob,
} from '../services/automation-service.js';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ workId: z.string().uuid().optional() });

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/automation/mandates', async (request) => {
    const auth = await requireAuth(request);
    const query = listQuery.parse(request.query ?? {});
    return { mandates: await listMandates(auth, query.workId) };
  });

  app.post('/api/automation/mandates', async (request) => {
    const auth = await requireAuth(request);
    const input = automationMandateInputSchema.parse(request.body);
    return createMandate(auth, input);
  });

  app.post('/api/automation/mandates/:id/revoke', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return revokeMandate(auth, id);
  });

  app.post('/api/automation/preflight', async (request) => {
    const auth = await requireAuth(request);
    const input = automationJobInputSchema.parse(request.body);
    return preflightAutomation(auth, input);
  });

  app.get('/api/automation/jobs', async (request) => {
    const auth = await requireAuth(request);
    const query = listQuery.parse(request.query ?? {});
    return { jobs: await listJobs(auth, query.workId) };
  });

  app.post('/api/automation/jobs', async (request) => {
    const auth = await requireAuth(request);
    const input = automationJobInputSchema.parse(request.body);
    return createJob(auth, input);
  });

  app.get('/api/automation/jobs/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return getJob(auth, id);
  });

  app.post('/api/automation/jobs/:id/pause', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return pauseJob(auth, id);
  });

  app.post('/api/automation/jobs/:id/resume', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return resumeJob(auth, id);
  });

  app.post('/api/automation/jobs/:id/stop', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return stopJob(auth, id);
  });
}
