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
const suite = dbAvailable && mock && buildServer ? describe : describe.skip;
const RUN_ID = randomUUID().slice(0, 8);

interface CallbackResult {
  status: number;
  location: string | null;
  sessionCookie: string | null;
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
});
