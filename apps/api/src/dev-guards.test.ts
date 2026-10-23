import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 这一族测的是"开发身份三闸"与 env.ts 的启动不变量：零数据库、零模型调用。
 *
 * 关键约束（也是本轮踩到的一条）：`packages/db/src/env.ts:17` 用 `override: false` 读根目录
 * `.env`，dotenv 只不覆盖**已存在**的键，但会把**没设过**的键从文件里补回来。仓库 `.env` 里
 * 有 `DEV_AUTH=1` 与 `SESSION_SECRET=…`，所以 `delete process.env.DEV_AUTH` 之后 dotenv 会
 * 把 1 再塞进去、闸永远是开的；要模拟"未开启/缺失"必须显式写成空串或 '0'（键存在但值不算数）。
 */

interface ErrorShape {
  status: number;
  code: string;
  message: string;
  topKeys: string[];
}

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

const keys = [
  'DEV_AUTH',
  'NODE_ENV',
  'SESSION_SECRET',
  'MODEL_KEY_SECRET',
  'MAIL_MODE',
  'LOG_LEVEL',
] as const;

const original: Record<string, string | undefined> = Object.fromEntries(
  keys.map((key) => [key, process.env[key]]),
);

/** 只改显式给出的键：用例里每个环境都要留着 NODE_ENV，误删会把生产守卫整段跳过。 */
function setEnv(values: Partial<Record<(typeof keys)[number], string>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key as (typeof keys)[number]] = value;
  }
}

function restoreEnv(): void {
  setEnv(original as Partial<Record<(typeof keys)[number], string>>);
}

/** 每次都要 resetModules：env.ts 的导出对象在导入时就把环境变量算成常量了。 */
async function freshEnv(): Promise<typeof import('./env.js')> {
  vi.resetModules();
  return await import('./env.js');
}

async function envImportError(): Promise<string> {
  vi.resetModules();
  try {
    await import('./env.js');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('本该拒绝启动，却成功加载了 env');
}

describe('开发登录开关与生产启动不变量', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('非生产环境只有显式 DEV_AUTH=1 才开启开发登录', async () => {
    setEnv({ NODE_ENV: 'test', DEV_AUTH: '1' });
    expect((await freshEnv()).env.devAuth).toBe(true);

    // '0' 与空串都要关：这两行是同一句 `process.env.DEV_AUTH === '1'` 的两个失配方向，
    // 而 delete 在这里等价于"让 dotenv 从 .env 补回 1"，测不到关闭分支。
    setEnv({ DEV_AUTH: '0' });
    expect((await freshEnv()).env.devAuth).toBe(false);
    setEnv({ DEV_AUTH: '' });
    expect((await freshEnv()).env.devAuth).toBe(false);
  });

  it('生产环境即使 DEV_AUTH=1 也必须关掉开发登录，并把 Cookie 设为 Secure', async () => {
    setEnv({
      NODE_ENV: 'production',
      DEV_AUTH: '1',
      SESSION_SECRET: 'session-secret-for-test',
      MODEL_KEY_SECRET: 'model-key-secret-for-test',
    });
    const { env } = await freshEnv();
    // M5-A 复审修过的那条：README 写"开发登录仅限本机、生产强制关闭"，靠的就是这个
    // `!isProduction` 前置项；它以前只写在报告里，没有任何断言守着。
    expect(env.devAuth).toBe(false);
    expect(env.cookieSecure).toBe(true);
  });

  it('生产环境缺密钥、密钥复用或内存邮箱都直接拒绝启动', async () => {
    setEnv({
      NODE_ENV: 'production',
      DEV_AUTH: '1',
      SESSION_SECRET: '',
      MODEL_KEY_SECRET: '',
    });
    expect(await envImportError()).toBe('生产环境必须设置 SESSION_SECRET，不能使用开发默认值');

    setEnv({ SESSION_SECRET: 'session-secret-for-test', MODEL_KEY_SECRET: '' });
    expect(await envImportError()).toBe(
      '生产环境必须设置独立的 MODEL_KEY_SECRET，不能回退到会话密钥',
    );

    setEnv({ MODEL_KEY_SECRET: 'session-secret-for-test' });
    expect(await envImportError()).toBe('生产环境 MODEL_KEY_SECRET 必须与 SESSION_SECRET 不同');

    setEnv({ MODEL_KEY_SECRET: 'model-key-secret-for-test', MAIL_MODE: 'memory' });
    expect(await envImportError()).toContain('生产环境不允许 MAIL_MODE=memory');
  });

  it('MAIL_MODE 写错时同样拒绝启动，而不是悄悄退回默认值', async () => {
    setEnv({ NODE_ENV: 'test', MAIL_MODE: 'smtp-ish' });
    expect(await envImportError()).toBe('MAIL_MODE 只能是 smtp、memory 或 off，当前为 smtp-ish');
    // 默认值分叉：非生产退回 memory（本机可读邮箱），生产退回 off（不会假装能投递）。
    setEnv({ MAIL_MODE: '' });
    expect((await freshEnv()).env.mail.mode).toBe('memory');
    setEnv({ MAIL_MODE: '', NODE_ENV: 'production', SESSION_SECRET: 'a', MODEL_KEY_SECRET: 'b' });
    expect((await freshEnv()).env.mail.mode).toBe('off');
  });
});

describe('开发身份三闸在 DEV_AUTH 关闭时逐个拒', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // 闸在数据库之前抛出，所以这一族完全不碰库。LOG_LEVEL=silent 只是不想让建服务时的
    // 请求日志淹掉 vitest 的输出；runner 由 `index.ts:9` 起，`buildServer()` 本来也不起。
    setEnv({ DEV_AUTH: '0', NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    vi.resetModules();
    const { buildServer } = await import('./server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    restoreEnv();
  });

  it('邮箱有、密码没有：先过契约再撞开发登录闸，报 400 而不是 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.invalid' },
    });
    expect(shapeOf(response)).toEqual({
      status: 400,
      code: 'PASSWORD_REQUIRED',
      message: '此部署未启用开发登录，请填写邮箱和密码',
      topKeys: ['error'],
    });
  });

  it('连邮箱都没有时先被契约拦下，开发闸轮不到作答', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(shapeOf(response)).toEqual({
      status: 400,
      code: 'VALIDATION',
      message: '请求参数不合法',
      topKeys: ['error'],
    });
    // 契约失败带 details，而三条开发闸用的是 notFound()/AppError 的无 details 分支：
    // 序列化会丢掉 undefined，所以这里锁 error 对象的键集合，能把两种口径分开。
    expect(Object.keys(response.json().error as Record<string, unknown>).sort()).toEqual([
      'code',
      'details',
      'message',
    ]);
  });

  it('开发内存邮箱与开发用户清单两个只读端点都报 404 并各自说明原因', async () => {
    const mailbox = await app.inject({ method: 'GET', url: '/api/dev/mailbox' });
    expect(shapeOf(mailbox)).toEqual({
      status: 404,
      code: 'DEV_MAILBOX_DISABLED',
      message: '开发内存邮箱未启用',
      topKeys: ['error'],
    });
    const users = await app.inject({ method: 'GET', url: '/api/dev/users' });
    expect(shapeOf(users)).toEqual({
      status: 404,
      code: 'DEV_AUTH_DISABLED',
      message: '开发登录未启用',
      topKeys: ['error'],
    });
    // 闸是"抛错"而不是"不注册路由"，所以这一句必须显式钉住返回码：将来改成条件注册，
    // 这两个端点会掉进不带归因的通用 404，界面就分不清"没这个接口"和"闸关着"。
    expect(Object.keys(mailbox.json().error as Record<string, unknown>).sort()).toEqual([
      'code',
      'message',
    ]);
    expect(Object.keys(users.json().error as Record<string, unknown>).sort()).toEqual([
      'code',
      'message',
    ]);
  });
});
