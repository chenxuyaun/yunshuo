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

const CODE_PARAM = /^(code|errorCode)$/i;
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;
const DECL_BEFORE = /(?:export\s+)?(?:async\s+)?function\s+$/;
const verbose = process.argv.includes('--verbose');

const files = sources.map((file) => ({
  rel: file.split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

function lineOf(text, index) {
  return (text.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}

function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    j += 1;
  }
  return j;
}

// 从某个 '(' 的下标起切出顶层实参；返回 [{ raw, start }]，start 用于回推行号。
function splitArgs(text, openIndex) {
  const out = [];
  let depth = 0;
  let cur = '';
  let curStart = -1;
  let i = openIndex + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      if (curStart < 0) curStart = i;
      const from = i;
      i = skipString(text, i);
      cur += text.slice(from, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === '}') {
      if (depth === 0) {
        if (cur.trim()) out.push({ raw: cur, start: Math.max(curStart, openIndex + 1) });
        break;
      }
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      if (cur.trim()) out.push({ raw: cur, start: Math.max(curStart, openIndex + 1) });
      cur = '';
      curStart = -1;
      i += 1;
      continue;
    }
    if (cur.trim().length === 0 && !/\s/.test(c) && curStart < 0) curStart = i;
    cur += c;
    i += 1;
  }
  return out;
}

function skipTo(text, from, target) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0 && c === target) return i;
    }
    i += 1;
  }
  return -1;
}

function quotedLiteral(value) {
  const m = /^'([^']*)$/.exec((value ?? '').trim());
  return m ? m[1] : null;
}

function literalsIn(value) {
  return [...String(value).matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((x) => CODE_SHAPE.test(x));
}

// 收集“码形参函数”：任何形参名恰好叫 code / errorCode 的函数，以及 AppError 的构造函数。
const codeFns = new Map();
for (const file of files) {
  for (const m of file.text.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const params = splitArgs(file.text, open);
    const names = params.map((p) => /^([A-Za-z0-9_]+)\s*[:?!=]/.exec(p.raw.trim())?.[1] ?? '');
    const index = names.findIndex((name) => CODE_PARAM.test(name));
    if (index >= 0 && !codeFns.has(m[1])) codeFns.set(m[1], { index, params: names });
  }
  for (const m of file.text.matchAll(/\bclass\s+([A-Za-z0-9_]+)\b/g)) {
    const ctor = file.text.indexOf('constructor', m.index);
    if (ctor < 0 || ctor - m.index > 1200) continue;
    const open = file.text.indexOf('(', ctor);
    const params = splitArgs(file.text, open);
    const names = params.map((p) => /^([A-Za-z0-9_]+)\s*[:?!=]/.exec(p.raw.trim())?.[1] ?? '');
    const index = names.findIndex((name) => CODE_PARAM.test(name));
    if (index >= 0 && !codeFns.has(m[1])) codeFns.set(m[1], { index, params: names });
  }
}

const codes = new Map();
const dynamicSites = [];

function addCode(code, site, rule) {
  if (!CODE_SHAPE.test(code)) return false;
  const existed = codes.has(code);
  const entry = codes.get(code) ?? { code, sites: new Set(), rules: new Set(), statusCode: null, messages: new Set() };
  entry.sites.add(site);
  entry.rules.add(rule);
  codes.set(code, entry);
  return !existed;
}

function addMessage(code, message) {
  const entry = codes.get(code);
  if (!entry || !message) return;
  const clean = message.replace(/^'$/, '').replace(/^`|`$/g, '').trim();
  if (clean.length > 1 && !/^[|$\\]/.test(clean)) entry.messages.add(clean.slice(0, 70));
}

// 规则 A/B：按码形参的位置取实参。字面量直接进码集；变量位点记为“真·动态”，再由调用方展开。
function collectByArgPosition(name, rule) {
  const { index } = codeFns.get(name);
  const found = [];
  for (const file of files) {
    for (const m of file.text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
      const before = file.text.slice(Math.max(0, m.index - 40), m.index);
      if (DECL_BEFORE.test(before)) continue;
      const open = m.index + m[0].length - 1;
      const args = splitArgs(file.text, open);
      if (args.length <= index) continue;
      const raw = args[index].raw;
      const site = `${file.rel}:${lineOf(file.text, m.index)}`;
      const message = args[index + 1] ? args[index + 1].raw.replace(/^[\s'"]+/, '') : null;
      const literal = quotedLiteral(raw);
      if (literal) {
        found.push({ code: literal, site });
        addMessage(literal, message);
      } else if (literalsIn(raw).length > 0) {
        for (const code of literalsIn(raw)) found.push({ code, site });
      } else if (rule === 'A') {
        dynamicSites.push({ site, fn: name, index, expr: raw.replace(/\s+/g, ' ').trim().slice(0, 48) });
      }
    }
  }
  return found;
}

for (const name of codeFns.keys()) {
  for (const hit of collectByArgPosition(name, 'A')) addCode(hit.code, hit.site, 'A_码形参实参');
}

const expanded = [];
for (const site of [...dynamicSites]) {
  if (!codeFns.has(site.fn)) continue;
  const seen = new Set();
  for (const hit of collectByArgPosition(site.fn, 'B')) {
    if (seen.has(hit.code)) continue;
    seen.add(hit.code);
    const isNew = addCode(hit.code, hit.site, 'B_动态位点展开');
    expanded.push({ code: hit.code, via: `${site.fn}(第 ${site.index + 1} 参) ← ${hit.site}`, isNew });
  }
}

// 规则 C：响应装配位点 code: 'X'（含联合类型的其余成员与 as const）。
for (const file of files) {
  for (const m of file.text.matchAll(/\bcode:\s*((?:'[^']*'\s*\|?\s*)+(?:as const)?)/g)) {
    for (const code of literalsIn(m[1])) addCode(code, `${file.rel}:${lineOf(file.text, m.index)}`, 'C_响应装配');
  }
}

// 规则 G：函数名含 code 的函数体里，处于 return / ?? / 三元 else 位置的码形状字面量（兜住码映射的兜底值）。
function isCodePosition(body, litIndex) {
  let k = litIndex - 1;
  while (k >= 0 && /\s/.test(body[k])) k -= 1;
  if (k < 0) return false;
  const tail = body.slice(Math.max(0, k - 7), k + 1);
  if (/(?:return|\?\?|=>)\s*$/.test(tail)) return true;
  if (!/:\s*$/.test(tail)) return false;
  let p = k - 1;
  while (p >= 0 && /\s/.test(body[p])) p -= 1;
  return p >= 0 && !/[A-Za-z0-9_$]/.test(body[p]);
}

for (const file of files) {
  for (const m of file.text.matchAll(/\bfunction\s+([A-Za-z0-9_]*code[A-Za-z0-9_]*)\s*\(/gi)) {
    const open = file.text.indexOf('(', m.index);
    const close = skipTo(file.text, open, ')');
    const bodyOpen = file.text.indexOf('{', close);
    if (bodyOpen < 0) continue;
    const bodyEnd = skipTo(file.text, bodyOpen, '}');
    const body = file.text.slice(bodyOpen, bodyEnd);
    for (const lit of body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) {
      if (!isCodePosition(body, lit.index)) continue;
      addCode(lit[1], `${file.rel}:${lineOf(file.text, bodyOpen + lit.index)}`, 'G_码映射函数');
    }
  }
}

// 规则 H：`const code = <表达式>` 形式的码映射（错误处理器按状态码选码、上游码兜底都走这条路）。
function expressionTo(text, from) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth === 0) break;
    i += 1;
  }
  return text.slice(from, i);
}

for (const file of files) {
  for (const m of file.text.matchAll(/\b(?:const|let)\s+code\s*=\s*/g)) {
    const start = m.index + m[0].length;
    for (const code of literalsIn(expressionTo(file.text, start))) {
      addCode(code, `${file.rel}:${lineOf(file.text, m.index)}`, 'H_码变量赋值');
    }
  }
}

// 状态码与文案：只在 AppError 直接构造位点取（首参是整数、次参是码字面量）。
for (const file of files) {
  for (const m of file.text.matchAll(/\bAppError\s*\(/g)) {
    const args = splitArgs(file.text, m.index + m[0].length - 1);
    const status = Number(args[0]?.raw.trim());
    const code = quotedLiteral(args[1]?.raw);
    if (!code || !Number.isInteger(status)) continue;
    const entry = codes.get(code);
    if (entry) {
      entry.statusCode = status;
      addMessage(code, args[2]?.raw);
    }
  }
}

// 残留普查：形如错误码、却没被 A/B/C/G 任何一条规则收到的字面量（历史上这里是盲区）。
const residual = new Map();
for (const file of files) {
  for (const m of file.text.matchAll(/'([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|[A-Z]{4,})'/g)) {
    const code = m[1];
    if (codes.has(code)) continue;
    const site = `${file.rel}:${lineOf(file.text, m.index)}`;
    if (!residual.has(code)) residual.set(code, new Set());
    residual.get(code).add(site);
  }
}

// 与旧普查（只看 badRequest/notFound/conflict/badGateway 首参与 AppError 次参的两条正则）对账：
// 新规则应当是旧规则的超集，丢了哪个码必须当场看得见。
const HELPER = String.raw`(?:badRequest|notFound|conflict|badGateway)`;
const legacyRe = new RegExp(`${HELPER}\\(\\s*'([A-Z0-9_]+)'`, 'g');
const legacyAppErrorRe = /new AppError\(\s*(\d+),\s*'([A-Z0-9_]+)'/g;
const legacy = new Set();
for (const file of files) {
  for (const m of file.text.matchAll(legacyRe)) legacy.add(m[1]);
  for (const m of file.text.matchAll(legacyAppErrorRe)) legacy.add(m[2]);
}
const gained = [...codes.keys()].filter((code) => !legacy.has(code)).sort();
const lost = [...legacy].filter((code) => !codes.has(code)).sort();

const unasserted = [];
for (const entry of [...codes.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const quoted = new RegExp(`['"\`]${entry.code}['"\`]`);
  entry.hitFiles = testFiles.filter((test) => quoted.test(test.text)).map((test) => test.name);
  if (entry.hitFiles.length === 0) unasserted.push(entry);
}

const residualRows = [...residual.entries()]
  .map(([code, sites]) => ({
    code,
    sites: [...sites],
    inTests: testFiles.some((test) => new RegExp(`['"\`]${code}['"\`]`).test(test.text)),
  }))
  .sort((a, b) => Number(b.inTests) - Number(a.inTests) || a.code.localeCompare(b.code));

console.log(
  `\n错误码 ${codes.size} 个（来自 ${sources.length} 个非测试文件；旧普查 ${legacy.size} 个，新增 ${gained.length} 个、丢失 ${lost.length} 个；` +
    `真·动态码位点 ${dynamicSites.length} 处；规则命中明细与对账见 --verbose），` +
    `其中测试里以字面量引用过 ${codes.size - unasserted.length} 个。以下 ${unasserted.length} 个从未在任何测试中出现：`,
);

if (verbose) {
  const byRule = new Map();
  for (const entry of codes.values()) {
    for (const rule of entry.rules) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }
  console.log('\n按规则统计（一个码可被多条规则收到）：');
  for (const [rule, n] of [...byRule.entries()].sort()) console.log(`  ${rule}: ${n} 个码`);
  console.log(`\n与旧普查对账：旧 ${legacy.size} 个 → 新 ${codes.size} 个`);
  console.log(`  新增（旧规则结构上看不见的位点）${gained.length} 个：`);
  for (const code of gained) {
    const entry = codes.get(code);
    console.log(
      `    ${code.padEnd(30)} ${[...entry.rules].join('+').padEnd(24)} ${testFiles.some((t) => new RegExp(`['"\`]${code}['"\`]`).test(t.text)) ? '测试里断过' : '测试里没断'}  ${[...entry.sites].slice(0, 2).join(', ')}`,
    );
  }
  console.log(`  丢失（旧规则有、新规则没有，必须解释）${lost.length} 个：`);
  for (const code of lost) console.log(`    ${code}`);
  console.log('\n真·动态码位点（码由变量决定，不再按排版误报）：');
  for (const site of dynamicSites) console.log(`  ${site.site}  → ${site.fn}(第 ${site.index + 1} 个实参) = ${site.expr}`);
  console.log(`\n动态位点按调用方展开的候选码（其中真正新计入码集的 ${expanded.filter((r) => r.isNew).length} 个）：`);
  for (const row of expanded) console.log(`  ${row.code.padEnd(30)} ${row.isNew ? '新计入码集' : '码集已含'}  ${row.via}`);
  console.log('\n形如错误码、但四条规则都没收到的字面量：');
  for (const row of residualRows) {
    console.log(`  ${row.code.padEnd(30)} ${row.inTests ? '测试里断过（漏计）' : '测试里没断'}  ${row.sites.slice(0, 3).join(', ')}`);
  }
}

for (const entry of unasserted) {
  const status = entry.statusCode ? `HTTP ${entry.statusCode}` : '状态码由构造器决定';
  console.log(
    `  ${entry.code.padEnd(34)} ${status.padEnd(16)} ${[...entry.rules].join('+').padEnd(20)} ${[...entry.sites].join(', ')}\n` +
      `      文案：${[...entry.messages].join(' / ') || '（无字面量文案）'}`,
  );
}

console.log(
  '\n口径：这是“错误码有没有在测试里被当作字面量断过”的粗筛。命中不等于该码的每个抛出点都测过——' +
    '同一个码常被打在多个位置（不同路由、不同分支），断言其中一处不能算覆盖其余；' +
    '未命中也要人工确认：测试可能只断 HTTP 状态或文案、可能把码拼进变量或模板串、' +
    '也可能是根本不该被 HTTP 触达的内部防御分支。宁可多问一次，不要当成结论。',
);
