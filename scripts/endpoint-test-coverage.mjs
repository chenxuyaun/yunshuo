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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 一段路径参数：测试源码里既可能是模板插值 `${chapterId}`，也可能是写死的字面量。
const PARAM = String.raw`(?:\$\{[^}]*\}|[^/'"\\\s]+)`;
// 整条路径必须是"到此为止"：后面紧跟 / 或单词字符说明那是另一条更长的路由，不能算命中本条。
const END = String.raw`(?![/\w])`;

// 精确口径：把每个 :param 当作一段通配，并要求参数之后的字面段也出现。
// `/api/model-providers/:id/test` 与 `/api/model-providers/:id` 不再塌成同一个前缀。
function probeExact(endpoint) {
  const parts = endpoint.path
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? PARAM : escapeRegExp(segment)));
  const source = '/' + parts.join('/') + END;
  const re = new RegExp(source);
  return { source, hits: tests.filter((test) => re.test(test.text)).map((test) => test.name) };
}

// 粗口径：只取第一个 :param 之前的静态段。精确口径判为未命中、而这一口径判为命中，
// 说明测试里出现过同前缀的别的 URL——它不能证明本条被调用过。
function probePrefix(endpoint) {
  const segments = [];
  for (const segment of endpoint.path.split('/').filter(Boolean)) {
    if (segment.startsWith(':')) break;
    segments.push(segment);
  }
  const needle = segments.length === 0 ? endpoint.path : '/' + segments.join('/');
  return { needle, hits: tests.filter((test) => test.text.includes(needle)).map((test) => test.name) };
}

const uncovered = [];
const prefixOnly = [];
for (const endpoint of endpoints) {
  const exact = probeExact(endpoint);
  if (exact.hits.length > 0) continue;
  const prefix = probePrefix(endpoint);
  uncovered.push({ ...endpoint, source: exact.source });
  if (prefix.hits.length > 0) {
    prefixOnly.push({ ...endpoint, needle: prefix.needle, files: prefix.hits });
  }
}

console.log(
  `路由 ${endpoints.length} 条，按完整路径形状（:param 视为一段通配、参数后的字面段也要出现）被测试引用的是 ` +
    `${endpoints.length - uncovered.length} 条，以下 ${uncovered.length} 条没有任何测试引用其 URL 形状：`,
);
for (const row of uncovered) console.log(`  ${row.method.padEnd(6)} ${row.path}  [${row.file}]`);
console.log(
  `\n其中 ${prefixOnly.length} 条属于"同前缀出现过、但这条路由本身没被引用"` +
    '（旧版只看第一个 :param 之前的静态段，会把它们误判成已覆盖）：',
);
for (const row of prefixOnly) {
  console.log(`  ${row.method.padEnd(6)} ${row.path}  仅出现前缀 ${row.needle}  见于 ${row.files.join(', ')}`);
}
console.log(
  '\n口径：这是“端点有没有被调用过”的粗筛，命中不代表分支覆盖；未命中要人工确认，' +
    '因为跨行拼接、把 URL 存进变量或走前端 api.ts 调用都会漏判（漏判方向偏保守，宁可多问一次）。' +
    '按表名/标识符 grep 不能代替按行为与端点判断覆盖。',
);
