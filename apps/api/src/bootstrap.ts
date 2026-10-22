import { randomUUID } from 'node:crypto';
import { closeDb, sql } from '@yunshuo/db';
import { hashPassword } from './passwords.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readRequired(name: string, label: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}（${label}）`);
  }
  return value;
}

async function bootstrapOwner(): Promise<void> {
  const email = readRequired('BOOTSTRAP_OWNER_EMAIL', '首个所有者邮箱').toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD ?? '';
  const name = process.env.BOOTSTRAP_OWNER_NAME?.trim() || '所有者';
  const workspaceName = process.env.BOOTSTRAP_WORKSPACE_NAME?.trim() || '云说工作区';

  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('BOOTSTRAP_OWNER_EMAIL 不是合法邮箱');
  }

  let created: { userId: string; workspaceId: string } | null = null;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('yunshuo-bootstrap-owner'))`;

    const existing = await tx<{ id: string; kind: string }[]>`
      SELECT id, kind FROM users WHERE lower(email) = ${email} LIMIT 1
    `;
    if (existing.length > 0) {
      const user = existing[0]!;
      if (user.kind !== 'human') {
        throw new Error('该邮箱已被非人类账号占用，无法用于所有者账号');
      }
      const owned = await tx<{ workspace_id: string }[]>`
        SELECT workspace_id FROM memberships
        WHERE user_id = ${user.id} AND role = 'owner'
        LIMIT 1
      `;
      if (owned.length > 0) {
        console.log(`账号 ${email} 已是工作区所有者，跳过初始化（未做修改）。`);
        return;
      }
      console.warn(
        `警告：账号 ${email} 已存在但不是任何工作区所有者，bootstrap 不修改既有账号与角色，已跳过。`,
      );
      return;
    }

    // 仅在需要新建账号时校验密码与名称；已有所有者时运维可以移除这些环境变量。
    if (password.length < 10) {
      throw new Error('BOOTSTRAP_OWNER_PASSWORD 至少需要 10 位');
    }
    if (name.length > 80) {
      throw new Error('BOOTSTRAP_OWNER_NAME 不能超过 80 个字符');
    }
    if (workspaceName.length > 120) {
      throw new Error('BOOTSTRAP_WORKSPACE_NAME 不能超过 120 个字符');
    }

    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await tx`
      INSERT INTO users (id, email, name, password_hash, password_updated_at)
      VALUES (${userId}, ${email}, ${name}, ${passwordHash}, now())
    `;
    await tx`
      INSERT INTO workspaces (id, name) VALUES (${workspaceId}, ${workspaceName})
    `;
    await tx`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')
    `;
    await tx`
      INSERT INTO audit_log (
        workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
      )
      VALUES (
        ${workspaceId}, ${userId}, 'human', 'owner', 'workspace.bootstrap',
        'workspace', ${workspaceId}, 'success',
        ${tx.json({ email, workspaceName, source: 'bootstrap' })}
      )
    `;
    created = { userId, workspaceId };
  });

  if (created) {
    const { userId, workspaceId } = created;
    console.log('首个所有者初始化完成：');
    console.log(`  邮箱：${email}`);
    console.log(`  称呼：${name}`);
    console.log(`  工作区：${workspaceName}`);
    console.log(`  用户 ID：${userId}`);
    console.log(`  工作区 ID：${workspaceId}`);
    console.log('密码未写入日志。');
  }
}

try {
  await bootstrapOwner();
} catch (error) {
  console.error(
    `初始化失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
