import fs from 'node:fs';
import path from 'node:path';

const apiSrc = 'apps/api/src';

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const sources = walk(apiSrc).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !/[\\/]node_modules[\\/]/.test(file),
);

const testFiles = walk(apiSrc)
  .filter((file) => file.endsWith('.test.ts'))
  .concat(walk('apps/worker/src').filter((file) => file.endsWith('.test.ts')))
  .concat(walk('packages').filter((file) => file.endsWith('.test.ts')))
  .map((file) => ({ name: file.split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }));

// 抛错构造器：这四个把码当第一个实参；AppError 直接构造时码在第二个实参。
const HELPER = String.raw`(badRequest|notFound|conflict|badGateway)`;
const literalRe = new RegExp(
  `${HELPER}\\(\\s*'([A-Z0-9_]+)'(?:,\\s*'((?:[^'\\\\]|\\\\.)*)')?`,
  'g',
);
const appErrorRe = /new AppError\(\s*(\d+),\s*'([A-Z0-9_]+)'(?:,\s*'((?:[^'\\]|\\.*)*)')?/g;
const dynamicRe = new RegExp(`${HELPER}\\(\\s*[^'\\)]`, 'g');

const codes = new Map();
const dynamicSites = [];
const verbose = process.argv.includes('--verbose');

function isDeclaration(text, index) {
  return /\bfunction\s+$/.test(text.slice(Math.max(0, index - 20), index));
}

function addSite(code, statusCode, message, file, line) {
  const entry = codes.get(code) ?? { code, statusCode, sites: [], messages: new Set() };
  entry.sites.push(`${file}:${line}`);
  if (message) entry.messages.add(message);
  codes.set(code, entry);
}

function lineOf(text, index, file) {
  const before = text.slice(0, index);
  return { file, line: (before.match(/\n/g)?.length ?? 0) + 1 };
}

for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = file.split(path.sep).join('/');
  for (const m of text.matchAll(literalRe)) {
    const at = lineOf(text, m.index, rel);
    addSite(m[2], null, m[3], at.file, at.line);
  }
  for (const m of text.matchAll(appErrorRe)) {
    const at = lineOf(text, m.index, rel);
    addSite(m[2], Number(m[1]), m[3], at.file, at.line);
  }
  for (const m of text.matchAll(dynamicRe)) {
    if (isDeclaration(text, m.index)) continue;
    const at = lineOf(text, m.index, rel);
    dynamicSites.push(`${at.file}:${at.line}`);
  }
}

const unasserted = [];
for (const entry of [...codes.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const quoted = new RegExp(`['"\`]${entry.code}['"\`]`);
  entry.hitFiles = testFiles.filter((test) => quoted.test(test.text)).map((test) => test.name);
  if (entry.hitFiles.length === 0) unasserted.push(entry);
}

console.log(
  `\n错误码 ${codes.size} 个（来自 ${sources.length} 个非测试文件、另有 ${dynamicSites.length} 处动态码位点需人工判断），` +
    `其中测试里以字面量引用过 ${codes.size - unasserted.length} 个。以下 ${unasserted.length} 个从未在任何测试中出现：`,
);
if (verbose) {
  for (const site of dynamicSites) console.log(`  动态码位点：${site}`);
}
for (const entry of unasserted) {
  const status = entry.statusCode ? `HTTP ${entry.statusCode}` : '状态码由构造器决定';
  console.log(
    `  ${entry.code.padEnd(34)} ${status.padEnd(16)} ${entry.sites.join(', ')}\n` +
      `      文案：${[...entry.messages].join(' / ') || '（无字面量文案）'}`,
  );
}

console.log(
  '\n口径：这是“错误码有没有在测试里被当作字面量断过”的粗筛。命中不等于该码的每个抛出点都测过——' +
    '同一个码常被打在多个位置（不同路由、不同分支），断言其中一处不能算覆盖其余；' +
    '未命中也要人工确认：测试可能只断 HTTP 状态或文案、可能把码拼进变量或模板串、' +
    '也可能是根本不该被 HTTP 触达的内部防御分支。宁可多问一次，不要当成结论。',
);
