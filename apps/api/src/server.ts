import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './env.js';
import { AppError } from './errors.js';
import { accountRoutes } from './routes/account.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automation.js';
import { billingRoutes } from './routes/billing.js';
import { chapterRoutes } from './routes/chapters.js';
import { healthRoutes } from './routes/health.js';
import { identityRoutes } from './routes/identity.js';
import { indexRoutes } from './routes/index.js';
import { modelProviderRoutes } from './routes/model-providers.js';
import { searchRoutes } from './routes/search.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: env.trustProxy,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(cors, {
    origin: env.webOrigin,
    credentials: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION',
          message: '请求参数不合法',
          details: error.issues,
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      const code =
        statusCode === 413
          ? 'PAYLOAD_TOO_LARGE'
          : statusCode === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : 'BAD_REQUEST';
      const message =
        statusCode === 413
          ? '请求体过大'
          : statusCode === 415
            ? '不支持的请求内容类型'
            : '请求格式不正确';
      return reply.code(statusCode).send({ error: { code, message } });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: '服务器内部错误',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(identityRoutes);
  await app.register(chapterRoutes);
  await app.register(indexRoutes);
  await app.register(searchRoutes);
  await app.register(modelProviderRoutes);
  await app.register(aiRoutes);
  await app.register(automationRoutes);
  await app.register(billingRoutes);

  return app;
}
