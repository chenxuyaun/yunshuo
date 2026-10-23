import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { closeDb, sql } from '@yunshuo/db';
import { exportJWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * 这一族钉的是"企业身份服务不配合"时的归因码：发现端点坏掉、token 端点坏掉、ID Token 缺东西、
 * 本地账号解析失败。与 `m5b-oidc.test.ts` 的成功链分开成文件，是因为 `oidc-service.ts` 的
 * `discoveryCache` 是模块级 5 分钟缓存：一旦某个用例先成功发现，后面的文档级失败（issuer 不一致、
 * 缺 authorization_endpoint）就会被缓存挡住，再也走不到。**本文件的用例顺序因此是断言的一部分**：
 * 先跑五种发现失败（失败不写缓存），再跑一次成功，其余用例共享那份正常文档。
 *
 * 同一个缓存也划出了本文件诚实留下的边界：OIDC_SIGNING_ALGORITHM_UNSUPPORTED 与
 * OIDC_CLIENT_AUTH_UNSUPPORTED 都由发现文档决定，要和正常文档共存必须再起一个模块实例；
 * OIDC_IDENTITY_CONFLICT 的三处抛出都是并发窗口/唯一冲突兜底，HTTP 面单线程构造不出来。
 * 这三条不装作用例覆盖了，见审计报告 §三十七。（码名故意不加引号：错误码筛子把任何引号包着的
 * 码都算成"测试里引用过"，写在注释里加引号会让这三个没断过的码凭空从空白名单上消失。）
 */
interface MockIdentity {
  email?: string;
  emailVerified?: boolean;
  name?: string;
  subject: string;
}

type DiscoveryFault =
  | 'none'
  | 'http-500'
  | 'wrong-issuer'
  | 'missing-auth'
  | 'bad-url'
  | 'bad-protocol';

type TokenFault = 'ok' | 'http-400' | 'missing-id-token' | 'empty-id-token';

interface MockIdp {
  issuer: string;
  setDiscoveryFault(fault: DiscoveryFault): void;
  setTokenFault(fault: TokenFault): void;
  setIdentity(identity: MockIdentity): void;
  setNonce(nonce: string): void;
  tokenCalls(): number;
  close(): Promise<void>;
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('OIDC 失败族测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startMockIdp(): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const kid = 'failure-key';
  let discoveryFault: DiscoveryFault = 'none';
  let tokenFault: TokenFault = 'ok';
  let identity: MockIdentity = { subject: 'subject-default' };
  let nonce = '';
  let tokenCalls = 0;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        if (discoveryFault === 'http-500') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        const document: Record<string, unknown> = {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          id_token_signing_alg_values_supported: ['RS256'],
        };
        if (discoveryFault === 'wrong-issuer') document.issuer = 'https://elsewhere.example.test';
        if (discoveryFault === 'missing-auth') delete document.authorization_endpoint;
        if (discoveryFault === 'bad-url') document.authorization_endpoint = 'not-a-url';
        if (discoveryFault === 'bad-protocol') {
          document.authorization_endpoint = 'ftp://idp.example.test/authorize';
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(document));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        tokenCalls += 1;
        await readBody(request);
        if (tokenFault === 'http-400') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        if (tokenFault === 'missing-id-token') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ access_token: 'unused', token_type: 'Bearer' }));
          return;
        }
        if (tokenFault === 'empty-id-token') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ access_token: 'unused', token_type: 'Bearer', id_token: '' }));
          return;
        }
        const claims: Record<string, unknown> = {
          nonce,
          email_verified: identity.emailVerified ?? true,
          name: identity.name ?? '测试用户',
        };
        if (identity.email !== undefined) claims.email = identity.email;
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid })
          .setSubject(identity.subject)
          .setIssuer(issuer)
          .setAudience('yunshuo-failure-client')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'unused', token_type: 'Bearer', id_token: idToken }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    })().catch(() => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'mock_failure' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    issuer: `http://127.0.0.1:${port}`,
    setDiscoveryFault(fault) {
      discoveryFault = fault;
    },
    setTokenFault(fault) {
      tokenFault = fault;
    },
    setIdentity(next) {
      identity = next;
    },
    setNonce(next) {
      nonce = next;
    },
    tokenCalls() {
      return tokenCalls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const WEB_ORIGIN = 'http://localhost:5173';
const mock = dbAvailable ? await startMockIdp() : null;
if (mock) {
  process.env.OIDC_ISSUER = mock.issuer;
  process.env.OIDC_CLIENT_ID = 'yunshuo-failure-client';
  process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:3100/api/auth/oidc/callback';
  process.env.OIDC_AUTO_PROVISION = '0';
  process.env.OIDC_PROVIDER_NAME = '失败族测试 SSO';
  process.env.WEB_ORIGIN = WEB_ORIGIN;
}

const { buildServer } = mock ? await import('./server.js') : { buildServer: null };
const suite = dbAvailable && mock && buildServer ? describe : describe.skip;
const RUN_ID = randomUUID().slice(0, 8);

interface CallbackResult {
  status: number;
  location: string | null;
  entries: string[];
}

suite('M5-B OIDC 失败族：发现、兑换与账号解析的归因码', () => {
  let app: FastifyInstance;
  const emails = {
    noEmail: `oidc-no-email-${RUN_ID}@example.test`,
    noProvision: `oidc-no-provision-${RUN_ID}@example.test`,
  };

  function cookieFrom(headers: Record<string, unknown>, name: string): string | null {
    const raw = headers['set-cookie'];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const match = values.find((value) => value.startsWith(`${name}=`));
    return match ? match.split(';')[0]! : null;
  }

  function entries(headers: Record<string, unknown>): string[] {
    const raw = headers['set-cookie'];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    return values.map((entry) => String(entry));
  }

  function hasSessionCookie(setCookies: string[]): boolean {
    return setCookies.some((entry) => entry.startsWith('yunshuo_session='));
  }

  function errorCode(result: CallbackResult): string | null {
    if (!result.location) return null;
    return new URL(result.location).searchParams.get('oidc_error');
  }

  async function startLogin(): Promise<{ cookie: string; state: string; nonce: string }> {
    const response = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(response.statusCode).toBe(302);
    const cookie = cookieFrom(response.headers, 'yunshuo_oidc_state');
    if (!cookie) throw new Error('企业登录未写入 state Cookie');
    const location = response.headers.location;
    if (typeof location !== 'string') throw new Error('企业登录未重定向');
    const url = new URL(location);
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    if (!state || !nonce) throw new Error('授权 URL 缺少 state 或 nonce');
    return { cookie, state, nonce };
  }

  async function callback(
    query: Record<string, string>,
    cookie: string | null,
  ): Promise<CallbackResult> {
    const search = new URLSearchParams(query).toString();
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${search}`,
      ...(cookie ? { headers: { cookie } } : {}),
    });
    return {
      status: response.statusCode,
      location: typeof response.headers.location === 'string' ? response.headers.location : null,
      entries: entries(response.headers),
    };
  }

  async function callbackWithToken(): Promise<CallbackResult> {
    const login = await startLogin();
    mock!.setNonce(login.nonce);
    return callback(
      { code: `code-${RUN_ID}`, state: login.state },
      login.cookie,
    );
  }

  beforeAll(async () => {
    app = await buildServer!();
  });

  // 每个用例都从"服务正常"出发：否则上一发失败落在循环中间时，下一族用例会拿着残留的故障模式红在
  // 与自身无关的码上（G8 首轮就是这么连带红了 EMAIL_REQUIRED 与 ACCOUNT_NOT_FOUND 两条）。
  afterEach(() => {
    mock?.setDiscoveryFault('none');
    mock?.setTokenFault('ok');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (mock) await mock.close();
    if (!dbAvailable) {
      await closeDb();
      return;
    }
    await sql`DELETE FROM user_identities WHERE subject LIKE ${`subject-failure-${RUN_ID}%`}`;
    await sql`
      DELETE FROM sessions WHERE user_id IN (
        SELECT id FROM users WHERE lower(email) IN (${emails.noEmail}, ${emails.noProvision})
      )
    `;
    await sql`DELETE FROM users WHERE lower(email) IN (${emails.noEmail}, ${emails.noProvision})`;
    await closeDb();
  });

  it('发现端点 500：start 是 502 JSON，归因 OIDC_DISCOVERY_FAILED，不种 state Cookie', async () => {
    mock!.setDiscoveryFault('http-500');
    const response = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(response.statusCode).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error).toEqual({
      code: 'OIDC_DISCOVERY_FAILED',
      message: '企业身份服务发现失败',
    });
    expect(entries(response.headers).join('\n')).not.toContain('yunshuo_oidc_state');
  });

  it('发现文档四种坏形状：issuer 不一致、缺端点、端点不是 URL、协议不合法，各有各的话', async () => {
    const cases: Array<{ fault: DiscoveryFault; message: string }> = [
      { fault: 'wrong-issuer', message: '企业身份服务 issuer 与配置不一致' },
      { fault: 'missing-auth', message: '身份服务发现缺少 authorization_endpoint' },
      {
        fault: 'bad-url',
        message: '身份服务发现中的 authorization_endpoint 不是有效地址',
      },
      { fault: 'bad-protocol', message: '身份服务发现中的 authorization_endpoint 不合法' },
    ];
    for (const item of cases) {
      mock!.setDiscoveryFault(item.fault);
      const response = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
      expect(response.statusCode, item.fault).toBe(502);
      expect(response.json().error, item.fault).toEqual({
        code: 'OIDC_DISCOVERY_INVALID',
        message: item.message,
      });
      expect(entries(response.headers).join('\n'), item.fault).not.toContain('yunshuo_oidc_state');
    }
    // 四条文案两两不同：把任意一条改成另一条的文案，这里就会红，而不是只红一条模糊的 502。
    expect(new Set(cases.map((item) => item.message)).size).toBe(cases.length);
  });

  it('IDP 在回调上回 ?error=：先于 code/state 判定，归因 OIDC_PROVIDER_ERROR', async () => {
    mock!.setDiscoveryFault('none');
    const login = await startLogin();
    const result = await callback({ error: 'access_denied' }, login.cookie);
    expect(result.status).toBe(302);
    expect(result.location).toBe(`${WEB_ORIGIN}/?oidc_error=OIDC_PROVIDER_ERROR`);
    expect(errorCode(result)).toBe('OIDC_PROVIDER_ERROR');
    expect(hasSessionCookie(result.entries)).toBe(false);
    // 没有 code 也没有 state，但错误排在形状检查之前：顺序反过来这里会变成 OIDC_CALLBACK_INVALID。
    const cleared = result.entries.find((entry) => entry.startsWith('yunshuo_oidc_state=;'));
    expect(cleared).toBeDefined();
  });

  it('token 端点 400（非 invalid_grant）：归因 OIDC_TOKEN_EXCHANGE_FAILED，不种会话', async () => {
    mock!.setTokenFault('http-400');
    const before = mock!.tokenCalls();
    const result = await callbackWithToken();
    expect(mock!.tokenCalls()).toBe(before + 1);
    expect(result.status).toBe(302);
    expect(errorCode(result)).toBe('OIDC_TOKEN_EXCHANGE_FAILED');
    expect(hasSessionCookie(result.entries)).toBe(false);
  });

  it('token 端点 200 但缺 id_token：空字符串和整个字段缺失都归因 OIDC_TOKEN_MISSING', async () => {
    for (const fault of ['missing-id-token', 'empty-id-token'] as const) {
      mock!.setTokenFault(fault);
      const result = await callbackWithToken();
      expect(errorCode(result), fault).toBe('OIDC_TOKEN_MISSING');
      expect(hasSessionCookie(result.entries), fault).toBe(false);
    }
    mock!.setTokenFault('ok');
  });

  it('ID Token 校验通过但没有邮箱：OIDC_EMAIL_REQUIRED，身份表不多一行', async () => {
    mock!.setIdentity({
      subject: `subject-failure-no-email-${RUN_ID}`,
      name: '无邮箱用户',
      emailVerified: true,
    });
    const result = await callbackWithToken();
    expect(result.status).toBe(302);
    expect(errorCode(result)).toBe('OIDC_EMAIL_REQUIRED');
    expect(hasSessionCookie(result.entries)).toBe(false);
    const identities = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_identities
      WHERE subject = ${`subject-failure-no-email-${RUN_ID}`}
    `;
    expect(identities[0]?.count).toBe(0);
  });

  it('邮箱已验证但没有本地账号、自动开通关闭：OIDC_ACCOUNT_NOT_FOUND，库里不多人', async () => {
    mock!.setIdentity({
      email: emails.noProvision,
      emailVerified: true,
      name: '未开通用户',
      subject: `subject-failure-no-provision-${RUN_ID}`,
    });
    const before = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users WHERE lower(email) = ${emails.noProvision}
    `;
    const result = await callbackWithToken();
    expect(result.status).toBe(302);
    expect(errorCode(result)).toBe('OIDC_ACCOUNT_NOT_FOUND');
    expect(hasSessionCookie(result.entries)).toBe(false);
    const after = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users WHERE lower(email) = ${emails.noProvision}
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
    const identities = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_identities
      WHERE subject = ${`subject-failure-no-provision-${RUN_ID}`}
    `;
    expect(identities[0]?.count).toBe(0);
  });
});
