import type { FastifyInstance } from 'fastify';
import { sql } from '@yunshuo/db';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (request, reply) => {
    try {
      await sql`SELECT 1`;
      return {
        status: 'ok',
        database: 'ok',
        service: 'yunshuo-api',
        time: new Date().toISOString(),
      };
    } catch (error) {
      request.log.error({ err: error }, 'health check failed');
      reply.code(503);
      return {
        status: 'degraded',
        database: 'unreachable',
        service: 'yunshuo-api',
        time: new Date().toISOString(),
      };
    }
  });
}
