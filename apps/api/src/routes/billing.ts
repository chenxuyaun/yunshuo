import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  importProviderBillSchema,
  reviewProviderBillSchema,
  updateBillingBudgetSchema,
  updateBillingPriceSchema,
} from '@yunshuo/contracts';
import { requireAuth } from '../auth.js';
import {
  loadBillingReport,
  updateProviderPrices,
  updateWorkspaceBudget,
} from '../services/billing-service.js';
import {
  importProviderBill,
  listProviderBills,
  loadProviderBillReconciliation,
  reviewProviderBill,
} from '../services/provider-bill-service.js';

const idParams = z.object({ id: z.string().uuid() });

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/billing/report', async (request) => {
    const auth = await requireAuth(request);
    return loadBillingReport(auth);
  });

  app.put('/api/billing/budget', async (request) => {
    const auth = await requireAuth(request);
    const input = updateBillingBudgetSchema.parse(request.body);
    return updateWorkspaceBudget(auth, input);
  });

  app.patch('/api/billing/prices/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = updateBillingPriceSchema.parse(request.body);
    return updateProviderPrices(auth, id, input);
  });

  app.get('/api/billing/bills', async (request) => {
    const auth = await requireAuth(request);
    return listProviderBills(auth);
  });

  app.post('/api/billing/bills/import', async (request) => {
    const auth = await requireAuth(request);
    const input = importProviderBillSchema.parse(request.body);
    return importProviderBill(auth, input);
  });

  app.get('/api/billing/bills/:id/reconciliation', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    return loadProviderBillReconciliation(auth, id);
  });

  app.patch('/api/billing/bills/:id', async (request) => {
    const auth = await requireAuth(request);
    const { id } = idParams.parse(request.params);
    const input = reviewProviderBillSchema.parse(request.body);
    return reviewProviderBill(auth, id, input);
  });
}
