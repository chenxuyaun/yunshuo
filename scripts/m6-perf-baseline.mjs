#!/usr/bin/env node
// M6 性能基线：1000 章导入与“出场扫描/角色时间线”随正典规模的增长。
// 只在隔离测试库上跑：API 必须指向 yunshuo_test，且 runner 关闭。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3101';
const EMAIL = process.env.PERF_EMAIL ?? 'owner@demo.local';
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'yunshuo-db';
const DB_USER = process.env.DB_USER ?? 'yunshuo';
const DB_NAME = process.env.DB_NAME ?? 'yunshuo_test';
const STAGES = (process.env.PERF_STAGES ?? '200,300,500')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const CHARS_PER_CHAPTER = Number(process.env.PERF_CHAPTER_CHARS ?? '600');
const LONG_CHAPTER_CHARS = Number(process.env.PERF_LONG_CHAPTER_CHARS ?? '500000');
const REPEATS = Number(process.env.PERF_REPEATS ?? '3');
const CONCURRENCY_LEVELS = (process.env.PERF_CONCURRENCY ?? '1,4,8')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const CONCURRENCY_ROUNDS = Number(process.env.PERF_CONCURRENCY_ROUNDS ?? '3');
const KEEP = process.argv.includes('--keep');
const RUN_ID = process.env.PERF_RUN_ID ?? randomUUID().slice(0, 8);
const WORK_TITLE = `压测作品 ${RUN_ID}`;
const VOLUME_TITLE = `压测卷 ${RUN_ID}`;
const CHARACTER_NAME = '林七';
const CHARACTER_ALIASES = ['七姐', '守门人'];
const RUN_LABEL = process.env.PERF_REPORT_NAME ?? 'baseline';
const REPORT_PATH = new URL(
  `../docs/m6-perf-${RUN_LABEL}.json`,
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');

if (DB_NAME !== 'yunshuo_test' && !process.env.PERF_ALLOW_OTHER_DB) {
  console.error(`只允许在 yunshuo_test 上压测（当前 DB_NAME=${DB_NAME}）。`);
  process.exit(1);
}

function psql(query) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-Atc', query], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  }).trim();
}

let cookie = '';

function authHeaders(hasBody) {
  return {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}),
  };
}

async function request(path, { method = 'GET', body } = {}) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(Boolean(body)),
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

// 并发压测不能因为一个 500 就终止整轮：那正是想知道的结果之一。
async function requestSafe(path) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}${path}`, { headers: authHeaders(false) });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: String(error?.message ?? error).slice(0, 200),
      elapsedMs: Math.round(performance.now() - started),
      bytes: 0,
    };
  }
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// 报告只留派生计数，不留整段接口响应：1000 章时原样落 lastJson 会让两份 JSON 涨到 1.2MB，
// 里面全是章节标题和 id，对基线本身没有信息量。
function digest(result, fields) {
  const { lastJson, ...rest } = result;
  return { ...rest, ...fields(lastJson ?? {}) };
}

async function measure(path, { method = 'GET', body } = {}, repeats = REPEATS) {
  const times = [];
  const sizes = [];
  let lastJson = null;
  for (let index = 0; index < repeats; index += 1) {
    const result = await request(path, { method, body });
    times.push(result.elapsedMs);
    sizes.push(result.bytes);
    lastJson = result.json;
  }
  return { medianMs: median(times), samples: times, responseBytes: median(sizes), lastJson };
}

function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0));
  return sorted[index];
}

// 每轮并发发 concurrency 个请求、等全部返回再开下一轮：这是"批量并发"，不是恒定到达率，
// 报告里要按这个口径读，不能当成持续压测的吞吐上限。
async function burst(path, concurrency, rounds = CONCURRENCY_ROUNDS) {
  const results = [];
  const wallStart = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => requestSafe(path)),
    );
    results.push(...batch);
  }
  const wallMs = Math.max(Math.round(performance.now() - wallStart), 1);
  const times = results.map((item) => item.elapsedMs);
  const failures = results.filter((item) => !item.ok);
  const statusCounts = Object.fromEntries(
    Object.entries(
      results.reduce((acc, item) => {
        const key = String(item.status ?? 'network-error');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    ),
  );
  return {
    concurrency,
    rounds,
    totalRequests: results.length,
    wallMs,
    throughputPerSecond: Math.round((results.length / (wallMs / 1000)) * 100) / 100,
    medianMs: median(times),
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    maxMs: Math.max(...times),
    minMs: Math.min(...times),
    statusCounts,
    failures: failures.length,
    failureSample: failures[0] ? { status: failures[0].status, error: failures[0].error ?? null } : null,
  };
}

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

function buildChapterBody(seed, targetChars) {
  let text = '';
  let cursor = seed;
  while (text.length < targetChars) {
    const prefix =
      cursor % 11 === 0
        ? `${CHARACTER_NAME}停在巷口，`
        : cursor % 17 === 0
          ? `${CHARACTER_ALIASES[0]}没有回头。`
          : cursor % 23 === 0
            ? `${CHARACTER_ALIASES[1]}把门闩按住了。`
            : '';
    text += `${prefix}${FILLER[cursor % FILLER.length]}\n\n`;
    cursor += 1;
  }
  // 截到目标长度：契约单章上限正好是 500_000 字，压测要能取到这个边界值。
  return text.slice(0, targetChars).trim();
}

function countQuery() {
  const rows = psql(`
    SELECT 'works='||count(*) FROM works
    UNION ALL SELECT 'chapters='||count(*) FROM chapters
    UNION ALL SELECT 'canon_versions='||count(*) FROM canon_versions
    UNION ALL SELECT 'canon_current='||count(*) FROM canon_current
    UNION ALL SELECT 'chapter_metadata='||count(*) FROM chapter_metadata
    UNION ALL SELECT 'index_status='||count(*) FROM index_status
    UNION ALL SELECT 'gate_evaluations='||count(*) FROM gate_evaluations
    UNION ALL SELECT 'ledger_entries='||count(*) FROM ledger_entries
    UNION ALL SELECT 'ledger_versions='||count(*) FROM ledger_entry_versions
    UNION ALL SELECT 'ledger_aliases='||count(*) FROM ledger_entry_aliases
    UNION ALL SELECT 'ledger_index_status='||count(*) FROM ledger_index_status
    UNION ALL SELECT 'links='||count(*) FROM chapter_ledger_links
    UNION ALL SELECT 'sessions='||count(*) FROM sessions
    UNION ALL SELECT 'events='||count(*) FROM events
    UNION ALL SELECT 'audit='||count(*) FROM audit_log
    UNION ALL SELECT 'outbox='||count(*) FROM outbox
    UNION ALL SELECT 'canon_chars='||coalesce(sum(length(content)),0)::text FROM canon_versions
  `);
  return Object.fromEntries(
    rows
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split('=');
        return [key, Number(value)];
      }),
  );
}

function apiRssMb() {
  if (!process.env.PERF_API_PID) return null;
  try {
    const value = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${process.env.PERF_API_PID}).WorkingSet64 / 1MB`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
  } catch {
    return null;
  }
}

console.log(`云说 M6 性能基线 @ ${BASE}，库=${DB_NAME}，批次标记=${RUN_ID}`);
const baseline = countQuery();
console.log('压测前基线：', JSON.stringify(baseline));
const providerRows = psql(`
  SELECT 'enabled='||count(*) FILTER (WHERE is_enabled)::text
      ||' embedding_enabled='||count(*) FILTER (WHERE is_enabled AND purpose='embedding')::text
  FROM model_providers
`);
console.log(`服务商（本库）：${providerRows}`);
// docker exec + psql 本身就有进程启动开销；不单独量它，"DB 直取正文"的毫秒数会被误读成查询耗时。
const psqlOverheadSamples = [];
for (let index = 0; index < 3; index += 1) {
  const started = performance.now();
  psql('SELECT 1');
  psqlOverheadSamples.push(Math.round(performance.now() - started));
}
const psqlOverheadMs = median(psqlOverheadSamples);
console.log(`psql 进程启动开销（中位）：${psqlOverheadMs}ms`);

// 登录本身会写一条 object_id 为空的 auth.login 审计与会话，清理必须按时间窗捕获它们，
// 否则“计数回到基线”只是巧合。时间窗起点直接取数据库自己的 now()，避免本机与容器时钟偏移。
const runStart = psql('SELECT now()::text');
const session = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
console.log(`登录：${session.json.user.name}（${session.json.role}）@ ${session.json.workspace.name}`);
const runUserId = session.json.user.id;

const stages = [];
let workId = null;
let chapterIds = [];
let characterId = null;
let foreshadowId = null;
let firstChapterId = null;
let nextNumber = 1;

async function importBatch(count, charsPerChapter, label) {
  const chapters = [];
  for (let index = 0; index < count; index += 1) {
    const number = nextNumber;
    nextNumber += 1;
    chapters.push({
      number,
      title: `压测第 ${number} 章`,
      content: buildChapterBody(number * 7 + 3, charsPerChapter),
    });
  }
  // 请求体大小必须自己算：response.text() 只有 API 返回的 JSON，不是发出去的正文。
  const requestBodyBytes = Buffer.byteLength(
    JSON.stringify({ workTitle: WORK_TITLE, volumeNumber: 1, volumeTitle: VOLUME_TITLE, chapters }),
  );
  const sentChars = chapters.reduce((total, item) => total + item.content.length, 0);
  const result = await request('/api/chapters/import', {
    method: 'POST',
    body: {
      workTitle: WORK_TITLE,
      volumeNumber: 1,
      volumeTitle: VOLUME_TITLE,
      chapters,
    },
  });
  workId = result.json.workId;
  chapterIds.push(...result.json.imported.map((item) => item.id));
  if (!firstChapterId) firstChapterId = result.json.imported[0]?.id ?? null;
  console.log(
    `${label}：导入 ${result.json.imported.length} 章（送出 ${sentChars} 字），单事务 ${result.elapsedMs}ms，` +
      `请求体 ${(requestBodyBytes / 1024 / 1024).toFixed(2)}MB，响应 ${(result.bytes / 1024).toFixed(0)}KB`,
  );
  return {
    label,
    chapterCount: result.json.imported.length,
    sentChars,
    importMs: result.elapsedMs,
    requestBodyBytes,
    responseBytes: result.bytes,
    storedWordCount: result.json.imported.reduce(
      (total, item) => total + (item.wordCount ?? 0),
      0,
    ),
    longestChapterChars: Math.max(
      ...result.json.imported.map((item) => item.wordCount ?? 0),
      0,
    ),
  };
}

async function ensureLedgerEntries() {
  const created = await request('/api/ledger/entries', {
    method: 'POST',
    body: {
      kind: 'character',
      workId,
      name: CHARACTER_NAME,
      aliases: CHARACTER_ALIASES,
      summary: '压测角色，出场扫描按名称与别名统计。',
      sourceChapterId: firstChapterId,
      payload: {
        role: '压测',
        appearance: '',
        personality: '',
        goals: '',
        faction: '',
        abilities: '',
        speechStyle: '',
        relationships: [{ name: '追兵', relation: '对峙', notes: '' }],
        states: [
          {
            asOfChapterId: firstChapterId,
            life: 'alive',
            location: '巷口',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      },
    },
  });
  characterId = created.json.id;
  await request(`/api/ledger/entries/${characterId}/publish`, {
    method: 'POST',
    body: { expectedDraftVersionId: created.json.draftVersion.id, changeSummary: '压测播种' },
  });
  const foreshadow = await request('/api/ledger/entries', {
    method: 'POST',
    body: {
      kind: 'foreshadowing',
      workId,
      name: '压测伏笔·第六枚钉',
      aliases: [],
      summary: '压测伏笔，用于报告与提醒口径。',
      sourceChapterId: firstChapterId,
      payload: {
        seedChapterId: firstChapterId,
        payoffChapterMin: 1,
        payoffChapterMax: 99_999,
        importance: 'high',
        state: 'planted',
        payoffChapterId: null,
        note: '压测说明，正文不引用。',
        resolutionNote: '',
      },
    },
  });
  foreshadowId = foreshadow.json.id;
  await request(`/api/ledger/entries/${foreshadowId}/publish`, {
    method: 'POST',
    body: { expectedDraftVersionId: foreshadow.json.draftVersion.id, changeSummary: '压测播种' },
  });
  console.log('已发布压测角色与伏笔条目。');
}

let imported = [];
for (const count of STAGES) {
  imported.push(await importBatch(count, CHARS_PER_CHAPTER, `批量导入 ${count} 章`));
  if (stages.length === 0) await ensureLedgerEntries();
  const chapterTotal = chapterIds.length;
  const lastChapterId = chapterIds[chapterIds.length - 1];
  const midChapterId = chapterIds[Math.floor(chapterIds.length / 2)];
  const dbCounts = countQuery();
  const canonChars = dbCounts.canon_chars;

  const timeline = await measure(`/api/ledger/entries/${characterId}/timeline`);
  const context = await measure(`/api/ledger/character-context?chapterId=${midChapterId}`);
  const reminders = await measure(`/api/ledger/foreshadowing/reminders?chapterId=${lastChapterId}`);
  const report = await measure(`/api/ledger/foreshadowing/report?workId=${workId}`);
  const chapterList = await measure('/api/chapters');

  const scanStart = performance.now();
  const scanRows = psql(`
    SELECT c.id, cv.content
    FROM chapters c
    JOIN canon_current cc ON cc.chapter_id = c.id
    JOIN canon_versions cv ON cv.id = cc.version_id
    WHERE c.work_id = '${workId}'
    ORDER BY c.number ASC
  `);
  const dbFetchMs = Math.round(performance.now() - scanStart);
  const dbFetchBytes = Buffer.byteLength(scanRows);
  const indexStates = psql(`
    SELECT coalesce(string_agg(status||'='||n, ','), '(空)')
    FROM (
      SELECT i.status, count(*)::int AS n
      FROM index_status i
      JOIN chapters c ON c.id = i.chapter_id
      WHERE c.work_id = '${workId}'
      GROUP BY 1
      ORDER BY 1
    ) t
  `);

  stages.push({
    chapterTotal,
    canonChars,
    import: imported[imported.length - 1],
    indexStates,
    timeline: digest(timeline, (json) => ({
      appearances: json.appearances?.length ?? null,
      states: json.states?.length ?? null,
      warnings: json.warnings?.length ?? null,
      scanScope: json.scanScope ?? null,
    })),
    characterContext: digest(context, (json) => ({
      characters: json.characters?.length ?? null,
      omittedCharacters: json.omittedCharacters ?? null,
      asOfChapterNumber: json.asOfChapter?.number ?? null,
    })),
    foreshadowingReminders: digest(reminders, (json) => ({
      reminders: json.reminders?.length ?? null,
      latestCanonChapterNumber: json.latestCanonChapter?.number ?? null,
    })),
    foreshadowingReport: digest(report, (json) => ({
      items: json.items?.length ?? null,
      summary: json.summary ?? null,
    })),
    chapterList: digest(chapterList, (json) => ({
      chapters: Array.isArray(json) ? json.length : null,
    })),
    rawCanonFetch: {
      ms: dbFetchMs,
      psqlOverheadMs,
      msExcludingProcessStart: Math.max(dbFetchMs - psqlOverheadMs, 0),
      bytes: dbFetchBytes,
    },
    apiRssMb: apiRssMb(),
  });
  console.log(
    `  累计 ${chapterTotal} 章 / ${canonChars} 字：时间线 ${timeline.medianMs}ms（出场 ${
      timeline.lastJson?.appearances?.length ?? 0
    } 章）` +
      `，角色卡 ${context.medianMs}ms，提醒 ${reminders.medianMs}ms，报告 ${report.medianMs}ms，` +
      `章节列表 ${chapterList.medianMs}ms，DB 直取正文 ${dbFetchMs}ms（含 psql 启动 ${psqlOverheadMs}ms）/ ${(dbFetchBytes / 1024 / 1024).toFixed(1)}MB` +
      `，索引状态 ${indexStates}`,
  );
}

const longImport = await importBatch(1, LONG_CHAPTER_CHARS, `单章长文导入 ${LONG_CHAPTER_CHARS} 字`);
const longChapterId = chapterIds[chapterIds.length - 1];
const timelineAfterLong = await measure(`/api/ledger/entries/${characterId}/timeline`);
const longLastChapter = await measure(`/api/ledger/foreshadowing/reminders?chapterId=${longChapterId}`);
console.log(
  `  加入 ${LONG_CHAPTER_CHARS} 字长章后：时间线 ${timelineAfterLong.medianMs}ms，提醒 ${longLastChapter.medianMs}ms`,
);

// 并发读：把"每请求把整部正典取进 Node"这条路径推到多个请求同时发生，
// 看的是单实例的串行化程度与尾延迟，不是集群容量。
const concurrencyCorpus = countQuery();
const heavyPath = `/api/ledger/entries/${characterId}/timeline`;
const lightPath = `/api/ledger/character-context?chapterId=${
  chapterIds[Math.floor(chapterIds.length / 2)]
}`;
const concurrentReads = {
  note: '客户端与被测 API 在同一台机器、由同一个 Node 进程发起；每轮并发等全部返回再开下一轮（批量并发，不是恒定到达率）。请求都复用同一个登录会话，不代表多用户/多工作区分布。',
  levels: CONCURRENCY_LEVELS,
  roundsPerLevel: CONCURRENCY_ROUNDS,
  corpus: { chapters: concurrencyCorpus.chapters, canonChars: concurrencyCorpus.canon_chars },
  apiRssMbBefore: apiRssMb(),
  heavyScan: [],
  lightRead: [],
};
for (const level of CONCURRENCY_LEVELS) {
  const heavy = await burst(heavyPath, level);
  const light = await burst(lightPath, level);
  concurrentReads.heavyScan.push(heavy);
  concurrentReads.lightRead.push(light);
  console.log(
    `  并发 ${level}：时间线 中位 ${heavy.medianMs}ms / p95 ${heavy.p95Ms}ms / 最大 ${heavy.maxMs}ms，` +
      `${heavy.throughputPerSecond} req/s，失败 ${heavy.failures}` +
      ` ｜ 角色卡 中位 ${light.medianMs}ms / p95 ${light.p95Ms}ms / 最大 ${light.maxMs}ms，` +
      `${light.throughputPerSecond} req/s`,
  );
}
concurrentReads.apiRssMbAfter = apiRssMb();

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  database: DB_NAME,
  runId: RUN_ID,
  runLabel: RUN_LABEL,
  scenario: process.env.PERF_SCENARIO ?? '（未填写）',
  workTitle: WORK_TITLE,
  cleanupWindowStart: runStart,
  config: {
    stages: STAGES,
    charsPerChapter: CHARS_PER_CHAPTER,
    longChapterChars: LONG_CHAPTER_CHARS,
    repeatsPerEndpoint: REPEATS,
    concurrencyLevels: CONCURRENCY_LEVELS,
    roundsPerConcurrencyLevel: CONCURRENCY_ROUNDS,
    automationRunner: '关闭（AUTOMATION_RUNNER=0，独立实例指向 yunshuo_test）',
  },
  baselineCounts: baseline,
  environment: {
    modelProvidersInDatabase: providerRows,
    indexingWorker: '未启动（只跑独立 API 实例；索引状态停留在 not_configured/pending，检索与嵌入不在本轮测量范围）',
    automationRunner: '关闭',
    zeroModelSpend: true,
  },
  stages,
  longChapter: {
    import: longImport,
    timelineMedianMs: timelineAfterLong.medianMs,
    timelineSamples: timelineAfterLong.samples,
    remindersMedianMs: longLastChapter.medianMs,
  },
  concurrentReads,
  countsAfterRun: countQuery(),
  apiRssMb: apiRssMb(),
};

if (!KEEP) {
  console.log('\n清理压测数据…');
  // 清理不能把上千个章节 id 拼进 SQL：1000 章时命令行参数直接超出 Windows 上限。
  // 全部改成按 work / entry 的集合子查询，语句长度与章节数无关。
  const entryIds = [characterId, foreshadowId].map((id) => `'${id}'`).join(',');
  psql(`
    BEGIN;
    DELETE FROM outbox WHERE payload ? 'chapterId'
      AND (payload->>'chapterId')::uuid IN (SELECT id FROM chapters WHERE work_id = '${workId}');
    DELETE FROM outbox WHERE payload ? 'entryId'
      AND (payload->>'entryId')::uuid IN (${entryIds});
    DELETE FROM events WHERE aggregate_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR aggregate_id IN (${entryIds}) OR aggregate_id = '${workId}';
    DELETE FROM audit_log WHERE object_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR object_id IN (${entryIds}) OR object_id = '${workId}';
    DELETE FROM audit_log WHERE action = 'auth.login' AND created_at >= '${runStart}';
    DELETE FROM sessions WHERE user_id = '${runUserId}' AND created_at >= '${runStart}';
    DELETE FROM ledger_entries WHERE id IN (${entryIds});
    DELETE FROM works WHERE id = '${workId}';
    COMMIT;
  `);
  const after = countQuery();
  const drift = Object.entries(baseline).filter(
    ([key, value]) => after[key] !== value,
  );
  report.countsAfterCleanup = after;
  report.cleanupDrift = Object.fromEntries(
    drift.map(([key, value]) => [key, `${value} -> ${after[key]}`]),
  );
  if (drift.length > 0) {
    console.log('清理后与基线不一致：', JSON.stringify(report.cleanupDrift));
  } else {
    console.log('清理后各表计数与压测前基线完全一致。');
  }
}

writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n报告已写入 ${REPORT_PATH}`);
console.log('说明：合成正文、真实 API 与真实数据库；这是规模增长基线，不是生产 SLA。');
