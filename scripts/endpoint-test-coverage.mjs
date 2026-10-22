import fs from 'node:fs';
import path from 'node:path';

const apiSrc = 'apps/api/src';
const routesDir = path.join(apiSrc, 'routes');
const workerSrc = 'apps/worker/src';

function readTests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => ({ name: path.basename(dir) + '/' + f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

const tests = [...readTests(apiSrc), ...readTests(workerSrc)];

// 路由前缀来自 routes/index.ts 的 register(fn, { prefix: '/api/...' })
const prefixes = new Map();
const indexText = fs.readFileSync(path.join(routesDir, 'index.ts'), 'utf8');
for (const m of indexText.matchAll(/register\((\w+),\s*\{\s*prefix:\s*'([^']+)'/g)) {
  prefixes.set(m[1], m[2]);
}

const endpoints = [];
for (const file of fs
  .readdirSync(routesDir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
  const text = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const moduleName = file.replace(/\.ts$/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const prefix = prefixes.get(moduleName) ?? '';
  for (const m of text.matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    endpoints.push({ file, method: m[1].toUpperCase(), path: prefix + m[2] });
  }
}

// 只看静态前缀：`/api/chapters/:id/ledger-links` 与 `/api/chapters/ledger-links`
// 在同一份测试里出现即算覆盖到这条路由。
function probe(endpoint) {
  const segments = [];
  for (const segment of endpoint.path.split('/').filter(Boolean)) {
    if (segment.startsWith(':')) break;
    segments.push(segment);
  }
  const needle = segments.length === 0 ? endpoint.path : '/' + segments.join('/');
  return { needle, hits: tests.filter((test) => test.text.includes(needle)).map((test) => test.name) };
}

const uncovered = [];
for (const endpoint of endpoints) {
  const { needle, hits } = probe(endpoint);
  if (hits.length === 0) uncovered.push({ ...endpoint, needle });
}

console.log(
  `路由 ${endpoints.length} 条，测试文本中出现过其静态前缀的 ${endpoints.length - uncovered.length} 条，` +
    `以下 ${uncovered.length} 条没有任何测试引用：`,
);
for (const row of uncovered) console.log(`  ${row.method.padEnd(6)} ${row.path}  [${row.file}]`);
console.log(
  '口径：这是“端点有没有被调用过”的粗筛，命中不代表分支覆盖，未命中才需要人工确认；' +
    '按表名/标识符 grep 不能代替按行为与端点判断覆盖。',
);
