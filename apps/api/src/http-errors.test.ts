import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

interface ErrorShape {
  status: number;
  code: string;
  message: string;
  topKeys: string[];
}

/**
 * 归因按响应形状建键：同一个状态码下「我们的嵌套 error 形状」与 Fastify 自己的
 * 扁平形状（statusCode/error/message 平铺）是两种答案，只看状态码分不出来。
 */
function shapeOf(response: { statusCode: number; json(): unknown }): ErrorShape {
  const body = response.json() as Record<string, unknown>;
  const error = body.error as { code?: string; message?: string } | undefined;
  return {
    status: response.statusCode,
    code: error?.code ?? '(无 error.code)',
    message: error?.message ?? '(无 error.message)',
    topKeys: Object.keys(body).sort(),
  };
}

describe('HTTP 请求错误映射', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();
    // 只存在于本测试进程的路由：给 500 兜底一个可控的原生抛出点。
    app.get('/api/boom-native', () => {
      throw new Error('测试用原生抛出');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('畸形 JSON 请求体返回 400，而不是 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('未知接口保持 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('超过默认 1MiB 请求体上限时映射为 413 的中文归因', async () => {
    const oversized = JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1_100_000) });
    expect(oversized.length).toBeGreaterThan(1_048_576);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: oversized,
    });
    expect(shapeOf(response)).toEqual({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: '请求体过大',
      topKeys: ['error'],
    });
    expect(response.json().message ?? '').not.toContain('Request body is too large');
  });

  it('未注册的内容类型映射为 415 的中文归因', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/csv' },
      payload: 'email,password\na@b.c,x\n',
    });
    expect(shapeOf(response)).toEqual({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: '不支持的请求内容类型',
      topKeys: ['error'],
    });
  });

  it('未知接口带不支持的内容类型时仍是 404，不升级成 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/does-not-exist',
      headers: { 'content-type': 'text/csv' },
      payload: 'email,password\na@b.c,x\n',
    });
    expect(shapeOf(response)).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: '接口不存在',
      topKeys: ['error'],
    });
  });

  it('处理器的原生抛出兜底为 500 INTERNAL，且不泄露抛出文案', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/boom-native' });
    expect(shapeOf(response)).toEqual({
      status: 500,
      code: 'INTERNAL',
      message: '服务器内部错误',
      topKeys: ['error'],
    });
    expect(response.body).not.toContain('测试用原生抛出');
  });
});
