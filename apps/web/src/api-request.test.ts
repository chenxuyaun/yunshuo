import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getMe, login } from './api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('request 的响应与错误映射', () => {
  it('成功时带上会话凭据、解析 JSON 并原样返回', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1', email: 'a@b.c' }));

    await expect(getMe()).resolves.toEqual({ id: 'u1', email: 'a@b.c' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({});
  });

  it('有请求体时才加 JSON 内容类型，并原样发出请求体', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'u1' }));

    await login('a@b.c', 'pw');

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/login');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.c', password: 'pw' }));
  });

  it('2xx 空响应体返回 null，而不是解析错误', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(getMe()).resolves.toBeNull();
  });

  it('2xx 但响应体不是 JSON 时返回 null（当前实现的静默取舍）', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(getMe()).resolves.toBeNull();
  });

  it('非 2xx 的 JSON 错误体映射成 ApiError 的 status/code/message/details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'BUDGET_GUARD_UNAVAILABLE', message: '预算拦住', details: { budget: 1 } } },
        409,
      ),
    );

    const error: unknown = await getMe().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'BUDGET_GUARD_UNAVAILABLE',
      message: '预算拦住',
      details: { budget: 1 },
    });
  });

  it('非 2xx 且没有 JSON 错误体时落兜底码与兜底文案', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const error: unknown = await getMe().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'UNKNOWN',
      message: '请求失败（HTTP 502）',
      details: undefined,
    });
  });
});
