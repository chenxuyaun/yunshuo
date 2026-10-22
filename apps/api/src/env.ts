import { loadEnv } from '@yunshuo/db';

loadEnv();

function searchVectorMinScore(): number {
  const raw = Number(process.env.SEARCH_VECTOR_MIN_SCORE ?? '0.4');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.4;
}

function automationPollMs(): number {
  const raw = Number(process.env.AUTOMATION_POLL_MS ?? '2000');
  if (!Number.isFinite(raw)) return 2000;
  return Math.min(60_000, Math.max(250, Math.round(raw)));
}

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret) {
    throw new Error('生产环境必须设置 SESSION_SECRET，不能使用开发默认值');
  }
  const modelKeySecret = process.env.MODEL_KEY_SECRET?.trim();
  if (!modelKeySecret) {
    throw new Error('生产环境必须设置独立的 MODEL_KEY_SECRET，不能回退到会话密钥');
  }
  if (modelKeySecret === sessionSecret) {
    throw new Error('生产环境 MODEL_KEY_SECRET 必须与 SESSION_SECRET 不同');
  }
}

type MailMode = 'smtp' | 'memory' | 'off';

function mailMode(): MailMode {
  const raw = process.env.MAIL_MODE?.trim().toLowerCase();
  if (raw === 'smtp' || raw === 'memory' || raw === 'off') {
    if (isProduction && raw === 'memory') {
      throw new Error('生产环境不允许 MAIL_MODE=memory：内存邮箱不会真实投递');
    }
    return raw;
  }
  if (raw) {
    throw new Error(`MAIL_MODE 只能是 smtp、memory 或 off，当前为 ${raw}`);
  }
  return isProduction ? 'off' : 'memory';
}

const mail = mailMode();
const mailPort = Number(process.env.MAIL_PORT ?? '587');

interface OidcConfig {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  autoProvision: boolean;
}

function oidcConfig(): OidcConfig {
  const issuer = process.env.OIDC_ISSUER?.trim().replace(/\/+$/, '') ?? '';
  const clientId = process.env.OIDC_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim() ?? '';
  const anyConfigured = Boolean(issuer || clientId || clientSecret || redirectUri);
  if (!anyConfigured) {
    return {
      enabled: false,
      providerName: '企业 SSO',
      issuer: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid email profile',
      autoProvision: false,
    };
  }
  if (!issuer || !clientId || !redirectUri) {
    throw new Error('OIDC 配置不完整：必须同时设置 OIDC_ISSUER、OIDC_CLIENT_ID、OIDC_REDIRECT_URI');
  }

  const issuerUrl = new URL(issuer);
  const redirectUrl = new URL(redirectUri);
  for (const [name, url] of [
    ['OIDC_ISSUER', issuerUrl],
    ['OIDC_REDIRECT_URI', redirectUrl],
  ] as const) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${name} 必须是 http/https 地址，且不能包含账号密码`);
    }
    if (isProduction && url.protocol !== 'https:') {
      throw new Error(`${name} 在生产环境必须使用 HTTPS`);
    }
  }

  const scopes = process.env.OIDC_SCOPES?.trim() || 'openid email profile';
  if (!scopes.split(/\s+/).includes('openid')) {
    throw new Error('OIDC_SCOPES 必须包含 openid');
  }

  return {
    enabled: true,
    providerName: process.env.OIDC_PROVIDER_NAME?.trim() || '企业 SSO',
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    autoProvision:
      process.env.OIDC_AUTO_PROVISION === '1' ||
      process.env.OIDC_AUTO_PROVISION?.toLowerCase() === 'true',
  };
}

const oidc = oidcConfig();

export function isSmtpConfigured(): boolean {
  return (
    mail === 'smtp' &&
    Boolean(process.env.MAIL_HOST?.trim()) &&
    Boolean((process.env.MAIL_FROM ?? '云说 <no-reply@yunshuo.local>').trim())
  );
}

export const env = {
  host: process.env.API_HOST?.trim() || '127.0.0.1',
  port: Number(process.env.API_PORT ?? '3000'),
  trustProxy: process.env.TRUST_PROXY === '1',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-change-me',
  cookieSecure: isProduction,
  modelKeySecret:
    process.env.MODEL_KEY_SECRET ?? process.env.SESSION_SECRET ?? 'dev-only-change-me',
  modelKeySecretIsDedicated: Boolean(process.env.MODEL_KEY_SECRET),
  devAuth: !isProduction && process.env.DEV_AUTH === '1',
  searchVectorMinScore: searchVectorMinScore(),
  automationRunner: process.env.AUTOMATION_RUNNER !== '0',
  automationPollMs: automationPollMs(),
  mail: {
    mode: mail,
    smtp: {
      host: process.env.MAIL_HOST?.trim() ?? '',
      port: Number.isInteger(mailPort) && mailPort > 0 && mailPort <= 65_535 ? mailPort : 587,
      secure:
        process.env.MAIL_SECURE === '1' ||
        process.env.MAIL_SECURE?.toLowerCase() === 'true' ||
        mailPort === 465,
      user: process.env.MAIL_USER ?? '',
      password: process.env.MAIL_PASSWORD ?? '',
      from: process.env.MAIL_FROM?.trim() || '云说 <no-reply@yunshuo.local>',
    },
  },
  oidc,
};
