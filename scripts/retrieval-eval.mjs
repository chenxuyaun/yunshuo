import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@demo.local';
const MODES = (process.env.EVAL_MODES ?? 'lexical,auto')
  .split(',')
  .map((mode) => mode.trim())
  .filter((mode) => mode === 'lexical' || mode === 'auto');
const queryFile = fileURLToPath(new URL('./retrieval-eval-queries.json', import.meta.url));
const outputFile = fileURLToPath(new URL('../docs/m4-retrieval-eval.json', import.meta.url));

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

function ratio(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function metric(ranks, k) {
  return ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
}

function meanReciprocalRank(ranks) {
  return ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length;
}

const dataset = JSON.parse(await readFile(queryFile, 'utf8'));
const k = dataset.k ?? 8;
const positives = dataset.queries.filter((item) => item.expectChapter !== null);
const negatives = dataset.queries.filter((item) => item.expectChapter === null);

console.log(`检索评估 @ ${BASE}，k=${k}，模式=${MODES.join('/')}，账号=${EMAIL}`);
const me = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
console.log(`工作区：${me.workspace.name}`);

const chapters = await request('/api/chapters');
const chapterByNumber = new Map(
  chapters
    .filter((chapter) => chapter.status === 'canon' && chapter.currentVersionNo !== null)
    .map((chapter) => [chapter.number, chapter]),
);
for (const item of positives) {
  if (!chapterByNumber.has(item.expectChapter)) {
    throw new Error(`查询集期望第 ${item.expectChapter} 章，但当前工作区没有该正典章节`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  workspace: me.workspace.name,
  dataset: {
    description: dataset.description,
    k,
    positiveQueries: positives.length,
    negativeQueries: negatives.length,
  },
  modes: {},
};

for (const mode of MODES) {
  const rows = [];
  let actualHybrid = 0;
  let actualLexical = 0;

  for (const item of dataset.queries) {
    const response = await request(
      `/api/search?q=${encodeURIComponent(item.q)}&limit=${k}&mode=${mode}`,
    );
    if (response.mode === 'hybrid') actualHybrid += 1;
    else actualLexical += 1;

    const expected = item.expectChapter === null ? null : chapterByNumber.get(item.expectChapter);
    let rank = null;
    if (expected) {
      const index = response.results.findIndex((result) => result.chapterId === expected.id);
      if (index >= 0) rank = index + 1;
    }
    const top = response.results[0] ?? null;
    rows.push({
      query: item.q,
      expectChapter: item.expectChapter,
      note: item.note,
      rank,
      mode: response.mode,
      semanticReason: response.semanticReason,
      topChapter: top?.chapterNumber ?? null,
      topTitle: top?.chapterTitle ?? null,
      topExcerpt: top?.excerpt ?? null,
    });
  }

  const positiveRows = rows.filter((row) => row.expectChapter !== null);
  const ranks = positiveRows.map((row) => row.rank);
  const metrics = {
    hitAt1: metric(ranks, 1),
    hitAt3: metric(ranks, 3),
    hitAtK: metric(ranks, k),
    mrr: meanReciprocalRank(ranks),
  };
  const negativeRows = rows.filter((row) => row.expectChapter === null);
  const negativeTopHits = negativeRows.filter((row) => row.topChapter !== null).length;
  const coverageRow = await request(`/api/search?q=${encodeURIComponent(positives[0].q)}&limit=1&mode=${mode}`);
  report.modes[mode] = {
    actualHybrid,
    actualLexical,
    metrics,
    negativeTopHits,
    negativeQueries: negativeRows.length,
    coverage: coverageRow.coverage,
    queries: rows,
  };

  console.log(`\n=== ${mode} ===`);
  console.log(
    `实际 hybrid ${actualHybrid} 条 / lexical ${actualLexical} 条；` +
      `coverage ready=${coverageRow.coverage.ready}/${coverageRow.coverage.totalCanonChapters}，` +
      `vectorChunks=${coverageRow.coverage.vectorChunks}，vectorModel=${coverageRow.coverage.vectorModel ?? '无'}`,
  );
  console.log('查询'.padEnd(22), '期望', '排名', '实际模式');
  for (const row of rows) {
    const rankLabel = row.expectChapter === null ? '对照' : row.rank === null ? '未命中' : String(row.rank);
    console.log(
      row.query.padEnd(22),
      String(row.expectChapter ?? '-').padEnd(4),
      rankLabel.padEnd(4),
      row.mode,
    );
  }
  console.log(
    `hit@1=${ratio(metrics.hitAt1)}  hit@3=${ratio(metrics.hitAt3)}  ` +
      `hit@${k}=${ratio(metrics.hitAtK)}  MRR=${metrics.mrr.toFixed(3)}`,
  );

  const negativesResult = rows.filter((row) => row.expectChapter === null);
  for (const row of negativesResult) {
    console.log(`对照查询「${row.query}」首条：第${row.topChapter ?? '无'}章 ${row.topTitle ?? ''}`);
  }
  console.log(`无答案对照返回章节：${negativeTopHits}/${negativeRows.length}`);
}

const anyReady = Object.values(report.modes).some((mode) => mode.coverage.ready > 0);
if (!anyReady) {
  report.warning =
    '当前工作区没有 ready 索引（coverage.ready=0）；hit@k/MRR 均为 0 只说明没有可检索内容，不能用于比较检索质量。';
  console.warn(`\n警告：${report.warning}`);
}
report.vectorMinScore = Number(process.env.SEARCH_VECTOR_MIN_SCORE ?? '0.4');
report.caveats = [
  '查询集为 11 条关键词正例 + 8 条无答案对照（2 条域外 + 6 条近域/混合），正例查询词与原文高度重合，天然偏向词法通道；不能据此断言混合检索更好或更差。',
  `向量通道按 SEARCH_VECTOR_MIN_SCORE=${report.vectorMinScore} 过滤低分邻居，并在最高分低于阈值时整通道降级；该阈值来自本机 bge-m3 与最初的 13 条查询，样本不足以证明它是最优值，换模型或换语料需重测。`,
  '负例包含 2 条域外查询与 6 条近域/混合查询；0.4 只让两条域外对照降级，近域/混合负例仍会返回章节。阈值在加入这些硬负例之前已经确定，本轮没有按硬负例结果调参；相似度下限不是“无答案分类器”。',
  'demo 仅 4 章约 3664 字、9 个片段，样本不足以调参，也不能代表真实检索质量。',
  'lexical 模式强制不调用嵌入服务，仅用于同数据集对照，不是线上默认行为。',
];
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n报告已写入 ${outputFile}`);
console.log(
  '说明：demo 仅 4 章、约 3664 字，查询集为自拟回归样本；' +
    '本报告只能证明检索管线、版本隔离与词法/混合相对差异，不能代表真实检索质量。',
);
