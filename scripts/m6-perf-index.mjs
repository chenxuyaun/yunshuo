#!/usr/bin/env node
// 千章规模的索引排空与检索基线：真实 worker + 真实本机嵌入服务。
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
const CHAPTERS = Number(process.env.PERF_INDEX_CHAPTERS ?? '1000');
const CHARS_PER_CHAPTER = Number(process.env.PERF_INDEX_CHAPTER_CHARS ?? '600');
const BATCH = Number(process.env.PERF_INDEX_BATCH ?? '1000');
const POLL_MS = Number(process.env.PERF_INDEX_POLL_MS ?? '20000');
// 默认 90 分钟：千章在本机模型上实测排空 2070s（34.5 分钟），旧的 30 分钟默认值会把
// 一次慢但成功的排空记成"未排空"，那是超时设置而不是管线状态。
const TIMEOUT_MS = Number(process.env.PERF_INDEX_TIMEOUT_MS ?? '5_400_000'.replace(/_/g, ''));
const EMBED_BASE_URL = process.env.PERF_EMBED_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const EMBED_MODEL = process.env.PERF_EMBED_MODEL ?? 'bge-m3:latest';
const RUN_LABEL = process.env.PERF_REPORT_NAME ?? 'index';
const REPORT_PATH = new URL(
  `../docs/m6-perf-${RUN_LABEL}.json`,
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REPEATS = 3;

if (DB_NAME !== 'yunshuo_test' && !process.env.PERF_ALLOW_OTHER_DB) {
  console.error(`只允许在 yunshuo_test 上压测索引（当前 DB_NAME=${DB_NAME}）。`);
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
  -- chapter_metadata 每章一行，删除靠 works→chapters 的级联；不列进基线就看不见漏删。
  UNION ALL SELECT 'chapter_metadata='||count(*) FROM chapter_metadata
  UNION ALL SELECT 'chunk_embeddings='||count(*) FROM chunk_embeddings
  UNION ALL SELECT 'index_status='||count(*) FROM index_status
  UNION ALL SELECT 'ledger_chunks='||count(*) FROM ledger_chunks
  UNION ALL SELECT 'ledger_index_status='||count(*) FROM ledger_index_status
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
  // status 必须带别名：index_status JOIN chapters 时两表都有 status 列，裸写会直接报 ambiguous。
  const rows = psql(`
    SELECT coalesce(string_agg(status||'='||n, ','), '(空)')
    FROM (SELECT ${alias}.status, count(*)::int AS n FROM ${from} GROUP BY 1 ORDER BY 1) t
  `);
  return rows;
}

// 与 m6-perf-baseline.mjs 同一份 filler，保证两轮的切块与命中可对照。
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
    text += `${FILLER[cursor % FILLER.length]}\n\n`;
    cursor += 1;
  }
  return text.slice(0, targetChars).trim();
}

console.log(`云说 M6 索引基线 @ ${BASE}，库=${DB_NAME}，目标 ${CHAPTERS} 章 × ${CHARS_PER_CHAPTER} 字`);

// 嵌入服务必须先可达：否则整轮只会得到 pending，那不是索引基线而是环境状态。
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
const runStart = psql('SELECT now()::text');
const session = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
const runUserId = session.json.user.id;
console.log(`登录：${session.json.user.name}（${session.json.role}）@ ${session.json.workspace.name}`);

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
const WORK_TITLE = `索引压测作品 ${RUN_ID}`;
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
    chapters.push({ number, title: `索引压测第 ${number} 章`, content: buildChapterBody(number * 7 + 3, CHARS_PER_CHAPTER) });
  }
  const requestBodyBytes = Buffer.byteLength(
    JSON.stringify({ workTitle: WORK_TITLE, volumeNumber: 1, volumeTitle: `索引压测卷 ${RUN_ID}`, chapters }),
  );
  const result = await request('/api/chapters/import', {
    method: 'POST',
    body: { workTitle: WORK_TITLE, volumeNumber: 1, volumeTitle: `索引压测卷 ${RUN_ID}`, chapters },
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

const workIndexFrom = `index_status i JOIN chapters c ON c.id = i.chapter_id WHERE c.work_id = '${workId}'`;
const queueStart = {
  at: new Date().toISOString(),
  indexStatus: statusCounts(workIndexFrom, 'i'),
  outbox: statusCounts('outbox', 'outbox'),
};
console.log(`入队即刻：index_status ${queueStart.indexStatus}，outbox ${queueStart.outbox}`);

const drain = [];
const startedAt = performance.now();
let finished = false;
let timedOut = true;
while (performance.now() - startedAt < TIMEOUT_MS) {
  const elapsedMs = Math.round(performance.now() - startedAt);
  const states = statusCounts(workIndexFrom, 'i');
  const sample = {
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
    indexStatus: states,
    outbox: statusCounts('outbox', 'outbox'),
    canonChunks: Number(psql('SELECT count(*) FROM canon_chunks')),
    chunkEmbeddings: Number(psql('SELECT count(*) FROM chunk_embeddings')),
    workerRssMb: processRssMb(process.env.PERF_WORKER_PID),
    apiRssMb: processRssMb(process.env.PERF_API_PID),
  };
  drain.push(sample);
  console.log(
    `  +${sample.elapsedSec}s：${states}，切块 ${sample.canonChunks}，向量 ${sample.chunkEmbeddings}，` +
      `outbox ${sample.outbox}，worker RSS ${sample.workerRssMb ?? 'n/a'}MB`,
  );
  if (!/pending=|indexing=|ready=|failed=|not_configured=/.test(states)) {
    throw new Error(`本次作品没有 index_status 行（${states}）——导入时嵌入服务商未生效，不能读成"已排空"`);
  }
  const pendingish = /pending=|indexing=|not_configured=/.test(states);
  if (!pendingish) {
    finished = true;
    timedOut = false;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
const drainMs = drain.length > 0 ? drain[drain.length - 1].elapsedMs : 0;
console.log(
  finished
    ? `排空用时 ${Math.round(drainMs / 1000)}s（采样点 ${drain.length} 个）`
    : `${Math.round(drainMs / 1000)}s 后仍未排空（超时停止等待，按未排空记录）`,
);

const indexDetail = psql(`
  SELECT coalesce(string_agg(detail, ' | '), '(空)')
  FROM (
    SELECT provider_name||'/'||model||' dim='||coalesce(dimensions::text,'null')||' chunks='||chunk_count AS detail
    FROM index_status i JOIN chapters c ON c.id = i.chapter_id
    WHERE c.work_id = '${workId}' AND i.status = 'ready'
    LIMIT 3
  ) t
`);
const chunkStats = psql(`
  SELECT 'chunks_per_chapter_avg='||coalesce(round(avg(n),2)::text,'null')||' max='||coalesce(max(n)::text,'0')||' min='||coalesce(min(n)::text,'0')
  FROM (SELECT ch.chapter_id, count(*)::int AS n FROM canon_chunks ch JOIN chapters c ON c.id = ch.chapter_id
        WHERE c.work_id = '${workId}' GROUP BY 1) t
`);
const embeddingCoverage = psql(`
  SELECT 'vector_chunks='||count(ce.chunk_id)::text||' of canon_chunks='||count(ch.id)::text
  FROM canon_chunks ch
  JOIN chapters c ON c.id = ch.chapter_id AND c.work_id = '${workId}'
  LEFT JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
`);
// model_calls.status 的实际取值是 'ok'/'failed'（另有预算阻断的 'blocked'），
// 写成 'completed' 会让一份成功索引 1000 章的报告自称"0 次成功调用"。
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
const queryCallsAfterDrain = callStats('embedding_query');
console.log(`索引期嵌入调用：${indexCalls}（此时检索调用 ${queryCallsAfterDrain}）`);

const QUERIES = [
  { q: '巷口的更夫敲了第二遍鼓', label: '原文片段' },
  { q: '铜钉 掌心 发烫', label: '关键词' },
  { q: '有人把呼吸压在门板后面', label: '近似改写' },
  { q: '量子色动力学的渐近自由', label: '域外对照' },
];

const retrieval = [];
for (const mode of ['lexical', 'auto']) {
  for (const item of QUERIES) {
    const times = [];
    let last = null;
    for (let index = 0; index < REPEATS; index += 1) {
      const result = await request(
        `/api/search?q=${encodeURIComponent(item.q)}&workId=${workId}&mode=${mode}&limit=8`,
      );
      times.push(result.elapsedMs);
      last = result.json;
    }
    retrieval.push({
      mode,
      label: item.label,
      queryChars: item.q.length,
      medianMs: median(times),
      samples: times,
      results: last?.results?.length ?? null,
      topChapterNumber: last?.results?.[0]?.chapterNumber ?? null,
      topLexicalScore: last?.results?.[0]?.lexicalScore ?? null,
      topVectorScore: last?.results?.[0]?.vectorScore ?? null,
      topRrfScore: last?.results?.[0]?.rrfScore ?? null,
      modeUsed: last?.mode ?? null,
      semanticReason: last?.semanticReason ?? null,
      coverage: last?.coverage
        ? {
            totalCanonChapters: last.coverage.totalCanonChapters ?? null,
            ready: last.coverage.ready ?? null,
            chunks: last.coverage.chunks ?? null,
            vectorChunks: last.coverage.vectorChunks ?? null,
            vectorModel: last.coverage.vectorModel ?? null,
          }
        : null,
      responseBytes: last ? JSON.stringify(last).length : 0,
    });
    const row = retrieval.at(-1);
    console.log(
      `  检索 ${mode} / ${item.label}：中位 ${row.medianMs}ms，命中 ${row.results ?? 0} 条，` +
        `首位第 ${row.topChapterNumber ?? '-'} 章，mode=${row.modeUsed}` +
        `${row.semanticReason ? `（${row.semanticReason}）` : ''}`,
    );
  }
}

// 检索本身也会打嵌入服务（查询向量），必须在报告里和索引调用分开记账。
const queryCallsAfterRetrieval = callStats('embedding_query');
const totalCalls = psql(`SELECT 'n='||count(*)::text FROM model_calls WHERE provider_id = '${providerId}'`);
console.log(`检索后查询向量调用：${queryCallsAfterRetrieval}；本服务商合计 ${totalCalls}`);

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  database: DB_NAME,
  runId: RUN_ID,
  runLabel: RUN_LABEL,
  scenario:
    process.env.PERF_SCENARIO ??
    `千章规模索引与检索：导入 ${CHAPTERS} 章 × ${CHARS_PER_CHAPTER} 字，真实 worker 排空 outbox，再用本机嵌入服务做词法与混合检索`,
  workTitle: WORK_TITLE,
  cleanupWindowStart: runStart,
  config: {
    chapterTarget: CHAPTERS,
    charsPerChapter: CHARS_PER_CHAPTER,
    importBatchSize: BATCH,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    embedBaseUrl: EMBED_BASE_URL,
    embedModel: EMBED_MODEL,
    repeatsPerQuery: REPEATS,
    automationRunner: '关闭（AUTOMATION_RUNNER=0，独立实例指向 yunshuo_test）',
  },
  caveats: [
    '合成正文：同一组 8 句 filler 循环拼接，切块边界与真实小说不同，检索命中也不具备语义难度。',
    '单台机器上的单个 worker，POLL_MS 之间的采样是瞬时值而不是持续吞吐。',
    '嵌入服务为本机模型，输入价填 0，成本数字不代表任何付费服务商。',
    '本轮没有并发读写混合，也没有 Studio 容器内测量。',
  ],
  baselineCounts: baseline,
  embedServiceProbe: { reachable: true, modelSeenInList: modelSeen },
  import: {
    batches: importBatches,
    totalChapters: chapterTotal,
    totalImportMs: importBatches.reduce((total, item) => total + item.importMs, 0),
  },
  queueStart,
  drain: {
    fullyDrained: finished,
    timedOut,
    elapsedMs: drainMs,
    chaptersPerMinute:
      finished && drainMs > 0 ? Math.round((chapterTotal / (drainMs / 60000)) * 10) / 10 : null,
    samples: drain,
  },
  indexDetail,
  chunkStats,
  embeddingCoverage,
  calls: {
    indexPhase: indexCalls,
    queryPhase: queryCallsAfterRetrieval,
    queryPhaseAtDrainEnd: queryCallsAfterDrain,
    providerTotal: totalCalls,
    note: 'indexPhase 在检索开始前取样，queryPhase 含每次混合检索的查询向量调用；两者按 purpose 分开记账。',
  },
  retrieval,
  countsAfterRun: countQuery(),
};

if (!process.argv.includes('--keep')) {
  console.log('\n清理索引压测数据…');
  const callRows = psql(`SELECT count(*) FROM model_calls WHERE provider_id = '${providerId}'`);
  report.cleanupNote = `临时服务商的 model_calls 共 ${callRows} 条（报告 calls.providerTotal = ${totalCalls}，两者应一致），与服务商行一并按 id 删除；真实用量与耗时已先写入本报告 calls。`;
  psql(`
    BEGIN;
    DELETE FROM outbox WHERE payload ? 'chapterId'
      AND (payload->>'chapterId')::uuid IN (SELECT id FROM chapters WHERE work_id = '${workId}');
    DELETE FROM events WHERE aggregate_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR aggregate_id = '${workId}';
    DELETE FROM audit_log WHERE object_id IN (SELECT id FROM chapters WHERE work_id = '${workId}')
      OR object_id = '${workId}';
    DELETE FROM audit_log WHERE action = 'auth.login' AND created_at >= '${runStart}';
    DELETE FROM sessions WHERE user_id = '${runUserId}' AND created_at >= '${runStart}';
    DELETE FROM audit_log WHERE object_id = '${providerId}';
    DELETE FROM model_calls WHERE provider_id = '${providerId}';
    DELETE FROM chunk_embeddings WHERE provider_id = '${providerId}';
    DELETE FROM works WHERE id = '${workId}';
    DELETE FROM model_providers WHERE id = '${providerId}';
    COMMIT;
  `);
  const after = countQuery();
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
console.log(`\n报告已写入 ${REPORT_PATH}`);
console.log('说明：真实 worker、真实本机嵌入调用；这是索引管线的规模排空基线，不是生产 SLA。');
