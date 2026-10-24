import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors.js';

/**
 * 回调 catch 的兜底形状：`OIDC_LOGIN_FAILED` 只在 `completeOidcLogin` 抛出非 AppError 时出现——
 * 例如数据库在登录中途不可用、会话落库失败这类预期外故障。真实 chain（发现→兑换→校验→解析）
 * 的每一个已知失败都在 oidc-service 里提前归因成 AppError，HTTP 面单线程也造不出底层故障，
 * 所以这里在模块边界注入一次普通 Error，只钉路由层的回答：不 500、不种会话、清 state Cookie，
 * 把兜底码塞进 `?oidc_error=`。第二个用例用 AppError 反证 `instanceof` 分支不是把一切都吞成兜底码。
 */
type Behavior = 'unexpected' | 'app-error';
let behavior: Behavior = 'unexpected';

vi.mock('./services/oidc-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/oidc-service.js')>();
  return {
    ...actual,
    completeOidcLogin: async () => {
      if (behavior === 'app-error') {
        throw new AppError(401, 'OIDC_STATE_INVALID', '登录状态无效，请重新登录');
      }
      throw new Error('connect ECONNREFUSED 127.0.0.1:9');
    },
  };
});

const WEB_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'silent';
process.env.WEB_ORIGIN = WEB_ORIGIN;

const { buildServer } = await import('./server.js');

interface CallbackResult {
  status: number;
  location: string | null;
  entries: string[];
}

function entries(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return values.map((entry) => String(entry));
}

describe('M5-B OIDC 回调的意外失败兜底', () => {
  let app: FastifyInstance;

  async function callback(): Promise<CallbackResult> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=code-unexpected&state=state-unexpected',
    });
    return {
      status: response.statusCode,
      location: typeof response.headers.location === 'string' ? response.headers.location : null,
      entries: entries(response.headers),
    };
  }

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('完整登录抛出普通 Error：302 回前端兜底码，不种会话，state Cookie 被清', async () => {
    behavior = 'unexpected';
    const result = await callback();
    expect(result.status).toBe(302);
    expect(result.location).toBe(`${WEB_ORIGIN}/?oidc_error=OIDC_LOGIN_FAILED`);
    expect(result.entries.some((entry) => entry.startsWith('yunshuo_session='))).toBe(false);
    expect(
      result.entries.some((entry) => entry.startsWith('yunshuo_oidc_state=;')),
    ).toBe(true);
  });

  it('完整登录抛出 AppError：保留它自己的码，不落兜底', async () => {
    behavior = 'app-error';
    const result = await callback();
    expect(result.status).toBe(302);
    expect(result.location).toBe(`${WEB_ORIGIN}/?oidc_error=OIDC_STATE_INVALID`);
    expect(result.entries.some((entry) => entry.startsWith('yunshuo_session='))).toBe(false);
  });
});
