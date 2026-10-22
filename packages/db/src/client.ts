import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { requireEnv } from './env.js';
import * as schema from './schema.js';

const databaseUrl = requireEnv('DATABASE_URL');

export const sql = postgres(databaseUrl, {
  max: 10,
  onnotice: () => undefined,
});

// drizzle 的 postgres-js 驱动会把日期类型序列化器替换成恒等函数，若与原生 SQL
// 共用同一个客户端，传 Date 参数会在 Bind 阶段报错，因此这里使用独立连接池。
const drizzleClient = postgres(databaseUrl, {
  max: 2,
  onnotice: () => undefined,
});

export const db = drizzle(drizzleClient, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await Promise.all([
    sql.end({ timeout: 5 }),
    drizzleClient.end({ timeout: 5 }),
  ]);
}
