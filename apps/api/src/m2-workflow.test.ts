import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  AbandonRevisionResponse,
  AuditReport,
  ChapterDetail,
  CommitResponse,
  GateEvaluationView,
  MeResponse,
  RollbackResponse,
  SaveDraftResponse,
  StageResponse,
  StartRevisionResponse,
  VersionSummary,
  WaiverView,
} from '@yunshuo/contracts';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { countWords, sha256, type ChapterPlan } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TITLE = 'M2 测试章节';
const TEST_NUMBER = 9901;

const plan: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

const importedContent = `旧城的雨下了七天。林默把最后一张封印符按进门框，指尖被木刺划出一道血线。他必须在追兵赶到之前完成封印，否则整条街都会变成祭坛。

门外传来脚步声。林默没有回头，只把最后一枚铜钉咬在齿间。

“还差一枚。”他低声说。`;

const contentA = `旧城的雨没有停。林默把最后一张封印符按进门框，指尖的血线已经凝住。他听见巷口传来追兵的马蹄声，知道封印必须在下一声更鼓之前完成。

他把铜钉一枚枚钉进门槛，嘴里默数。门后是整条街的灯火，也是他不能退让的理由。追兵撞开第一道木栅时，封印只差最后一角。林默没有回头，他咬破指尖，把血按在符心。

雨声忽然静了一瞬。门楣上的旧漆裂开，一道暗金色的纹路顺着门框爬满整条街。追兵停在巷口，像被一堵看不见的墙挡住。林默扶住门框，终于听见更鼓响起。

更鼓过后，街角的雨水倒流回檐下。林默低头看见自己的影子被门框上的金光拉得很长。他知道追兵不会就此放弃，下一次来的，或许不只是人。

雨又落下来，落在封印之上。他完成了封印，也知道这只是开始？`;

const contentB = `${contentA}

更鼓声里，林默把最后一枚铜钉收入袖中。追兵退去，封印仍在，他知道明天的雨会更冷，也知道封印还能撑多久？`;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface ApiResult<T> {
  status: number;
  body: T;
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('M2 集成测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

suite('M2 修订 / 回滚 / 豁免', () => {
  let app: FastifyInstance;
  let owner: Session;
  let author: Session;
  let lead: Session;

  let chapterId: string;
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;
  let waiverId: string;

  async function call<T>(
    cookie: string,
    method: Method,
    url: string,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      headers: { cookie },
      payload,
    });
    return {
      status: response.statusCode,
      body: response.json() as T,
    };
  }

  function expectError(result: ApiResult<unknown>, status: number, code: string): void {
    expect(result.status).toBe(status);
    expect((result.body as ErrorBody).error.code).toBe(code);
  }

  async function login(email: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error(`登录 ${email} 未返回会话 Cookie`);
    return {
      cookie: raw.split(';')[0]!,
      me: response.json() as MeResponse,
    };
  }

  async function cleanupChapter(id: string): Promise<void> {
    await sql`DELETE FROM commits WHERE chapter_id = ${id}`;
    await sql`DELETE FROM commit_intents WHERE chapter_id = ${id}`;
    await sql`UPDATE canon_versions SET waiver_id = NULL WHERE chapter_id = ${id}`;
    await sql`DELETE FROM waivers WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_current WHERE chapter_id = ${id}`;
    await sql`UPDATE chapters SET current_version_id = NULL WHERE id = ${id}`;
    await sql`DELETE FROM index_status WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_metadata WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_versions WHERE chapter_id = ${id}`;
    await sql`DELETE FROM events WHERE aggregate_type = 'chapter' AND aggregate_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE object_id = ${id} OR metadata->>'chapterId' = ${id}`;
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${id}`;
    await sql`DELETE FROM chapters WHERE id = ${id}`;
  }

  async function getChapter(cookie: string): Promise<ChapterDetail> {
    const result = await call<ChapterDetail>(
      cookie,
      'GET',
      `/api/chapters/${chapterId}`,
    );
    expect(result.status).toBe(200);
    return result.body;
  }

  async function prepareStagedDraft(content: string): Promise<string> {
    const revision = await call<StartRevisionResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision`,
    );
    expect(revision.status).toBe(200);

    const saved = await call<SaveDraftResponse>(
      owner.cookie,
      'PUT',
      `/api/chapters/${chapterId}/draft`,
      { content },
    );
    expect(saved.status).toBe(200);

    const evaluation = await call<GateEvaluationView>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/gates`,
    );
    expect(evaluation.status).toBe(200);
    expect(evaluation.body.status).toBe('passed');

    const staged = await call<StageResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/stage`,
      {
        evaluationId: evaluation.body.id,
        expectedContentHash: saved.body.draft.contentHash,
      },
    );
    expect(staged.status).toBe(200);
    return staged.body.stagedDraft.id;
  }

  async function addRevisionAndCommit(
    content: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ): Promise<{ commit: CommitResponse; payload: object }> {
    const stagedDraftId = await prepareStagedDraft(content);
    const payload = {
      idempotencyKey,
      targetChapterId: chapterId,
      expectedCurrentVersionId,
      stagedDraftId,
    };
    const commit = await call<CommitResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/commit`,
      payload,
    );
    expect(commit.status).toBe(200);
    expect(commit.body.alreadyCommitted).toBe(false);
    return { commit: commit.body, payload };
  }

  async function rollback(input: {
    cookie: string;
    idempotencyKey: string;
    targetVersionId: string;
    expectedCurrentVersionId: string;
    reason: string;
    waiverId?: string;
  }): Promise<ApiResult<RollbackResponse>> {
    return call<RollbackResponse>(
      input.cookie,
      'POST',
      `/api/chapters/${chapterId}/rollback`,
      {
        idempotencyKey: input.idempotencyKey,
        targetVersionId: input.targetVersionId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        reason: input.reason,
        ...(input.waiverId ? { waiverId: input.waiverId } : {}),
      },
    );
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    const { buildServer } = await import('./server.js');
    app = await buildServer();

    owner = await login('owner@demo.local');
    author = await login('author@demo.local');
    lead = await login('lead@demo.local');

    const stale = await sql<{ id: string }[]>`
      SELECT id FROM chapters WHERE title = ${TEST_TITLE}
    `;
    for (const row of stale) {
      await cleanupChapter(row.id);
    }

    const locationRows = await sql<{ work_id: string; volume_id: string }[]>`
      SELECT wo.id AS work_id, v.id AS volume_id
      FROM works wo
      JOIN volumes v ON v.work_id = wo.id
      JOIN workspaces ws ON ws.id = wo.workspace_id
      JOIN memberships m ON m.workspace_id = ws.id
      JOIN users u ON u.id = m.user_id
      WHERE u.email = 'owner@demo.local'
      ORDER BY v.number ASC
      LIMIT 1
    `;
    const location = locationRows[0];
    if (!location) throw new Error('找不到演示作品/卷，请先执行 pnpm db:seed');

    chapterId = randomUUID();
    v1Id = randomUUID();
    const wordCount = countWords(importedContent);
    const contentHash = sha256(importedContent);

    await sql`
      INSERT INTO chapters (
        id, work_id, volume_id, number, title, status, plan
      )
      VALUES (
        ${chapterId}, ${location.work_id}, ${location.volume_id}, ${TEST_NUMBER},
        ${TEST_TITLE}, 'canon', ${sql.json(jsonValue(plan))}
      )
    `;
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id
      )
      VALUES (
        ${v1Id}, ${chapterId}, 1, ${importedContent}, ${contentHash}, ${wordCount},
        NULL, 'import', ${owner.me.user.id}
      )
    `;
    await sql`
      UPDATE chapters SET current_version_id = ${v1Id} WHERE id = ${chapterId}
    `;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${v1Id})
    `;
    await sql`
      INSERT INTO chapter_metadata (chapter_id, word_count)
      VALUES (${chapterId}, ${wordCount})
    `;
    await sql`
      INSERT INTO index_status (chapter_id, version_id, status, detail)
      VALUES (${chapterId}, ${v1Id}, 'not_configured', 'M2 测试初始导入，未接入索引')
    `;
  });

  afterAll(async () => {
    if (chapterId) await cleanupChapter(chapterId);
    await sql`
      DELETE FROM sessions
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@demo.local')
    `;
    await sql`
      DELETE FROM audit_log
      WHERE action = 'auth.login'
        AND actor_id IN (SELECT id FROM users WHERE email LIKE '%@demo.local')
    `;
    if (app) await app.close();
    await closeDb();
  });

  it('租约冲突时阻止第二位编辑，并允许持租约者放弃修订', async () => {
    const started = await call<StartRevisionResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision`,
    );
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('revision');
    expect(started.body.baseVersionId).toBe(v1Id);

    const blockedRevision = await call<unknown>(
      author.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision`,
    );
    expectError(blockedRevision, 409, 'CHAPTER_NOT_REVISABLE');

    const blockedDraft = await call<unknown>(
      author.cookie,
      'PUT',
      `/api/chapters/${chapterId}/draft`,
      { content: '第二个人不应写入这段内容。' },
    );
    expectError(blockedDraft, 409, 'LEASE_HELD');

    const abandoned = await call<AbandonRevisionResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision/abandon`,
    );
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.status).toBe('canon');
    expect(abandoned.body.currentVersionId).toBe(v1Id);

    const detail = await getChapter(owner.cookie);
    expect(detail.status).toBe('canon');
    expect(detail.currentVersion?.versionNo).toBe(1);
    expect(detail.lease).toBeNull();
  });

  it('提交两版后复用门禁证据回滚，并拒绝无证据回滚', async () => {
    const v2 = await addRevisionAndCommit(contentA, v1Id, 'm2-test-commit-v2');
    v2Id = v2.commit.versionId;
    expect(v2.commit.versionNo).toBe(2);

    const v2Replay = await call<CommitResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/commit`,
      v2.payload,
    );
    expect(v2Replay.status).toBe(200);
    expect(v2Replay.body.alreadyCommitted).toBe(true);
    expect(v2Replay.body.versionId).toBe(v2Id);

    const stagedForRetry = await prepareStagedDraft(contentB);
    const retryPayload = {
      idempotencyKey: 'm2-test-commit-v3',
      targetChapterId: chapterId,
      expectedCurrentVersionId: v1Id,
      stagedDraftId: stagedForRetry,
    };
    const failedAttempt = await call<unknown>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/commit`,
      retryPayload,
    );
    expectError(failedAttempt, 409, 'CONCURRENT_COMMIT');

    const retried = await call<CommitResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/commit`,
      { ...retryPayload, expectedCurrentVersionId: v2Id },
    );
    expect(retried.status).toBe(200);
    expect(retried.body.alreadyCommitted).toBe(false);
    expect(retried.body.versionNo).toBe(3);
    v3Id = retried.body.versionId;

    const first = await rollback({
      cookie: owner.cookie,
      idempotencyKey: 'm2-test-rb-v2',
      targetVersionId: v2Id,
      expectedCurrentVersionId: v3Id,
      reason: '回到有通过门禁证据的 v2',
    });
    expect(first.status).toBe(200);
    expect(first.body.evidence).toBe('reused');
    expect(first.body.evaluationId).not.toBeNull();
    expect(first.body.waiverId).toBeNull();
    expect(first.body.targetVersionId).toBe(v2Id);
    expect(first.body.previousVersionId).toBe(v3Id);
    expect(first.body.versionNo).toBe(4);
    const v4Id = first.body.versionId;

    const replay = await rollback({
      cookie: owner.cookie,
      idempotencyKey: 'm2-test-rb-v2',
      targetVersionId: v2Id,
      expectedCurrentVersionId: v3Id,
      reason: '回到有通过门禁证据的 v2',
    });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyCommitted).toBe(true);
    expect(replay.body.versionId).toBe(v4Id);

    const denied = await rollback({
      cookie: owner.cookie,
      idempotencyKey: 'm2-test-rb-v1-denied',
      targetVersionId: v1Id,
      expectedCurrentVersionId: v4Id,
      reason: 'v1 为迁移导入，没有门禁证据',
    });
    expectError(denied, 409, 'ROLLBACK_EVIDENCE_REQUIRED');

    const crossOperation = await call<unknown>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/commit`,
      {
        idempotencyKey: 'm2-test-rb-v2',
        targetChapterId: chapterId,
        expectedCurrentVersionId: v4Id,
        stagedDraftId: randomUUID(),
      },
    );
    expectError(crossOperation, 409, 'IDEMPOTENCY_KEY_REUSED');

    const detail = await getChapter(owner.cookie);
    expect(detail.status).toBe('canon');
    expect(detail.currentVersion?.versionNo).toBe(4);
    expect(detail.versions.map((version) => version.versionNo)).toEqual([4, 3, 2, 1]);
    const v4 = detail.versions.find((version) => version.versionNo === 4);
    expect(v4?.source).toBe('rollback');
    expect(v4?.evaluationId).not.toBeNull();
    expect(v4?.waiverId).toBeNull();
  });

  it('豁免申请人不能自批，批准后一次性使用，目标版本保留未评估', async () => {
    const requested = await call<WaiverView>(
      author.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers`,
      {
        targetVersionId: v1Id,
        gateKey: 'rollback',
        reason: 'v1 是迁移导入稿，没有可复用的通过门禁证据',
      },
    );
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe('pending');
    expect(requested.body.requestedBy).toBe(author.me.user.id);
    expect(requested.body.approvedBy).toBeNull();
    waiverId = requested.body.id;

    const duplicate = await call<unknown>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers`,
      {
        targetVersionId: v1Id,
        gateKey: 'rollback',
        reason: '重复申请应当被拒绝',
      },
    );
    expectError(duplicate, 409, 'WAIVER_ALREADY_EXISTS');

    const authorApprove = await call<unknown>(
      author.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers/${waiverId}/approve`,
      { note: '作者越权审批' },
    );
    expectError(authorApprove, 403, 'FORBIDDEN');

    const ownedWaiver = await call<WaiverView>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers`,
      {
        targetVersionId: v3Id,
        gateKey: 'rollback',
        reason: '验证申请人不能审批自己的申请',
      },
    );
    expect(ownedWaiver.status).toBe(200);
    const selfApprove = await call<unknown>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers/${ownedWaiver.body.id}/approve`,
      { note: '自己批准自己' },
    );
    expectError(selfApprove, 403, 'FORBIDDEN');
    expect((selfApprove.body as ErrorBody).error.message).toContain('不能审批自己的申请');
    const rejected = await call<WaiverView>(
      lead.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers/${ownedWaiver.body.id}/reject`,
      { note: '测试用申请，驳回清理' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const authorRollback = await rollback({
      cookie: author.cookie,
      idempotencyKey: 'm2-test-author-rb',
      targetVersionId: v1Id,
      expectedCurrentVersionId: v3Id,
      reason: '作者无权执行正典回滚',
      waiverId,
    });
    expectError(authorRollback, 403, 'FORBIDDEN');

    const approved = await call<WaiverView>(
      lead.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers/${waiverId}/approve`,
      { note: '同意一次性回滚至导入稿' },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedBy).toBe(lead.me.user.id);
    expect(approved.body.decisionNote).toBe('同意一次性回滚至导入稿');

    const decideAgain = await call<unknown>(
      lead.cookie,
      'POST',
      `/api/chapters/${chapterId}/waivers/${waiverId}/approve`,
      { note: '重复审批' },
    );
    expectError(decideAgain, 409, 'WAIVER_ALREADY_DECIDED');

    const detailBefore = await getChapter(owner.cookie);
    const currentBefore = detailBefore.currentVersion;
    if (!currentBefore) throw new Error('测试章节缺少当前正典');

    const waived = await rollback({
      cookie: lead.cookie,
      idempotencyKey: 'm2-test-rb-v1-waiver',
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentBefore.id,
      reason: '按批准的一次性豁免回滚至导入稿',
      waiverId,
    });
    expect(waived.status).toBe(200);
    expect(waived.body.evidence).toBe('waived');
    expect(waived.body.evaluationId).toBeNull();
    expect(waived.body.waiverId).toBe(waiverId);
    expect(waived.body.versionNo).toBe(5);

    const detailAfter = await getChapter(owner.cookie);
    expect(detailAfter.currentVersion?.versionNo).toBe(5);
    const imported = detailAfter.versions.find((version) => version.versionNo === 1);
    expect(imported?.gateStatus).toBe('not_evaluated');
    expect(imported?.waiverId).toBeNull();
    const waivedVersion = detailAfter.versions.find((version) => version.versionNo === 5);
    expect(waivedVersion?.source).toBe('rollback');
    expect(waivedVersion?.gateStatus).toBe('waived');
    expect(waivedVersion?.waiverId).toBe(waiverId);
    expect(detailAfter.waivers.find((waiver) => waiver.id === waiverId)?.status).toBe(
      'approved',
    );

    const forward = await rollback({
      cookie: lead.cookie,
      idempotencyKey: 'm2-test-rb-v2-after',
      targetVersionId: v2Id,
      expectedCurrentVersionId: waived.body.versionId,
      reason: '回到有通过门禁证据的 v2',
    });
    expect(forward.status).toBe(200);
    expect(forward.body.evidence).toBe('reused');
    expect(forward.body.versionNo).toBe(6);

    const reuse = await rollback({
      cookie: lead.cookie,
      idempotencyKey: 'm2-test-rb-v1-reuse',
      targetVersionId: v1Id,
      expectedCurrentVersionId: forward.body.versionId,
      reason: '同一豁免不能第二次使用',
      waiverId,
    });
    expectError(reuse, 409, 'WAIVER_ALREADY_USED');

    const finalDetail = await getChapter(owner.cookie);
    expect(finalDetail.currentVersion?.versionNo).toBe(6);
    expect(finalDetail.versions.map((version) => version.versionNo)).toEqual([
      6, 5, 4, 3, 2, 1,
    ]);
    const sources = finalDetail.versions.map((version) => [
      version.versionNo,
      version.source,
    ]);
    expect(sources).toEqual([
      [6, 'rollback'],
      [5, 'rollback'],
      [4, 'rollback'],
      [3, 'human'],
      [2, 'human'],
      [1, 'import'],
    ]);
  });

  it('版本列表单独成页：按版本号倒序、只给预览不给正文，且看不见别人的章节', async () => {
    const list = await call<VersionSummary[]>(
      owner.cookie,
      'GET',
      `/api/chapters/${chapterId}/versions`,
    );
    expect(list.status).toBe(200);
    expect(list.body.map((version) => version.versionNo)).toEqual([6, 5, 4, 3, 2, 1]);

    // 表头是当前生效的那一版；排序按版本号，不是按写入时间
    const pointer = await sql<{ current_version_id: string }[]>`
      SELECT current_version_id FROM chapters WHERE id = ${chapterId}
    `;
    expect(list.body[0]!.id).toBe(pointer[0]!.current_version_id);

    // 这一页只给预览：响应里没有正文字段，长正文压平空白并截到 80 字
    for (const version of list.body) {
      expect(version).not.toHaveProperty('content');
      expect(version.contentPreview).not.toContain('\n');
      expect(version.contentPreview.length).toBeLessThanOrEqual(81);
    }

    // 三种门禁标识各归其位：导入的 v1 仍是未评估，带豁免的 v5 是 waived
    const imported = list.body[5]!;
    expect(imported).toMatchObject({
      versionNo: 1,
      source: 'import',
      gateStatus: 'not_evaluated',
      evaluationId: null,
      waiverId: null,
    });
    expect(list.body.find((version) => version.versionNo === 5)?.gateStatus).toBe('waived');
    expect(list.body.find((version) => version.versionNo === 5)?.waiverId).toBe(waiverId);
    expect(list.body.find((version) => version.versionNo === 6)?.source).toBe('rollback');

    // 每一版归因到当时动手的那个人
    expect(imported.actorName).toBe(owner.me.user.name);
    expect(list.body[0]!.actorName).toBe(lead.me.user.name);

    // 幽灵章节 id 就是 404，不区分"存在但不属于你"
    expectError(
      await call(owner.cookie, 'GET', `/api/chapters/${randomUUID()}/versions`),
      404,
      'CHAPTER_NOT_FOUND',
    );
  });

  it('审计端点算的是调用者自己的草稿，未接入的检测器如实标注且不落库', async () => {
    const started = await call<StartRevisionResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision`,
    );
    expect(started.status).toBe(200);

    async function saveDraft(content: string): Promise<void> {
      const saved = await call<SaveDraftResponse>(
        owner.cookie,
        'PUT',
        `/api/chapters/${chapterId}/draft`,
        { content },
      );
      expect(saved.status).toBe(200);
    }

    await saveDraft(contentA);
    const gatesBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM gate_evaluations WHERE chapter_id = ${chapterId}
    `;
    const auditRowsBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log
      WHERE object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId}
    `;

    const clean = await call<AuditReport>(
      owner.cookie,
      'GET',
      `/api/chapters/${chapterId}/audits`,
    );
    expect(clean.status).toBe(200);
    expect(clean.body.advisoryOnly).toBe(true);
    expect(clean.body.audits.map((audit) => audit.key)).toEqual([
      'ai_flavor',
      'typos',
      'punctuation',
      'sensitive_words',
      'coherence',
    ]);
    for (const audit of clean.body.audits) {
      expect(audit.advisoryOnly).toBe(true);
    }
    const cleanByKey = new Map(clean.body.audits.map((audit) => [audit.key, audit]));
    expect(cleanByKey.get('ai_flavor')?.status).toBe('ok');
    expect(cleanByKey.get('punctuation')?.status).toBe('ok');
    expect(cleanByKey.get('sensitive_words')?.status).toBe('ok');
    // 没接入的检测器不能装作跑过：状态与文案都得说是未接入
    expect(cleanByKey.get('typos')?.status).toBe('not_connected');
    expect(cleanByKey.get('typos')?.message).toContain('未接入');
    expect(cleanByKey.get('coherence')?.status).toBe('not_connected');
    expect(cleanByKey.get('coherence')?.message).toContain('未接入');

    // 换一个作者读同一章：他自己手上没有草稿就如实拒绝，不去算别人的正文
    expectError(
      await call(author.cookie, 'GET', `/api/chapters/${chapterId}/audits`),
      409,
      'NO_DRAFT',
    );

    // 同一个作者改了草稿，审计跟着改
    await saveDraft(`${contentA}\n\n他仿佛听见巷口的脚步声,却仍没有回头。`);
    const dirty = await call<AuditReport>(
      owner.cookie,
      'GET',
      `/api/chapters/${chapterId}/audits`,
    );
    const dirtyByKey = new Map(dirty.body.audits.map((audit) => [audit.key, audit]));
    expect(dirtyByKey.get('ai_flavor')?.status).toBe('warning');
    expect(dirtyByKey.get('ai_flavor')?.hits).toBe(1);
    expect(dirtyByKey.get('ai_flavor')?.examples).toEqual(['仿佛×1']);
    expect(dirtyByKey.get('ai_flavor')?.message).toContain('仅提示，不改写正文');
    expect(dirtyByKey.get('punctuation')?.status).toBe('warning');
    expect(dirtyByKey.get('punctuation')?.examples).toEqual([',']);
    // 警告不会反过来把未接入的检测器说成跑过
    expect(dirtyByKey.get('typos')?.status).toBe('not_connected');

    // 读审计既不建门禁评估也不留一条审计日志，章节仍停在修订草稿流程里
    const gatesAfter = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM gate_evaluations WHERE chapter_id = ${chapterId}
    `;
    expect(gatesAfter[0]!.n).toBe(gatesBefore[0]!.n);
    const auditRowsAfter = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_log
      WHERE object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId}
    `;
    expect(auditRowsAfter[0]!.n).toBe(auditRowsBefore[0]!.n);
    const detail = await getChapter(owner.cookie);
    expect(detail.status).toBe('writing');

    const abandoned = await call<AbandonRevisionResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/revision/abandon`,
    );
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.status).toBe('canon');
  });

  it('状态机对非法转移逐条拒：正典只读、空草稿不落、无租约不写、门禁未过不暂存', async () => {
    interface Trace {
      drafts: string;
      evals: string;
      staged: string;
      audits: string;
      versions: string;
      failedIntents: string;
      status: string;
      currentVersionId: string | null;
    }

    async function trace(): Promise<Trace> {
      const rows = await sql<Trace[]>`
        SELECT
          (SELECT count(*)::text FROM draft_revisions dr
             JOIN draft_branches db ON db.id = dr.branch_id
             WHERE db.chapter_id = ${chapterId}) AS drafts,
          (SELECT count(*)::text FROM gate_evaluations WHERE chapter_id = ${chapterId}) AS evals,
          (SELECT count(*)::text FROM staged_drafts WHERE chapter_id = ${chapterId}) AS staged,
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId}) AS audits,
          (SELECT count(*)::text FROM canon_versions WHERE chapter_id = ${chapterId}) AS versions,
          (SELECT count(*)::text FROM commit_intents
             WHERE chapter_id = ${chapterId} AND status = 'failed') AS "failedIntents",
          (SELECT status FROM chapters WHERE id = ${chapterId}) AS status,
          (SELECT current_version_id::text FROM chapters WHERE id = ${chapterId}) AS "currentVersionId"
      `;
      return rows[0]!;
    }

    const draftPath = `/api/chapters/${chapterId}/draft`;
    const leasePath = `/api/chapters/${chapterId}/lease`;
    const stagePath = `/api/chapters/${chapterId}/stage`;
    const gatesPath = `/api/chapters/${chapterId}/gates`;
    const revisionPath = `/api/chapters/${chapterId}/revision`;
    const abandonPath = `/api/chapters/${chapterId}/revision/abandon`;
    const commitPath = `/api/chapters/${chapterId}/commit`;

    async function save(content: string): Promise<string> {
      const saved = await call<SaveDraftResponse>(owner.cookie, 'PUT', draftPath, { content });
      expect(saved.status).toBe(200);
      return saved.body.draft.contentHash;
    }

    async function evaluate(): Promise<GateEvaluationView> {
      const result = await call<GateEvaluationView>(owner.cookie, 'POST', gatesPath);
      expect(result.status).toBe(200);
      return result.body;
    }

    // 起点：上一个用例放弃修订后，章节回到正典
    const canonTrace = await trace();
    expect(canonTrace.status).toBe('canon');

    // ① 正典只读：连取得租约都被拒，文案把人指向"开始修订"
    const readOnly = await call<ErrorBody>(owner.cookie, 'POST', leasePath);
    expectError(readOnly, 409, 'CHAPTER_READ_ONLY');
    expect(readOnly.body.error.message).toBe('正典只读；请从“开始修订”进入修订流程');

    // ② 正典不收草稿；空白检查还排在状态检查之前
    expectError(await call(owner.cookie, 'PUT', draftPath, { content: '   ' }), 409, 'EMPTY_DRAFT');
    const notEditable = await call<ErrorBody>(owner.cookie, 'PUT', draftPath, { content: contentA });
    expectError(notEditable, 409, 'CHAPTER_NOT_EDITABLE');
    expect(notEditable.body.error.message).toBe('章节当前状态 canon 不允许写草稿');

    // ③ 正典既不能暂存也不能取消暂存
    expectError(
      await call(owner.cookie, 'POST', stagePath, {
        evaluationId: randomUUID(),
        expectedContentHash: '0'.repeat(64),
      }),
      409,
      'CHAPTER_NOT_STAGEABLE',
    );
    expectError(await call(owner.cookie, 'DELETE', stagePath), 409, 'CHAPTER_NOT_STAGED');

    // ④ 这一整轮拒绝不落任何一行：草稿、证据、暂存、审计与指针全都不动
    expect(await trace()).toEqual(canonTrace);

    // 进入修订：startRevision 把租约顺手发给发起者，并把当前正典复制成第一条草稿，
    // 所以库里草稿 +1 是这一步该发生的写痕，不是泄漏。
    const started = await call<StartRevisionResponse>(owner.cookie, 'POST', revisionPath);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('revision');
    const afterRevision = await trace();
    expect(Number(afterRevision.drafts)).toBe(Number(canonTrace.drafts) + 1);
    expect(afterRevision.evals).toBe(canonTrace.evals);
    expect(afterRevision.staged).toBe(canonTrace.staged);
    expect(afterRevision.currentVersionId).toBe(canonTrace.currentVersionId);

    // ⑤ "空草稿不落盘"有两道闸：契约的 min(1) 先在边界拦下空串，
    //    纯空白能过边界但过不了服务端的 isBlank。两层都在状态转移之后、落库之前。
    const beforeWrites = await trace();
    const boundaryBlank = await call<ErrorBody>(owner.cookie, 'PUT', draftPath, { content: '' });
    expectError(boundaryBlank, 400, 'VALIDATION');
    expect(boundaryBlank.body.error.message).toBe('请求参数不合法');
    expect(JSON.stringify(boundaryBlank.body.error.details)).toContain('空草稿不落盘');
    const serviceBlank = await call<ErrorBody>(owner.cookie, 'PUT', draftPath, { content: '   ' });
    expectError(serviceBlank, 409, 'EMPTY_DRAFT');
    expect(serviceBlank.body.error.message).toBe('空草稿不落盘');
    expect(await trace()).toEqual(beforeWrites);

    // ⑥ 没有有效租约才叫 LEASE_REQUIRED（区别于上一用例钉过的"别人持有时是 LEASE_HELD"）：
    //    持有者自己释放租约后，无论他来写还是主笔来写，都是同一句"请先取得编辑租约"，
    //    且拒绝里明确 holder 为 null——界面不会把上一个人显示成还在锁定。
    expect((await call(owner.cookie, 'DELETE', leasePath)).status).toBe(200);
    const ownerNoLease = await call<ErrorBody>(owner.cookie, 'PUT', draftPath, { content: contentA });
    expectError(ownerNoLease, 409, 'LEASE_REQUIRED');
    expect(ownerNoLease.body.error.message).toBe('该章节没有有效租约，请先取得编辑租约');
    expect(ownerNoLease.body.error.details).toEqual({ holder: null });
    const leadNoLease = await call<ErrorBody>(lead.cookie, 'PUT', draftPath, { content: contentA });
    expectError(leadNoLease, 409, 'LEASE_REQUIRED');
    expect(await trace()).toEqual(beforeWrites);
    expect((await call(owner.cookie, 'POST', leasePath)).status).toBe(200);

    // ⑦ 一次成功保存把状态从 revision 拉回 writing（saveDraft 无条件写 'writing'），
    //    这也是后面"放弃修订"仍能工作的原因：abandon 同时接受 revision 与 writing。
    //    门禁没过就不能暂存：短正文评估成 failed，结论写进拒绝文案里
    const failingHash = await save('林默仿佛走了一步。');
    expect((await trace()).status).toBe('writing');
    const failingEval = await evaluate();
    expect(failingEval.status).toBe('failed');
    const gateRejected = await call<ErrorBody>(owner.cookie, 'POST', stagePath, {
      evaluationId: failingEval.id,
      expectedContentHash: failingHash,
    });
    expectError(gateRejected, 409, 'GATE_NOT_PASSED');
    expect(gateRejected.body.error.message).toBe('门禁结论为 failed，不能暂存');

    // ⑧ 证据与草稿的对应关系：四种不一致各拒一次，检查顺序也钉住
    const hashA = await save(contentA);
    const evalA = await evaluate();
    expect(evalA.status).toBe('passed');
    const hashB = await save(contentB);
    const beforeRejections = await trace();

    // 草稿已换、证据还是旧的：正文对不上
    const staleEval = await call<ErrorBody>(owner.cookie, 'POST', stagePath, {
      evaluationId: evalA.id,
      expectedContentHash: hashB,
    });
    expectError(staleEval, 409, 'EVALUATION_STALE');
    expect(staleEval.body.error.message).toBe('门禁评估对应的正文不是当前草稿，请重新跑门禁');

    // 期望哈希还是旧草稿的：草稿侧先变化，这一枪先响
    const changedDraft = await call<ErrorBody>(owner.cookie, 'POST', stagePath, {
      evaluationId: evalA.id,
      expectedContentHash: hashA,
    });
    expectError(changedDraft, 409, 'DRAFT_CHANGED');
    expect(changedDraft.body.error.message).toBe('保存后草稿已变化，请重新跑门禁');

    // 哈希对得上但证据是别人的：查不到就是不属于本章
    expectError(
      await call(owner.cookie, 'POST', stagePath, {
        evaluationId: randomUUID(),
        expectedContentHash: hashB,
      }),
      409,
      'EVALUATION_NOT_FOUND',
    );

    // 没有草稿的人跑门禁：拒的是"先保存"，不去算正典正文
    expectError(await call(lead.cookie, 'POST', gatesPath), 409, 'NO_DRAFT');

    // 四次拒绝都不建暂存、不再产出证据、一条审计都不留
    const afterRejections = await trace();
    expect(afterRejections.staged).toBe(beforeRejections.staged);
    expect(afterRejections.evals).toBe(beforeRejections.evals);
    expect(afterRejections.audits).toBe(beforeRejections.audits);
    expect(afterRejections.status).toBe('writing');

    // ⑨ 暂存与取消暂存可以往返，但取消第二次就没东西可取消。
    //    取消只把章节状态改回 writing，暂存行留在库里当历史——真正的闸是状态：
    //    取消后详情读不到暂存，拿着那个暂存 id 去提交也被 CHAPTER_NOT_COMMITTABLE 拒。
    const evalB = await evaluate();
    const beforeStage = await trace();
    const stagedView = await call<StageResponse>(owner.cookie, 'POST', stagePath, {
      evaluationId: evalB.id,
      expectedContentHash: hashB,
    });
    expect(stagedView.status).toBe(200);
    const stagedDraftId = stagedView.body.stagedDraft.id;
    const afterStage = await trace();
    expect(Number(afterStage.staged)).toBe(Number(beforeStage.staged) + 1);
    expect(afterStage.status).toBe('staged');

    expect((await call(owner.cookie, 'DELETE', stagePath)).status).toBe(200);
    const afterUnstage = await trace();
    expect(afterUnstage.status).toBe('writing');
    expect(afterUnstage.staged).toBe(afterStage.staged);
    expect((await getChapter(owner.cookie)).stagedDraft).toBeNull();
    expectError(await call(owner.cookie, 'DELETE', stagePath), 409, 'CHAPTER_NOT_STAGED');

    const ghostCommit = await call<ErrorBody>(owner.cookie, 'POST', commitPath, {
      idempotencyKey: `m2-state-unstaged-${randomUUID()}`,
      targetChapterId: chapterId,
      expectedCurrentVersionId: canonTrace.currentVersionId,
      stagedDraftId,
    });
    expectError(ghostCommit, 409, 'CHAPTER_NOT_COMMITTABLE');
    expect(ghostCommit.body.error.message).toBe('章节当前状态 writing 不允许提交');

    // ⑩ 放弃修订只认一次，第二次说清当前状态
    const abandonedAgain = await call<AbandonRevisionResponse>(
      owner.cookie,
      'POST',
      abandonPath,
    );
    expect(abandonedAgain.status).toBe(200);
    const repeatAbandon = await call<ErrorBody>(owner.cookie, 'POST', abandonPath);
    expectError(repeatAbandon, 409, 'CHAPTER_NOT_IN_REVISION');
    expect(repeatAbandon.body.error.message).toBe('章节当前状态 canon，不能放弃修订');

    // ⑪ 草稿多 4 行 = 开始修订时复制正典那 1 行 + 显式保存 3 次；门禁证据多 3 行；
    //    暂存多 1 行且取消后仍留着（历史）；正典版本数与指针一步没动；
    //    唯一的额外写痕是那次被拒的提交意图——失败留痕，不是把失败伪装成没发生。
    const endTrace = await trace();
    expect(endTrace.status).toBe('canon');
    expect(endTrace.currentVersionId).toBe(canonTrace.currentVersionId);
    expect(endTrace.versions).toBe(canonTrace.versions);
    expect(Number(endTrace.drafts)).toBe(Number(canonTrace.drafts) + 4);
    expect(Number(endTrace.evals)).toBe(Number(canonTrace.evals) + 3);
    expect(Number(endTrace.staged)).toBe(Number(canonTrace.staged) + 1);
    expect(Number(endTrace.failedIntents)).toBe(Number(canonTrace.failedIntents) + 1);
  });
});

afterAll(async () => {
  if (!dbAvailable) await closeDb();
});
