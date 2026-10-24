#!/usr/bin/env node
// 千章规模的账本索引排空与账本通道检索基线：真实 worker + 真实本机嵌入服务。
// 关掉的是"千章正典那轮库里没有账本条目"这条空白：同一份千章作品上再挂 1000 条已发布账本条目，
// 分别量正典投影与账本投影的排空，再量账本通道在千条规模下的检索。
// 只在隔离测试库上跑：API 与 worker 必须指向 yunshuo_test。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3101';
const EMAIL = process.env.PERF_EMAIL ?? 'owner@demo.local';
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'yunshuo-db';
const DB_USER = process.env.DB_USER ?? 'yunshuo';
const DB_NAME = process.env.DB_NAME ?? 'yunshuo_test';
const CHAPTERS = Number(process.env.PERF_LEDGER_CHAPTERS ?? '1000');
const CHARS_PER_CHAPTER = Number(process.env.PERF_LEDGER_CHAPTER_CHARS ?? '600');
const ENTRIES = Number(process.env.PERF_LEDGER_ENTRIES ?? '1000');
const SETTINGS_COUNT = Number(process.env.PERF_LEDGER_SETTINGS ?? '500');
const CHARACTERS_COUNT = Number(process.env.PERF_LEDGER_CHARACTERS ?? '300');
const WORK_SCOPED_SETTINGS = Number(process.env.PERF_LEDGER_WORK_SCOPED_SETTINGS ?? '350');
const BATCH = Number(process.env.PERF_LEDGER_BATCH ?? '1000');
const POLL_MS = Number(process.env.PERF_LEDGER_POLL_MS ?? '20000');
// 每段排空各给 90 分钟：千章正典排空实测 2070s，账本这轮按同量级预估，
// 超时设置小于实际用量会把"慢但成功"记成"未排空"。
const TIMEOUT_MS = Number(process.env.PERF_LEDGER_TIMEOUT_MS ?? '5_400_000'.replace(/_/g, ''));
const EMBED_BASE_URL = process.env.PERF_EMBED_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const EMBED_MODEL = process.env.PERF_EMBED_MODEL ?? 'bge-m3:latest';
const RUN_LABEL = process.env.PERF_REPORT_NAME ?? 'ledger';
const REPORT_PATH = new URL(
  `../docs/m6-perf-${RUN_LABEL}.json`,
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REPEATS = 3;

if (DB_NAME !== 'yunshuo_test' && !process.env.PERF_ALLOW_OTHER_DB) {
  console.error(`只允许在 yunshuo_test 上压测账本索引（当前 DB_NAME=${DB_NAME}）。`);
  process.exit(1);
}

if (SETTINGS_COUNT + CHARACTERS_COUNT > ENTRIES) {
  console.error(
    `设定 ${SETTINGS_COUNT} + 角色 ${CHARACTERS_COUNT} 已超过条目总额 ${ENTRIES}，伏笔将为负数。`,
  );
  process.exit(1);
}

function psql(query) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-Atc', query], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  }).trim();
}

function processRssMb(pid) {
  if (!pid) return null;
  try {
    const value = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64 / 1MB`],
      { encoding: 'utf8' },
    ).trim();
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
  } catch {
    return null;
  }
}

function median(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

let cookie = '';

async function request(path, { method = 'GET', body } = {}) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length > 0) cookie = setCookie[0].split(';')[0];
  const text = await response.text();
  const elapsedMs = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}\n${text.slice(0, 800)}`);
  }
  return { json: text ? JSON.parse(text) : null, elapsedMs, bytes: Buffer.byteLength(text) };
}

const COUNTS = `
  SELECT 'works='||count(*) FROM works
  UNION ALL SELECT 'chapters='||count(*) FROM chapters
  UNION ALL SELECT 'canon_versions='||count(*) FROM canon_versions
  UNION ALL SELECT 'canon_current='||count(*) FROM canon_current
  UNION ALL SELECT 'canon_chunks='||count(*) FROM canon_chunks
  UNION ALL SELECT 'chunk_embeddings='||count(*) FROM chunk_embeddings
  UNION ALL SELECT 'index_status='||count(*) FROM index_status
  UNION ALL SELECT 'ledger_entries='||count(*) FROM ledger_entries
  UNION ALL SELECT 'ledger_entry_versions='||count(*) FROM ledger_entry_versions
  UNION ALL SELECT 'ledger_entry_aliases='||count(*) FROM ledger_entry_aliases
  UNION ALL SELECT 'ledger_chunks='||count(*) FROM ledger_chunks
  UNION ALL SELECT 'ledger_chunk_embeddings='||count(*) FROM ledger_chunk_embeddings
  UNION ALL SELECT 'ledger_index_status='||count(*) FROM ledger_index_status
  UNION ALL SELECT 'chapter_ledger_links='||count(*) FROM chapter_ledger_links
  UNION ALL SELECT 'chapter_metadata='||count(*) FROM chapter_metadata
  UNION ALL SELECT 'outbox='||count(*) FROM outbox
  UNION ALL SELECT 'model_calls='||count(*) FROM model_calls
  UNION ALL SELECT 'providers='||count(*) FROM model_providers
  UNION ALL SELECT 'sessions='||count(*) FROM sessions
  UNION ALL SELECT 'events='||count(*) FROM events
  UNION ALL SELECT 'audit='||count(*) FROM audit_log
`;

function countQuery() {
  return Object.fromEntries(
    psql(COUNTS)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split('=');
        return [key, Number(value)];
      }),
  );
}

function statusCounts(from, alias) {
  // status 必须带别名：正典与账本的索引状态表都可能有同名列，裸写会报 ambiguous。
  const rows = psql(`
    SELECT coalesce(string_agg(status||'='||n, ','), '(空)')
    FROM (SELECT ${alias}.status, count(*)::int AS n FROM ${from} GROUP BY 1 ORDER BY 1) t
  `);
  return rows;
}

// 排空速率的解释依赖"有几个进程在领任务"，所以每轮采样都把数据库侧的实例形状记下来：
// claimer = 最近一条语句是 outbox 领取更新的连接数（近似在跑的 worker 数，取下界）。
function workerProbe() {
  const total = Number(
    psql(`
      SELECT count(*)::int FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
    `),
  );
  const byKind = psql(`
    SELECT coalesce(string_agg(kind||'='||n, ','), '(无)')
    FROM (
      SELECT CASE
               WHEN query LIKE '%UPDATE outbox%processing%' THEN 'claimer'
               WHEN query LIKE '%automation_jobs%' THEN 'automation'
               ELSE 'other'
             END AS kind,
             count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
      GROUP BY 1
    ) t
  `);
  return { backends: total, byLastQuery: byKind };
}

// 领用痕迹：attempts>1 说明同一行被领过两次（超时回收或并发实例），那会重复扣模型调用。
function outboxShape(predicate) {
  return {
    status: psql(`
      SELECT coalesce(string_agg(status||'='||n, ','), '(空)')
      FROM (SELECT status, count(*)::int AS n FROM outbox WHERE ${predicate} GROUP BY 1 ORDER BY 1) t
    `),
    attempts: psql(`
      SELECT coalesce(string_agg('attempts='||attempts||':'||n, ' '), '(空)')
      FROM (SELECT attempts, count(*)::int AS n
            FROM outbox WHERE ${predicate} GROUP BY 1 ORDER BY 1) t
    `),
    lockAge: psql(
      `SELECT 'locked_max_age_sec='||coalesce(round(extract(epoch FROM max(now()-locked_at))::numeric,1)::text,'null')
       FROM outbox WHERE ${predicate}`,
    ),
  };
}

// 与 m6-perf-index.mjs / m6-perf-baseline.mjs 同一份 filler，保证三轮的切块与命中可对照。
const FILLER = [
  '雨从傍晚落到半夜，街面上的水光把灯笼映成一片。',
  '他沿着石阶往上走，靴底碾过湿透的碎纸。',
  '门轴响了一声，又安静下去，像有人把呼吸压在木板后面。',
  '巷口的更夫敲了第二遍鼓，声音被风撕开一半。',
  '她把油纸包塞进袖子里，手指一直在抖，却不让旁人看见。',
  '铜钉在掌心发烫，像刚从炉子里挑出来。',
  '墙上的旧符被雨水泡软，边角一片一片翘起来。',
  '远处有人喊话，喊的是名字，也可能不是。',
];

function buildText(seed, targetChars) {
  let text = '';
  let cursor = seed;
  while (text.length < targetChars) {
    text += `${FILLER[cursor % FILLER.length]}`;
    cursor += 1;
  }
  return text.slice(0, targetChars);
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

console.log(
  `云说 M6 账本索引基线 @ ${BASE}，库=${DB_NAME}，目标 ${CHAPTERS} 章 × ${CHARS_PER_CHAPTER} 字 + ${ENTRIES} 条账本条目` +
    `（设定 ${SETTINGS_COUNT} / 角色 ${CHARACTERS_COUNT} / 伏笔 ${ENTRIES - SETTINGS_COUNT - CHARACTERS_COUNT}）`,
);

// 嵌入服务必须先可达：否则账本投影只会得到 not_configured，那是环境状态而不是账本索引基线。
let embedModels = null;
try {
  const probe = await fetch(`${EMBED_BASE_URL}/models`);
  embedModels = await probe.json();
} catch (error) {
  console.error(`嵌入服务不可达（${EMBED_BASE_URL}）：${error?.message ?? error}`);
  console.error('请先启动本机嵌入服务再跑本脚本；不会降级成"未配置"来蒙混。');
  process.exit(1);
}
const modelSeen = JSON.stringify(embedModels).includes(EMBED_MODEL);
console.log(`嵌入服务可达，模型 ${EMBED_MODEL} ${modelSeen ? '在列表中' : '不在列表中（仍按配置尝试真实调用）'}`);

const baseline = countQuery();
console.log('压测前基线：', JSON.stringify(baseline));
if (baseline.ledger_entries !== 0 || baseline.ledger_chunks !== 0) {
  console.error(
    `压测前库里已有账本条目/投影（${JSON.stringify({ entries: baseline.ledger_entries, chunks: baseline.ledger_chunks })}），` +
      '先清理或换库再跑；否则排空数与覆盖度读不出本轮。',
  );
  process.exit(1);
}
const runStart = psql('SELECT now()::text');
const session = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
const runUserId = session.json.user.id;
const workspaceId = session.json.workspace.id;
console.log(`登录：${session.json.user.name}（${session.json.role}）@ ${session.json.workspace.name}`);

// 实例形状守卫：上一轮遗留的 worker 会和本轮 worker 抢同一张 outbox（表不按工作区隔离），
// 抢过之后"单 worker 排空"的读数就不成立了，所以宁可拒绝启动。
const preflight = workerProbe();
console.log(`压测前连接形状：${preflight.backends} 个后端（${preflight.byLastQuery}）`);
const claimers = Number(/claimer=(\d+)/.exec(preflight.byLastQuery)?.[1] ?? '0');
if (claimers > 1 && !process.env.PERF_ALLOW_MULTI_WORKER) {
  console.error(
    `检测到 ${claimers} 个连接最近在领 outbox 任务——很可能有上一轮遗留的 worker 指向本库。` +
      '先停掉多余 worker 再跑；确认无误可加 PERF_ALLOW_MULTI_WORKER=1（报告会照实记录实例形状）。',
  );
  process.exit(1);
}

// 每次发布会递增工作区的 settings_version / ledger_version：这两列不在 COUNTS 里，
// 删除条目不会把计数带回去，所以单独读取、清理后显式还原并留痕。
function workspaceCounters() {
  const [settings, ledger] = psql(
    `SELECT settings_version||'/'||ledger_version FROM workspaces WHERE id = '${workspaceId}'`,
  ).split('/');
  return { settingsVersion: Number(settings), ledgerVersion: Number(ledger) };
}
const countersBefore = workspaceCounters();

const provider = await request('/api/model-providers', {
  method: 'POST',
  body: {
    name: `压测嵌入 ${RUN_LABEL}`.slice(0, 80),
    baseUrl: EMBED_BASE_URL,
    model: EMBED_MODEL,
    purpose: 'embedding',
    isEnabled: true,
    priority: 10,
    promptPricePer1m: 0,
    priceCurrency: 'CNY',
  },
});
const providerId = provider.json.id ?? provider.json.provider?.id ?? null;
if (!providerId) throw new Error(`创建嵌入服务商后拿不到 id：${JSON.stringify(provider.json).slice(0, 400)}`);
console.log(`已创建临时嵌入服务商 ${providerId}（输入价 0，本机服务）`);

const RUN_ID = randomUUID().slice(0, 8);
const WORK_TITLE = `账本索引压测作品 ${RUN_ID}`;
const VOLUME_TITLE = `账本索引压测卷 ${RUN_ID}`;
let workId = null;
let chapterTotal = 0;
const importBatches = [];
let nextNumber = 1;
while (chapterTotal < CHAPTERS) {
  const size = Math.min(BATCH, CHAPTERS - chapterTotal);
  const chapters = [];
  for (let index = 0; index < size; index += 1) {
    const number = nextNumber;
    nextNumber += 1;
    chapters.push({
      number,
      title: `账本压测第 ${number} 章`,
      content: buildText(number * 7 + 3, CHARS_PER_CHAPTER),
    });
  }
  const requestBodyBytes = Buffer.byteLength(
    JSON.stringify({ workTitle: WORK_TITLE, volumeNumber: 1, volumeTitle: VOLUME_TITLE, chapters }),
  );
  const result = await request('/api/chapters/import', {
    method: 'POST',
    body: { workTitle: WORK_TITLE, volumeNumber: 1, volumeTitle: VOLUME_TITLE, chapters },
  });
  workId = result.json.workId;
  chapterTotal += result.json.imported.length;
  importBatches.push({
    chapterCount: result.json.imported.length,
    importMs: result.elapsedMs,
    requestBodyBytes,
    storedWordCount: result.json.imported.reduce((total, item) => total + (item.wordCount ?? 0), 0),
  });
  console.log(
    `  导入 ${result.json.imported.length} 章（累计 ${chapterTotal}），单事务 ${result.elapsedMs}ms，` +
      `请求体 ${(requestBodyBytes / 1024 / 1024).toFixed(2)}MB`,
  );
}

// 章号 → 章 id：账本条目的来源章、角色状态章、伏笔埋设/回收章都要按章号散布到整部作品。
const chapterIdByNumber = new Map();
for (const line of psql(
  `SELECT number||'='||id FROM chapters WHERE work_id = '${workId}' ORDER BY number`,
).split(/\r?\n/)) {
  if (!line) continue;
  const [number, id] = line.split('=');
  chapterIdByNumber.set(Number(number), id);
}
if (chapterIdByNumber.size !== chapterTotal) {
  throw new Error(
    `章号映射不完整（${chapterIdByNumber.size} 行 vs 导入 ${chapterTotal} 章），不能按章号散布账本条目`,
  );
}
const chapterAt = (number) => chapterIdByNumber.get(Math.min(Math.max(number, 1), chapterTotal));

async function drain(label, indexFrom, alias, progressSql) {
  const samples = [];
  const startedAt = performance.now();
  let finished = false;
  let timedOut = true;
  while (performance.now() - startedAt < TIMEOUT_MS) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const states = statusCounts(indexFrom, alias);
    if (!/pending=|indexing=|ready=|failed=|not_configured=/.test(states)) {
      throw new Error(`${label}：本次没有索引状态行（${states}）——导入/发布时嵌入服务商未生效，不能读成"已排空"`);
    }
    const sample = {
      elapsedMs,
      elapsedSec: Math.round(elapsedMs / 1000),
      indexStatus: states,
      outbox: statusCounts('outbox', 'outbox'),
      ...workerProbe(),
      progress: psql(progressSql),
      workerRssMb: processRssMb(process.env.PERF_WORKER_PID),
      apiRssMb: processRssMb(process.env.PERF_API_PID),
    };
    samples.push(sample);
    console.log(
      `  [${label}] +${sample.elapsedSec}s：${states}，${sample.progress}，outbox ${sample.outbox}，` +
        `连接 ${sample.backends} 个（${sample.byLastQuery}），worker RSS ${sample.workerRssMb ?? 'n/a'}MB`,
    );
    if (!/pending=|indexing=|not_configured=/.test(states)) {
      finished = true;
      timedOut = false;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const elapsedMs = samples.length > 0 ? samples[samples.length - 1].elapsedMs : 0;
  console.log(
    `  [${label}] ${finished ? `排空用时 ${Math.round(elapsedMs / 1000)}s（采样 ${samples.length} 个）` : `${Math.round(elapsedMs / 1000)}s 后仍未排空（超时停止等待，按未排空记录）`}`,
  );
  return { samples, elapsedMs, finished, timedOut };
}

const canonIndexFrom = `index_status i JOIN chapters c ON c.id = i.chapter_id WHERE c.work_id = '${workId}'`;
const canonDrain = await drain(
  '正典',
  canonIndexFrom,
  'i',
  `SELECT 'canon_chunks='||count(*) FROM canon_chunks`,
);
const canonOutboxShape = outboxShape(
  `event_type = 'index.chapter' AND (payload->>'workspaceId') = '${workspaceId}'`,
);
console.log(`正典 outbox 领用痕迹：${canonOutboxShape.status} / ${canonOutboxShape.attempts} / ${canonOutboxShape.lockAge}`);

// 正典排空之后再挂账本条目：两段排空各自计时，同一个 worker、同一台机器、同一个模型，
// 正典那条同时是本轮账本数字的同机对照。
const entryPlan = [];
for (let index = 1; index <= SETTINGS_COUNT; index += 1) {
  entryPlan.push({ kind: 'setting', index });
}
for (let index = 1; index <= CHARACTERS_COUNT; index += 1) {
  entryPlan.push({ kind: 'character', index });
}
for (let index = 1; index <= ENTRIES - SETTINGS_COUNT - CHARACTERS_COUNT; index += 1) {
  entryPlan.push({ kind: 'foreshadowing', index });
}

const createMs = [];
const publishMs = [];
const createdEntries = [];
const skippedEntries = [];
const buildEntry = (item) => {
  const tag = pad(item.index, 4);
  const seed = item.index * 13 + 5;
  if (item.kind === 'setting') {
    const workScoped = item.index <= WORK_SCOPED_SETTINGS;
    return {
      status: workScoped ? 'work' : 'workspace',
      body: {
        kind: 'setting',
        ...(workScoped ? { workId } : {}),
        name: `压测设定 ${tag}`,
        aliases: [`设定别名${tag}`],
        summary: `第 ${pad(item.index, 3)} 号压测设定：${FILLER[seed % FILLER.length]}`,
        sourceChapterId: chapterAt(seed % chapterTotal),
        payload: {
          category: ['world', 'location', 'faction', 'rule', 'item', 'other'][seed % 6],
          details: buildText(seed, 320 + (seed % 5) * 90),
          tags: [`压测${tag}`, FILLER[seed % FILLER.length].slice(0, 6)],
          verification: seed % 4 === 0 ? 'unverified' : 'verified',
        },
      },
    };
  }
  if (item.kind === 'character') {
    const stateCount = 2 + (seed % 5);
    const states = [];
    for (let s = 0; s < stateCount; s += 1) {
      const number = ((seed + s * Math.max(1, Math.floor(chapterTotal / (stateCount + 1)))) % chapterTotal) + 1;
      states.push({
        asOfChapterId: chapterAt(number),
        life: s === stateCount - 1 && seed % 9 === 0 ? 'unknown' : 'alive',
        location: ['街口', '城北', '船上', '祠堂', '客栈二楼'][number % 5],
        knowledge: buildText(seed + s, 60 + (s % 3) * 40),
        possessions: s % 2 === 0 ? '一枚发烫的铜钉' : '',
        relationshipChanges: s % 3 === 0 ? `与压测角色 ${pad(((item.index + 7) % CHARACTERS_COUNT) + 1, 4)} 反目` : '',
      });
    }
    return {
      status: 'work',
      body: {
        kind: 'character',
        workId,
        name: `压测角色 ${tag}`,
        aliases: [`角色别名${tag}`],
        summary: `第 ${pad(item.index, 3)} 号压测角色：${FILLER[seed % FILLER.length]}`,
        sourceChapterId: chapterAt(seed % chapterTotal),
        payload: {
          role: ['更夫', '绣娘', '账房', '刀客', '门生'][seed % 5],
          appearance: buildText(seed + 1, 90 + (seed % 4) * 30),
          personality: buildText(seed + 2, 70 + (seed % 3) * 30),
          goals: FILLER[(seed + 3) % FILLER.length],
          faction: ['城北会', '官驿', '江湖', '自保'][seed % 4],
          abilities: buildText(seed + 4, 80),
          speechStyle: FILLER[(seed + 5) % FILLER.length],
          relationships: [
            { name: `压测角色 ${pad(((item.index + 11) % CHARACTERS_COUNT) + 1, 4)}`, relation: '旧识', notes: '共过一场雨' },
            { name: `压测设定 ${pad(((item.index + 17) % SETTINGS_COUNT) + 1, 4)}`, relation: '持有', notes: '铜钉' },
          ],
          states,
        },
      },
    };
  }
  const seedNumber = ((seed * 7) % Math.max(1, chapterTotal - 30)) + 1;
  const windowStart = Math.min(seedNumber + 10, chapterTotal);
  const windowEnd = Math.min(windowStart + 20, chapterTotal);
  const paidOff = item.index % 10 === 0;
  return {
    status: 'work',
    body: {
      kind: 'foreshadowing',
      workId,
      name: `压测伏笔 ${tag}`,
      aliases: [`伏笔别名${tag}`],
      summary: `第 ${pad(item.index, 3)} 号压测伏笔：${FILLER[seed % FILLER.length]}`,
      sourceChapterId: chapterAt(seedNumber),
      payload: {
        seedChapterId: chapterAt(seedNumber),
        payoffChapterMin: windowStart,
        payoffChapterMax: windowEnd,
        importance: ['low', 'medium', 'high'][seed % 3],
        state: paidOff ? 'paid_off' : item.index % 3 === 0 ? 'reinforced' : 'planted',
        payoffChapterId: paidOff ? chapterAt(windowEnd) : null,
        note: buildText(seed + 6, 90 + (seed % 4) * 40),
        resolutionNote: paidOff ? '铜钉在回收章里发挥了作用，压测伏笔按窗口收回。' : '',
      },
    },
  };
};

for (const item of entryPlan) {
  const spec = buildEntry(item);
  try {
    const created = await request('/api/ledger/entries', { method: 'POST', body: spec.body });
    createMs.push(created.elapsedMs);
    const entry = created.json;
    const draftVersionId = entry?.draftVersion?.id ?? null;
    if (!entry?.id || !draftVersionId) {
      throw new Error(`创建${item.kind}后拿不到 id 或 draftVersion.id：${JSON.stringify(entry).slice(0, 300)}`);
    }
    const published = await request(`/api/ledger/entries/${entry.id}/publish`, {
      method: 'POST',
      body: { expectedDraftVersionId: draftVersionId, changeSummary: '压测发布' },
    });
    publishMs.push(published.elapsedMs);
    createdEntries.push({
      entryId: entry.id,
      kind: item.kind,
      scope: spec.status,
      chunkHintChars: JSON.stringify(spec.body).length,
    });
    if (createdEntries.length % 100 === 0) {
      console.log(
        `  已创建并发布 ${createdEntries.length}/${entryPlan.length} 条` +
          `（创建中位 ${median(createMs)}ms、发布中位 ${median(publishMs)}ms）`,
      );
    }
  } catch (error) {
    skippedEntries.push({ kind: item.kind, index: item.index, message: String(error).slice(0, 300) });
    if (skippedEntries.length <= 3) console.error(`  条目失败（${item.kind} #${item.index}）：${String(error).slice(0, 300)}`);
  }
}
const createPhaseMs = Math.round(createMs.reduce((total, value) => total + value, 0));
const publishPhaseMs = Math.round(publishMs.reduce((total, value) => total + value, 0));
console.log(
  `账本条目：成功发布 ${createdEntries.length} 条（设定 ${createdEntries.filter((e) => e.kind === 'setting').length} / ` +
    `角色 ${createdEntries.filter((e) => e.kind === 'character').length} / ` +
    `伏笔 ${createdEntries.filter((e) => e.kind === 'foreshadowing').length}），失败 ${skippedEntries.length} 条；` +
    `创建累计 ${createPhaseMs}ms、发布累计 ${publishPhaseMs}ms`,
);
if (skippedEntries.length > 0) {
  console.error(`  注意：有 ${skippedEntries.length} 条创建/发布失败，本轮条目数不等于目标数，报告按实际成功数记账。`);
}

const ledgerIndexFrom = `ledger_index_status s JOIN ledger_entries e ON e.id = s.entry_id WHERE e.workspace_id = '${session.json.workspace.id}'`;
const ledgerQueueStart = {
  at: new Date().toISOString(),
  indexStatus: statusCounts(ledgerIndexFrom, 's'),
  outbox: statusCounts('outbox', 'outbox'),
};
console.log(`入队即刻（账本）：index_status ${ledgerQueueStart.indexStatus}，outbox ${ledgerQueueStart.outbox}`);
const ledgerReadyAtStart = Number(/ready=(\d+)/.exec(ledgerQueueStart.indexStatus)?.[1] ?? '0');

const ledgerDrain = await drain(
  '账本',
  ledgerIndexFrom,
  's',
  `SELECT 'ledger_chunks='||count(*)::text||' vectors='||(SELECT count(*) FROM ledger_chunk_embeddings)::text FROM ledger_chunks`,
);
const ledgerOutboxShape = outboxShape(
  `event_type = 'index.ledger' AND (payload->>'workspaceId') = '${workspaceId}'`,
);
console.log(`账本 outbox 领用痕迹：${ledgerOutboxShape.status} / ${ledgerOutboxShape.attempts} / ${ledgerOutboxShape.lockAge}`);

function detail(sqlText) {
  return psql(sqlText);
}
const canonDetail = detail(`
  SELECT coalesce(string_agg(detail, ' | '), '(空)')
  FROM (
    SELECT provider_name||'/'||model||' dim='||coalesce(dimensions::text,'null')||' chunks='||chunk_count AS detail
    FROM index_status i JOIN chapters c ON c.id = i.chapter_id
    WHERE c.work_id = '${workId}' AND i.status = 'ready'
    LIMIT 3
  ) t
`);
const ledgerDetail = detail(`
  SELECT coalesce(string_agg(detail, ' | '), '(空)')
  FROM (
    SELECT provider_name||'/'||model||' dim='||coalesce(dimensions::text,'null')||' chunks='||chunk_count AS detail
    FROM ledger_index_status WHERE status = 'ready'
    LIMIT 3
  ) t
`);
const canonChunkStats = detail(`
  SELECT 'chunks_per_chapter_avg='||coalesce(round(avg(n),2)::text,'null')||' max='||coalesce(max(n)::text,'0')||' min='||coalesce(min(n)::text,'0')
  FROM (SELECT ch.chapter_id, count(*)::int AS n FROM canon_chunks ch JOIN chapters c ON c.id = ch.chapter_id
        WHERE c.work_id = '${workId}' GROUP BY 1) t
`);
const ledgerChunkStats = detail(`
  SELECT 'entries_with_chunks='||count(*)::text||' avg='||coalesce(round(avg(n),2)::text,'null')
        ||' max='||coalesce(max(n)::text,'0')||' min='||coalesce(min(n)::text,'0')
  FROM (SELECT entry_id, count(*)::int AS n FROM ledger_chunks GROUP BY 1) t
`);
const ledgerChunkStatsByKind = detail(`
  SELECT coalesce(string_agg(kind||': avg='||avg_n||' min='||min_n||' max='||max_n||' entries='||n, ' | '), '(空)')
  FROM (
    SELECT kind, round(avg(n),2)::text AS avg_n, min(n)::text AS min_n, max(n)::text AS max_n, count(*)::int AS n
    FROM (SELECT kind, entry_id, count(*)::int AS n FROM ledger_chunks GROUP BY 1, 2) t GROUP BY kind
  ) s
`);
const ledgerCoverageSql = detail(`
  SELECT 'ledger_chunks='||count(*)::text||' vector_chunks='||(SELECT count(*) FROM ledger_chunk_embeddings)::text
  FROM ledger_chunks
`);
const ledgerStatusDetail = detail(`
  SELECT coalesce(string_agg(status||'='||n, ','), '(空)')
  FROM (SELECT status, count(*)::int AS n FROM ledger_index_status GROUP BY 1 ORDER BY 1) t
`);
const ledgerRetryDetail = detail(`
  SELECT 'attempts_max='||coalesce(max(attempts),0)::text
        ||' with_next_retry='||count(*) FILTER (WHERE next_retry_at IS NOT NULL)::text
        ||' last_error_kinds='||coalesce(
             string_agg(DISTINCT coalesce(left(last_error, 40), 'null'), ' | '), 'null')
  FROM ledger_index_status
`);

// model_calls.status 的实际取值是 'ok'/'failed'（另有预算阻断的 'blocked'），
// 写成 'completed' 会让一份成功索引的报告自称"0 次成功调用"。
function callStats(purpose) {
  return psql(`
    SELECT 'n='||count(*)::text||' ok='||count(*) FILTER (WHERE status='ok')::text
          ||' failed='||count(*) FILTER (WHERE status='failed')::text
          ||' blocked='||count(*) FILTER (WHERE status='blocked')::text
          ||' prompt_tokens='||coalesce(sum(prompt_tokens),0)::text
          ||' cost='||coalesce(sum(cost),0)::text||' '||coalesce(max(cost_currency),'-')::text
          ||' latency_med='||coalesce(
               (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::text
                FROM model_calls WHERE provider_id = '${providerId}' AND purpose = '${purpose}'),
               'null')
    FROM model_calls WHERE provider_id = '${providerId}' AND purpose = '${purpose}'
  `);
}
const indexCalls = callStats('embedding');
const queryCallsAtDrain = callStats('embedding_query');
console.log(`索引期嵌入调用：${indexCalls}（此时检索调用 ${queryCallsAtDrain}）`);

// 账本侧查询：名称、别名、正文短语各一条，再加一条域外对照，验证账本向量通道的降级原因。
const LEDGER_QUERIES = [
  { q: '压测设定 0007', label: '设定名称', expect: 'ledger' },
  { q: '角色别名0021', label: '角色别名', expect: 'ledger' },
  { q: '一枚发烫的铜钉 持有', label: '状态字段', expect: 'ledger' },
  { q: '铜钉在掌心发烫', label: '正文短语（正典与账本共有）', expect: 'both' },
  { q: '量子色动力学的渐近自由', label: '域外对照', expect: 'none' },
];

const retrieval = [];
for (const mode of ['lexical', 'auto']) {
  for (const item of LEDGER_QUERIES) {
    const times = [];
    let last = null;
    for (let index = 0; index < REPEATS; index += 1) {
      const result = await request(
        `/api/search?q=${encodeURIComponent(item.q)}&workId=${workId}&mode=${mode}&limit=8`,
      );
      times.push(result.elapsedMs);
      last = result.json;
    }
    const row = {
      mode,
      label: item.label,
      expect: item.expect,
      queryChars: item.q.length,
      medianMs: median(times),
      samples: times,
      canonResults: last?.results?.length ?? null,
      canonTopChapter: last?.results?.[0]?.chapterNumber ?? null,
      ledgerResults: last?.ledgerResults?.length ?? null,
      ledgerTopKind: last?.ledgerResults?.[0]?.kind ?? null,
      ledgerTopName: last?.ledgerResults?.[0]?.name ?? null,
      ledgerTopLexicalScore: last?.ledgerResults?.[0]?.lexicalScore ?? null,
      ledgerTopVectorScore: last?.ledgerResults?.[0]?.vectorScore ?? null,
      ledgerTopRrfScore: last?.ledgerResults?.[0]?.rrfScore ?? null,
      modeUsed: last?.mode ?? null,
      semanticReason: last?.semanticReason ?? null,
      ledgerReason: last?.ledgerReason ?? null,
      coverage: last?.coverage
        ? {
            totalCanonChapters: last.coverage.totalCanonChapters ?? null,
            ready: last.coverage.ready ?? null,
            chunks: last.coverage.chunks ?? null,
            vectorChunks: last.coverage.vectorChunks ?? null,
            vectorModel: last.coverage.vectorModel ?? null,
          }
        : null,
      ledgerCoverage: last?.ledgerCoverage
        ? {
            activeEntries: last.ledgerCoverage.activeEntries ?? null,
            indexedEntries: last.ledgerCoverage.indexedEntries ?? null,
            chunks: last.ledgerCoverage.chunks ?? null,
            vectorChunks: last.ledgerCoverage.vectorChunks ?? null,
            vectorModel: last.ledgerCoverage.vectorModel ?? null,
          }
        : null,
      responseBytes: last ? JSON.stringify(last).length : 0,
    };
    retrieval.push(row);
    console.log(
      `  检索 ${mode} / ${item.label}：中位 ${row.medianMs}ms，正典 ${row.canonResults} 条、账本 ${row.ledgerResults} 条` +
        `（首位 ${row.ledgerTopKind ?? '-'}/${row.ledgerTopName ?? '-'}）mode=${row.modeUsed}` +
        `${row.ledgerReason ? ` ledgerReason=${row.ledgerReason}` : ''}`,
    );
  }
}

const queryCallsAfterRetrieval = callStats('embedding_query');
const totalCalls = psql(`SELECT 'n='||count(*)::text||' ok='||count(*) FILTER (WHERE status='ok')::text FROM model_calls WHERE provider_id = '${providerId}'`);
console.log(`检索后查询向量调用：${queryCallsAfterRetrieval}；本服务商合计 ${totalCalls}`);

// 排空速率的解释必须先问"有几个进程在领任务"。单个 worker 一次 claimOutbox 只领 10 条、
// 且 runOutboxTick 逐条 await，所以任一瞬间 processing 不可能超过 10；采样里若更高，
// 就说明本轮不止一个实例在领任务，速率是聚合值而不是单 worker 值。
const maxProcessing = (samples) =>
  samples.reduce((m, s) => Math.max(m, Number(/processing=(\d+)/.exec(s.outbox)?.[1] ?? '0')), 0);
const maxClaimers = (samples) =>
  samples.reduce((m, s) => Math.max(m, Number(/claimer=(\d+)/.exec(s.byLastQuery)?.[1] ?? '0')), 0);

const canonMaxProcessing = maxProcessing(canonDrain.samples);
const ledgerMaxProcessing = maxProcessing(ledgerDrain.samples);
const CLAIM_BATCH_CAP = 10;
const topologyConclusive =
  claimers <= 1 &&
  maxClaimers(canonDrain.samples) <= 1 &&
  maxClaimers(ledgerDrain.samples) <= 1 &&
  canonMaxProcessing <= CLAIM_BATCH_CAP &&
  ledgerMaxProcessing <= CLAIM_BATCH_CAP;
if (!topologyConclusive) {
  console.warn(
    `  [拓扑] 本轮无法证明只有一个 worker：正典采样里同时 processing 最多 ${canonMaxProcessing} 条、` +
      `账本 ${ledgerMaxProcessing} 条，而单实例领用上限是 ${CLAIM_BATCH_CAP} 条。` +
      '排空速率只能按"多实例聚合、受嵌入服务串行吞吐约束"解释。',
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  database: DB_NAME,
  runId: RUN_ID,
  runLabel: RUN_LABEL,
  scenario:
    process.env.PERF_SCENARIO ??
    `千章规模账本索引与检索：导入 ${CHAPTERS} 章 × ${CHARS_PER_CHAPTER} 字 + 发布 ${createdEntries.length} 条账本条目，` +
      '真实 worker 分别排空正典与账本投影，再做词法与混合检索（账本通道单独计数）',
  workTitle: WORK_TITLE,
  cleanupWindowStart: runStart,
  config: {
    chapterTarget: CHAPTERS,
    charsPerChapter: CHARS_PER_CHAPTER,
    entryTarget: ENTRIES,
    entryMix: {
      setting: SETTINGS_COUNT,
      character: CHARACTERS_COUNT,
      foreshadowing: ENTRIES - SETTINGS_COUNT - CHARACTERS_COUNT,
      workScopedSettings: WORK_SCOPED_SETTINGS,
    },
    importBatchSize: BATCH,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    embedBaseUrl: EMBED_BASE_URL,
    embedModel: EMBED_MODEL,
    repeatsPerQuery: REPEATS,
    automationRunner: '关闭（AUTOMATION_RUNNER=0，独立实例指向 yunshuo_test）',
  },
  caveats: [
    '合成正文与合成条目：同一组 8 句 filler 循环拼接，条目字段也从 filler 派生，检索命中不具备语义难度。',
    '条目数量是按"千章作品的上限"构造的，不代表真实作品的账本规模；名称/别名/章节绑定按序号散布。',
    '正典与账本本轮用同一个服务商同一个模型（同维度），检索只发一次查询向量、两个通道共用；' +
      '模型/维度不同才走双查询向量那条分支，本脚本没有覆盖它。',
    topologyConclusive
      ? '实例形状与单实例一致：压测前只有 1 个连接最近在领任务，且各阶段采样里同时在处理的任务数都没超过单次领用上限，' +
        '所以本轮速率可以按单 worker 串行读；要更强结论需要显式的进程清单，本轮没有采。'
      : `本轮不能把排空速率解释成单 worker 速率：正典阶段采样里同时在处理的任务最多 ${canonMaxProcessing} 条、账本阶段 ${ledgerMaxProcessing} 条，` +
        `而单个实例一次只领 ${CLAIM_BATCH_CAP} 条并逐条 await，超出该值说明当时有多个 worker 在领同一张 outbox。` +
        '因此这里的"每分钟条数"是多实例聚合值，且受本机嵌入服务串行处理约束。',
    '嵌入服务为本机模型，输入价填 0，成本数字不代表任何付费服务商。',
    '本轮没有并发读写混合（发布与索引串行），没有多工作区，没有 Studio 容器内测量，也没有做账本检索质量评估。',
  ],
  baselineCounts: baseline,
  workspaceCountersBefore: countersBefore,
  embedServiceProbe: { reachable: true, modelSeenInList: modelSeen },
  import: {
    batches: importBatches,
    totalChapters: chapterTotal,
    totalImportMs: importBatches.reduce((total, item) => total + item.importMs, 0),
  },
  canonDrain: {
    fullyDrained: canonDrain.finished,
    timedOut: canonDrain.timedOut,
    elapsedMs: canonDrain.elapsedMs,
    chaptersPerMinute:
      canonDrain.finished && canonDrain.elapsedMs > 0
        ? Math.round((chapterTotal / (canonDrain.elapsedMs / 60000)) * 100) / 100
        : null,
    samples: canonDrain.samples,
  },
  ledgerEntries: {
    target: ENTRIES,
    published: createdEntries.length,
    failed: skippedEntries.length,
    failures: skippedEntries.slice(0, 20),
    byKind: {
      setting: createdEntries.filter((item) => item.kind === 'setting').length,
      character: createdEntries.filter((item) => item.kind === 'character').length,
      foreshadowing: createdEntries.filter((item) => item.kind === 'foreshadowing').length,
    },
    byScope: {
      work: createdEntries.filter((item) => item.scope === 'work').length,
      workspace: createdEntries.filter((item) => item.scope === 'workspace').length,
    },
    createMedianMs: median(createMs),
    publishMedianMs: median(publishMs),
    createTotalMs: createPhaseMs,
    publishTotalMs: publishPhaseMs,
    note: '创建与发布各自计一次 HTTP 往返；发布同时写版本、生效指针、审计与 index.ledger outbox。',
  },
  ledgerQueueStart,
  ledgerDrain: {
    fullyDrained: ledgerDrain.finished,
    timedOut: ledgerDrain.timedOut,
    elapsedMs: ledgerDrain.elapsedMs,
    readyAtQueueStart: ledgerReadyAtStart,
    entriesIndexedInWindow: createdEntries.length - ledgerReadyAtStart,
    entriesPerMinute:
      ledgerDrain.finished && ledgerDrain.elapsedMs > 0
        ? Math.round(((createdEntries.length - ledgerReadyAtStart) / (ledgerDrain.elapsedMs / 60000)) * 100) / 100
        : null,
    rateNote:
      '分母只算本轮窗口内真正需要索引的条目（发布总数减去入队即刻已 ready 的条数）；' +
      '把全部条目除以整段用时会把速率抬高。',
    samples: ledgerDrain.samples,
  },
  topology: {
    claimBatchCap: CLAIM_BATCH_CAP,
    preflight,
    maxClaimersObserved: { canon: maxClaimers(canonDrain.samples), ledger: maxClaimers(ledgerDrain.samples) },
    maxProcessingObserved: { canon: canonMaxProcessing, ledger: ledgerMaxProcessing },
    singleWorkerProvable: topologyConclusive,
    note:
      'claimer 取自 pg_stat_activity 里最近一条语句为 outbox 领取更新的连接数（并发领任务实例数的下界）；' +
      `processing 是采样瞬间同时在处理的任务数。单个 worker 一次只领 ${CLAIM_BATCH_CAP} 条且逐条 await，` +
      '所以任一瞬间 processing 超过该上限就说明不止一个实例在领任务，此时排空速率是多实例聚合值。',
  },
  canonOutboxShape,
  ledgerOutboxShape,
  indexDetail: { canon: canonDetail, ledger: ledgerDetail },
  chunkStats: { canon: canonChunkStats, ledger: ledgerChunkStats, ledgerByKind: ledgerChunkStatsByKind },
  ledgerCoverage: ledgerCoverageSql,
  ledgerStatusDetail,
  ledgerRetryDetail,
  calls: {
    indexPhase: indexCalls,
    queryPhase: queryCallsAfterRetrieval,
    queryPhaseAtDrainEnd: queryCallsAtDrain,
    providerTotal: totalCalls,
    note: 'indexPhase 在检索开始前取样，含正典与账本两侧的嵌入调用（按同一 purpose 记账，未分侧）；queryPhase 按每次混合检索的查询向量记账。',
  },
  retrieval,
  countsAfterRun: countQuery(),
};

if (!process.argv.includes('--keep')) {
  console.log('\n清理账本索引压测数据…');
  const callRows = psql(`SELECT count(*) FROM model_calls WHERE provider_id = '${providerId}'`);
  const ledgerIds = `(SELECT id FROM ledger_entries WHERE workspace_id = '${session.json.workspace.id}' AND name LIKE '压测%')`;
  report.cleanupNote = `临时服务商的 model_calls 共 ${callRows} 条（报告 calls.providerTotal = ${totalCalls}，两者应一致），与服务商行一并按 id 删除；真实用量与耗时已先写入本报告 calls。`;
  psql(`
    BEGIN;
    DELETE FROM outbox WHERE payload ? 'entryId'
      AND (payload->>'entryId')::uuid IN ${ledgerIds};
    DELETE FROM outbox WHERE payload ? 'chapterId'
      AND (payload->>'chapterId')::uuid IN (SELECT id FROM chapters WHERE work_id = '${workId}');
    DELETE FROM events WHERE aggregate_id IN ${ledgerIds};
    DELETE FROM audit_log WHERE object_id IN ${ledgerIds};
    DELETE FROM ledger_entries WHERE id IN ${ledgerIds};
    DELETE FROM events WHERE aggregate_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR aggregate_id = '${workId}';
    DELETE FROM audit_log WHERE object_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR object_id = '${workId}';
    DELETE FROM audit_log WHERE action = 'auth.login' AND created_at >= '${runStart}';
    DELETE FROM sessions WHERE user_id = '${runUserId}' AND created_at >= '${runStart}';
    DELETE FROM audit_log WHERE object_id = '${providerId}';
    DELETE FROM model_calls WHERE provider_id = '${providerId}';
    DELETE FROM chunk_embeddings WHERE provider_id = '${providerId}';
    DELETE FROM ledger_chunk_embeddings WHERE provider_id = '${providerId}';
    DELETE FROM works WHERE id = '${workId}';
    DELETE FROM model_providers WHERE id = '${providerId}';
    COMMIT;
  `);
  const after = countQuery();
  const countersAfterDelete = workspaceCounters();
  psql(
    `UPDATE workspaces SET settings_version = ${countersBefore.settingsVersion}, ledger_version = ${countersBefore.ledgerVersion} WHERE id = '${workspaceId}'`,
  );
  const countersRestored = workspaceCounters();
  report.workspaceCounters = {
    before: countersBefore,
    afterPublishes: countersAfterDelete,
    restoredTo: countersRestored,
    note: '发布递增的工作区版本计数不在 COUNTS 里；清理后显式还原为压测前的值并留痕。',
  };
  const drift = Object.entries(baseline).filter(([key, value]) => after[key] !== value);
  report.countsAfterCleanup = after;
  report.cleanupDrift = Object.fromEntries(
    drift.map(([key, value]) => [key, `${value} -> ${after[key]}`]),
  );
  console.log(
    drift.length > 0
      ? `清理后与基线不一致： ${JSON.stringify(report.cleanupDrift)}`
      : '清理后各表计数与压测前基线完全一致。',
  );
}

writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`报告已写入 ${REPORT_PATH}`);
