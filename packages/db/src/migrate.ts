import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadEnv, requireEnv } from './env.js';

loadEnv();

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? requireEnv('DATABASE_URL');
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await sql`
      SELECT filename FROM schema_migrations WHERE filename = ${file}
    `;
    if (existing.length > 0) {
      console.log(`skip ${file}`);
      continue;
    }

    const content = readFileSync(join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
    console.log(`applied ${file}`);
  }

  console.log('migrations complete');
} finally {
  await sql.end({ timeout: 5 });
}
