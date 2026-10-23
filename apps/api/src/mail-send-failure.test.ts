import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { CreateInviteResponse } from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from './auth.js';
import { sanitizeError } from './services/mail-service.js';

/**
 * 邮件失败这一族此前只在服务层被读过码，HTTP 面与库里那行都没钉过。这里用**真 SMTP 配置 +
 * 本机一个没人监听的端口**让 nodemailer 自己抛错：不 stub、不改产品分支，失败是网络栈给的。
 *
 * 钉三件事：① 邀请照样成立（邮件失败不回滚邀请，`acceptUrl` 仍可手动复制）；② 账上如实记
 * `failed` + 归因码 + 单行文案，且 `sent_at` 留空——**失败不能看起来像发过**；③ 口令与用户名
 * 不出现在 HTTP 响应体、库里那一行与错误文案里（这条路径没有 `redactSecret`，靠的是错误里本来
 * 就没写凭据，所以要实测而不是推断）。
 *
 * **候选名单里那条 `MAIL_SEND_FAILED` 被这一枪改掉了**：真 SMTP 连不上时 nodemailer 一定带着自己
 * 的 `ESOCKET`（底层 `ECONNREFUSED` 只活在 message 里），所以 HTTP 面钉不到兜底码，它归下面那组
 * 纯函数用例。写死的"通常没人用"的端口也不采用：现取一个空闲端口再关掉，迟早被某个进程占上变成假绿。
 */
const KEYS = [
  'NODE_ENV',
  'DEV_AUTH',
  'MAIL_MODE',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_FROM',
  'MAIL_USER',
  'MAIL_PASSWORD',
  'LOG_LEVEL',
] as const;
const WORKSPACE_NAME = '邮件失败验收工作区';
const OWNER_NAME = '邮件失败所有者';
const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `mailfail-owner-${RUN_ID}@test.local`;
const INVITEE = 'probe@example.test';
// 这两个字符串必须哪儿都不出现：库里、响应里、内存邮箱里。
const SMTP_USER = `probe-user-${RUN_ID}`;
const SMTP_PASSWORD = `probe-password-${RUN_ID}-leak-check`;

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

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('拿不到空闲端口')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

type Sql = Awaited<typeof import('@yunshuo/db')>['sql'];

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('邮件失败测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('真 SMTP 连不上：邀请成立，账上如实记失败', () => {
  let app: FastifyInstance;
  let sqlHandle: Sql;
  let workspaceId = '';
  let ownerId = '';
  let cookie = '';
  let inviteId = '';
  let mailId = '';
  let inviteBodyText = '';

  beforeAll(async () => {
    const port = await closedPort();
    setEnv({
      NODE_ENV: 'test',
      DEV_AUTH: '1',
      MAIL_MODE: 'smtp',
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: String(port),
      MAIL_FROM: '云说 <no-reply@test.local>',
      MAIL_USER: SMTP_USER,
      MAIL_PASSWORD: SMTP_PASSWORD,
      LOG_LEVEL: 'silent',
    });
    vi.resetModules();
    const db = await import('@yunshuo/db');
    const { buildServer } = await import('./server.js');
    const { clearMemoryMailbox } = await import('./services/mail-service.js');
    sqlHandle = db.sql;
    workspaceId = randomUUID();
    ownerId = randomUUID();
    await sqlHandle`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${WORKSPACE_NAME})`;
    await sqlHandle`INSERT INTO users (id, email, name) VALUES (${ownerId}, ${OWNER_EMAIL}, ${OWNER_NAME})`;
    await sqlHandle`
      INSERT INTO memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')
    `;
    // 同进程里 §三十三 那个文件可能已经把数组留下过内容；这里要的是"这一轮一条都没进箱"。
    clearMemoryMailbox();
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
  });

  afterAll(async () => {
    await app.close();
    await sqlHandle`DELETE FROM sessions WHERE user_id = ${ownerId}`;
    await sqlHandle`DELETE FROM audit_log WHERE actor_id = ${ownerId} OR workspace_id = ${workspaceId}`;
    await sqlHandle`DELETE FROM workspace_invites WHERE workspace_id = ${workspaceId}`;
    await sqlHandle`DELETE FROM mail_messages WHERE workspace_id = ${workspaceId}`;
    await sqlHandle`DELETE FROM memberships WHERE user_id = ${ownerId}`;
    await sqlHandle`DELETE FROM users WHERE id = ${ownerId}`;
    await sqlHandle`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await closeDb();
    restoreEnv();
  });

  it('邮件失败不吞掉邀请：201 带 acceptUrl，mail 一侧如实报 failed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/invites',
      headers: { cookie },
      payload: { email: INVITEE, role: 'author' },
    });
    expect(response.statusCode).toBe(201);
    inviteBodyText = response.body;
    const body = response.json() as CreateInviteResponse;
    inviteId = body.invite.id;
    const mail = body.mail;
    mailId = mail.id;

    expect(mail.status).toBe('failed');
    expect(mail.provider).toBe('smtp');
    // 记录失败是另一条分支（id 回落空串 + MAIL_RECORD_FAILED）；这里 insert 成功，所以 id 必须是真 uuid。
    expect(mail.id).not.toBe('');
    expect(mail.sentAt).toBeNull();
    expect(mail.errorCode).not.toBeNull();
    expect(mail.message).toBe('邮件发送失败，链接仍可手动复制');

    // 邀请本身一行不少：邮件失败不回滚它，链接仍然能用。
    expect(body.invite.status).toBe('pending');
    expect(body.invite.email).toBe(INVITEE);
    const token = body.acceptUrl.slice(body.acceptUrl.lastIndexOf('/') + 1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await sqlHandle<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM workspace_invites WHERE id = ${inviteId}
    `;
    expect(stored[0]!.count).toBe('1');
  });

  it('归因码是 nodemailer 自己的 ESOCKET；底层 ECONNREFUSED 只活在文案里', async () => {
    const rows = await sqlHandle<{ error_code: string; error_message: string }[]>`
      SELECT error_code, error_message FROM mail_messages WHERE id = ${mailId}
    `;
    const code = rows[0]!.error_code;
    const message = rows[0]!.error_message;
    // 这一条是本轮把候选名单改掉的原因：`MAIL_SEND_FAILED` 是错误对象没有码时的兜底，
    // 真 SMTP 连不上永远拿得到 nodemailer 的码，所以 HTTP 面上钉不到它。
    expect(code).toBe('ESOCKET');
    expect(code).not.toBe('MAIL_SEND_FAILED');
    // 底层原因没有因为换了个码就丢掉：它整句留在 error_message 里，界面上能看到。
    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('127.0.0.1');
  });

  it('库里那行：failed + 单行截断文案 + sent_at 留空，凭据一个都不出现', async () => {
    const rows = await sqlHandle<Record<string, unknown>[]>`
      SELECT * FROM mail_messages WHERE id = ${mailId}
    `;
    const row = rows[0]!;
    expect(row.status).toBe('failed');
    expect(row.provider).toBe('smtp');
    expect(row.template).toBe('workspace_invite');
    expect(row.to_email).toBe(INVITEE);
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.user_id).toBeNull();
    // 失败不假装有发送时间。
    expect(row.sent_at).toBeNull();
    const code = String(row.error_code);
    const message = String(row.error_message);
    expect(code).not.toBe('');
    expect(code.length).toBeLessThanOrEqual(80);
    expect(message).not.toBe('');
    expect(message.length).toBeLessThanOrEqual(300);
    // sanitizeError 把空白压成单空格再截 300：库里这条必须已经是压平后的形状。
    expect(message).toBe(message.replace(/\s+/g, ' ').trim());
    const serialized = JSON.stringify(row);
    for (const secret of [SMTP_USER, SMTP_PASSWORD]) {
      // 库里那一行、HTTP 响应那一段原文、以及错误文案本身，三处都不得出现凭据。
      expect(serialized).not.toContain(secret);
      expect(inviteBodyText).not.toContain(secret);
      expect(message).not.toContain(secret);
    }
  });

  it('失败的邮件不进内存邮箱，smtp 模式下那条读端点本来也关着', async () => {
    const { listMemoryMailbox } = await import('./services/mail-service.js');
    expect(listMemoryMailbox()).toEqual([]);
    const mailbox = await app.inject({ method: 'GET', url: '/api/dev/mailbox' });
    expect(mailbox.statusCode).toBe(404);
    expect(mailbox.json().error.code).toBe('DEV_MAILBOX_DISABLED');
  });
});

/**
 * 兜底码与两处截断在这一族里是**纯函数用例**，不是端点用例：上面那枪已经实测出真 SMTP 连不上时
 * nodemailer 一定带着自己的 `ESOCKET`，HTTP 面造不出"错误对象没有码"的局面。这一组直接问脱敏
 * 本身：没有码 / 码是空串 / 码超长 / 文案是多行超长时，落到库里的那两个字段分别长什么样。
 */
describe('脱敏本身：没有可用的码才兜底，两处截断有上限', () => {
  it('没有码、码为 undefined 或码是空白 → 兜底 MAIL_SEND_FAILED', () => {
    expect(sanitizeError(new Error('connect ECONNREFUSED 127.0.0.1:25')).code).toBe('MAIL_SEND_FAILED');
    // 键存在但值是 undefined 走的是同一句兜底：这里曾经靠 `?? 'MAIL_SEND_FAILED'` 接住。
    expect(sanitizeError({ code: undefined, message: 'x' }).code).toBe('MAIL_SEND_FAILED');
    // 空串与纯空白：改之前 `String('' ?? 兜底)` 得到的是空串，库里会出现一条"失败了但归因码是空的"。
    expect(sanitizeError({ code: '', message: 'x' }).code).toBe('MAIL_SEND_FAILED');
    expect(sanitizeError({ code: '   ', message: 'x' }).code).toBe('MAIL_SEND_FAILED');
  });

  it('错误对象自己的码优先保留，包括不是 Error 的那些', () => {
    const esocket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ESOCKET' });
    expect(sanitizeError(esocket)).toEqual({
      code: 'ESOCKET',
      message: 'connect ECONNREFUSED 127.0.0.1:25',
    });
    expect(sanitizeError(Object.assign(new Error('认证失败'), { code: 'EAUTH' })).code).toBe('EAUTH');
    // 抛出来的不是 Error 而是字符串时，码走兜底、文案用 String() 的结果。
    expect(sanitizeError('邮件网关炸了')).toEqual({
      code: 'MAIL_SEND_FAILED',
      message: '邮件网关炸了',
    });
  });

  it('码截到 80、文案压成单行并截到 300：库里那两列的形状由这里保证', () => {
    const longCode = 'X'.repeat(200);
    const sanitizedCode = sanitizeError({ code: longCode, message: 'ok' }).code;
    expect(sanitizedCode).toHaveLength(80);
    expect(sanitizedCode).toBe('X'.repeat(80));

    const multiline = `  第一行\n\t第二行   连着两个空格\n${'尾'.repeat(400)}  `;
    const sanitizedMessage = sanitizeError(new Error(multiline)).message;
    // 换行与制表符全部压成单个空格：审计面板与列表直接读这一列，不能塞多行。
    expect(sanitizedMessage).not.toMatch(/[\n\r\t]/);
    expect(sanitizedMessage.startsWith('第一行 第二行 连着两个空格 尾')).toBe(true);
    expect(sanitizedMessage).toHaveLength(300);
    expect(sanitizedMessage).toBe(multiline.replace(/\s+/g, ' ').trim().slice(0, 300));

    // 空文案不留空列：换成一句能读懂的中文，而不是给界面一个空白。
    expect(sanitizeError(new Error('   '))).toEqual({
      code: 'MAIL_SEND_FAILED',
      message: '邮件发送失败',
    });
  });
});
