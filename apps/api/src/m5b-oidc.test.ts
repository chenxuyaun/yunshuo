import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { AuthConfigResponse, MeResponse } from '@yunshuo/contracts';
import { sha256 } from '@yunshuo/domain';
import { closeDb, sql } from '@yunshuo/db';
import { exportJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface MockIdentity {
  email: string;
  emailVerified: boolean;
  name: string;
  subject: string;
  audience?: string;
  nonce?: string;
}

interface AuthorizationRecord {
  code: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
}

interface MockOidc {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  setIdentity(identity: MockIdentity): void;
  close(): Promise<void>;
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('OIDC 集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
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

async function startMockOidc(): Promise<MockOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key';
  const records = new Map<string, AuthorizationRecord>();
  let identity: MockIdentity = {
    email: '',
    emailVerified: true,
    name: '测试用户',
    subject: 'subject-default',
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const state = url.searchParams.get('state') ?? '';
        const nonce = url.searchParams.get('nonce') ?? '';
        const code = randomUUID();
        records.set(code, {
          code,
          nonce,
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: url.searchParams.get('redirect_uri') ?? '',
          clientId: url.searchParams.get('client_id') ?? '',
        });
        const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.writeHead(302, { location: callback.toString() });
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await readBody(request));
        const record = records.get(body.get('code') ?? '');
        if (
          !record ||
          body.get('client_id') !== record.clientId ||
          body.get('client_secret') !== 'test-client-secret' ||
          body.get('redirect_uri') !== record.redirectUri
        ) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const verifier = body.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== record.challenge) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        records.delete(record.code);

        const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const idToken = await new SignJWT({
          nonce: identity.nonce ?? record.nonce,
          email: identity.email,
          email_verified: identity.emailVerified,
          name: identity.name,
        })
          .setProtectedHeader({ alg: 'RS256', kid })
          .setSubject(identity.subject)
          .setIssuer(issuer)
          .setAudience(identity.audience ?? record.clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'not-used-by-yunshuo',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          }),
        );
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
  const issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/jwks`,
    setIdentity(next) {
      identity = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const mock = dbAvailable ? await startMockOidc() : null;
if (mock) {
  process.env.OIDC_ISSUER = mock.issuer;
  process.env.OIDC_CLIENT_ID = 'yunshuo-test-client';
  process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:3100/api/auth/oidc/callback';
  process.env.OIDC_AUTO_PROVISION = '1';
  process.env.OIDC_PROVIDER_NAME = '测试企业 SSO';
  process.env.WEB_ORIGIN = 'http://localhost:5173';
}

const { buildServer } = mock ? await import('./server.js') : { buildServer: null };
// 这两个常量只能晚 import。`oidc-service.js` 顶层就 import 了 `../env.js`，而 `env.ts` 在模块
// 求值的那一刻读 OIDC_*；写成静态 import 会把读取提前到上面那段赋值之前，`env.oidc.enabled`
// 变成 false，整族用例一起红在「404 ≠ 302」这种和属性毫无关系的文案上。
const { OIDC_STATE_COOKIE, OIDC_STATE_COOKIE_PATH } = await import('./services/oidc-service.js');
const suite = dbAvailable && mock && buildServer ? describe : describe.skip;
const RUN_ID = randomUUID().slice(0, 8);

interface CallbackResult {
  status: number;
  location: string | null;
  sessionCookie: string | null;
  entries: string[];
}

interface SetCookieParts {
  name: string;
  /** 原始（仍带 URL 编码）的值段，不含任何属性。 */
  value: string;
  /** 属性按字典序排好，便于整组逐字比对。 */
  attributes: string[];
}

/**
 * `Set-Cookie` 的每一条都是一整串属性，而既有 `cookieFrom` 取的是 `split(';')[0]`：
 * 名字与值读得到，属性整段被丢掉。§三十五 记下这是启用链上的一处空白，下面三个用例
 * 要钉的正是被丢掉那一段，所以另开一个保留属性的解析，不动 `cookieFrom`
 * （其余用例继续拿 `name=value` 当请求头发回去，那是它们要的形状）。
 */
function setCookieEntries(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return values.map((entry) => String(entry));
}

function readSetCookie(entry: string): SetCookieParts {
  const [pair, ...attributes] = entry.split(';');
  const separator = pair!.indexOf('=');
  return {
    name: pair!.slice(0, separator),
    value: pair!.slice(separator + 1),
    attributes: attributes.map((attribute) => attribute.trim()).sort(),
  };
}

/** 剥掉签名取载荷：签名验不验得过另有一句断言，这里只要点号左边那段 JSON。 */
function signedPayload(value: string): string {
  const decoded = decodeURIComponent(value);
  const separator = decoded.lastIndexOf('.');
  // 没有签名段就先把话说清楚：否则下面 JSON.parse 会红在「Expected ',' or '}' …」上，
  // 看着像夹具坏了，其实是被测的 Cookie 根本没签名。
  if (separator <= 0) {
    throw new Error(`state Cookie 没有签名段（前 32 字符：${decoded.slice(0, 32)}…）`);
  }
  return decoded.slice(0, separator);
}

suite('M5-B OIDC 企业登录、账号绑定与受邀开通', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let ownerId = '';
  let existingUserId = '';
  const extraUserIds: string[] = [];
  const emails = {
    owner: `oidc-owner-${RUN_ID}@example.test`,
    existing: `oidc-existing-${RUN_ID}@example.test`,
    invited: `oidc-invited-${RUN_ID}@example.test`,
    noInvite: `oidc-no-invite-${RUN_ID}@example.test`,
    unverified: `oidc-unverified-${RUN_ID}@example.test`,
  };

  function cookieFrom(response: { headers: Record<string, unknown> }, name: string): string | null {
    const raw = response.headers['set-cookie'];
    const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const match = values.find((value) => value.startsWith(`${name}=`));
    return match ? match.split(';')[0]! : null;
  }

  async function startFlow(identity: MockIdentity): Promise<{
    stateCookie: string;
    authorizationUrl: URL;
  }> {
    mock!.setIdentity(identity);
    const started = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(started.statusCode).toBe(302);
    const stateCookie = cookieFrom(started, 'yunshuo_oidc_state');
    if (!stateCookie) throw new Error('企业登录未写入 state Cookie');
    const location = started.headers.location;
    if (typeof location !== 'string') throw new Error('企业登录未重定向');
    return { stateCookie, authorizationUrl: new URL(location) };
  }

  async function authorizationCallback(authorizationUrl: URL): Promise<URL> {
    const authorized = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const location = authorized.headers.get('location');
    if (!location) throw new Error('模拟 IdP 未返回回调地址');
    return new URL(location);
  }

  async function callback(
    stateCookie: string | null,
    callbackUrl: URL,
  ): Promise<CallbackResult> {
    const response = await app.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      ...(stateCookie ? { headers: { cookie: stateCookie } } : {}),
    });
    return {
      status: response.statusCode,
      location: typeof response.headers.location === 'string' ? response.headers.location : null,
      sessionCookie: cookieFrom(response, 'yunshuo_session'),
      entries: setCookieEntries(response.headers),
    };
  }

  async function completeFlow(identity: MockIdentity): Promise<CallbackResult> {
    const { stateCookie, authorizationUrl } = await startFlow(identity);
    const callbackUrl = await authorizationCallback(authorizationUrl);
    return callback(stateCookie, callbackUrl);
  }

  function errorCode(result: CallbackResult): string | null {
    if (!result.location) return null;
    return new URL(result.location).searchParams.get('oidc_error');
  }

  async function me(sessionCookie: string): Promise<MeResponse> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as MeResponse;
  }

  beforeAll(async () => {
    app = await buildServer!();
    workspaceId = randomUUID();
    ownerId = randomUUID();
    existingUserId = randomUUID();
    await sql`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${`OIDC 测试 ${RUN_ID}`})`;
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${ownerId}, ${emails.owner}, 'OIDC 所有者')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${ownerId}, 'owner')
    `;
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${existingUserId}, ${emails.existing}, '既有本地作者')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${existingUserId}, 'author')
    `;
    await sql`
      INSERT INTO workspace_invites (
        id, workspace_id, email, role, token_hash, invited_by, expires_at
      )
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${emails.invited}, 'reviewer',
        ${sha256(`oidc-invite-${RUN_ID}`)}, ${ownerId}, now() + interval '1 day'
      )
    `;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (mock) await mock.close();
    if (!dbAvailable) {
      await closeDb();
      return;
    }
    await sql`DELETE FROM sessions WHERE user_id = ${existingUserId} OR user_id = ${ownerId}`;
    await sql`DELETE FROM user_identities WHERE user_id = ${existingUserId} OR user_id = ${ownerId}`;
    const invited = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = ${emails.invited}
    `;
    for (const row of invited) {
      await sql`DELETE FROM sessions WHERE user_id = ${row.id}`;
      await sql`DELETE FROM user_identities WHERE user_id = ${row.id}`;
    }
    await sql`DELETE FROM audit_log WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_invites WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM users WHERE id = ${ownerId} OR id = ${existingUserId}`;
    for (const row of invited) await sql`DELETE FROM users WHERE id = ${row.id}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    for (const id of extraUserIds) await sql`DELETE FROM users WHERE id = ${id}`;
    await closeDb();
  });

  it('公开认证配置只暴露 SSO 开关、名称与受邀开通策略', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AuthConfigResponse;
    expect(body).toEqual({
      oidcEnabled: true,
      oidcProviderName: '测试企业 SSO',
      oidcAutoProvision: true,
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('授权码 + PKCE + state/nonce 登录已绑定邮箱的本地账号', async () => {
    const { stateCookie, authorizationUrl } = await startFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-existing-${RUN_ID}`,
    });
    expect(authorizationUrl.origin).toBe(mock!.issuer);
    expect(authorizationUrl.pathname).toBe('/authorize');
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toContain('openid');
    expect(stateCookie.startsWith('yunshuo_oidc_state=')).toBe(true);

    const callbackUrl = await authorizationCallback(authorizationUrl);
    const result = await callback(stateCookie, callbackUrl);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost:5173/');
    expect(result.sessionCookie).not.toBeNull();
    const meResponse = await me(result.sessionCookie!);
    expect(meResponse.user.id).toBe(existingUserId);
    expect(meResponse.role).toBe('author');

    const identities = await sql<{ provider: string; subject: string; email_verified: boolean }[]>`
      SELECT provider, subject, email_verified FROM user_identities
      WHERE user_id = ${existingUserId}
    `;
    expect(identities).toHaveLength(1);
    expect(identities[0]?.provider).toBe(mock!.issuer);
    expect(identities[0]?.subject).toBe(`subject-existing-${RUN_ID}`);
    expect(identities[0]?.email_verified).toBe(true);

    const sessions = await sql<{ auth_method: string }[]>`
      SELECT auth_method FROM sessions
      WHERE user_id = ${existingUserId} AND workspace_id = ${workspaceId}
    `;
    expect(sessions.some((row) => row.auth_method === 'oidc')).toBe(true);
  });

  it('同一 subject 即使 IdP 邮箱变化仍绑定原账号', async () => {
    const result = await completeFlow({
      email: `changed-${RUN_ID}@example.test`,
      emailVerified: true,
      name: '改名后的作者',
      subject: `subject-existing-${RUN_ID}`,
    });
    expect(result.sessionCookie).not.toBeNull();
    const meResponse = await me(result.sessionCookie!);
    expect(meResponse.user.id).toBe(existingUserId);
    const identities = await sql<{ email: string; user_id: string }[]>`
      SELECT user_id, email FROM user_identities
      WHERE provider = ${mock!.issuer} AND subject = ${`subject-existing-${RUN_ID}`}
    `;
    expect(identities[0]?.user_id).toBe(existingUserId);
    expect(identities[0]?.email).toBe(`changed-${RUN_ID}@example.test`);
  });

  it('受邀且邮箱已验证的新身份自动开通账号并接受邀请', async () => {
    const result = await completeFlow({
      email: emails.invited,
      emailVerified: true,
      name: '受邀审阅者',
      subject: `subject-invited-${RUN_ID}`,
    });
    expect(result.sessionCookie).not.toBeNull();
    const meResponse = await me(result.sessionCookie!);
    expect(meResponse.user.email).toBe(emails.invited);
    expect(meResponse.user.name).toBe('受邀审阅者');
    expect(meResponse.role).toBe('reviewer');
    extraUserIds.push(meResponse.user.id);

    const invite = await sql<{ accepted_by: string; accepted_at: Date | null }[]>`
      SELECT accepted_by, accepted_at FROM workspace_invites
      WHERE workspace_id = ${workspaceId} AND lower(email) = ${emails.invited}
    `;
    expect(invite[0]?.accepted_by).toBe(meResponse.user.id);
    expect(invite[0]?.accepted_at).not.toBeNull();

    const audit = await sql<{ metadata: { via?: string; accountCreated?: boolean } }[]>`
      SELECT metadata FROM audit_log
      WHERE workspace_id = ${workspaceId}
        AND action = 'member.invite.accept'
        AND object_id = (
          SELECT id FROM workspace_invites
          WHERE workspace_id = ${workspaceId} AND lower(email) = ${emails.invited}
        )
    `;
    expect(audit[0]?.metadata.via).toBe('oidc');
    expect(audit[0]?.metadata.accountCreated).toBe(true);
  });

  it('没有待接受邀请的新身份不会自动建号', async () => {
    const before = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users WHERE lower(email) = ${emails.noInvite}
    `;
    const result = await completeFlow({
      email: emails.noInvite,
      emailVerified: true,
      name: '无邀请用户',
      subject: `subject-no-invite-${RUN_ID}`,
    });
    expect(errorCode(result)).toBe('OIDC_INVITE_REQUIRED');
    expect(result.sessionCookie).toBeNull();
    const after = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM users WHERE lower(email) = ${emails.noInvite}
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('未验证邮箱不能绑定或登录', async () => {
    const result = await completeFlow({
      email: emails.unverified,
      emailVerified: false,
      name: '未验证用户',
      subject: `subject-unverified-${RUN_ID}`,
    });
    expect(errorCode(result)).toBe('OIDC_EMAIL_UNVERIFIED');
    const identities = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_identities
      WHERE subject = ${`subject-unverified-${RUN_ID}`}
    `;
    expect(identities[0]?.count).toBe(0);
  });

  it('state 被篡改或 state Cookie 缺失时拒绝回调', async () => {
    const { stateCookie, authorizationUrl } = await startFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-tampered-${RUN_ID}`,
    });
    const callbackUrl = await authorizationCallback(authorizationUrl);
    callbackUrl.searchParams.set('state', 'tampered-state');
    const tampered = await callback(stateCookie, callbackUrl);
    expect(errorCode(tampered)).toBe('OIDC_STATE_INVALID');
    expect(tampered.sessionCookie).toBeNull();

    const { authorizationUrl: secondUrl } = await startFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-missing-cookie-${RUN_ID}`,
    });
    const secondCallback = await authorizationCallback(secondUrl);
    const missing = await callback(null, secondCallback);
    expect(errorCode(missing)).toBe('OIDC_CALLBACK_INVALID');
    expect(missing.sessionCookie).toBeNull();
  });

  it('audience 或 nonce 不匹配的 ID Token 被拒绝', async () => {
    const wrongAudience = await completeFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-wrong-audience-${RUN_ID}`,
      audience: 'another-client',
    });
    expect(errorCode(wrongAudience)).toBe('OIDC_TOKEN_INVALID');
    expect(wrongAudience.sessionCookie).toBeNull();

    const wrongNonce = await completeFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-wrong-nonce-${RUN_ID}`,
      nonce: 'not-the-login-nonce',
    });
    expect(errorCode(wrongNonce)).toBe('OIDC_NONCE_MISMATCH');
    expect(wrongNonce.sessionCookie).toBeNull();

    const identities = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_identities
      WHERE subject IN (
        ${`subject-wrong-audience-${RUN_ID}`}, ${`subject-wrong-nonce-${RUN_ID}`}
      )
    `;
    expect(identities[0]?.count).toBe(0);
  });

  it('授权码只能兑换一次，重放不会产生第二个会话', async () => {
    const { stateCookie, authorizationUrl } = await startFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-replay-${RUN_ID}`,
    });
    const callbackUrl = await authorizationCallback(authorizationUrl);
    const first = await callback(stateCookie, callbackUrl);
    expect(first.sessionCookie).not.toBeNull();
    const replay = await callback(stateCookie, callbackUrl);
    expect(replay.sessionCookie).toBeNull();
    expect(errorCode(replay)).toBe('OIDC_CODE_REJECTED');
  });

  it('启用链上种下的 state Cookie：四条属性逐字、签名验得过、载荷与授权 URL 是同一套', async () => {
    mock!.setIdentity({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-cookie-shape-${RUN_ID}`,
    });
    const started = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(started.statusCode).toBe(302);
    // 这一跳要把 state、nonce、codeVerifier 全留在这台浏览器上；缓存住等于把一次登录的前置材料
    // 交给下一个访客（或下一段共用代理）。
    expect(started.headers['cache-control']).toBe('no-store');

    const entries = setCookieEntries(started.headers);
    expect(entries).toHaveLength(1);
    const state = readSetCookie(entries[0]!);
    expect(state.name).toBe(OIDC_STATE_COOKIE);
    // 整组属性逐字比对：多一条、少一条、换一条都算红。
    expect(state.attributes).toEqual([
      'HttpOnly',
      'Max-Age=600',
      'Path=/api/auth/oidc',
      'SameSite=Lax',
    ]);
    // Path 与清除那侧共用同一个导出常量，否则浏览器根本删不掉它（`routes/auth.ts:61` 与 `:72`）。
    expect(state.attributes.filter((attribute) => attribute.startsWith('Path=')))
      .toEqual([`Path=${OIDC_STATE_COOKIE_PATH}`]);
    // 测试装配下 `env.cookieSecure` 为假，所以这组里不该有 Secure。生产那一支（真时补上）本族不钉：
    // `start` 第一句就 discover()，需要一个真能 HTTPS 访问的 IdP。
    expect(state.attributes.some((attribute) => attribute.toLowerCase() === 'secure')).toBe(false);
    // 只给 Max-Age：同时给 Expires 会在旧浏览器上留下两个不一致的寿命。
    expect(state.attributes.some((attribute) => attribute.startsWith('Expires='))).toBe(false);

    const decoded = decodeURIComponent(state.value);
    expect(app.unsignCookie(decoded).valid).toBe(true);
    expect(app.unsignCookie(`${decoded}tampered`).valid).toBe(false);

    const payload = JSON.parse(signedPayload(state.value)) as {
      state: string;
      nonce: string;
      codeVerifier: string;
      createdAt: number;
    };
    expect(Object.keys(payload).sort()).toEqual(['codeVerifier', 'createdAt', 'nonce', 'state']);
    expect(payload.createdAt).toBeGreaterThan(Date.now() - 5_000);
    expect(payload.createdAt).toBeLessThanOrEqual(Date.now());

    // 种下的这套材料必须就是发给 IdP 的那一套：三个键各自对一次，缺一个都对不上回调。
    const authorizationUrl = new URL(started.headers.location as string);
    expect(payload.state).toBe(authorizationUrl.searchParams.get('state'));
    expect(payload.nonce).toBe(authorizationUrl.searchParams.get('nonce'));
    expect(createHash('sha256').update(payload.codeVerifier).digest('base64url')).toBe(
      authorizationUrl.searchParams.get('code_challenge'),
    );
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('回调无论成败都把 state Cookie 按同一路径清掉，且只留该留的那几条', async () => {
    const clearedAttributes = [
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Max-Age=0',
      `Path=${OIDC_STATE_COOKIE_PATH}`,
      'SameSite=Lax',
    ];

    // 成功一侧：重新登录既有 subject，只多出一次会话，不新增身份行。
    const succeeded = await completeFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-existing-${RUN_ID}`,
    });
    expect(succeeded.status).toBe(302);
    expect(succeeded.entries).toHaveLength(2);
    const clearEntry = succeeded.entries.find((entry) => entry.startsWith(`${OIDC_STATE_COOKIE}=`));
    if (!clearEntry) throw new Error(`成功回调没清 state Cookie：${JSON.stringify(succeeded.entries)}`);
    const cleared = readSetCookie(clearEntry);
    expect(cleared.value).toBe('');
    // 先单独看这两条：清除指令的归因就是「Path 与种下时逐字相同」+「寿命归零」。
    // 只留下面那组整组比对的话，Path 分叉时的红字是 `[…(4)] vs […(4)]`，看不出谁变了。
    expect(cleared.attributes.filter((attribute) => /^(Path|Max-Age)=/.test(attribute))).toEqual([
      'Max-Age=0',
      `Path=${OIDC_STATE_COOKIE_PATH}`,
    ]);
    expect(cleared.attributes).toEqual(clearedAttributes);
    // Max-Age=0 与纪元 Expires 两条一起给是删除 Cookie 的兼容写法；关键是 Path 与种下时逐字相同。
    expect(succeeded.entries.filter((entry) => entry.startsWith('yunshuo_session='))).toHaveLength(1);

    // 被拒的一侧：同一条清除指令，且不带会话 Cookie。拒绝之后材料不该还挂在浏览器上。
    const { stateCookie, authorizationUrl } = await startFlow({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-clear-on-reject-${RUN_ID}`,
    });
    const callbackUrl = await authorizationCallback(authorizationUrl);
    callbackUrl.searchParams.set('state', 'tampered-state');
    const rejected = await callback(stateCookie, callbackUrl);
    expect(errorCode(rejected)).toBe('OIDC_STATE_INVALID');
    expect(rejected.sessionCookie).toBeNull();
    expect(rejected.entries).toHaveLength(1);
    expect(readSetCookie(rejected.entries[0]!).attributes).toEqual(cleared.attributes);
  });

  it('state Cookie 的寿命就是它自己声明的那个 Max-Age：两头各差一分钟，两个码互斥', async () => {
    mock!.setIdentity({
      email: emails.existing,
      emailVerified: true,
      name: '既有本地作者',
      subject: `subject-state-age-${RUN_ID}`,
    });
    const started = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    const state = readSetCookie(setCookieEntries(started.headers)[0]!);
    // 阈值从浏览器看到的那条 Max-Age 推出来，而不是在本文件再抄一遍 600：
    // `routes/auth.ts:62` 的 600 与 `oidc-service.ts:11` 的 10*60*1000 分处两个文件，
    // 只有跨过这条推导，才证明它们说的是同一个 10 分钟。
    const maxAgeAttribute = state.attributes.find((attribute) => attribute.startsWith('Max-Age='));
    if (!maxAgeAttribute) throw new Error(`state Cookie 没有 Max-Age：${JSON.stringify(state.attributes)}`);
    const maxAgeSeconds = Number(maxAgeAttribute.slice('Max-Age='.length));
    expect(Number.isInteger(maxAgeSeconds)).toBe(true);

    const payload = JSON.parse(signedPayload(state.value)) as {
      state: string;
      nonce: string;
      codeVerifier: string;
      createdAt: number;
    };
    // 签传真值：用 app.signCookie 重新签一条，走的就是回调里那句 unsignCookie 的对称面。
    const forge = (createdAt: number): string =>
      `${OIDC_STATE_COOKIE}=${encodeURIComponent(
        app.signCookie(JSON.stringify({ ...payload, createdAt })),
      )}`;
    // 授权码用一条模拟 IdP 从未签发过的：过期守卫一旦被摘掉，这条请求会一路走到令牌端点，
    // 换成 OIDC_CODE_REJECTED 而不是 OIDC_STATE_EXPIRED。两个码互斥，红字才归得因。
    const callbackUrl = new URL('http://localhost:3100/api/auth/oidc/callback');
    callbackUrl.searchParams.set('code', `code-never-issued-${RUN_ID}`);
    callbackUrl.searchParams.set('state', payload.state);

    const expired = await callback(forge(Date.now() - (maxAgeSeconds + 1) * 1000), callbackUrl);
    expect(errorCode(expired)).toBe('OIDC_STATE_EXPIRED');
    expect(expired.sessionCookie).toBeNull();
    expect(expired.entries.filter((entry) => entry.startsWith(`${OIDC_STATE_COOKIE}=`))).toHaveLength(1);

    // 未过期一侧留 60 秒而不是 1 秒：这一侧的误差方向是偶发假失败（机器一慢就误判成过期），
    // 而上面那一侧单调安全（时间只会让它更旧）。60 秒足以抓走任何一档常量改动。
    const straddled = await callback(forge(Date.now() - (maxAgeSeconds - 60) * 1000), callbackUrl);
    expect(errorCode(straddled)).toBe('OIDC_CODE_REJECTED');
    expect(straddled.sessionCookie).toBeNull();

    const identities = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_identities
      WHERE subject = ${`subject-state-age-${RUN_ID}`}
    `;
    expect(identities[0]?.count).toBe(0);
  });
});
