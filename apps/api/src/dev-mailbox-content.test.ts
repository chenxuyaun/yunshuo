import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  CreateInviteResponse,
  DevMailboxResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from './auth.js';

/**
 * §二十九 留下的边界②在这里兑现：那个文件钉的是「闸关着会拒绝」与「闸开着但邮箱是空的」，
 * 本文件钉的是**邮箱里有货时 HTTP 面到底长什么样**——邀请邮件的完整正文、邀请 id 与邮箱条目 id
 * 的同一条接缝、最新在前的顺序，以及「`mail_messages` 只存元数据、正文与令牌都不落库」这条
 * 诚实边界在接口面上同样成立。
 *
 * 为什么不并进 `dev-guards.test.ts`：那个文件的性质是**一行都不写库**，而这里的货必须由真实
 * 邀请流程产生（`workspace_invites` + `audit_log` + `mail_messages` 各一行）。夹具工作区与夹具
 * 账号都是本轮自建的，清理按 id 走；种子里那三个账号一行都不碰（§三十一 的教训）。
 *
 * 本文件带了一处产品改动：`/api/dev/mailbox` 现在把条目投影成契约声明的六个键。第一条用例
 * 跑出来的是八个键——内存里那份投递入参连着 `workspaceId`/`userId` 一起发了出去。
 */
const KEYS = ['NODE_ENV', 'DEV_AUTH', 'MAIL_MODE', 'LOG_LEVEL', 'WEB_ORIGIN'] as const;
// 刻意不用 .env 里那个默认端口：acceptUrl 的断言不能靠"默认值刚好也一样"偶然成立。
const WEB_ORIGIN = 'http://127.0.0.1:5199';
const WORKSPACE_NAME = '邮箱形状验收工作区';
const OWNER_NAME = '邮箱形状所有者';
const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `mailbox-owner-${RUN_ID}@test.local`;
const INVITEE_A = 'probe-a@example.test';
const INVITEE_B = 'probe-b@example.test';

const saved = new Map<string, string | undefined>(KEYS.map((key) => [key, process.env[key]]));

function setEnv(next: Record<string, string>): void {
  // 只合并显式给出的键：误删 NODE_ENV 会整段跳过生产守卫，误删 DEV_AUTH 则被 dotenv
  // 从仓库 .env 补回 '1'（`packages/db/src/env.ts:17` 的 `override: false`）。
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

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('开发邮箱内容测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('开发内存邮箱：有货时的 HTTP 形状', () => {
  let app: FastifyInstance;
  let sqlHandle: Sql;
  let workspaceId = '';
  let ownerId = '';
  let cookie = '';
  const inviteIds: string[] = [];
  const mailIds: string[] = [];
  /** 明文邀请令牌只该活在 HTTP 面与内存邮箱里；本文件把它当"绝不该出现在库里的那串字符"来用。 */
  const tokens: string[] = [];
  const ACCEPT_PREFIX = `${WEB_ORIGIN}/invite/`;

  async function mailbox(): Promise<{ status: number; body: DevMailboxResponse }> {
    const response = await app.inject({ method: 'GET', url: '/api/dev/mailbox' });
    return { status: response.statusCode, body: response.json() as DevMailboxResponse };
  }

  async function invite(email: string, role: 'author' | 'reviewer' = 'author') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/invites',
      headers: { cookie },
      payload: { email, role },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as CreateInviteResponse;
    inviteIds.push(body.invite.id);
    mailIds.push(body.mail.id);
    expect(body.acceptUrl.startsWith(ACCEPT_PREFIX)).toBe(true);
    const token = body.acceptUrl.slice(ACCEPT_PREFIX.length);
    // randomBytes(32).toString('base64url') 恒定 43 个字符，所以"从 URL 里切出令牌"这步是可核对的。
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    tokens.push(token);
    return body;
  }

  beforeAll(async () => {
    setEnv({
      NODE_ENV: 'test',
      DEV_AUTH: '1',
      MAIL_MODE: 'memory',
      LOG_LEVEL: 'silent',
      WEB_ORIGIN,
    });
    vi.resetModules();
    const db = await import('@yunshuo/db');
    const { buildServer } = await import('./server.js');
    sqlHandle = db.sql;
    workspaceId = randomUUID();
    ownerId = randomUUID();
    await sqlHandle`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${WORKSPACE_NAME})`;
    await sqlHandle`
      INSERT INTO users (id, email, name)
      VALUES (${ownerId}, ${OWNER_EMAIL}, ${OWNER_NAME})
    `;
    await sqlHandle`
      INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')
    `;
    app = await buildServer();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: OWNER_EMAIL },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const entry = Array.isArray(raw) ? raw[0] : raw;
    if (typeof entry !== 'string') throw new Error('开发登录未返回会话 Cookie');
    cookie = entry.split(';')[0]!;
    // 会话行的 auth_method 只作前置校验：dev 身份由 §二十八/三十一 钉，这里要的是"带着能建邀请的会话"。
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  });

  afterAll(async () => {
    await app.close();
    // 逐行按 id 删：本轮建的夹具才有删除资格。
    await sqlHandle`DELETE FROM sessions WHERE user_id = ${ownerId}`;
    await sqlHandle`
      DELETE FROM audit_log WHERE actor_id = ${ownerId} OR workspace_id = ${workspaceId}
    `;
    await sqlHandle`DELETE FROM workspace_invites WHERE workspace_id = ${workspaceId}`;
    await sqlHandle`DELETE FROM mail_messages WHERE workspace_id = ${workspaceId}`;
    await sqlHandle`DELETE FROM memberships WHERE user_id = ${ownerId}`;
    await sqlHandle`DELETE FROM users WHERE id = ${ownerId}`;
    await sqlHandle`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await closeDb();
    restoreEnv();
  });

  it('邀请一封进邮箱：顶层三键、消息六键，逐字给出面包与正文', async () => {
    const created = await invite(`  ${INVITEE_A.toUpperCase()}  `);
    const { status, body } = await mailbox();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['delivered', 'messages', 'mode']);
    // 有货时那两个常量仍然是常量：登录页「未真实投递 · 仅 DEV_AUTH 本机可读」读的就是它们。
    expect(body.mode).toBe('memory');
    expect(body.delivered).toBe(false);
    expect(body.messages).toHaveLength(1);

    const message = body.messages[0]!;
    expect(Object.keys(message).sort()).toEqual([
      'createdAt',
      'id',
      'subject',
      'template',
      'text',
      'to',
    ]);
    // 这条键集合是本轮写用例时才翻出来的真分歧：投影之前，HTTP 面把内存里那条投递入参整份发出去，
    // 多带 `workspaceId` 与 `userId` 两个内部 id——契约 `DevMailboxMessage` 只声明六个键，
    // 而登录页只读 subject/to/text/createdAt/id。`routes/auth.ts` 里那次 `.map()` 就是为这条断言存在的。
    expect(JSON.stringify(message)).not.toContain(workspaceId);
    expect(JSON.stringify(body)).not.toContain(ownerId);
    // 同一条接缝：创建响应里的邮件 id 就是邮箱条目 id，也是 mail_messages 的主键。
    expect(message.id).toBe(created.mail.id);
    expect(message.id).not.toBe('');
    expect(created.mail.status).toBe('captured');
    expect(created.mail.provider).toBe('memory');
    // 服务层把邮箱归一化成小写再落面，HTTP 面必须给归一化后的地址而不是我刚发出去的那串。
    expect(message.to).toBe(INVITEE_A);
    expect(message.template).toBe('workspace_invite');
    expect(message.subject).toBe(`邀请你加入「${WORKSPACE_NAME}」· 云说`);

    const lines = message.text.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(`${OWNER_NAME} 邀请你以「作者」身份加入「${WORKSPACE_NAME}」。`);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(`接受邀请：${created.acceptUrl}`);
    expect(lines[5]).toBe('若你不认识这次邀请，可以忽略本邮件。');
    // 邮件说的有效期就是默认 72 小时——不是界面另算一遍，而是正文里那个日期本身。
    // 整行按形状捕获（ISO 带 Z、后面跟一个全角句号）：只 strip 前缀会把句号留在串里，Date.parse 变 NaN。
    const expiry = lines[1]!.match(/^邀请有效期至 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)。$/);
    expect(expiry).not.toBeNull();
    const expiryMs = Date.parse(expiry![1]!);
    expect((expiryMs - Date.now()) / 3_600_000).toBeGreaterThan(71.5);
    expect((expiryMs - Date.now()) / 3_600_000).toBeLessThan(72.5);

    // 令牌从 URL 里切出来后，必须真在正文里——登录页"直接打开邀请链接"靠的就是这一句。
    expect(tokens).toHaveLength(1);
    expect(message.text).toContain(tokens[0]!);
    expect(Date.parse(message.createdAt)).not.toBeNaN();
  });

  it('第二封压在最先面：邮箱按最新在前，先前那些保持原有相对顺序跟在后面', async () => {
    const before = (await mailbox()).body.messages.map((message) => message.id);
    const second = await invite(INVITEE_B, 'reviewer');
    const { body } = await mailbox();
    // unshift 的顺序就是界面拿到的顺序：第 0 条永远是刚发出去的那封。
    expect(body.messages[0]!.id).toBe(second.mail.id);
    expect(body.messages[0]!.to).toBe(INVITEE_B);
    expect(body.messages.map((message) => message.id)).toEqual([second.mail.id, ...before]);
    expect(body.messages[0]!.text).toContain('「审阅者」');
    expect(body.messages[1]!.to).toBe(INVITEE_A);
  });

  it('mail_messages 只有元数据：正文与邀请令牌都不落库，但同一条在 HTTP 面读得到', async () => {
    const rows = await sqlHandle<Record<string, unknown>[]>`
      SELECT * FROM mail_messages WHERE workspace_id = ${workspaceId} ORDER BY created_at ASC, id ASC
    `;
    expect(rows.length).toBeGreaterThan(0);
    // 11 个元数据列里没有任何正文列：这张表从形状上就存不下邮件内容。
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'created_at',
      'error_code',
      'error_message',
      'id',
      'provider',
      'sent_at',
      'status',
      'template',
      'to_email',
      'user_id',
      'workspace_id',
    ]);
    const serialized = JSON.stringify(rows);
    for (const token of tokens) expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('接受邀请');
    expect(serialized).not.toContain(WORKSPACE_NAME);
    // 捕获不是失败也不是发送：错误两列必须留空，界面才不会把内存邮箱念成"已投递"。
    for (const row of rows) {
      expect(row.status).toBe('captured');
      expect(row.provider).toBe('memory');
      expect(row.error_code).toBeNull();
      expect(row.error_message).toBeNull();
      expect(row.user_id).toBeNull();
      expect(row.sent_at).not.toBeNull();
    }
    // 同一批 id 正是邮箱里那些条目，一封都没漏——内容只活在进程内存中。
    expect(mailIds).toHaveLength(inviteIds.length);
    const { body } = await mailbox();
    expect(body.messages.map((message) => message.id).sort()).toEqual([...mailIds].sort());
  });

  it('清零内存邮箱后 HTTP 立刻空回来，而库里的元数据行一条没少', async () => {
    const rowCountBefore = await sqlHandle<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM mail_messages WHERE workspace_id = ${workspaceId}
    `;
    // 服务端与这里是同一份已加载的模块图（beforeAll 的 resetModules 之后没有第二次重置），
    // 所以清的就是那个进程内数组——这也顺带钉住"读端点读的是内存，不是 mail_messages"。
    const mailService = await import('./services/mail-service.js');
    mailService.clearMemoryMailbox();
    expect((await mailbox()).body.messages).toEqual([]);
    const rowCountAfter = await sqlHandle<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM mail_messages WHERE workspace_id = ${workspaceId}
    `;
    expect(rowCountAfter[0]!.n).toBe(rowCountBefore[0]!.n);
  });
});
