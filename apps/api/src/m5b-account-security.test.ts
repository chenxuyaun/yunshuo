import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  ChangePasswordResponse,
  CreateInviteResponse,
  MeResponse,
  PasswordResetRequestResponse,
} from '@yunshuo/contracts';
import { closeDb, sql } from '@yunshuo/db';
import { sha256 } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { env } from './env.js';
import { hashPassword } from './passwords.js';
import { buildServer } from './server.js';
import { changePassword } from './services/account-security-service.js';
import { findLatestMemoryMail } from './services/mail-service.js';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@m5b-${RUN_ID}.test`;
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'another-long-password-42';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M5-B 账号安全集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;
const passwordHash = dbAvailable ? await hashPassword(PASSWORD) : '';

suite('M5-B 账号安全：邮件投递、密码修改与重置', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let owner: Session;
  let authorChangeId = '';
  let authorResetId = '';
  let authorRepeatId = '';
  let authorExpiryId = '';
  let authorRateId = '';
  let authorKnownId = '';
  let noPasswordId = '';
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  async function loginPassword(email: string, password = PASSWORD): Promise<ApiResult<MeResponse>> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    return { status: response.statusCode, body: response.json() as MeResponse };
  }

  async function login(email: string, password = PASSWORD): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof rawCookie !== 'string') throw new Error('登录未返回会话 Cookie');
    return { cookie: rawCookie.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(
    targetWorkspaceId: string | null,
    email: string,
    name: string,
    role: string,
    withPassword = true,
  ): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await sql`
      INSERT INTO users (id, email, name, password_hash, password_updated_at)
      VALUES (${id}, ${email}, ${name}, ${withPassword ? passwordHash : null},
        ${withPassword ? new Date() : null})
    `;
    if (targetWorkspaceId) {
      await sql`
        INSERT INTO memberships (workspace_id, user_id, role)
        VALUES (${targetWorkspaceId}, ${id}, ${role})
      `;
    }
    return id;
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    session: Session | null,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      ...(session ? { headers: { cookie: session.cookie } } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() as T };
  }

  function expectError(result: ApiResult<unknown>, status: number, code: string): void {
    expect(result.status).toBe(status);
    expect((result.body as ErrorBody).error.code).toBe(code);
  }

  async function requestReset(email: string): Promise<ApiResult<PasswordResetRequestResponse>> {
    return call<PasswordResetRequestResponse>('POST', '/api/auth/password/reset-request', null, {
      email,
    });
  }

  function tokenFromEmail(email: string): string {
    const message = findLatestMemoryMail(email);
    if (!message) throw new Error(`开发内存邮箱中没有发给 ${email} 的邮件`);
    const match = /\/reset\/([A-Za-z0-9_-]{20,200})/.exec(message.text);
    if (!match) throw new Error('重置邮件缺少重置链接');
    return match[1]!;
  }

  async function completeReset(
    token: string,
    newPassword = NEW_PASSWORD,
  ): Promise<ApiResult<{ ok: true } | ErrorBody>> {
    return call<{ ok: true } | ErrorBody>('POST', '/api/auth/password/reset', null, {
      token,
      newPassword,
    });
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();
    workspaceId = await createWorkspace(`M5-B 账号安全 ${RUN_ID}`);

    const ownerId = await createUser(workspaceId, `owner${EMAIL_SUFFIX}`, '安全所有者', 'owner');
    owner = await login(`owner${EMAIL_SUFFIX}`);

    authorChangeId = await createUser(
      workspaceId,
      `change${EMAIL_SUFFIX}`,
      '改密作者',
      'author',
    );
    authorResetId = await createUser(workspaceId, `reset${EMAIL_SUFFIX}`, '重置作者', 'author');
    authorRepeatId = await createUser(workspaceId, `repeat${EMAIL_SUFFIX}`, '补发作者', 'author');
    authorExpiryId = await createUser(workspaceId, `expiry${EMAIL_SUFFIX}`, '过期作者', 'author');
    authorRateId = await createUser(workspaceId, `rate${EMAIL_SUFFIX}`, '限流作者', 'author');
    authorKnownId = await createUser(workspaceId, `known${EMAIL_SUFFIX}`, '已知作者', 'author');
    noPasswordId = await createUser(
      workspaceId,
      `nopassword${EMAIL_SUFFIX}`,
      '无密码作者',
      'author',
      false,
    );
    await createUser(null, `orphan${EMAIL_SUFFIX}`, '孤立账号', 'author');
    expect(ownerId).toBeTruthy();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!dbAvailable) {
      await closeDb();
      return;
    }
    for (const id of userIds) {
      await sql`DELETE FROM mail_messages WHERE user_id = ${id}`;
      await sql`DELETE FROM auth_events WHERE user_id = ${id}`;
      await sql`DELETE FROM password_reset_tokens WHERE user_id = ${id}`;
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      await sql`DELETE FROM memberships WHERE user_id = ${id}`;
    }
    for (const id of workspaceIds) {
      await sql`DELETE FROM mail_messages WHERE workspace_id = ${id}`;
      await sql`DELETE FROM workspace_invites WHERE workspace_id = ${id}`;
      await sql`DELETE FROM sessions WHERE workspace_id = ${id}`;
      await sql`DELETE FROM workspaces WHERE id = ${id}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    await closeDb();
  });

  it('邀请会投递到开发内存邮箱，令牌只存哈希且不进入邮件元数据', async () => {
    const target = `invitee${EMAIL_SUFFIX}`;
    const created = await call<CreateInviteResponse>(
      'POST',
      '/api/workspace/invites',
      owner,
      { email: target, role: 'author', expiresInHours: 24 },
    );
    expect(created.status).toBe(201);
    expect(created.body.mail.status).toBe('captured');
    expect(created.body.mail.provider).toBe('memory');
    expect(created.body.mail.message).toContain('未真实投递');

    const token = created.body.acceptUrl.split('/invite/')[1]!;
    const inviteRows = await sql<{ token_hash: string }[]>`
      SELECT token_hash FROM workspace_invites WHERE id = ${created.body.invite.id}
    `;
    expect(inviteRows[0]?.token_hash).toBe(sha256(token));
    expect(inviteRows[0]?.token_hash).not.toBe(token);

    const mail = findLatestMemoryMail(target);
    expect(mail?.text).toContain(created.body.acceptUrl);
    expect(mail?.text).toContain(token);

    const mailRows = await sql<{ row: string }[]>`
      SELECT row_to_json(m)::text AS row FROM mail_messages m WHERE id = ${created.body.mail.id}
    `;
    expect(mailRows[0]?.row).not.toContain(token);
    expect(mailRows[0]?.row).toContain('workspace_invite');
    expect(mailRows[0]?.row).toContain('captured');
  });

  it('邮件表只保留元数据，不包含正文或令牌列', async () => {
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_messages'
    `;
    const names = columns.map((column) => column.column_name);
    for (const forbidden of ['body', 'content', 'text', 'token', 'token_hash']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toEqual(expect.arrayContaining(['to_email', 'template', 'status', 'provider']));
  });

  it('修改密码校验当前密码，撤销其他会话并保留当前会话', async () => {
    const email = `change${EMAIL_SUFFIX}`;
    const first = await login(email);
    const second = await login(email);

    const wrong = await call<ErrorBody>('POST', '/api/auth/password/change', first, {
      currentPassword: 'definitely-wrong-password',
      newPassword: NEW_PASSWORD,
    });
    expectError(wrong, 400, 'CURRENT_PASSWORD_INVALID');

    const failures = await sql`
      SELECT result FROM auth_events
      WHERE user_id = ${authorChangeId} AND action = 'password.change' AND result = 'failure'
    `;
    expect(failures.length).toBe(1);

    const changed = await call<ChangePasswordResponse>(
      'POST',
      '/api/auth/password/change',
      first,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    );
    expect(changed.status).toBe(200);
    expect(changed.body.revokedOtherSessions).toBe(1);

    expect((await call('GET', '/api/me', first)).status).toBe(200);
    expect((await call('GET', '/api/me', second)).status).toBe(401);
    expect((await loginPassword(email, PASSWORD)).status).toBe(401);
    expect((await loginPassword(email, NEW_PASSWORD)).status).toBe(200);

    const events = await sql<{ metadata: { revokedOtherSessions: number } }[]>`
      SELECT metadata FROM auth_events
      WHERE user_id = ${authorChangeId} AND action = 'password.change' AND result = 'success'
    `;
    expect(events[0]?.metadata.revokedOtherSessions).toBe(1);
  });

  it('修改密码会作废未使用的重置链接', async () => {
    const email = `known${EMAIL_SUFFIX}`;
    const session = await login(email);
    const requested = await requestReset(email);
    expect(requested.status).toBe(202);
    const token = tokenFromEmail(email);

    const changed = await call<ChangePasswordResponse>(
      'POST',
      '/api/auth/password/change',
      session,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    );
    expect(changed.status).toBe(200);

    expectError(await completeReset(token), 400, 'RESET_TOKEN_INVALID');
    const rows = await sql<{ used_at: Date | null }[]>`
      SELECT used_at FROM password_reset_tokens WHERE user_id = ${authorKnownId}
    `;
    expect(rows.every((row) => row.used_at !== null)).toBe(true);
  });

  it('重置密码：令牌一次性、撤销全部会话、新密码可登录', async () => {
    const email = `reset${EMAIL_SUFFIX}`;
    const first = await login(email);
    const second = await login(email);

    const requested = await requestReset(email);
    expect(requested.status).toBe(202);
    expect(requested.body.message).toContain('如果该邮箱对应可登录账号');
    const token = tokenFromEmail(email);

    const tokenRows = await sql<{ token_hash: string; used_at: Date | null }[]>`
      SELECT token_hash, used_at FROM password_reset_tokens WHERE user_id = ${authorResetId}
    `;
    expect(tokenRows[0]?.token_hash).toBe(sha256(token));
    expect(tokenRows[0]?.token_hash).not.toBe(token);
    expect(tokenRows[0]?.used_at).toBeNull();

    const done = await completeReset(token);
    expect(done.status).toBe(200);

    expect((await call('GET', '/api/me', first)).status).toBe(401);
    expect((await call('GET', '/api/me', second)).status).toBe(401);
    expect((await loginPassword(email, PASSWORD)).status).toBe(401);
    expect((await loginPassword(email, NEW_PASSWORD)).status).toBe(200);
    expectError(await completeReset(token), 400, 'RESET_TOKEN_INVALID');

    const events = await sql<{ metadata: { revokedSessions: number } }[]>`
      SELECT metadata FROM auth_events
      WHERE user_id = ${authorResetId} AND action = 'password.reset.complete' AND result = 'success'
    `;
    expect(events[0]?.metadata.revokedSessions).toBe(2);
  });

  it('重复申请会作废旧令牌，同时只有一个未使用令牌', async () => {
    const email = `repeat${EMAIL_SUFFIX}`;
    const firstRequest = await requestReset(email);
    expect(firstRequest.status).toBe(202);
    const firstToken = tokenFromEmail(email);

    const secondRequest = await requestReset(email);
    expect(secondRequest.status).toBe(202);
    const secondToken = tokenFromEmail(email);
    expect(secondToken).not.toBe(firstToken);

    const unused = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM password_reset_tokens
      WHERE user_id = ${authorRepeatId} AND used_at IS NULL
    `;
    expect(unused[0]?.count).toBe('1');

    expectError(await completeReset(firstToken), 400, 'RESET_TOKEN_INVALID');
    expect((await completeReset(secondToken)).status).toBe(200);
  });

  it('过期令牌被拒绝并标记为已使用', async () => {
    const email = `expiry${EMAIL_SUFFIX}`;
    expect((await requestReset(email)).status).toBe(202);
    const token = tokenFromEmail(email);
    await sql`
      UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
      WHERE token_hash = ${sha256(token)}
    `;
    expectError(await completeReset(token), 400, 'RESET_TOKEN_INVALID');
    const rows = await sql<{ used_at: Date | null }[]>`
      SELECT used_at FROM password_reset_tokens WHERE user_id = ${authorExpiryId}
    `;
    expect(rows[0]?.used_at).not.toBeNull();
  });

  it('未知邮箱、孤立账号与可登录账号返回同一提示，未知账号不投递', async () => {
    const known = await requestReset(`known${EMAIL_SUFFIX}`);
    const unknownEmail = `missing-${RUN_ID}${EMAIL_SUFFIX}`;
    const unknown = await requestReset(unknownEmail);
    const orphanEmail = `orphan${EMAIL_SUFFIX}`;
    const orphan = await requestReset(orphanEmail);

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(orphan.status).toBe(202);
    expect(unknown.body.message).toBe(known.body.message);
    expect(orphan.body.message).toBe(known.body.message);

    expect(findLatestMemoryMail(unknownEmail)).toBeUndefined();
    expect(findLatestMemoryMail(orphanEmail)).toBeUndefined();
    const orphanMails = await sql`
      SELECT id FROM mail_messages WHERE lower(to_email) = ${orphanEmail.toLowerCase()}
    `;
    expect(orphanMails.length).toBe(0);
    const orphanTokens = await sql`
      SELECT id FROM password_reset_tokens
      WHERE user_id = (SELECT id FROM users WHERE lower(email) = ${orphanEmail.toLowerCase()})
    `;
    expect(orphanTokens.length).toBe(0);
  });

  it('同一邮箱的重置请求在第五次之后触发限流', async () => {
    const email = `rate${EMAIL_SUFFIX}`;
    for (let index = 0; index < 5; index += 1) {
      expect((await requestReset(email)).status).toBe(202);
    }
    expectError(await requestReset(email), 429, 'RESET_RATE_LIMITED');
  });

  it('邮件关闭时不伪造发送成功，邀请链接仍返回', async () => {
    const previousMode = env.mail.mode;
    env.mail.mode = 'off';
    try {
      const target = `offline${EMAIL_SUFFIX}`;
      const created = await call<CreateInviteResponse>(
        'POST',
        '/api/workspace/invites',
        owner,
        { email: target, role: 'viewer', expiresInHours: 24 },
      );
      expect(created.status).toBe(201);
      expect(created.body.mail.status).toBe('not_configured');
      expect(created.body.mail.provider).toBe('off');
      expect(created.body.mail.message).toContain('未配置');
      expect(created.body.acceptUrl).toContain('/invite/');
      expect(findLatestMemoryMail(target)).toBeUndefined();

      const rows = await sql<{ status: string; provider: string }[]>`
        SELECT status, provider FROM mail_messages WHERE id = ${created.body.mail.id}
      `;
      expect(rows[0]).toEqual({ status: 'not_configured', provider: 'off' });
    } finally {
      env.mail.mode = previousMode;
    }
  });

  it('无密码账号不能直接修改密码', async () => {
    const auth: AuthContext = {
      user: {
        id: noPasswordId,
        email: `nopassword${EMAIL_SUFFIX}`,
        name: '无密码作者',
      },
      workspace: {
        id: workspaceId,
        name: `M5-B 账号安全 ${RUN_ID}`,
        settingsVersion: 1,
        ledgerVersion: 1,
      },
      role: 'author',
      sessionId: randomUUID(),
    };
    await expect(
      changePassword(
        auth,
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { ip: '127.0.0.1', userAgent: 'vitest' },
      ),
    ).rejects.toMatchObject({ code: 'PASSWORD_NOT_SET' });
  });

  it(
    '新密码与当前密码相同要先过验旧密码这一关；并发窗口里已被改掉的密码不会被后到的请求覆盖',
    async () => {
      const email = `same${EMAIL_SUFFIX}`;
      const userId = await createUser(workspaceId, email, '同密码账号', 'author');
      const mine = await login(email);
      const other = await login(email);

      async function sessionCount(): Promise<string> {
        const rows = await sql<{ count: string }[]>`
          SELECT count(*) AS count FROM sessions WHERE user_id = ${userId}
        `;
        return rows[0]!.count;
      }

      async function changeEvents(result: 'success' | 'failure'): Promise<string> {
        const rows = await sql<{ count: string }[]>`
          SELECT count(*) AS count FROM auth_events
          WHERE user_id = ${userId} AND action = 'password.change' AND result = ${result}
        `;
        return rows[0]!.count;
      }

      // ① 三道前置的先后：没设密码 → 验当前密码 → 比新旧是否相同。
      // 当前密码错的时候即使两个值相同也先响 CURRENT_PASSWORD_INVALID——不先把旧密码验一遍，
      // 服务端无从知道"相同"是笔误还是攻击。
      const wrongButSame = await call<ErrorBody>('POST', '/api/auth/password/change', mine, {
        currentPassword: 'definitely-wrong-password',
        newPassword: 'definitely-wrong-password',
      });
      expectError(wrongButSame, 400, 'CURRENT_PASSWORD_INVALID');
      expect(await changeEvents('failure')).toBe('1');

      const unchanged = await call<ErrorBody>('POST', '/api/auth/password/change', mine, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      });
      expectError(unchanged, 400, 'PASSWORD_UNCHANGED');
      expect(unchanged.body.error.message).toBe('新密码不能与当前密码相同');

      // 契约只管长度，"相同"这件事在服务层：6 位的相同密码先被 zod 拦成 VALIDATION，
      // 而这条拦在请求体解析阶段，连验密码那一步都没走到，所以失败事件数不变。
      expectError(
        await call<ErrorBody>('POST', '/api/auth/password/change', mine, {
          currentPassword: 'shorty',
          newPassword: 'shorty',
        }),
        400,
        'VALIDATION',
      );
      expect(await changeEvents('failure')).toBe('1');
      expect(await changeEvents('success')).toBe('0');
      expect((await call('GET', '/api/me', mine)).status).toBe(200);
      expect((await call('GET', '/api/me', other)).status).toBe(200);
      expect((await loginPassword(email, PASSWORD)).status).toBe(200);
      expect(await changeEvents('success')).toBe('0');

      // ② CAS 的窗口是确定性拉出来的，不靠时序运气：测试事务先用 FOR UPDATE 锁住用户行，
      //    等请求真的卡在行锁上——pg_stat_activity 里那条 wait_event='transactionid' 的
      //    密码 UPDATE 就是"旧哈希已读、正等着写"的凭据——再在锁内把密码改成 NEW_PASSWORD 并提交。
      //    请求醒来后 WHERE … AND password_hash = <旧哈希> 一行也匹配不到 → 409，
      //    而它整个事务回滚，所以"撤销其他会话"这一步没做成。
      const concurrentHash = await hashPassword(NEW_PASSWORD);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending: Promise<ApiResult<ErrorBody>> | null = null;

      async function requestParkedOnRowLock(): Promise<boolean> {
        // 文本是按 postgres.js 实际发出的样子匹配的：那条 CAS 带着模板里的换行和 $n 占位符进来，
        // 所以只能用子句片段认，不能用 "UPDATE users SET password_hash%" 这种前缀。
        const rows = await sql<{ count: string }[]>`
          SELECT count(*) AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND wait_event = 'transactionid'
            AND query LIKE ${'%UPDATE users%'}
            AND query LIKE ${'%password_hash%'}
        `;
        return rows[0]!.count !== '0';
      }

      async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (await predicate()) return true;
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      const sessionsBefore = await sessionCount();
      try {
        const blocker = sql.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
          await gate;
          await tx`
            UPDATE users SET password_hash = ${concurrentHash}, password_updated_at = now()
            WHERE id = ${userId}
          `;
        });

        pending = call<ErrorBody>('POST', '/api/auth/password/change', mine, {
          currentPassword: PASSWORD,
          newPassword: 'third-long-password-77',
        });
        expect(await waitUntil(requestParkedOnRowLock, 5_000)).toBe(true);
        release();
        await blocker;

        const raced = await pending;
        pending = null;
        expectError(raced, 409, 'PASSWORD_CHANGED_CONCURRENTLY');
        expect(raced.body.error.message).toBe('密码已被其他会话修改，请重新登录');

        // 输的一方一行都不许留下：会话没被撤销、没有成功事件、赢的那次改动作数。
        expect(await sessionCount()).toBe(sessionsBefore);
        expect(await changeEvents('success')).toBe('0');
        expect((await call('GET', '/api/me', other)).status).toBe(200);
        expect((await loginPassword(email, PASSWORD)).status).toBe(401);
        expect((await loginPassword(email, NEW_PASSWORD)).status).toBe(200);

        // 正控制：同一账号在密码已是最新值之后再改一次，走的就是正常成功路径。
        const afterWin = await login(email, NEW_PASSWORD);
        const normal = await call<ChangePasswordResponse>('POST', '/api/auth/password/change', afterWin, {
          currentPassword: NEW_PASSWORD,
          newPassword: 'fourth-long-password-88',
        });
        expect(normal.status).toBe(200);
        expect(await changeEvents('success')).toBe('1');
      } finally {
        release();
        if (pending) await pending.catch(() => undefined);
      }
    },
    25_000,
  );
});
