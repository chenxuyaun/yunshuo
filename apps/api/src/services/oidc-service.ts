import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { jsonValue, sql } from '@yunshuo/db';
import type { MeResponse } from '@yunshuo/contracts';
import { createSessionForUser } from '../auth.js';
import { env } from '../env.js';
import { AppError, conflict, forbidden } from '../errors.js';

export const OIDC_STATE_COOKIE = 'yunshuo_oidc_state';
export const OIDC_STATE_COOKIE_PATH = '/api/auth/oidc';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

interface OidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

interface IdTokenClaims extends JWTPayload {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
}

let discoveryCache: { document: OidcDiscovery; expiresAt: number } | null = null;
let jwksCache: { uri: string; keySet: JWTVerifyGetKey } | null = null;

function requireConfigured(): void {
  if (!env.oidc.enabled) {
    throw new AppError(404, 'OIDC_DISABLED', '此部署未启用企业 SSO');
  }
}

function validateEndpoint(name: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new AppError(502, 'OIDC_DISCOVERY_INVALID', `身份服务发现缺少 ${name}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(502, 'OIDC_DISCOVERY_INVALID', `身份服务发现中的 ${name} 不是有效地址`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError(502, 'OIDC_DISCOVERY_INVALID', `身份服务发现中的 ${name} 不合法`);
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new AppError(502, 'OIDC_DISCOVERY_INVALID', `生产环境的 ${name} 必须使用 HTTPS`);
  }
  return url.toString();
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string');
  return values.length > 0 ? values : undefined;
}

async function discover(): Promise<OidcDiscovery> {
  requireConfigured();
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.document;

  const response = await fetch(
    `${env.oidc.issuer}/.well-known/openid-configuration`,
    {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => {
    throw new AppError(502, 'OIDC_DISCOVERY_FAILED', '无法连接企业身份服务');
  });
  if (!response.ok) {
    throw new AppError(502, 'OIDC_DISCOVERY_FAILED', '企业身份服务发现失败');
  }
  const raw = (await response.json().catch(() => null)) as Partial<OidcDiscovery> | null;
  if (!raw || raw.issuer !== env.oidc.issuer) {
    throw new AppError(502, 'OIDC_DISCOVERY_INVALID', '企业身份服务 issuer 与配置不一致');
  }
  const document: OidcDiscovery = {
    issuer: raw.issuer,
    authorization_endpoint: validateEndpoint('authorization_endpoint', raw.authorization_endpoint),
    token_endpoint: validateEndpoint('token_endpoint', raw.token_endpoint),
    jwks_uri: validateEndpoint('jwks_uri', raw.jwks_uri),
    token_endpoint_auth_methods_supported: stringArray(
      raw.token_endpoint_auth_methods_supported,
    ),
    id_token_signing_alg_values_supported: stringArray(
      raw.id_token_signing_alg_values_supported,
    ),
  };
  discoveryCache = { document, expiresAt: Date.now() + 5 * 60 * 1000 };
  return document;
}

function keySetFor(document: OidcDiscovery): JWTVerifyGetKey {
  if (jwksCache?.uri !== document.jwks_uri) {
    jwksCache = {
      uri: document.jwks_uri,
      keySet: createRemoteJWKSet(new URL(document.jwks_uri), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 5 * 60 * 1000,
      }),
    };
  }
  return jwksCache.keySet;
}

function tokenEndpointAuthMethod(document: OidcDiscovery): 'basic' | 'post' | 'none' {
  if (!env.oidc.clientSecret) return 'none';
  const supported = document.token_endpoint_auth_methods_supported ?? [];
  if (supported.length === 0 || supported.includes('client_secret_basic')) return 'basic';
  if (supported.includes('client_secret_post')) return 'post';
  throw new AppError(
    500,
    'OIDC_CLIENT_AUTH_UNSUPPORTED',
    '配置了客户端密钥，但身份服务不支持 client_secret_basic 或 client_secret_post',
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function emailFromClaims(claims: IdTokenClaims): string | null {
  return typeof claims.email === 'string' ? normalizeEmail(claims.email) : null;
}

function nameFromClaims(claims: IdTokenClaims, email: string): string {
  const raw =
    (typeof claims.name === 'string' && claims.name.trim()) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username.trim()) ||
    email.split('@')[0] ||
    '新成员';
  return raw.slice(0, 40);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

export async function beginOidcLogin(): Promise<{ authorizationUrl: string; stateCookie: string }> {
  const document = await discover();
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(document.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.oidc.clientId,
    redirect_uri: env.oidc.redirectUri,
    scope: env.oidc.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  const stateValue: OidcState = { state, nonce, codeVerifier, createdAt: Date.now() };
  return { authorizationUrl: url.toString(), stateCookie: JSON.stringify(stateValue) };
}

async function exchangeCode(
  document: OidcDiscovery,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const method = tokenEndpointAuthMethod(document);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.oidc.redirectUri,
    client_id: env.oidc.clientId,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (method === 'basic') {
    const credentials = `${encodeURIComponent(env.oidc.clientId)}:${encodeURIComponent(
      env.oidc.clientSecret,
    )}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  } else if (method === 'post') {
    body.set('client_secret', env.oidc.clientSecret);
  }

  const response = await fetch(document.token_endpoint, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new AppError(502, 'OIDC_TOKEN_EXCHANGE_FAILED', '无法连接企业身份服务');
  });
  const payload = (await response.json().catch(() => null)) as {
    id_token?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new AppError(
      401,
      payload?.error === 'invalid_grant' ? 'OIDC_CODE_REJECTED' : 'OIDC_TOKEN_EXCHANGE_FAILED',
      '授权码兑换失败，请重新登录',
    );
  }
  if (typeof payload?.id_token !== 'string' || !payload.id_token) {
    throw new AppError(502, 'OIDC_TOKEN_MISSING', '身份服务未返回 ID Token');
  }
  return payload.id_token;
}

async function verifyIdToken(
  document: OidcDiscovery,
  idToken: string,
  expectedNonce: string,
): Promise<IdTokenClaims> {
  const advertised = document.id_token_signing_alg_values_supported ?? [];
  const allowedAlgorithms = [
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'ES512',
    'EdDSA',
  ];
  const algorithms = advertised.length
    ? advertised.filter((algorithm) => allowedAlgorithms.includes(algorithm))
    : allowedAlgorithms;
  if (algorithms.length === 0) {
    throw new AppError(
      500,
      'OIDC_SIGNING_ALGORITHM_UNSUPPORTED',
      '身份服务只提供不受支持的 ID Token 签名算法',
    );
  }

  let payload: IdTokenClaims;
  try {
    const verified = await jwtVerify(idToken, keySetFor(document), {
      issuer: document.issuer,
      audience: env.oidc.clientId,
      algorithms,
      clockTolerance: 60,
    });
    payload = verified.payload as IdTokenClaims;
  } catch {
    throw new AppError(401, 'OIDC_TOKEN_INVALID', 'ID Token 校验失败，请重新登录');
  }

  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expectedNonce)) {
    throw new AppError(401, 'OIDC_NONCE_MISMATCH', '登录 nonce 不匹配，请重新登录');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new AppError(401, 'OIDC_TOKEN_INVALID', 'ID Token 缺少 subject');
  }
  return payload;
}

interface ResolvedUser {
  userId: string;
  workspaceId: string | null;
}

async function resolveUser(
  provider: string,
  subject: string,
  claims: IdTokenClaims,
): Promise<ResolvedUser> {
  const email = emailFromClaims(claims);
  const linked = await sql<{ user_id: string; kind: string }[]>`
    SELECT i.user_id, u.kind
    FROM user_identities i
    JOIN users u ON u.id = i.user_id
    WHERE i.provider = ${provider} AND i.subject = ${subject}
    LIMIT 1
  `;
  const identity = linked[0];
  if (identity) {
    if (identity.kind !== 'human') {
      throw forbidden('企业身份不能绑定 AI 服务主体');
    }
    await sql`
      UPDATE user_identities
      SET last_login_at = now(),
          email = COALESCE(${email}, email),
          email_verified = email_verified OR ${claims.email_verified === true}
      WHERE provider = ${provider} AND subject = ${subject}
    `;
    return { userId: identity.user_id, workspaceId: null };
  }

  if (!email) {
    throw new AppError(403, 'OIDC_EMAIL_REQUIRED', '企业身份未提供邮箱，无法匹配本地账号');
  }
  if (claims.email_verified !== true) {
    throw new AppError(403, 'OIDC_EMAIL_UNVERIFIED', '企业身份邮箱未验证，不能登录或绑定账号');
  }

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`oidc:${email}`}))`;

      const existing = await tx<{ id: string; kind: string }[]>`
        SELECT id, kind FROM users
        WHERE lower(email) = ${email}
        LIMIT 1
        FOR UPDATE
      `;
      let userId = existing[0]?.id;
      let workspaceId: string | null = null;

      if (existing[0] && existing[0].kind !== 'human') {
        throw forbidden('该邮箱属于 AI 服务主体，不能绑定企业身份');
      }

      if (!userId) {
        if (!env.oidc.autoProvision) {
          throw new AppError(
            403,
            'OIDC_ACCOUNT_NOT_FOUND',
            '该企业身份尚未关联本地账号；请先接受工作区邀请，或由管理员开启受邀自动开通',
          );
        }
        const invites = await tx<{ id: string; workspace_id: string; role: string }[]>`
          SELECT id, workspace_id, role
          FROM workspace_invites
          WHERE lower(email) = ${email}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now()
          ORDER BY created_at ASC
          FOR UPDATE
        `;
        if (invites.length === 0) {
          throw new AppError(
            403,
            'OIDC_INVITE_REQUIRED',
            '该企业身份没有待接受的工作区邀请，无法自动开通账号',
          );
        }

        userId = randomUUID();
        await tx`
          INSERT INTO users (id, email, name)
          VALUES (${userId}, ${email}, ${nameFromClaims(claims, email)})
        `;
        for (const invite of invites) {
          await tx`
            INSERT INTO memberships (workspace_id, user_id, role)
            VALUES (${invite.workspace_id}, ${userId}, ${invite.role})
          `;
          await tx`
            UPDATE workspace_invites
            SET accepted_at = now(), accepted_by = ${userId}
            WHERE id = ${invite.id}
          `;
          await tx`
            INSERT INTO audit_log (
              workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
            )
            VALUES (
              ${invite.workspace_id}, ${userId}, 'human', ${invite.role},
              'member.invite.accept', 'workspace_invite', ${invite.id}, 'success',
              ${tx.json(jsonValue({ email, role: invite.role, accountCreated: true, via: 'oidc' }))}
            )
          `;
        }
        workspaceId = invites[0]?.workspace_id ?? null;
      }

      const inserted = await tx<{ user_id: string }[]>`
        INSERT INTO user_identities (
          id, user_id, provider, subject, email, email_verified, last_login_at
        )
        VALUES (
          ${randomUUID()}, ${userId}, ${provider}, ${subject}, ${email}, true, now()
        )
        ON CONFLICT (provider, subject) DO NOTHING
        RETURNING user_id
      `;
      if (inserted[0] && inserted[0].user_id !== userId) {
        throw conflict('OIDC_IDENTITY_CONFLICT', '该企业身份已绑定其他本地账号');
      }
      if (!inserted[0]) {
        const current = await tx<{ user_id: string }[]>`
          SELECT user_id FROM user_identities
          WHERE provider = ${provider} AND subject = ${subject}
          LIMIT 1
        `;
        if (current[0]?.user_id !== userId) {
          throw conflict('OIDC_IDENTITY_CONFLICT', '该企业身份已绑定其他本地账号');
        }
      }

      return { userId, workspaceId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('OIDC_IDENTITY_CONFLICT', '该企业身份或邮箱已被其他账号使用');
    }
    throw error;
  }
}

export async function completeOidcLogin(input: {
  code: string | null;
  state: string | null;
  error: string | null;
  stateCookie: string | null;
}): Promise<{ sessionId: string; me: MeResponse }> {
  requireConfigured();
  if (input.error) {
    throw new AppError(401, 'OIDC_PROVIDER_ERROR', '企业身份服务返回了登录错误');
  }
  if (!input.code || !input.state || !input.stateCookie) {
    throw new AppError(401, 'OIDC_CALLBACK_INVALID', '登录回调缺少授权码、state 或登录状态');
  }

  let saved: OidcState;
  try {
    saved = JSON.parse(input.stateCookie) as OidcState;
  } catch {
    throw new AppError(401, 'OIDC_STATE_INVALID', '登录状态无效，请重新登录');
  }
  if (
    typeof saved.state !== 'string' ||
    typeof saved.nonce !== 'string' ||
    typeof saved.codeVerifier !== 'string' ||
    typeof saved.createdAt !== 'number' ||
    !safeEqual(saved.state, input.state)
  ) {
    throw new AppError(401, 'OIDC_STATE_INVALID', '登录状态不匹配，请重新登录');
  }
  if (Date.now() - saved.createdAt > STATE_MAX_AGE_MS) {
    throw new AppError(401, 'OIDC_STATE_EXPIRED', '登录状态已过期，请重新登录');
  }

  const document = await discover();
  const idToken = await exchangeCode(document, input.code, saved.codeVerifier);
  const claims = await verifyIdToken(document, idToken, saved.nonce);
  const resolved = await resolveUser(document.issuer, claims.sub as string, claims);
  const session = await createSessionForUser(resolved.userId, resolved.workspaceId, 'oidc');
  return session;
}
