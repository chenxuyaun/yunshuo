import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAiProposalSchema } from '@yunshuo/contracts';
import { assertCanReadManuscript, requireAuth } from '../auth.js';
import {
  executeProposal,
  listProposals,
  prepareProposal,
  proposalMeta,
  releaseGenerationLock,
} from '../services/ai-service.js';

const idParams = z.object({ id: z.string().uuid() });

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chapters/:id/ai/proposals', async (request) => {
    const auth = await requireAuth(request);
    assertCanReadManuscript(auth.role);
    const { id } = idParams.parse(request.params);
    return listProposals(auth, id);
  });

  app.post('/api/chapters/:id/ai/proposals', async (request, reply) => {
    const auth = await requireAuth(request);
    assertCanReadManuscript(auth.role);
    const { id } = idParams.parse(request.params);
    const input = createAiProposalSchema.parse(request.body);

    const run = await prepareProposal(auth, id, input);
    const controller = new AbortController();
    let finished = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let onClose: (() => void) | null = null;

    try {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const send = (event: string, data: unknown) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      onClose = () => {
        if (!finished) controller.abort();
      };
      reply.raw.on('close', onClose);

      heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(': ping\n\n');
      }, 15_000);

      send('meta', proposalMeta(run));

      const result = await executeProposal(
        run,
        {
          onDelta: (text) => send('delta', { text }),
          onAttempt: (event) => send('attempt', event),
        },
        controller.signal,
      );
      if (result.ok) {
        send('done', { proposal: result.proposal });
      } else if (!controller.signal.aborted) {
        send('error', { code: result.code, message: result.message });
      }
    } catch (error) {
      request.log.error(error);
      if (!controller.signal.aborted && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({
            code: 'AI_GENERATION_FAILED',
            message: '生成失败，提案未写入。',
          })}\n\n`,
        );
      }
    } finally {
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      if (onClose) reply.raw.off('close', onClose);
      await releaseGenerationLock(run.chapterId, run.proposalId).catch((error: unknown) => {
        request.log.error(error, '生成锁释放失败，将在过期后自动回收');
      });
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    return reply;
  });
}
