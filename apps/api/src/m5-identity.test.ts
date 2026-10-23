import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  CreateInviteResponse,
  InvitePreviewResponse,
  MemberView,
  MeResponse,
  WorkspaceMembershipsResponse,
} from '@yunshuo/contracts';
import { sha256, type Role } from '@yunshuo/domain';
import { closeDb, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { SESSION_COOKIE } from './auth.js';
import { hashPassword } from './passwords.js';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// 路由层（maxParamLength）在应用错误处理器之前就回话，用的是框架自己的扁平形状。
interface FrameworkErrorBody {
  error: string;
  code: string;
  message: string;
}

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@m5-${RUN_ID}.test`;
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'another-long-password-42';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M5 身份集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;
const passwordHash = dbAvailable ? await hashPassword(PASSWORD) : '';

suite('M5-A 本地账号、邀请与成员角色', () => {
  let app: FastifyInstance;
  let workspaceA = '';
  let workspaceB = '';
  let ownerA: Session;
  let leadA: Session;
  let ownerB: Session;
  let invitedAuthor: Session;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  async function loginWithPassword(email: string, password: string): Promise<ApiResult<MeResponse>> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    return { status: response.statusCode, body: response.json() as MeResponse };
  }

  async function loginPassword(email: string, password = PASSWORD): Promise<Session> {
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

  async function createUser(
    workspaceId: string,
    email: string,
    name: string,
    role: Role,
  ): Promise<{ id: string; session: Session }> {
    const id = randomUUID();
    userIds.push(id);
    await sql`
      INSERT INTO users (id, email, name, password_hash, password_updated_at)
      VALUES (${id}, ${email}, ${name}, ${passwordHash}, now())
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${id}, ${role})
    `;
    return { id, session: await loginPassword(email) };
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
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

  async function createInvite(
    session: Session,
    email: string,
    role: string,
    expiresInHours = 72,
  ): Promise<ApiResult<CreateInviteResponse>> {
    return call<CreateInviteResponse>('POST', '/api/workspace/invites', session, {
      email,
      role,
      expiresInHours,
    });
  }

  function inviteToken(response: ApiResult<CreateInviteResponse>): string {
    expect(response.status).toBe(201);
    const token = response.body.acceptUrl.split('/invite/')[1];
    if (!token) throw new Error('邀请链接缺少令牌');
    return token;
  }

  async function acceptInvite(
    token: string,
    payload: object,
    session: Session | null = null,
  ): Promise<{ status: number; body: MeResponse | ErrorBody; cookie?: string }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      ...(session ? { headers: { cookie: session.cookie } } : {}),
      payload,
    });
    const setCookie = response.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return {
      status: response.statusCode,
      body: response.json() as MeResponse | ErrorBody,
      ...(typeof rawCookie === 'string' ? { cookie: rawCookie.split(';')[0]! } : {}),
    };
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();
    workspaceA = await createWorkspace(`M5-A 工作区 ${RUN_ID}`);
    workspaceB = await createWorkspace(`M5-B 工作区 ${RUN_ID}`);

    ownerA = (await createUser(workspaceA, `owner-a${EMAIL_SUFFIX}`, '甲所有者', 'owner')).session;
    ownerB = (await createUser(workspaceB, `owner-b${EMAIL_SUFFIX}`, '乙所有者', 'owner')).session;
    leadA = (await createUser(workspaceA, `lead-a${EMAIL_SUFFIX}`, '甲主笔', 'lead')).session;
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      if (!workspaceId) continue;
      await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM mail_messages WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_invites WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (userIds.length > 0) {
      const emailPattern = `%${EMAIL_SUFFIX}`;
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM users
        WHERE email LIKE ${emailPattern} OR id IN ${sql(userIds)}
      `;
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        await sql`DELETE FROM sessions WHERE user_id IN ${sql(ids)}`;
        await sql`DELETE FROM mail_messages WHERE user_id IN ${sql(ids)}`;
        await sql`DELETE FROM auth_events WHERE user_id IN ${sql(ids)}`;
        await sql`DELETE FROM password_reset_tokens WHERE user_id IN ${sql(ids)}`;
        await sql`DELETE FROM users WHERE id IN ${sql(ids)}`;
      }
    }
    if (app) await app.close();
    await closeDb();
  });

  it('密码登录成功，错误密码与未知邮箱返回同一失败码', async () => {
    const ok = await loginWithPassword(`owner-a${EMAIL_SUFFIX}`, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.workspace.id).toBe(workspaceA);

    expectError(await loginWithPassword(`owner-a${EMAIL_SUFFIX}`, 'wrong-password'), 401, 'LOGIN_FAILED');
    expectError(
      await loginWithPassword(`missing${EMAIL_SUFFIX}`, PASSWORD),
      401,
      'LOGIN_FAILED',
    );
  });

  it('连续失败触发限流，成功登录不泄露账号是否存在', async () => {
    const email = `rate-limit${EMAIL_SUFFIX}`;
    await createUser(workspaceA, email, '限流测试', 'viewer');
    for (let index = 0; index < 8; index += 1) {
      expectError(await loginWithPassword(email, `wrong-${index}`), 401, 'LOGIN_FAILED');
    }
    expectError(await loginWithPassword(email, PASSWORD), 429, 'LOGIN_RATE_LIMITED');
  });

  it('主笔可邀请作者，作者不能创建或查看邀请', async () => {
    const byLead = await createInvite(leadA, `invited-author${EMAIL_SUFFIX}`, 'author');
    expect(byLead.status).toBe(201);
    expect(byLead.body.invite.status).toBe('pending');
    expect(byLead.body.acceptUrl).toContain('/invite/');
    expect(byLead.body.acceptUrl).not.toContain('token_hash');

    expectError(await createInvite(leadA, `lead-2${EMAIL_SUFFIX}`, 'lead'), 403, 'FORBIDDEN');
    expectError(await createInvite(leadA, `owner-2${EMAIL_SUFFIX}`, 'owner'), 403, 'FORBIDDEN');

    const author = await acceptInvite(inviteToken(byLead), {
      name: '受邀作者',
      password: NEW_PASSWORD,
    });
    expect(author.status).toBe(200);
    expect((author.body as MeResponse).role).toBe('author');
    expect(author.cookie).toBeTruthy();
    invitedAuthor = { cookie: author.cookie!, me: author.body as MeResponse };

    expectError(await call('GET', '/api/workspace/invites', invitedAuthor), 403, 'FORBIDDEN');
    expectError(
      await createInvite(invitedAuthor, `nope${EMAIL_SUFFIX}`, 'viewer'),
      403,
      'FORBIDDEN',
    );
  });

  it('邀请只能使用一次，且邀请邮箱与登录账号必须一致', async () => {
    const created = await createInvite(ownerA, `single-use${EMAIL_SUFFIX}`, 'reviewer');
    const token = inviteToken(created);

    expectError(await acceptInvite(token, { name: '甲', password: 'short' }), 400, 'VALIDATION');

    const accepted = await acceptInvite(token, { name: '单次邀请', password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    expect((accepted.body as MeResponse).role).toBe('reviewer');

    expectError(await acceptInvite(token, { name: '重放', password: NEW_PASSWORD }), 409, 'INVITE_USED');

    const second = await createInvite(ownerA, `mismatch${EMAIL_SUFFIX}`, 'viewer');
    expectError(
      await acceptInvite(inviteToken(second), {}, ownerA),
      403,
      'FORBIDDEN',
    );
  });

  it('已登录的既有账号接受邀请后加入并切换到新工作区', async () => {
    const created = await createInvite(ownerB, `owner-a${EMAIL_SUFFIX}`, 'viewer');
    const preview = await call<InvitePreviewResponse>(
      'GET',
      `/api/invites/${inviteToken(created)}`,
      null,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.workspaceName).toContain('M5-B');
    expect(preview.body.accountExists).toBe(true);

    expectError(
      await acceptInvite(inviteToken(created), { name: '不应创建', password: NEW_PASSWORD }),
      401,
      'LOGIN_FAILED',
    );

    const accepted = await acceptInvite(inviteToken(created), {}, ownerA);
    expect(accepted.status).toBe(200);
    expect(accepted.cookie).toBe(ownerA.cookie);
    expect((accepted.body as MeResponse).workspace.id).toBe(workspaceB);
    expect((accepted.body as MeResponse).role).toBe('viewer');

    const memberships = await call<WorkspaceMembershipsResponse>(
      'GET',
      '/api/auth/workspaces',
      ownerA,
    );
    expect(memberships.status).toBe(200);
    expect(memberships.body.workspaces.map((item) => item.id).sort()).toEqual(
      [workspaceA, workspaceB].sort(),
    );

    const switched = await call<MeResponse>('POST', '/api/auth/workspace', ownerA, {
      workspaceId: workspaceA,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.workspace.id).toBe(workspaceA);

    expectError(
      await call('POST', '/api/auth/workspace', ownerA, { workspaceId: randomUUID() }),
      403,
      'FORBIDDEN',
    );
  });

  it('被移出全部工作区的账号可用密码直接接受新邀请，错误密码受限流', async () => {
    const email = `orphaned${EMAIL_SUFFIX}`.toLowerCase();
    const orphan = await createUser(workspaceB, email, '无工作区作者', 'author');
    await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceB} AND user_id = ${orphan.id}`;

    const inviteA = await createInvite(ownerA, email, 'viewer');
    const inviteB = await createInvite(ownerB, email, 'author');
    expect(inviteA.status).toBe(201);
    expect(inviteB.status).toBe(201);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expectError(
        await acceptInvite(inviteToken(inviteA), { password: 'wrong-password-42' }),
        401,
        'LOGIN_FAILED',
      );
    }
    expectError(
      await acceptInvite(inviteToken(inviteA), { password: PASSWORD }),
      429,
      'LOGIN_RATE_LIMITED',
    );

    const accepted = await acceptInvite(inviteToken(inviteB), { password: PASSWORD });
    expect(accepted.status).toBe(200);
    expect(accepted.cookie).toBeTruthy();
    expect((accepted.body as MeResponse).workspace.id).toBe(workspaceB);
    expect((accepted.body as MeResponse).role).toBe('author');

    const me = await call<MeResponse>('GET', '/api/me', {
      cookie: accepted.cookie!,
      me: accepted.body as MeResponse,
    });
    expect(me.status).toBe(200);
    expect(me.body.workspace.id).toBe(workspaceB);

    const accounts = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE lower(email) = ${email}
    `;
    expect(accounts[0]!.count).toBe('1');
  });

  it('并发接受同一新邮箱的两个邀请只创建一个账号', async () => {
    const email = `concurrent-new${EMAIL_SUFFIX}`.toLowerCase();
    const inviteA = await createInvite(ownerA, email, 'viewer');
    const inviteB = await createInvite(ownerB, email, 'viewer');
    expect(inviteA.status).toBe(201);
    expect(inviteB.status).toBe(201);

    const [resultA, resultB] = await Promise.all([
      acceptInvite(inviteToken(inviteA), { name: '并发注册', password: NEW_PASSWORD }),
      acceptInvite(inviteToken(inviteB), { name: '并发注册', password: NEW_PASSWORD }),
    ]);
    for (const result of [resultA, resultB]) {
      expect([200, 409]).toContain(result.status);
      if (result.status === 409) {
        expect((result.body as unknown as ErrorBody).error.code).toBe('ACCOUNT_EXISTS');
      }
    }

    const accounts = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE lower(email) = ${email}
    `;
    expect(accounts[0]!.count).toBe('1');

    const memberships = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE lower(u.email) = ${email}
    `;
    expect(Number(memberships[0]!.count)).toBeGreaterThanOrEqual(1);
    expect(Number(memberships[0]!.count)).toBeLessThanOrEqual(2);
  });

  it('重复邀请、邀请已有成员、撤销与过期邀请都有明确结果', async () => {
    const email = `dup${EMAIL_SUFFIX}`;
    const first = await createInvite(ownerA, email, 'viewer');
    expectError(await createInvite(ownerA, email, 'viewer'), 409, 'INVITE_PENDING');

    expectError(
      await createInvite(ownerA, `owner-a${EMAIL_SUFFIX}`, 'viewer'),
      409,
      'ALREADY_MEMBER',
    );

    const revoked = await createInvite(ownerA, `revoked${EMAIL_SUFFIX}`, 'viewer');
    const revoke = await call('DELETE', `/api/workspace/invites/${revoked.body.invite.id}`, ownerA);
    expect(revoke.status).toBe(200);
    const previewRevoked = await call<ErrorBody>(
      'GET',
      `/api/invites/${inviteToken(revoked)}`,
      null,
    );
    expectError(previewRevoked, 410, 'INVITE_USED');
    expectError(
      await acceptInvite(inviteToken(revoked), { name: '撤销后', password: NEW_PASSWORD }),
      409,
      'INVITE_USED',
    );

    const expiring = await createInvite(ownerA, `expired${EMAIL_SUFFIX}`, 'viewer', 1);
    await sql`
      UPDATE workspace_invites SET expires_at = now() - interval '1 minute'
      WHERE id = ${expiring.body.invite.id}
    `;
    expectError(
      await call<ErrorBody>('GET', `/api/invites/${inviteToken(expiring)}`, null),
      410,
      'INVITE_EXPIRED',
    );
    expectError(
      await acceptInvite(inviteToken(expiring), { name: '过期后', password: NEW_PASSWORD }),
      410,
      'INVITE_EXPIRED',
    );
    const replacement = await createInvite(ownerA, `expired${EMAIL_SUFFIX}`, 'viewer', 1);
    expect(replacement.status).toBe(201);
    expect(first.status).toBe(201);
  });

  it('并发创建同一邮箱邀请只保留一个待接受记录', async () => {
    const email = `concurrent-invite${EMAIL_SUFFIX}`;
    const [first, second] = await Promise.all([
      createInvite(ownerA, email, 'viewer'),
      createInvite(ownerA, email.toUpperCase(), 'reviewer'),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([201, 409]);
    const failed = first.status === 409 ? first : second;
    expect((failed.body as unknown as ErrorBody).error.code).toBe('INVITE_PENDING');

    const pending = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM workspace_invites
      WHERE workspace_id = ${workspaceA}
        AND lower(email) = ${email}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
    `;
    expect(pending[0]!.count).toBe('1');
  });

  it('邀请令牌与密码只以哈希形式入库', async () => {
    const email = `hashed${EMAIL_SUFFIX}`.toLowerCase();
    const created = await createInvite(ownerA, email, 'viewer');
    const token = inviteToken(created);
    const storedInvite = await sql<{ token_hash: string }[]>`
      SELECT token_hash FROM workspace_invites WHERE id = ${created.body.invite.id}
    `;
    expect(storedInvite[0]!.token_hash).toBe(sha256(token));
    expect(storedInvite[0]!.token_hash).not.toBe(token);

    const accepted = await acceptInvite(token, { name: '哈希验证', password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    const storedUser = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE lower(email) = ${email}
    `;
    expect(storedUser[0]!.password_hash).toMatch(/^scrypt\$/);
    expect(storedUser[0]!.password_hash).not.toContain(NEW_PASSWORD);
  });

  it('只有所有者能改角色，最后一名所有者不能被降级或移除', async () => {
    const members = await call<{ members: MemberView[] }>('GET', '/api/workspace/members', ownerA);
    expect(members.status).toBe(200);
    const authorMember = members.body.members.find((item) => item.email === `invited-author${EMAIL_SUFFIX}`);
    expect(authorMember?.role).toBe('author');

    const promoted = await call<MemberView>(
      'PATCH',
      `/api/workspace/members/${authorMember!.userId}`,
      ownerA,
      { role: 'reviewer' },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('reviewer');

    const refreshed = await call<MeResponse>('GET', '/api/me', invitedAuthor);
    expect(refreshed.body.role).toBe('reviewer');

    expectError(
      await call('PATCH', `/api/workspace/members/${authorMember!.userId}`, leadA, {
        role: 'viewer',
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await call('PATCH', `/api/workspace/members/${ownerA.me.user.id}`, ownerA, {
        role: 'viewer',
      }),
      409,
      'LAST_OWNER',
    );
    expectError(
      await call('DELETE', `/api/workspace/members/${ownerA.me.user.id}`, ownerA),
      409,
      'LAST_OWNER',
    );
  });

  it('并发降级两名所有者只允许一个成功，所有者不会归零', async () => {
    const workspaceId = await createWorkspace(`M5 并发所有者 ${RUN_ID}`);
    const first = await createUser(
      workspaceId,
      `concurrent-owner-a${EMAIL_SUFFIX}`,
      '并发所有者甲',
      'owner',
    );
    const second = await createUser(
      workspaceId,
      `concurrent-owner-b${EMAIL_SUFFIX}`,
      '并发所有者乙',
      'owner',
    );

    const [firstResult, secondResult] = await Promise.all([
      call<MemberView>('PATCH', `/api/workspace/members/${first.id}`, second.session, {
        role: 'viewer',
      }),
      call<MemberView>('PATCH', `/api/workspace/members/${second.id}`, first.session, {
        role: 'viewer',
      }),
    ]);
    expect([firstResult.status, secondResult.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const failed = firstResult.status === 409 ? firstResult : secondResult;
    expect((failed.body as unknown as ErrorBody).error.code).toBe('LAST_OWNER');

    const owners = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM memberships
      WHERE workspace_id = ${workspaceId} AND role = 'owner'
    `;
    expect(owners[0]!.count).toBe('1');
  });

  it('移除成员立即失效其会话，成员列表按工作区隔离', async () => {
    const temp = await createUser(workspaceA, `temp${EMAIL_SUFFIX}`, '临时成员', 'viewer');
    const removed = await call('DELETE', `/api/workspace/members/${temp.id}`, ownerA);
    expect(removed.status).toBe(200);
    expectError(await call('GET', '/api/me', temp.session), 401, 'UNAUTHENTICATED');

    const listA = await call<{ members: MemberView[] }>('GET', '/api/workspace/members', ownerA);
    const listB = await call<{ members: MemberView[] }>('GET', '/api/workspace/members', ownerB);
    expect(listA.body.members.some((item) => item.userId === temp.id)).toBe(false);
    expect(listB.body.members.map((item) => item.email)).not.toContain(`invited-author${EMAIL_SUFFIX}`);
    expect(listB.body.members.map((item) => item.email)).toContain(`owner-a${EMAIL_SUFFIX}`);

    const onlyInA = listA.body.members.find((item) => item.email === `lead-a${EMAIL_SUFFIX}`);
    expectError(
      await call('PATCH', `/api/workspace/members/${onlyInA!.userId}`, ownerB, {
        role: 'viewer',
      }),
      404,
      'MEMBER_NOT_FOUND',
    );
  });

  it('AI 服务主体不能被邀请、改角色或移除', async () => {
    const aiId = randomUUID();
    userIds.push(aiId);
    const aiEmail = `ai+${RUN_ID}@service.yunshuo.local`;
    await sql`INSERT INTO users (id, email, name, kind) VALUES (${aiId}, ${aiEmail}, 'AI 写作引擎', 'ai')`;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceA}, ${aiId}, 'ai')
    `;

    expectError(await createInvite(ownerA, aiEmail, 'viewer'), 409, 'AI_ACCOUNT_NOT_INVITABLE');
    expectError(
      await call('PATCH', `/api/workspace/members/${aiId}`, ownerA, { role: 'viewer' }),
      409,
      'AI_MEMBER_IMMUTABLE',
    );
    expectError(
      await call('DELETE', `/api/workspace/members/${aiId}`, ownerA),
      409,
      'AI_MEMBER_IMMUTABLE',
    );
  });

  it('登出作废服务端会话：同一 Cookie 复用失败，只影响当次会话', async () => {
    const email = `logout${EMAIL_SUFFIX}`;
    const created = await createUser(workspaceA, email, '登出作者', 'author');
    const first = created.session;
    const second = await loginPassword(email);
    const sessionCount = async (): Promise<string> => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM sessions WHERE user_id = ${created.id}
      `;
      return rows[0]!.count;
    };
    expect(await sessionCount()).toBe('2');

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: first.cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    const setCookie = out.headers['set-cookie'];
    const cleared = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(typeof cleared).toBe('string');
    // 登出删的是服务端会话行，不只是浏览器里的 Cookie：带着原 Cookie 再请求也是 401
    const token = first.cookie.split('=')[1]!;
    expect(cleared).toContain(SESSION_COOKIE);
    expect(cleared).not.toContain(token);
    expect(await sessionCount()).toBe('1');
    expectError(await call('GET', '/api/me', first), 401, 'UNAUTHENTICATED');
    expectError(
      await call('GET', '/api/me', { cookie: cleared!, me: first.me }),
      401,
      'UNAUTHENTICATED',
    );
    expect((await call('GET', '/api/me', second)).status).toBe(200);

    // 重复登出与无会话登出都幂等返回 200，不会伪造失败也不会多出会话
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: first.cookie },
    });
    expect(again.statusCode).toBe(200);
    const anonymous = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(anonymous.statusCode).toBe(200);
    expect(await sessionCount()).toBe('1');

    const back = await loginPassword(email);
    expect(await sessionCount()).toBe('2');
    expect(back.cookie).not.toBe(first.cookie);
    expect((await call('GET', '/api/me', back)).status).toBe(200);
  });

  it('开发登录仍可用，且 AI 主体不能通过密码或开发登录进入', async () => {
    const devResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: leadA.me.user.email },
    });
    expect(devResponse.statusCode).toBe(200);
    expect((devResponse.json() as MeResponse).user.email).toBe(leadA.me.user.email);

    const aiEmail = `ai+${RUN_ID}@service.yunshuo.local`;
    const byDev = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: aiEmail },
    });
    expect(byDev.statusCode).toBe(401);
    expectError(
      await loginWithPassword(aiEmail, PASSWORD),
      401,
      'LOGIN_FAILED',
    );
  });

  it('一句 INVITE_INVALID 回答"令牌太短"和"令牌不存在"，一句 INVITE_NOT_FOUND 回答四种撤销失败', async () => {
    async function revokeAudits(): Promise<string> {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*) AS count FROM audit_log
        WHERE workspace_id = ${workspaceA} AND action = 'member.invite.revoke'
      `;
      return rows[0]!.count;
    }

    async function counts(): Promise<{ invites: string; users: string }> {
      const [inviteRows, userRows] = await Promise.all([
        sql<{ count: string }[]>`SELECT count(*) AS count FROM workspace_invites`,
        sql<{ count: string }[]>`
          SELECT count(*) AS count FROM users WHERE email LIKE ${`%${EMAIL_SUFFIX}`}
        `,
      ]);
      return { invites: inviteRows[0]!.count, users: userRows[0]!.count };
    }

    const baseline = await counts();

    // ① "令牌形状不对"由两层分别回答，两层说的话不一样：
    //    短于 20 的那一支轮到 checkedToken（400，复用服务里那句"邀请链接无效"，是应用自己的
    //    {error:{code,message}} 形状）；而"长于 200"根本轮不到它——Fastify 的 maxParamLength
    //    默认 100，路由在进 setErrorHandler 之前就用 414 回话，带的是框架的
    //    {error:'Bad Request', code:'FST_ERR_MAX_PARAM_LENGTH'} 形状。
    //    也就是说：checkedToken 里 > 200 那一支从 HTTP 面打不到（要把它当可测分支，
    //    得先抬高超限，那是产品决定）；而这条拒绝不归一化、消息里把整条请求路径原样回显。
    const tooShort = 'short-token';
    const preview = await call<ErrorBody>('GET', `/api/invites/${tooShort}`, null);
    expectError(preview, 400, 'INVITE_INVALID');
    expect(preview.body.error.message).toBe('邀请链接无效');
    expectError((await acceptInvite(tooShort, {})) as ApiResult<unknown>, 400, 'INVITE_INVALID');

    const tooLong = 'x'.repeat(201);
    const longPreview = await call<FrameworkErrorBody>('GET', `/api/invites/${tooLong}`, null);
    expect(longPreview.status).toBe(414);
    expect(longPreview.body.code).toBe('FST_ERR_MAX_PARAM_LENGTH');
    expect(longPreview.body.error).toBe('Bad Request');
    expect(longPreview.body.message).toContain(`/api/invites/${tooLong}`);
    const longAccept = await acceptInvite(tooLong, {});
    expect(longAccept.status).toBe(414);
    expect((longAccept.body as unknown as FrameworkErrorBody).code).toBe(
      'FST_ERR_MAX_PARAM_LENGTH',
    );

    // 请求体解析排在令牌检查之前（routes/identity.ts:48 对 :49），所以坏令牌 + 坏请求体
    // 先响契约的 VALIDATION，而不是形状那句 INVITE_INVALID。
    expectError(
      (await acceptInvite(tooShort, { name: '甲', password: '123' })) as ApiResult<unknown>,
      400,
      'VALIDATION',
    );
    expect(await counts()).toEqual(baseline);

    // ② 形状合法但查无此令牌：预览与接受都是 404 同一句。
    const ghost = randomUUID().replaceAll('-', '');
    expectError(
      await call<ErrorBody>('GET', `/api/invites/${ghost}`, null),
      404,
      'INVITE_INVALID',
    );
    expectError(
      (await acceptInvite(ghost, {})) as ApiResult<unknown>,
      404,
      'INVITE_INVALID',
    );
    expect(await counts()).toEqual(baseline);

    // ③ 新邮箱的邀请：称呼与密码是"没有既有账号可登录"时才需要补的两项，
    //    缺任意一项都落进同一句 INVITE_PROFILE_REQUIRED。文案里的"至少 10 位"不是这道闸管的
    //    ——够长才轮到服务层，太短在契约就被拦走（上一条 ① 已经钉过一次）。
    const profileEmail = `profile-required${EMAIL_SUFFIX}`;
    const profileInvite = await createInvite(ownerA, profileEmail, 'viewer');
    const profileToken = inviteToken(profileInvite);
    for (const payload of [{}, { name: '只给称呼' }, { password: NEW_PASSWORD }]) {
      const refused = await acceptInvite(profileToken, payload);
      expectError(refused as ApiResult<unknown>, 400, 'INVITE_PROFILE_REQUIRED');
      expect((refused.body as ErrorBody).error.message).toBe('请填写称呼和至少 10 位密码');
    }
    expect(await counts()).toEqual({
      invites: String(Number(baseline.invites) + 1),
      users: baseline.users,
    });

    // ④ 撤销的一句 404 回答四种失败：不存在、已撤销、已接受、别的区的邀请。
    //    谓词是 UPDATE … WHERE id AND workspace_id AND accepted_at IS NULL AND revoked_at IS NULL，
    //    四种都只能得到"匹配 0 行"，界面因此无法区分贴错 id 与手慢了一步。
    //    四种形状逐个记标签再一起比：否则去掉某一条谓词时，红字只说"这一行不对"，
    //    说不出是四种里的哪一种被放行了。
    const ghostId = randomUUID();
    const revokedTwice = await createInvite(ownerA, `revoke-twice${EMAIL_SUFFIX}`, 'viewer');
    const revokedId = revokedTwice.body.invite.id;
    const auditBeforeFirst = await revokeAudits();
    expect((await call('DELETE', `/api/workspace/invites/${revokedId}`, ownerA)).status).toBe(200);
    expect(await revokeAudits()).toBe(String(Number(auditBeforeFirst) + 1));

    const acceptedInvite = await createInvite(ownerA, `revoke-accepted${EMAIL_SUFFIX}`, 'viewer');
    expect(
      (await acceptInvite(inviteToken(acceptedInvite), { name: '被撤销过', password: NEW_PASSWORD }))
        .status,
    ).toBe(200);

    const foreign = await createInvite(ownerB, `revoke-foreign${EMAIL_SUFFIX}`, 'viewer');
    const auditBeforeRefusals = await revokeAudits();
    const refusalShapes = [
      ['不存在', ghostId],
      ['已撤销', revokedId],
      ['已接受', acceptedInvite.body.invite.id],
      ['别的区', foreign.body.invite.id],
    ] as const;
    const refusals: {
      label: string;
      status: number;
      code: string;
      message: string;
    }[] = [];
    for (const [label, inviteId] of refusalShapes) {
      const refused = await call<ErrorBody>('DELETE', `/api/workspace/invites/${inviteId}`, ownerA);
      const error = (refused.body as Partial<ErrorBody>).error;
      refusals.push({
        label,
        status: refused.status,
        code: error?.code ?? '（成功，没有错误体）',
        message: error?.message ?? '',
      });
    }
    // 比的是"哪一种形状说了什么话"（按形状名建键）：红字里直接带形状名，
    // 不用猜是四条谓词里的哪一条松了。
    expect(
      Object.fromEntries(
        refusals.map((row) => [
          row.label,
          { status: row.status, code: row.code, message: row.message },
        ]),
      ),
    ).toEqual({
      不存在: { status: 404, code: 'INVITE_NOT_FOUND', message: '邀请不存在、已接受或已撤销' },
      已撤销: { status: 404, code: 'INVITE_NOT_FOUND', message: '邀请不存在、已接受或已撤销' },
      已接受: { status: 404, code: 'INVITE_NOT_FOUND', message: '邀请不存在、已接受或已撤销' },
      别的区: { status: 404, code: 'INVITE_NOT_FOUND', message: '邀请不存在、已接受或已撤销' },
    });
    // 四次拒绝一条审计都不留（审计写在 UPDATE 成功之后），而别人区那条邀请没有被顺手撤销。
    expect(await revokeAudits()).toBe(auditBeforeRefusals);
    const foreignRow = await sql<{ revoked_at: Date | null; accepted_at: Date | null }[]>`
      SELECT revoked_at, accepted_at FROM workspace_invites WHERE id = ${foreign.body.invite.id}
    `;
    expect(foreignRow[0]).toEqual({ revoked_at: null, accepted_at: null });
    // 作者没有撤销权：这一句在归属检查之前，403 与 404 是两种回答。
    expectError(
      await call<ErrorBody>('DELETE', `/api/workspace/invites/${revokedId}`, invitedAuthor),
      403,
      'FORBIDDEN',
    );
    expect(await revokeAudits()).toBe(auditBeforeRefusals);
  });
});
