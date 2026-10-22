const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const EMAIL = process.env.SMOKE_EMAIL ?? 'author@demo.local';
const CHAPTER_NUMBER = Number(process.env.SMOKE_CHAPTER ?? '2');

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
  if (setCookie.length > 0) {
    cookie = setCookie[0].split(';')[0];
  }
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}\n${text}`);
  }
  return json;
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const draftContent = `旧城的雨没有停。林默蹲在门洞里，把最后一张封印符压在门框上，木刺扎进指腹，血珠沿着符纸的边缘渗开。他必须在追兵赶到之前补齐缺掉的那一枚铜钉，否则整条街都会变成祭坛。

石阶下传来脚步声，不急不缓，每一步都踩在水里。林默没有回头。他把铜钉咬在齿间，腾出手去摸怀里的第二道符。封口只剩半寸，门后的东西已经开始撞门，一下，又一下，木屑从门缝里落下来。

“还差一枚。”

他听见自己说。声音很轻，却被门后的撞击盖了过去。身后的脚步停在巷口，来人没有提灯，只在雨里问了一句：“你确定要封的是门，不是你自己？”

林默终于回头。雨幕里站着的人，穿着七年前那场大火里烧焦的巡夜服。铜钉从他齿间滑落，滚进水沟。他的手按在门框上，封印阵的最后一笔还没有落下。门后的撞击忽然停了。

巷口的人抬起手，指间夹着那枚本该在他怀里的铜钉。

“现在，”那人说，“你打算拿什么封？”`;

console.log('[1/8] 登录', EMAIL);
const me = await request('/api/auth/login', { method: 'POST', body: { email: EMAIL } });
console.log('     ', me.user.name, me.role, me.workspace.name);

const chapters = await request('/api/chapters');
const chapter = chapters.find((item) => item.number === CHAPTER_NUMBER);
assert(chapter, `找不到第 ${CHAPTER_NUMBER} 章`);
if (chapter.status === 'canon') {
  throw new Error(`第 ${chapter.number} 章已是正典，请先 pnpm db:reset 再跑冒烟`);
}
console.log('[2/8] 目标章节', chapter.title, chapter.status);

const lease = await request(`/api/chapters/${chapter.id}/lease`, { method: 'POST' });
console.log('[3/8] 取得租约，到期', lease.lease.expiresAt);

const saved = await request(`/api/chapters/${chapter.id}/draft`, {
  method: 'PUT',
  body: { content: draftContent },
});
assert(saved.draft.contentHash.length === 64, '草稿哈希应为 sha256');
console.log('[4/8] 草稿已落盘', `${saved.draft.wordCount} 字`, saved.chapterStatus);

const evaluation = await request(`/api/chapters/${chapter.id}/gates`, { method: 'POST' });
console.log('[5/8] 门禁', evaluation.status);
for (const gate of evaluation.results) {
  console.log(`      ${gate.label}: ${gate.status} — ${gate.message}`);
}
assert(evaluation.status === 'passed', '演示草稿应通过 dev-v0 五门禁');
assert(evaluation.ruleset.isProduction === false, 'dev-v0 必须标记为非生产规则');

const audits = await request(`/api/chapters/${chapter.id}/audits`);
console.log('[6/8] 审计', audits.audits.map((a) => `${a.label}=${a.status}`).join(' / '));

const staged = await request(`/api/chapters/${chapter.id}/stage`, {
  method: 'POST',
  body: {
    evaluationId: evaluation.id,
    expectedContentHash: saved.draft.contentHash,
  },
});
console.log('[7/8] 已暂存', staged.stagedDraft.id, staged.chapterStatus);

const idempotencyKey = `smoke-${Date.now()}`;
const committed = await request(`/api/chapters/${chapter.id}/commit`, {
  method: 'POST',
  body: {
    idempotencyKey,
    targetChapterId: chapter.id,
    expectedCurrentVersionId: null,
    stagedDraftId: staged.stagedDraft.id,
  },
});
console.log('[8/8] 已提交正典', `v${committed.versionNo}`, committed.versionId);
assert(committed.status === 'canon', '提交后状态应为 canon');
assert(committed.alreadyCommitted === false, '首次提交不应是幂等重放');

const replay = await request(`/api/chapters/${chapter.id}/commit`, {
  method: 'POST',
  body: {
    idempotencyKey,
    targetChapterId: chapter.id,
    expectedCurrentVersionId: null,
    stagedDraftId: staged.stagedDraft.id,
  },
});
assert(replay.alreadyCommitted === true, '相同幂等键应返回已提交结果');
assert(replay.versionId === committed.versionId, '幂等重放必须指向同一版本');

const detail = await request(`/api/chapters/${chapter.id}`);
assert(detail.status === 'canon', '章节状态应为 canon');
assert(detail.currentVersion?.versionNo === committed.versionNo, '当前正典指针应指向新版本');
assert(detail.currentVersion?.gateStatus === 'passed', '版本应绑定通过的门禁证据');
assert(detail.stagedDraft === null, '已提交后不再展示暂存草稿');

const version = await request(`/api/versions/${committed.versionId}`);
assert(version.content === draftContent, '正典正文应与草稿一致');
assert(version.evaluation?.status === 'passed', '版本详情应带门禁证据');

console.log('\n冒烟通过：租约 → 草稿 → 五门禁 → 审计 → 暂存 → 提交 → 幂等重放 → 版本证据');
console.log('索引状态（worker 异步更新）：', committed.indexStatus.status);
