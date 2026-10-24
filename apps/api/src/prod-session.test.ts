import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from './passwords.js';
import { SESSION_COOKIE } from './auth.js';

/**
 * §二十八 只断到 `env.ts` 导出的布尔值（`cookieSecure: isProduction`、`devAuth: !isProduction && …`），
 * 它留下的口径边界②与③在这里兑现：生产部署的登录响应 `Set-Cookie` 真带 `Secure`，
 * 以及生产环境下无密码的开发登录在 HTTP 面被拒——包括对着**种子里那个真实存在的
 * `owner@demo.local`**（摘掉 `routes/auth.ts:118` 那道闸，这个账号就能被无密码登进，
 * 这才是 README「开发登录仅限本机、生产必须关闭」想挡的东西）。
 *
 * 同一个临时账号、同一个请求，生产与非生产之间只差一个 `NODE_ENV`，所以两侧各跑一次。
 * 两个环境各自 `vi.resetModules()` 重新装配一份服务与连接池，afterAll 里连池一起关。
 */
const KEYS = [
  'NODE_ENV',
  'SESSION_SECRET',
  'MODEL_KEY_SECRET',
  'DEV_AUTH',
  'MAIL_MODE',
  'LOG_LEVEL',
] as const;
const PASSWORD = 'prod-cookie-password-1234';
const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  // 生产守卫要求两把密钥都在且不相同（`env.ts:18-30`）；`DEV_AUTH=1` 是刻意留的，
  // 生产必须无视它——那正是 M5-A 修掉的那个洞。
  SESSION_SECRET: 'prod-test-session-secret',
  MODEL_KEY_SECRET: 'prod-test-model-key-secret',
  DEV_AUTH: '1',
  MAIL_MODE: 'off',
  LOG_LEVEL: 'silent',
};

const saved = new Map<string, string | undefined>(KEYS.map((key) => [key, process.env[key]]));

function setEnv(next: Record<string, string>): void {
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type Sql = Awaited<typeof import('@yunshuo/db')>['sql'];

interface Fixture {
  workspaceId: string;
  userId: string;
  email: string;
  startedAt: Date;
}

async function makeAccount(sql: Sql): Promise<Fixture> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const email = `prod-cookie-${workspaceId.slice(0, 8)}@test.local`;
  const passwordHash = await hashPassword(PASSWORD);
  // 窗口起点取数据库自己的 now()：客户端与 Postgres 的钟差会让"本轮之后"变成"本轮之前"。
  const nowRows = await sql<{ t: Date }[]>`SELECT now() AS t`;
  const startedAt = nowRows[0]?.t ?? new Date();
  await sql`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${'生产 Cookie 验收工作区'})`;
  await sql`
    INSERT INTO users (id, email, name, password_hash, password_updated_at)
    VALUES (${userId}, ${email}, ${'Cookie 验收所有者'}, ${passwordHash}, now())
  `;
  await sql`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  return { workspaceId, userId, email, startedAt };
}

/** 一次成功登录留下的会话行与 `auth.login` 审计；拒绝的两次都用它证明「什么都没写」。 */
async function traces(sql: Sql, userIds: string[]): Promise<string> {
  const rows = await sql<{ sessions: string; logins: string }[]>`
    SELECT
      (SELECT COUNT(*)::text FROM sessions WHERE user_id = ANY(${userIds})) AS sessions,
      (SELECT COUNT(*)::text FROM audit_log
        WHERE action = 'auth.login' AND actor_id = ANY(${userIds})) AS logins
  `;
  return `${rows[0]?.sessions}/${rows[0]?.logins}`;
}

/**
 * 临时账号按 id 删干净；种子 `owner@demo.local` **一行都不能删**——它是 owner，正文版本行
 * 的 `actor_id` 指着它（`canon_versions_actor_id_fkey`，第一次跑就撞在这条外键上），
 * 所以对它只清"本轮时间窗之内新出现的会话与 auth.login 审计"。这份白名单存在的理由与
 * §十八 同一条：夹具的清理能力也是被测面——摘掉生产那道闸的反向控制会给它建真会话。
 */
async function purgeTempAccount(sql: Sql, fixture: Fixture): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${fixture.userId}`;
  await sql`DELETE FROM audit_log WHERE action = 'auth.login' AND actor_id = ${fixture.userId}`;
  await sql`DELETE FROM memberships WHERE user_id = ${fixture.userId}`;
  await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
  await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
}

async function purgeSeedTraces(sql: Sql, userId: string, since: Date): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND created_at >= ${since}`;
  await sql`
    DELETE FROM audit_log
    WHERE action = 'auth.login' AND actor_id = ${userId} AND created_at >= ${since}
  `;
}

function sessionCookie(response: { headers: Record<string, unknown> }): string | undefined {
  const raw = response.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
  return list.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
}

describe('生产形态：Secure 的 Cookie 与关死的开发登录', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let fixture: Fixture;
  let ownerUserId: string;

  beforeAll(async () => {
    setEnv(PRODUCTION_ENV);
    vi.resetModules();
    const db = await import('@yunshuo/db');
    const { buildServer } = await import('./server.js');
    sql = db.sql;
    fixture = await makeAccount(sql);
    const owners = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = 'owner@demo.local' AND kind = 'human' LIMIT 1
    `;
    const id = owners[0]?.id;
    if (!id) throw new Error('测试库缺少种子账号 owner@demo.local，这条用例的前提不成立');
    ownerUserId = id;
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await purgeTempAccount(sql, fixture);
    await purgeSeedTraces(sql, ownerUserId, fixture.startedAt);
    const { closeDb } = await import('@yunshuo/db');
    await closeDb();
    restoreEnv();
  });

  it('密码登录成功，会话 Cookie 带 Secure、HttpOnly、SameSite=Lax 与七天有效期', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: fixture.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response);
    // 这一整条是 `auth.ts:197-206` 那份装配的端到端版本：`env.cookieSecure` 为真只是必要条件，
    // 最终发给浏览器的头部才是浏览器实际拿到的东西。
    expect(cookie).toBeDefined();
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
    // `signed: true` 才会带上签名段；界面拿不到裸会话 id 这件事由这里守一次。
    expect(cookie?.split(';')[0]).toMatch(/=[^.;]+\./);
    expect(response.body).not.toContain(PASSWORD);
  });

  it('生产环境不认 DEV_AUTH：同一账号无密码被拒，且一条痕迹都不留', async () => {
    const before = await traces(sql, [fixture.userId]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: fixture.email },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PASSWORD_REQUIRED');
    expect(response.json().error.message).toBe('此部署未启用开发登录，请填写邮箱和密码');
    expect(await traces(sql, [fixture.userId])).toBe(before);
  });

  it('种子里真实存在的 owner@demo.local 也无法在生产被无密码登进', async () => {
    const before = await traces(sql, [ownerUserId]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@demo.local' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PASSWORD_REQUIRED');
    // 上一组（dev-guards）摘掉同一道闸拿到的是 401 LOGIN_FAILED，因为那里的夹具邮箱根本不存在；
    // 这里换成真实存在的种子账号，闸若失守就是 200 + 一条真会话——所以这条断言才是那道闸的下游风险演练。
    expect(await traces(sql, [ownerUserId])).toBe(before);
  });
});

describe('非生产形态：同一个账号只差一个 NODE_ENV', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let fixture: Fixture;

  beforeAll(async () => {
    setEnv({ NODE_ENV: 'test', DEV_AUTH: '1', MAIL_MODE: 'memory', LOG_LEVEL: 'silent' });
    vi.resetModules();
    const db = await import('@yunshuo/db');
    const { buildServer } = await import('./server.js');
    sql = db.sql;
    fixture = await makeAccount(sql);
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await purgeTempAccount(sql, fixture);
    const { closeDb } = await import('@yunshuo/db');
    await closeDb();
    restoreEnv();
  });

  it('本机开发部署的会话 Cookie 不带 Secure（分叉的另一侧）', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: fixture.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response);
    expect(cookie).toBeDefined();
    // 少了这一条，`cookieSecure` 写成常量 `true` 也能让上面那组全绿——两侧都有，才是「分叉」。
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('DEV_AUTH=1 时同一个账号无密码即可登录，会话记 auth_method=dev', async () => {
    // 同组第一条用例已经为这个账号留过一条 password 会话，所以这里比的是"多出一整组形状"，
    // 不是绝对值（§二十二：共享测试库里的绝对值断言根本不成立）。
    const before = await traces(sql, [fixture.userId]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: fixture.email },
    });
    expect(response.statusCode).toBe(200);
    expect(sessionCookie(response)).toBeDefined();
    const rows = await sql<{ auth_method: string }[]>`
      SELECT auth_method FROM sessions WHERE user_id = ${fixture.userId} ORDER BY auth_method
    `;
    expect(rows.map((row) => row.auth_method)).toEqual(['dev', 'password']);
    expect(await traces(sql, [fixture.userId])).not.toBe(before);
  });
});
