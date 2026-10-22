const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@demo.local';
const QUERY = process.env.M4_QUERY ?? '封印 追兵';
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 10 * 60_000;

let cookie = '';
let passed = 0;
let failed = 0;

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

function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatStatus(detail) {
  const status = detail.indexStatus;
  if (!status) return '无索引状态';
  return `${status.status}${status.lastError ? `：${status.lastError}` : ''}`;
}

async function loadDetails(chapters) {
  return Promise.all(chapters.map((chapter) => request(`/api/chapters/${chapter.id}`)));
}

async function waitForSettled(chapters) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const details = await loadDetails(chapters);
    if (details.every((detail) => !['pending', 'indexing'].includes(detail.indexStatus?.status))) {
      return details;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('等待现有索引任务结束超时');
}

async function waitForReady(chapters) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const details = await loadDetails(chapters);
    const broken = details.find(
      (detail) =>
        detail.indexStatus?.status === 'failed' ||
        detail.indexStatus?.status === 'not_configured',
    );
    if (broken) {
      throw new Error(
        `第 ${broken.number} 章索引未就绪（${formatStatus(broken)}），请查看 worker 日志与服务商配置`,
      );
    }
    if (details.every((detail) => detail.indexStatus?.status === 'ready')) return details;
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write('.');
  }
  throw new Error('等待索引 ready 超时');
}

async function search(query) {
  return request(`/api/search?q=${encodeURIComponent(query)}&limit=8`);
}

console.log(`M4-A 真实嵌入验收 @ ${BASE}`);
console.log(`账号：${EMAIL}`);

const me = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
if (me.role !== 'owner') {
  throw new Error(`验收需要所有者账号（当前角色 ${me.role}），否则无法重建全工作区索引`);
}
console.log(`工作区：${me.workspace.name}，角色：${me.role}`);

const providerList = await request('/api/model-providers');
const embeddingProviders = providerList.providers.filter(
  (provider) => provider.purpose === 'embedding',
);
const enabledEmbedding = embeddingProviders.filter((provider) => provider.isEnabled);
if (enabledEmbedding.length === 0) {
  throw new Error(
    '没有启用的嵌入服务商：请先在服务商设置中配置用途=embedding 的在线服务并保存密钥，再重新验收',
  );
}
const primary = enabledEmbedding[0];
console.log(
  `嵌入服务：${primary.name} · ${primary.model} · ${primary.baseUrl}${primary.hasKey ? '' : '（未保存密钥）'}`,
);

console.log('\n[1/6] 探测嵌入服务');
const probe = await request('/api/model-providers/probe-embedding', {
  method: 'POST',
  body: { providerId: primary.id, baseUrl: primary.baseUrl, model: primary.model },
});
check(probe.supported === true, `探测返回支持（${probe.message}）`);
check(Number(probe.dimensions) > 0, `探测维度为 ${probe.dimensions}`);
if (probe.supported !== true) {
  throw new Error(`真实嵌入探测失败：${probe.message}`);
}

console.log('\n[2/6] 读取正典章节');
const canonChapters = (await request('/api/chapters')).filter(
  (chapter) => chapter.status === 'canon',
);
check(canonChapters.length > 0, `发现 ${canonChapters.length} 个正典章节`);
await waitForSettled(canonChapters);

console.log('\n[3/6] 重建全工作区索引');
const reindex = await request('/api/index/reindex', { method: 'POST', body: {} });
check(
  reindex.queued === canonChapters.length,
  `排队 ${reindex.queued}/${canonChapters.length} 章（alreadyQueued=${reindex.alreadyQueued}）`,
);
check(reindex.alreadyQueued === 0, '重建前没有遗留的活跃索引任务');

const readyDetails = await waitForReady(canonChapters);
console.log('');
for (const detail of readyDetails) {
  const status = detail.indexStatus;
  check(
    status.chunkCount > 0 &&
      Number(status.dimensions) > 0 &&
      Boolean(status.providerName) &&
      Boolean(status.model),
    `第 ${detail.number} 章 ready：${status.chunkCount} 片段 · ${status.model} · ${status.dimensions} 维`,
  );
  check(
    status.versionId === detail.currentVersion.id,
    `第 ${detail.number} 章索引绑定当前正典 v${detail.currentVersion.versionNo}`,
  );
}

const detailById = new Map(readyDetails.map((detail) => [detail.id, detail]));

console.log('\n[4/6] 验证重复重建去重');
const target = canonChapters[0];
const firstQueue = await request(`/api/chapters/${target.id}/reindex`, { method: 'POST' });
check(
  firstQueue.queued === 1 && firstQueue.alreadyQueued === 0,
  `首次重建排队成功（queued=${firstQueue.queued}）`,
);
const secondQueue = await request(`/api/chapters/${target.id}/reindex`, { method: 'POST' });
check(
  secondQueue.queued === 0 && secondQueue.alreadyQueued === 1,
  `重复重建未新增任务（alreadyQueued=${secondQueue.alreadyQueued}）`,
);
await waitForReady(canonChapters);

console.log('\n[5/6] 验证真实混合检索');
const hybrid = await search(QUERY);
check(hybrid.mode === 'hybrid', `检索模式为 hybrid（${hybrid.mode}）`);
check(hybrid.semanticReason === null, '混合检索没有降级原因');
check(hybrid.results.length > 0, `命中 ${hybrid.results.length} 条`);
check(
  hybrid.results.some((result) => result.vectorRank !== null),
  '至少一条结果来自向量通道',
);
check(
  hybrid.coverage.ready === canonChapters.length,
  `覆盖 ready=${hybrid.coverage.ready}/${canonChapters.length}`,
);
check(hybrid.coverage.vectorChunks > 0, `向量片段 ${hybrid.coverage.vectorChunks} 条`);
check(Boolean(hybrid.coverage.vectorModel), `索引模型 ${hybrid.coverage.vectorModel}`);

let versionMismatch = 0;
for (const result of hybrid.results) {
  const detail = detailById.get(result.chapterId);
  if (!detail || detail.currentVersion.id !== result.versionId) versionMismatch += 1;
}
check(versionMismatch === 0, '所有命中都绑定当前正典版本，没有旧版本泄漏');

console.log('\n[6/6] 验证停用嵌入后诚实降级');
const toggled = [...enabledEmbedding];
try {
  for (const provider of toggled) {
    await request(`/api/model-providers/${provider.id}`, {
      method: 'PATCH',
      body: { isEnabled: false },
    });
  }
  const lexical = await search(QUERY);
  check(lexical.mode === 'lexical', `停用后模式为 lexical（${lexical.mode}）`);
  check(
    typeof lexical.semanticReason === 'string' && lexical.semanticReason.length > 0,
    `降级原因明确：${lexical.semanticReason}`,
  );
  check(lexical.results.length > 0, '词法检索仍有结果');
  check(
    lexical.results.every((result) => result.vectorRank === null),
    '降级后没有向量排名',
  );
} finally {
  for (const provider of toggled) {
    await request(`/api/model-providers/${provider.id}`, {
      method: 'PATCH',
      body: { isEnabled: true },
    }).catch((error) => console.error(`恢复服务商失败：${provider.name}：${error.message}`));
  }
}

const restored = await search(QUERY);
check(restored.mode === 'hybrid', '恢复服务商后重新使用混合检索');

console.log(`\n验收完成：通过 ${passed} 项，失败 ${failed} 项`);
console.log('真实服务商已保留并重新启用，没有删除或替换模型。');
if (failed > 0) process.exitCode = 1;
