import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@demo.local';
const MODES = (process.env.EVAL_MODES ?? 'lexical,auto')
  .split(',')
  .map((mode) => mode.trim())
  .filter((mode) => mode === 'lexical' || mode === 'auto');
const KEEP = process.argv.includes('--keep');
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'yunshuo-db';
const DB_USER = process.env.DB_USER ?? 'yunshuo';
const DB_NAME = process.env.DB_NAME ?? 'yunshuo';
const INDEX_TIMEOUT_MS = Number(process.env.EVAL_INDEX_TIMEOUT_MS ?? '180000');

const datasetFile = fileURLToPath(new URL('./ledger-eval-dataset.json', import.meta.url));
const outputFile = fileURLToPath(new URL('../docs/m6-ledger-retrieval-eval.json', import.meta.url));

let cookie = '';

async function request(path, { method = 'GET', body } = {}) {
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
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}\n${text}`);
  }
  return json;
}

function psql(sqlText) {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-Atc', sqlText],
    { encoding: 'utf8' },
  ).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ratio(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function metric(ranks, k) {
  return ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
}

function meanReciprocalRank(ranks) {
  return ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length;
}

const dataset = JSON.parse(await readFile(datasetFile, 'utf8'));
const k = Math.min(20, dataset.k ?? 8);
const prefix = dataset.namePrefix ?? '评估·';
if (!/^[^'%_]{1,40}$/.test(prefix)) {
  throw new Error(`条目名前缀不适合用于清理匹配：${prefix}`);
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const positives = dataset.queries.filter((item) => item.expectEntry !== null);
const negatives = dataset.queries.filter((item) => item.expectEntry === null);
const expectedNames = new Set(dataset.entries.map((item) => item.name));
for (const item of positives) {
  if (!expectedNames.has(item.expectEntry)) {
    throw new Error(`查询「${item.q}」的标准答案 ${item.expectEntry} 不在条目集里`);
  }
}

console.log(`账本检索评估 @ ${BASE}，k=${k}，模式=${MODES.join('/')}，账号=${EMAIL}`);
const me = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
const workspaceId = me.workspace.id;
if (!uuidPattern.test(workspaceId)) throw new Error(`工作区标识异常：${workspaceId}`);
console.log(`工作区：${me.workspace.name}`);

const chapters = await request('/api/chapters');
const canonByNumber = new Map(
  chapters
    .filter((chapter) => chapter.status === 'canon' && chapter.currentVersionNo !== null)
    .map((chapter) => [chapter.number, chapter]),
);
if (canonByNumber.size === 0) {
  throw new Error('当前工作区没有已提交正典章节，评估集无法绑定来源章节');
}
const workId = canonByNumber.values().next().value.workId;
const chapterIdOf = (number) => {
  const chapter = canonByNumber.get(number);
  if (!chapter) throw new Error(`评估集需要第 ${number} 章的正典，但当前工作区没有`);
  return chapter.id;
};

function buildEntryBody(spec) {
  const base = {
    kind: spec.kind,
    name: spec.name,
    aliases: spec.aliases ?? [],
    summary: spec.summary ?? '',
    sourceChapterId: spec.sourceChapter === null ? null : chapterIdOf(spec.sourceChapter),
  };
  if (spec.kind === 'setting') {
    return {
      ...base,
      workId: spec.workScoped ? workId : null,
      payload: {
        category: spec.payload.category,
        details: spec.payload.details ?? '',
        tags: spec.payload.tags ?? [],
        verification: spec.payload.verification ?? 'unverified',
      },
    };
  }
  if (spec.kind === 'character') {
    return {
      ...base,
      workId,
      payload: {
        ...spec.payload,
        states: (spec.payload.states ?? []).map((state) => ({
          asOfChapterId: chapterIdOf(state.asOfChapter),
          life: state.life ?? 'unknown',
          location: state.location ?? '',
          knowledge: state.knowledge ?? '',
          possessions: state.possessions ?? '',
          relationshipChanges: state.relationshipChanges ?? '',
        })),
      },
    };
  }
  return {
    ...base,
    workId,
    payload: {
      seedChapterId: chapterIdOf(spec.payload.seedChapter),
      payoffChapterMin: spec.payload.payoffChapterMin ?? null,
      payoffChapterMax: spec.payload.payoffChapterMax ?? null,
      importance: spec.payload.importance ?? 'medium',
      state: spec.payload.state ?? 'planted',
      payoffChapterId: null,
      note: spec.payload.note ?? '',
      resolutionNote: '',
    },
  };
}

const listed = await request('/api/ledger/entries?limit=200');
const existingByName = new Map(listed.entries.map((entry) => [entry.name, entry]));
const seeded = [];
const skipped = [];
const targetIds = [];
for (const spec of dataset.entries) {
  if (existingByName.has(spec.name)) {
    skipped.push(spec.name);
    targetIds.push(existingByName.get(spec.name).id);
    console.log(`已存在，跳过播种：${spec.name}`);
    continue;
  }
  const detail = await request('/api/ledger/entries', { method: 'POST', body: buildEntryBody(spec) });
  await request(`/api/ledger/entries/${detail.id}/publish`, {
    method: 'POST',
    body: { expectedDraftVersionId: detail.draftVersion.id, changeSummary: '账本检索评估集播种' },
  });
  seeded.push(spec.name);
  targetIds.push(detail.id);
  console.log(`播种并发布：${spec.name}`);
}
if (seeded.length > 0) {
  console.log(`本次新建 ${seeded.length} 条，沿用 ${skipped.length} 条`);
}
for (const id of targetIds) {
  if (!uuidPattern.test(id)) throw new Error(`条目标识异常，已取消：${id}`);
}
if (targetIds.length !== dataset.entries.length) {
  throw new Error(`条目播种数量与评估集不一致：${targetIds.length}/${dataset.entries.length}`);
}

async function ledgerCoverage() {
  const probe = positives[0].q;
  return (await request(`/api/search?q=${encodeURIComponent(probe)}&limit=1&mode=auto`))
    .ledgerCoverage;
}

console.log('等待 worker 建立账本索引…');
const indexDeadline = Date.now() + INDEX_TIMEOUT_MS;
let coverage = await ledgerCoverage();
let vectorReady = false;
while (Date.now() < indexDeadline) {
  coverage = await ledgerCoverage();
  const fullyProjected =
    coverage.activeEntries >= dataset.entries.length &&
    coverage.indexedEntries === coverage.activeEntries &&
    coverage.chunks > 0;
  vectorReady = fullyProjected && coverage.vectorChunks === coverage.chunks;
  if (vectorReady) break;
  await sleep(3000);
}
console.log(
  `账本覆盖度：生效 ${coverage.activeEntries} 条 / 已索引 ${coverage.indexedEntries} 条，` +
    `片段 ${coverage.chunks}，向量片段 ${coverage.vectorChunks}，模型 ${coverage.vectorModel ?? '无'}`,
);
if (coverage.indexedEntries !== coverage.activeEntries || coverage.chunks === 0) {
  throw new Error(
    `等待索引超时（${INDEX_TIMEOUT_MS / 1000}s）：${coverage.indexedEntries}/${coverage.activeEntries} 条已投影。` +
      '请确认 worker 正在运行、嵌入服务商已启用（用途=embedding），再复跑。',
  );
}
if (!vectorReady) {
  console.warn(
    '警告：仍有片段没有向量索引，本次只能比较词法通道；混合通道的结论不成立。',
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  workspace: { id: workspaceId, name: me.workspace.name },
  dataset: {
    description: dataset.description,
    source: dataset.source,
    k,
    entries: dataset.entries.length,
    newlySeeded: seeded.length,
    reused: skipped.length,
    positiveQueries: positives.length,
    negativeQueries: negatives.length,
  },
  ledgerCoverage: coverage,
  vectorIndexComplete: vectorReady,
  modes: {},
};

for (const mode of MODES) {
  const rows = [];
  let ledgerVectorQueries = 0;
  let modeCoverage = coverage;

  for (const item of dataset.queries) {
    const response = await request(
      `/api/search?q=${encodeURIComponent(item.q)}&limit=${k}&mode=${mode}`,
    );
    modeCoverage = response.ledgerCoverage ?? modeCoverage;
    const results = response.ledgerResults ?? [];
    const usedLedgerVector = results.some((result) => result.vectorRank !== null);
    if (usedLedgerVector) ledgerVectorQueries += 1;

    let rank = null;
    if (item.expectEntry !== null) {
      const index = results.findIndex((result) => result.name === item.expectEntry);
      if (index >= 0) rank = index + 1;
    }
    const top = results[0] ?? null;
    rows.push({
      query: item.q,
      type: item.type,
      expectEntry: item.expectEntry,
      note: item.note,
      rank,
      resultCount: results.length,
      usedLedgerVector: usedLedgerVector,
      topEntry: top?.name ?? null,
      topKind: top?.kind ?? null,
      topExcerpt: top?.excerpt ?? null,
      topLexicalRank: top?.lexicalRank ?? null,
      topVectorRank: top?.vectorRank ?? null,
      topVectorScore: top?.vectorScore ?? null,
      ledgerReason: response.ledgerReason,
    });
  }

  const positiveRows = rows.filter((row) => row.expectEntry !== null);
  const ranks = positiveRows.map((row) => row.rank);
  const metrics = {
    hitAt1: metric(ranks, 1),
    hitAt3: metric(ranks, 3),
    hitAtK: metric(ranks, k),
    mrr: meanReciprocalRank(ranks),
  };
  const negativeRows = rows.filter((row) => row.expectEntry === null);
  const negativeTopHits = negativeRows.filter((row) => row.topEntry !== null).length;
  report.modes[mode] = {
    ledgerVectorQueries,
    queryCount: rows.length,
    metrics,
    negativeTopHits,
    negativeQueries: negativeRows.length,
    coverage: modeCoverage,
    queries: rows,
  };

  console.log(`\n=== ${mode}（账本向量参与 ${ledgerVectorQueries}/${rows.length} 条）===`);
  console.log('查询'.padEnd(26), '类型', '期望', '排名', '首条');
  for (const row of rows) {
    const rankLabel =
      row.expectEntry === null ? '对照' : row.rank === null ? '未命中' : String(row.rank);
    console.log(
      row.query.padEnd(26),
      String(row.type).padEnd(6),
      String(row.expectEntry ?? '-').padEnd(20),
      rankLabel.padEnd(6),
      row.topEntry ?? '无',
    );
  }
  console.log(
    `hit@1=${ratio(metrics.hitAt1)}  hit@3=${ratio(metrics.hitAt3)}  ` +
      `hit@${k}=${ratio(metrics.hitAtK)}  MRR=${metrics.mrr.toFixed(3)}`,
  );
  console.log(`无答案对照仍返回条目：${negativeTopHits}/${negativeRows.length}`);
  for (const row of negativeRows.filter((item) => item.topEntry !== null)) {
    console.log(`  对照「${row.query}」首条：${row.topEntry}（${row.topKind}）`);
  }
  const misses = positiveRows.filter((row) => row.rank === null);
  if (misses.length > 0) {
    console.log(`正例完全未命中 ${misses.length} 条：${misses.map((row) => row.query).join('、')}`);
  }
}

report.caveats = [
  '条目与标准答案由本仓库演示正典人工标注，查询词与条目文本同源；正例天然偏向词法通道，不能据此断言混合检索更好或更差。',
  'k 与阈值 SEARCH_VECTOR_MIN_SCORE 沿用 M4 的取值，本轮没有按账本语料重调；向量通道是否参与逐条记录在 usedLedgerVector。',
  `语料只有 ${dataset.entries.length} 条账本条目与 ${dataset.queries.length} 条查询，样本量不足以标定，也不能代表生产语料上的检索质量。`,
  'lexical 模式强制不调用嵌入服务，只用于同数据集对照，不是线上默认行为。',
  '评估集条目不带人工章节关联，也不进入 AI 上下文与门禁提示；本报告只评价 /api/search 的账本通道。',
  '清理按本次播种与沿用的条目 id 精确删除（版本、别名投影、检索投影、索引状态、章节关联、建议、审计、事件与 outbox 级联或定点清除），不按名称模糊匹配；加 --keep 可把评估条目留在工作区里复跑。',
];

if (!KEEP) {
  console.log('\n清理本次播种的评估条目…');
  psql(`
    BEGIN;
    CREATE TEMP TABLE eval_targets ON COMMIT DROP AS
      SELECT id FROM ledger_entries
      WHERE workspace_id = '${workspaceId}'
        AND id IN (${targetIds.map((id) => `'${id}'`).join(', ')});
    DELETE FROM outbox
      WHERE payload ? 'entryId'
        AND (payload->>'entryId')::uuid IN (SELECT id FROM eval_targets);
    DELETE FROM events
      WHERE aggregate_id IN (SELECT id FROM eval_targets) AND event_type LIKE 'ledger%';
    DELETE FROM audit_log
      WHERE object_type = 'ledger_entry' AND object_id IN (SELECT id FROM eval_targets);
    DELETE FROM ledger_suggestions
      WHERE entry_id IN (SELECT id FROM eval_targets);
    DELETE FROM ledger_entries WHERE id IN (SELECT id FROM eval_targets);
    COMMIT;
  `);
  const residue = psql(`
    SELECT 'entries='||count(*) FROM ledger_entries WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'versions='||count(*) FROM ledger_entry_versions WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'aliases='||count(*) FROM ledger_entry_aliases WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'chunks='||count(*) FROM ledger_chunks WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'embeddings='||count(*) FROM ledger_chunk_embeddings lce JOIN ledger_chunks lch ON lch.id = lce.chunk_id WHERE lch.workspace_id = '${workspaceId}'
    UNION ALL SELECT 'index_status='||count(*) FROM ledger_index_status WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'links='||count(*) FROM chapter_ledger_links WHERE workspace_id = '${workspaceId}'
    UNION ALL SELECT 'outbox='||count(*) FROM outbox WHERE payload ? 'entryId'
  `);
  report.residueAfterCleanup = Object.fromEntries(
    residue.replace(/\r/g, '').split('\n').map((line) => {
      const [key, value] = line.split('=');
      return [key, Number(value)];
    }),
  );
  const after = await ledgerCoverage();
  report.ledgerCoverageAfterCleanup = after;
  console.log(residue);
  console.log(`清理后检索覆盖度：生效 ${after.activeEntries} 条 / 已索引 ${after.indexedEntries} 条`);
} else {
  console.log('\n已指定 --keep：评估条目保留在工作区里，复跑时会直接沿用。');
}

await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n报告已写入 ${outputFile}`);
console.log(
  '说明：本报告只能证明账本投影、词法/向量通道与降级原因的真实行为，' +
    '查询集为自拟回归样本，不代表生产检索质量。',
);
