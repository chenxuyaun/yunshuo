import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  AbandonRevisionResponse,
  ChapterDetail,
  CommitResponse,
  GateEvaluationView,
  MeResponse,
  RollbackResponse,
  SaveDraftResponse,
  StageResponse,
  StartRevisionResponse,
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
});

afterAll(async () => {
  if (!dbAvailable) await closeDb();
});
