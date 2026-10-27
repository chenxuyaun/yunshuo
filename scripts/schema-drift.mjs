import fs from 'node:fs';
import path from 'node:path';

// 第三个筛子：迁移（唯一的运行时真相）与 schema.ts（声明式镜像）之间的漂移。
//
// 为什么需要它：schema.ts 没有任何运行时调用方，所有查询都走 postgres.js 的 sql 模板，
// 所以它漂移了不会有任何测试变红——gate_evaluations.hints 就是这么漏掉的。
// 它的价值只在"能被人当真相读"，一旦不真就只剩误导，必须由静态检查钉住。
//
// 口径：只比对表名与列名的有无，不比对类型、约束、默认值、索引、外键。
// 也就是说它拦得住"表/列漏登记"，拦不住"类型登记错了"。那部分仍要靠人。

const migrationsDir = 'packages/db/migrations';
const schemaFile = 'packages/db/src/schema.ts';

// 允许清单：只在"迁移确实这么做、而 schema.ts 有意不跟"时登记，并写清原因。
// 条目一旦不再需要（差异已经消失）同样报错，防止清单腐烂成免检通行证。
const ALLOWLIST = {
  // 'table_name': '原因',
  // 'table_name.column_name': '原因',
};
const check = process.argv.includes('--check');

// ---------- 迁移侧：按文件名顺序累加 DDL 效果 ----------

const sqlCols = new Map(); // table -> Set<column>
const bump = (table, column) => {
  if (!sqlCols.has(table)) sqlCols.set(table, new Set());
  if (column) sqlCols.get(table).add(column);
};

// 从 openIndex 处的开括号起配平，切出括号内部。SQL 用 '('，TypeScript 的 pgTable 用 '{'。
// 单引号字符串整体跳过：否则默认值里的括号会把配平带偏。
function bodyOf(text, openIndex, open = '(', close = ')') {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") {
      i += 1;
      while (i < text.length && text[i] !== "'") i += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return '';
}

// 列定义行：行首是列名，紧随其后的词不是表级约束关键字。
const CONSTRAINT_HEAD = /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i;

const migrationFiles = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  : [];

// $$…$$ / $tag$…$tag$ 里的分号会把语句切碎，先整块挖掉再扫 ALTER。
// 这个仓库当前没有在函数体里建表/改列，但真出现了就是筛子漏判，所以显式喊一声。
const DDL_KEYWORD = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
const strippedBlocks = [];

for (const file of migrationFiles) {
  const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  const bare = text.replace(/\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$/g, (block) => {
    if (DDL_KEYWORD.test(block)) strippedBlocks.push(`${file}（块内含建表/改列语句，已从 ALTER 扫描中排除）`);
    return ' ';
  });

  for (const m of text.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_0-9]+)\s*\(/gi)) {
    const table = m[1].toLowerCase();
    bump(table, null);
    for (const rawLine of bodyOf(text, m.index + m[0].length - 1).split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      const head = /^([a-z_0-9]+)\s+(\S+)/i.exec(line);
      if (!head || CONSTRAINT_HEAD.test(line)) continue;
      bump(table, head[1].toLowerCase());
    }
  }

  // 一条 ALTER TABLE 可以带多个 ADD COLUMN（0012 与 0021 就是），
  // 所以按"到下一个分号为止"整条取，而不是只认紧跟表名的那一个。
  for (const m of bare.matchAll(/ALTER TABLE\s+([a-z_0-9]+)([^;]*)/gi)) {
    const table = m[1].toLowerCase();
    for (const c of m[2].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_0-9]+)/gi)) {
      bump(table, c[1].toLowerCase());
    }
    for (const c of m[2].matchAll(/DROP COLUMN\s+(?:IF EXISTS\s+)?([a-z_0-9]+)/gi)) {
      sqlCols.get(table)?.delete(c[1].toLowerCase());
    }
  }

  for (const m of bare.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?([a-z_0-9]+)/gi)) {
    sqlCols.delete(m[1].toLowerCase());
  }
}

// ---------- schema.ts 侧：pgTable 块的顶层属性 ----------

const schemaText = fs.readFileSync(schemaFile, 'utf8');
const tsCols = new Map(); // table -> { line, columns: Set<column> }

for (const m of schemaText.matchAll(/pgTable\(\s*'([a-z_0-9]+)'\s*,\s*\{/g)) {
  const table = m[1].toLowerCase();
  const open = m.index + m[0].length - 1;
  const block = bodyOf(schemaText, open, '{', '}');
  const columns = new Set();

  // 只在块内第一层（相对块自身深度 0）取 `prop: type('col')`，避免把嵌套对象里的名字算进来。
  // 字符串字面量整体跳过，否则默认值里的括号会让深度失真。
  let depth = 0;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    const atTop = depth === 0;
    if (atTop) {
      const prop = /^(\w+):\s*[A-Za-z]+\(\s*'([a-z_0-9]+)'/.exec(line);
      if (prop) columns.add(prop[2].toLowerCase());
    }
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === "'" || c === '"' || c === '`') {
        i += 1;
        while (i < line.length && line[i] !== c) i += 1;
        continue;
      }
      if (c === '{' || c === '[' || c === '(') depth += 1;
      else if (c === '}' || c === ']' || c === ')') depth -= 1;
    }
  }

  tsCols.set(table, { line: schemaText.slice(0, m.index).split('\n').length, columns });
}

// ---------- 差异 ----------

const missingTables = [...sqlCols.keys()].filter((t) => !tsCols.has(t)).sort();
const extraTables = [...tsCols.keys()].filter((t) => !sqlCols.has(t)).sort();

const missingColumns = [];
const extraColumns = [];
for (const table of [...sqlCols.keys()].sort()) {
  const ts = tsCols.get(table);
  if (!ts) continue;
  for (const column of [...sqlCols.get(table)].sort()) {
    if (!ts.columns.has(column)) missingColumns.push(`${table}.${column}`);
  }
}
for (const table of [...tsCols.keys()].sort()) {
  const sq = sqlCols.get(table);
  if (!sq) continue;
  for (const column of [...tsCols.get(table).columns].sort()) {
    if (!sq.has(column)) extraColumns.push(`${table}.${column}`);
  }
}

console.log(
  `\n迁移 ${migrationFiles.length} 个文件、建表 ${sqlCols.size} 张；schema.ts 声明 ${tsCols.size} 张、` +
    `登记列 ${[...tsCols.values()].reduce((n, t) => n + t.columns.size, 0)} 列。`,
);
for (const row of strippedBlocks) console.log(`  ⚠ ${row}`);

function report(title, rows, hint) {
  console.log(`\n${title}（${rows.length}）：`);
  if (rows.length === 0) {
    console.log('  （无）');
    return;
  }
  for (const row of rows) console.log(`  ${row}`);
  if (hint) console.log(`  → ${hint}`);
}

report(
  '迁移里有、schema.ts 没有登记的表',
  missingTables,
  '迁移是运行时真相，缺登记会让把 schema.ts 当真相读的人（含 AI）少看见一张表。',
);
report('schema.ts 登记了、迁移里没有的表', extraTables, '要么迁移漏了，要么 schema.ts 该删。');
report('迁移里有、schema.ts 没有登记的列', missingColumns, '补进对应的 pgTable 块。');
report('schema.ts 登记了、迁移里没有的列', extraColumns, '要么迁移漏了，要么 schema.ts 该删。');

console.log(
  '\n口径：只比对表名与列名的有无，不比对类型、约束、默认值、索引与外键——' +
    '它拦得住“表/列漏登记”，拦不住“类型登记错了”。' +
    '迁移按文件名顺序累加（CREATE TABLE / ADD COLUMN / DROP COLUMN / DROP TABLE 都会算），' +
    '所以它读的是 DDL 的净效果，不是单个文件。',
);

if (check) {
  const drifted = [...missingTables, ...extraTables, ...missingColumns, ...extraColumns];
  const blocked = drifted.filter((key) => !(key in ALLOWLIST));
  const stale = Object.keys(ALLOWLIST).filter((key) => !drifted.includes(key));
  console.log('\n闸门判定（--check）：');
  console.log(`  漂移 ${drifted.length} 处；允许清单 ${Object.keys(ALLOWLIST).length} 条。`);
  for (const key of blocked) {
    console.log(`  失败：${key} 在迁移与 schema.ts 之间不一致，且不在允许清单里。`);
  }
  for (const key of stale) {
    console.log(`  失败：允许清单里的 ${key} 已经不再漂移，条目应当删除。`);
    console.log(`        当时登记的原因：${ALLOWLIST[key]}`);
  }
  if (blocked.length === 0 && stale.length === 0) {
    console.log('  通过：schema.ts 的表与列和迁移的净效果一致，允许清单为空或每条都仍然必要。');
  } else {
    process.exitCode = 1;
  }
}
