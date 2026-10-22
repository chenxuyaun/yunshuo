#!/usr/bin/env node
// 隔离测试库（yunshuo_test）残留对账：快照各表行数，并可与上一次快照比较。
// 一次快照看不出增长，所以标准用法是「跑一遍全量测试 → diff → 再跑一遍 → diff」。
//   node scripts/test-db-residue.mjs                # 打印当前快照
//   node scripts/test-db-residue.mjs --save=f.json  # 打印并保存快照
//   node scripts/test-db-residue.mjs --diff=f.json  # 与快照逐项比较，有增量则退出 1
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_CONTAINER = process.env.DB_CONTAINER ?? 'yunshuo-db';
const DB_USER = process.env.DB_USER ?? 'yunshuo';
const DB_NAME = process.env.DB_NAME ?? 'yunshuo_test';

if (DB_NAME !== 'yunshuo_test') {
  console.error(`只在隔离测试库上对账，当前 DB_NAME=${DB_NAME}`);
  process.exit(1);
}

const MEASURES = [
  ['audit_total', 'FROM audit_log'],
  ['audit_model_provider_create', "FROM audit_log WHERE action='model_provider.create'"],
  ['audit_auth_login', "FROM audit_log WHERE action='auth.login'"],
  ['events', 'FROM events'],
  ['outbox', 'FROM outbox'],
  ['mail_messages', 'FROM mail_messages'],
  ['workspace_invites', 'FROM workspace_invites'],
  ['auth_events', 'FROM auth_events'],
  ['password_reset_tokens', 'FROM password_reset_tokens'],
  ['sessions', 'FROM sessions'],
  ['users', 'FROM users'],
  ['workspaces', 'FROM workspaces'],
  ['memberships', 'FROM memberships'],
  ['works', 'FROM works'],
  ['chapters', 'FROM chapters'],
  ['canon_versions', 'FROM canon_versions'],
  ['canon_current', 'FROM canon_current'],
  ['ledger_entries', 'FROM ledger_entries'],
  ['chapter_ledger_links', 'FROM chapter_ledger_links'],
  ['ledger_suggestions', 'FROM ledger_suggestions'],
  ['model_calls', 'FROM model_calls'],
  ['ai_proposals', 'FROM ai_proposals'],
  ['ai_generation_locks', 'FROM ai_generation_locks'],
  ['model_providers', 'FROM model_providers'],
  ['gate_evaluations', 'FROM gate_evaluations'],
  ['waivers', 'FROM waivers'],
  ['automation_jobs', 'FROM automation_jobs'],
  ['automation_mandates', 'FROM automation_mandates'],
];

function psql(query) {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-Atc', query],
    { encoding: 'utf8' }
  ).trim();
}

const snapshotQuery = `${MEASURES.map(
  ([name, from]) => `SELECT '${name}' AS measure, count(*)::text AS n ${from}`
).join('\nUNION ALL\n')}\nORDER BY 1`;

const current = Object.fromEntries(
  psql(snapshotQuery)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [measure, n] = line.split('|');
      return [measure, Number(n)];
    })
);

const saveArg = process.argv.find((arg) => arg.startsWith('--save='));
const diffArg = process.argv.find((arg) => arg.startsWith('--diff='));

if (diffArg) {
  const file = diffArg.slice('--diff='.length);
  const before = JSON.parse(readFileSync(file, 'utf8'));
  let changed = 0;
  for (const [measure, n] of Object.entries(current)) {
    const delta = n - (before[measure] ?? 0);
    if (delta !== 0) {
      changed += 1;
      console.log(`${measure}: ${before[measure] ?? '—'} -> ${n} (${delta > 0 ? '+' : ''}${delta})`);
    }
  }
  console.log(changed === 0 ? '无增量：两次快照逐项相同' : `${changed} 项有增量`);
  process.exit(changed === 0 ? 0 : 1);
}

for (const [measure, n] of Object.entries(current)) {
  console.log(`${measure}\t${n}`);
}

if (saveArg) {
  const file = saveArg.slice('--save='.length);
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`\n快照已写入 ${file}`);
}
