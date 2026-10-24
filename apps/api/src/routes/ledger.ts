import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  archiveLedgerEntrySchema,
  createLedgerEntrySchema,
  createLedgerSuggestionSchema,
  decideLedgerSuggestionSchema,
  listLedgerEntriesQuerySchema,
  publishLedgerEntrySchema,
  rejectLedgerSuggestionSchema,
  rollbackLedgerEntrySchema,
  updateLedgerDraftSchema,
} from '@yunshuo/contracts';
import { requireAuth } from '../auth.js';
import {
  acceptLedgerSuggestion,
  createLedgerSuggestion,
  listLedgerSuggestions,
  rejectLedgerSuggestion,
} from '../services/ledger-suggestion-service.js';
import {
  archiveLedgerEntry,
  createLedgerEntry,
  getCharacterContext,
  getCharacterTimeline,
  getForeshadowingReminders,
  getForeshadowingReport,
  getLedgerEntry,
  listLedgerEntries,
  listLedgerVersions,
  publishLedgerEntry,
  rollbackLedgerEntry,
  saveLedgerDraft,
} from '../services/ledger-service.js';

const idParams = z.object({ id: z.string().uuid() });
const chapterContextQuery = z.object({ chapterId: z.string().uuid() });
const foreshadowingReportQuery = z.object({ workId: z.string().uuid().optional() });

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ledger/entries', async (request) => {
    const auth = await requireAuth(request);
    const query = listLedgerEntriesQuerySchema.parse(request.query);
    return listLedgerEntries(auth, query);
  });

  app.post('/api/ledger/entries', async (request) => {
    const auth = await requireAuth(request);
    const input = createLedgerEntrySchema.parse(request.body);
    return createLedgerEntry(auth, input);
  });

  app.get('/api/ledger/entries/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return getLedgerEntry(auth, id);
  });

  app.get('/api/ledger/entries/:id/versions', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return listLedgerVersions(auth, id);
  });

  app.get('/api/ledger/entries/:id/timeline', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return getCharacterTimeline(auth, id);
  });

  app.get('/api/ledger/character-context', async (request) => {
    const auth = await requireAuth(request);
    const { chapterId } = chapterContextQuery.parse(request.query);
    return getCharacterContext(auth, chapterId);
  });

  app.get('/api/ledger/foreshadowing/report', async (request) => {
    const auth = await requireAuth(request);
    const { workId } = foreshadowingReportQuery.parse(request.query);
    return getForeshadowingReport(auth, workId);
  });

  app.get('/api/ledger/foreshadowing/reminders', async (request) => {
    const auth = await requireAuth(request);
    const { chapterId } = chapterContextQuery.parse(request.query);
    return getForeshadowingReminders(auth, chapterId);
  });

  app.put('/api/ledger/entries/:id/draft', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = updateLedgerDraftSchema.parse(request.body);
    return saveLedgerDraft(auth, id, input);
  });

  app.post('/api/ledger/entries/:id/publish', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = publishLedgerEntrySchema.parse(request.body);
    return publishLedgerEntry(auth, id, input);
  });

  app.post('/api/ledger/entries/:id/archive', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = archiveLedgerEntrySchema.parse(request.body);
    return archiveLedgerEntry(auth, id, input);
  });

  app.post('/api/ledger/entries/:id/rollback', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = rollbackLedgerEntrySchema.parse(request.body);
    return rollbackLedgerEntry(auth, id, input);
  });

  app.get('/api/ledger/entries/:id/suggestions', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return listLedgerSuggestions(auth, id);
  });

  app.post('/api/ledger/entries/:id/suggestions', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = createLedgerSuggestionSchema.parse(request.body);
    return createLedgerSuggestion(auth, id, input);
  });

  app.post('/api/ledger/suggestions/:id/accept', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = decideLedgerSuggestionSchema.parse(request.body);
    return acceptLedgerSuggestion(auth, id, input);
  });

  app.post('/api/ledger/suggestions/:id/reject', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = rejectLedgerSuggestionSchema.parse(request.body);
    return rejectLedgerSuggestion(auth, id, input);
  });
}
