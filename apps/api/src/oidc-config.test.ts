import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OIDC_STATE_COOKIE, OIDC_STATE_COOKIE_PATH } from './services/oidc-service.js';

/**
 * OIDC 的配置分支与"未启用"这一族此前只在码普查里挂着（`OIDC_DISABLED` 在未断名单里）。这里
 * 零 stub、零真 IdP、零网络：装配面用显式的环境变量把 `env.ts` 的每一条 OIDC 分支走一遍，
 * HTTP 面用真装配出来的服务读三条公开端点。
 *
 * 关键口径：**同一个 `OIDC_DISABLED` 在两个面上形状不同**——`/api/auth/oidc/start` 是 404 JSON，
 * `/api/auth/oidc/callback` 是 302 把码塞进 `?oidc_error=`（那条 catch 只认查询串）。两种都要钉，
 * 少了哪一种，把另一条改掉都没人报警。
 *
 * `vi.resetModules()` 之后重新 import `./env.js` 才能读到新的环境变量；仓库 `.env` 里没有
 * `OIDC_*` 键，但 dotenv 用 `override: false` 会把**没设过**的键从文件补回来（§二十八 的坑），
 * 所以 `DEV_AUTH`、`WEB_ORIGIN` 这类文件里存在的键一律显式给值，不靠"删掉"表达意图。
 */
const OIDC_KEYS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_SCOPES',
  'OIDC_PROVIDER_NAME',
  'OIDC_AUTO_PROVISION',
] as const;
const BASE_KEYS = [
  'NODE_ENV',
  'SESSION_SECRET',
  'MODEL_KEY_SECRET',
  'MAIL_MODE',
  'DEV_AUTH',
  'WEB_ORIGIN',
  'LOG_LEVEL',
  ...OIDC_KEYS,
] as const;

const WEB_ORIGIN = 'http://127.0.0.1:5199';
const INCOMPLETE_MESSAGE =
  'OIDC 配置不完整：必须同时设置 OIDC_ISSUER、OIDC_CLIENT_ID、OIDC_REDIRECT_URI';
const PROD_SESSION_SECRET = 'oidc-config-test-session-secret';
const PROD_MODEL_SECRET = 'oidc-config-test-model-key-secret';

type EnvModule = typeof import('./env.js');
type EnvObject = EnvModule['env'];
type OidcConfig = EnvObject['oidc'];

const saved = new Map<string, string | undefined>(BASE_KEYS.map((key) => [key, process.env[key]]));

function applyVars(vars: Record<string, string>): void {
  for (const key of BASE_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of BASE_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 非生产装配：HTTP 允许 http 地址，密钥可留默认值。 */
function dev(vars: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', DEV_AUTH: '0', WEB_ORIGIN, MAIL_MODE: 'off', LOG_LEVEL: 'silent', ...vars };
}

function prod(vars: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: PROD_SESSION_SECRET,
    MODEL_KEY_SECRET: PROD_MODEL_SECRET,
    DEV_AUTH: '1',
    WEB_ORIGIN,
    MAIL_MODE: 'off',
    LOG_LEVEL: 'silent',
    ...vars,
  };
}

async function assemble(vars: Record<string, string>): Promise<EnvObject> {
  applyVars(vars);
  vi.resetModules();
  const module = await import('./env.js');
  return module.env;
}

async function assembleError(vars: Record<string, string>): Promise<string> {
  applyVars(vars);
  vi.resetModules();
  try {
    await import('./env.js');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  // 红字必须点名是哪一组键 unexpectedly 启动成功：一个用例里排着四条不同的缺键组合，
  // 不带这串的话五枪的失败文案一模一样，只能靠栈行号分辨谁打了谁。
  throw new Error(`期望装配 env 时抛出，但它启动成功了：${JSON.stringify(vars)}`);
}

describe('OIDC 装配分支：默认关闭、缺一即拒、边界按实现', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('四个键全空 → 整块退回未启用默认值，八个字段逐字', async () => {
    const env = await assemble(dev());
    expect(env.oidc).toEqual<OidcConfig>({
      enabled: false,
      providerName: '企业 SSO',
      issuer: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid email profile',
      autoProvision: false,
    });
  });

  it('只想启用却配齐不了：四个键里缺任何一个都在启动时拒绝', async () => {
    const complete = {
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'yunshuo',
      OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
    };
    expect(await assembleError(dev({ OIDC_ISSUER: complete.OIDC_ISSUER }))).toBe(INCOMPLETE_MESSAGE);
    expect(await assembleError(dev({ OIDC_CLIENT_ID: complete.OIDC_CLIENT_ID }))).toBe(
      INCOMPLETE_MESSAGE,
    );
    expect(await assembleError(dev({ OIDC_REDIRECT_URI: complete.OIDC_REDIRECT_URI }))).toBe(
      INCOMPLETE_MESSAGE,
    );
    // 只填 clientSecret 也算"想启用"：`anyConfigured` 把它算进去了。少了这一支，
    // 一个只粘了密钥的部署会被静默当成没配置，SSO 按钮消失且没有任何报错。
    expect(await assembleError(dev({ OIDC_CLIENT_SECRET: 'a-secret' }))).toBe(INCOMPLETE_MESSAGE);
    // 反过来：配齐三件就启用，不因缺密钥而拒（PKCE 公开客户端是允许的部署）。
    const env = await assemble(dev(complete));
    expect(env.oidc.enabled).toBe(true);
    expect(env.oidc.clientSecret).toBe('');
  });

  it('issuer 剥掉尾部斜杠，redirect 不剥：这个不对称要留在断言里', async () => {
    const env = await assemble(
      dev({
        OIDC_ISSUER: 'https://idp.example.test///',
        OIDC_CLIENT_ID: 'yunshuo',
        OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback/`,
      }),
    );
    expect(env.oidc.issuer).toBe('https://idp.example.test');
    // redirect_uri 要参与授权请求，按 OIDC 惯例必须与注册值逐字一致，所以这里不剥尾斜杠。
    expect(env.oidc.redirectUri).toBe(`${WEB_ORIGIN}/api/auth/oidc/callback/`);
  });

  it('协议与内嵌凭据：两个键各查一次，失配方向不共用一条消息', async () => {
    const message = (name: string) => `${name} 必须是 http/https 地址，且不能包含账号密码`;
    expect(
      await assembleError(
        dev({
          OIDC_ISSUER: 'ftp://idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
        }),
      ),
    ).toBe(message('OIDC_ISSUER'));
    expect(
      await assembleError(
        dev({
          OIDC_ISSUER: 'https://probe-user:probe-pass@idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
        }),
      ),
    ).toBe(message('OIDC_ISSUER'));
    expect(
      await assembleError(
        dev({
          OIDC_ISSUER: 'https://idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: 'ftp://app.example.test/callback',
        }),
      ),
    ).toBe(message('OIDC_REDIRECT_URI'));
    // 非生产允许 http：少了这一侧，"生产必须 HTTPS"那支写成常量 true 也能全绿。
    const env = await assemble(
      dev({
        OIDC_ISSUER: 'http://idp.example.test',
        OIDC_CLIENT_ID: 'yunshuo',
        OIDC_REDIRECT_URI: 'http://app.example.test/api/auth/oidc/callback',
      }),
    );
    expect(env.oidc.enabled).toBe(true);
  });

  it('生产环境两个键都必须 HTTPS，且各自归因自己那条消息', async () => {
    expect(
      await assembleError(
        prod({
          OIDC_ISSUER: 'http://idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
        }),
      ),
    ).toBe('OIDC_ISSUER 在生产环境必须使用 HTTPS');
    expect(
      await assembleError(
        prod({
          OIDC_ISSUER: 'https://idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: 'http://app.example.test/api/auth/oidc/callback',
        }),
      ),
    ).toBe('OIDC_REDIRECT_URI 在生产环境必须使用 HTTPS');
    const env = await assemble(
      prod({
        OIDC_ISSUER: 'https://idp.example.test',
        OIDC_CLIENT_ID: 'yunshuo',
        OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
      }),
    );
    expect(env.oidc.enabled).toBe(true);
  });

  it('issuer 连 URL 都不是时，抛的是解析器的原话而不是本仓的中文说明', async () => {
    // 现状如实钉住：这条分支没有包一层中文消息，运维看到的是 `Invalid URL`。
    const message = await assembleError(
      dev({
        OIDC_ISSUER: 'idp.example.test',
        OIDC_CLIENT_ID: 'yunshuo',
        OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
      }),
    );
    expect(message).toContain('Invalid URL');
    expect(message).not.toContain(INCOMPLETE_MESSAGE);
  });

  it('scope：漏 openid 直接拒绝启动，给了就按给的走', async () => {
    expect(
      await assembleError(
        dev({
          OIDC_ISSUER: 'https://idp.example.test',
          OIDC_CLIENT_ID: 'yunshuo',
          OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
          OIDC_SCOPES: 'email profile',
        }),
      ),
    ).toBe('OIDC_SCOPES 必须包含 openid');
    const env = await assemble(
      dev({
        OIDC_ISSUER: 'https://idp.example.test',
        OIDC_CLIENT_ID: 'yunshuo',
        OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
        OIDC_SCOPES: '  openid email  ',
      }),
    );
    expect(env.oidc.scopes).toBe('openid email');
  });

  it('autoProvision 只认 1 与 true（不分大小写），其余一律关闭', async () => {
    const base = {
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'yunshuo',
      OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
    };
    for (const value of ['1', 'true', 'TRUE', 'True']) {
      const env = await assemble(dev({ ...base, OIDC_AUTO_PROVISION: value }));
      expect(env.oidc.autoProvision, `OIDC_AUTO_PROVISION=${value}`).toBe(true);
    }
    for (const value of ['0', 'yes', 'on', '']) {
      const env = await assemble(dev({ ...base, OIDC_AUTO_PROVISION: value }));
      expect(env.oidc.autoProvision, `OIDC_AUTO_PROVISION=${value}`).toBe(false);
    }
    // 未设置也是关：自动开户是默认关闭的能力，不能靠"键不存在"变成开。
    const env = await assemble(dev(base));
    expect(env.oidc.autoProvision).toBe(false);
  });

  it('providerName 给了用给的，空白退回「企业 SSO」', async () => {
    const base = {
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'yunshuo',
      OIDC_REDIRECT_URI: `${WEB_ORIGIN}/api/auth/oidc/callback`,
    };
    const named = await assemble(dev({ ...base, OIDC_PROVIDER_NAME: ' 公司统一身份 ' }));
    expect(named.oidc.providerName).toBe('公司统一身份');
    const blank = await assemble(dev({ ...base, OIDC_PROVIDER_NAME: '   ' }));
    expect(blank.oidc.providerName).toBe('企业 SSO');
  });
});

describe('OIDC 未启用时的三个公开端点：一个码在两个面上的两种形状', () => {
  let app: FastifyInstance;
  let envModule: EnvObject;

  beforeAll(async () => {
    envModule = await assemble(dev());
    expect(envModule.oidc.enabled).toBe(false);
    const { buildServer } = await import('./server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const db = await import('@yunshuo/db');
    await db.closeDb();
    restoreEnv();
    vi.resetModules();
  });

  it('config 如实报未启用：三键逐字，且带 no-store', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    // 登录页就是靠这三个键决定要不要画 SSO 按钮：谎报 enabled=true 会让按钮指向一条必然失败的跳转。
    expect(response.json()).toEqual({
      oidcEnabled: false,
      oidcProviderName: '企业 SSO',
      oidcAutoProvision: false,
    });
  });

  it('start 是一条 404 JSON，逐字给出「此部署未启用企业 SSO」，且不种 state Cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error).toEqual({
      code: 'OIDC_DISABLED',
      message: '此部署未启用企业 SSO',
    });
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.join('\n') : (raw ?? '');
    expect(cookies).not.toContain(OIDC_STATE_COOKIE);
  });

  it('callback 同一个码走查询串：302 到界面并清掉 state Cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=probe-code&state=probe-state',
      headers: { cookie: `${OIDC_STATE_COOKIE}=probe-state` },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['cache-control']).toBe('no-store');
    // `requireConfigured()` 是 completeOidcLogin 的第一句：它排在回调形状检查之前，
    // 所以带着看起来完整的 code/state 也一样是 OIDC_DISABLED，而不是 OIDC_CALLBACK_INVALID。
    expect(response.headers.location).toBe(`${WEB_ORIGIN}/?oidc_error=OIDC_DISABLED`);
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const cleared = cookies.find((entry) => entry.startsWith(`${OIDC_STATE_COOKIE}=;`));
    expect(cleared).toBeDefined();
    expect(cleared).toContain(`Path=${OIDC_STATE_COOKIE_PATH}`);
  });

  it('IDP 在错误里回 ?error= 时，未启用的判定先于它：顺序也是一条口径', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?error=access_denied',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${WEB_ORIGIN}/?oidc_error=OIDC_DISABLED`);
  });
});
