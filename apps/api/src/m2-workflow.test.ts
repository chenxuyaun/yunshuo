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
    // 同一条兜底也适用于提交意图：别的章节名下、指向本章版本或暂存行的意图行
    // （target/expected_current_version_id、staged_draft_id 三条外键都是 RESTRICT），
    // 不清掉就会挡住本章的版本行与暂存行删除。
    await sql`
      DELETE FROM commit_intents
      WHERE chapter_id <> ${id}
        AND (
          target_version_id IN (SELECT id FROM canon_versions WHERE chapter_id = ${id})
          OR expected_current_version_id IN (SELECT id FROM canon_versions WHERE chapter_id = ${id})
          OR staged_draft_id IN (SELECT id FROM staged_drafts WHERE chapter_id = ${id})
        )
    `;
    await sql`DELETE FROM commit_intents WHERE chapter_id = ${id}`;
    await sql`UPDATE canon_versions SET waiver_id = NULL WHERE chapter_id = ${id}`;
    // 兜底：挂在别的章节名下、但指向本章某个版本的豁免记录（跨章归属用例会造出来）
    // 会因外键挡住本章版本行的删除，先按目标版本清掉。
    await sql`
      DELETE FROM waivers
      WHERE chapter_id <> ${id}
        AND target_version_id IN (SELECT id FROM canon_versions WHERE chapter_id = ${id})
    `;
    await sql`DELETE FROM waivers WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_current WHERE chapter_id = ${id}`;
    await sql`UPDATE chapters SET current_version_id = NULL WHERE id = ${id}`;
    await sql`DELETE FROM index_status WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_metadata WHERE chapter_id = ${id}`;
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${id}`;
    await sql`DELETE FROM canon_versions WHERE chapter_id = ${id}`;
    // 用例八的兄弟章节走的是真实修订流程，暂存/门禁证据/草稿分支都会落行；
    // 这些表不在原来的清理清单里，失败一次就会永久留下孤儿。
    await sql`DELETE FROM staged_drafts WHERE chapter_id = ${id}`;
    await sql`DELETE FROM gate_evaluations WHERE chapter_id = ${id}`;
    await sql`
      DELETE FROM draft_revisions
      WHERE branch_id IN (SELECT id FROM draft_branches WHERE chapter_id = ${id})
    `;
    await sql`DELETE FROM draft_branches WHERE chapter_id = ${id}`;
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

  it('回滚前逐条复核：目标必须更早且属本章、正典且无人占租、豁免对得上且批准人独立', async () => {
    const startedAt = new Date();

    interface Trace {
      versions: string;
      waivers: string;
      intents: string;
      failedIntents: string;
      commits: string;
      canonCurrent: string;
      leases: string;
      events: string;
      audits: string;
      rollbackAudits: string;
      rollbackEvents: string;
      status: string;
      currentVersionId: string | null;
    }

    async function trace(): Promise<Trace> {
      const rows = await sql<Trace[]>`
        SELECT
          (SELECT count(*)::text FROM canon_versions WHERE chapter_id = ${chapterId}) AS versions,
          (SELECT count(*)::text FROM waivers WHERE chapter_id = ${chapterId}) AS waivers,
          (SELECT count(*)::text FROM commit_intents WHERE chapter_id = ${chapterId}) AS intents,
          (SELECT count(*)::text FROM commit_intents
             WHERE chapter_id = ${chapterId} AND status = 'failed') AS "failedIntents",
          (SELECT count(*)::text FROM commits WHERE chapter_id = ${chapterId}) AS commits,
          (SELECT count(*)::text FROM canon_current WHERE chapter_id = ${chapterId}) AS "canonCurrent",
          (SELECT count(*)::text FROM chapter_leases WHERE chapter_id = ${chapterId}) AS leases,
          (SELECT count(*)::text FROM events
             WHERE aggregate_type = 'chapter' AND aggregate_id = ${chapterId}) AS events,
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId}) AS audits,
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${chapterId} AND action = 'chapter.rollback') AS "rollbackAudits",
          (SELECT count(*)::text FROM events
             WHERE aggregate_id = ${chapterId} AND event_type = 'chapter.rolled_back') AS "rollbackEvents",
          (SELECT status FROM chapters WHERE id = ${chapterId}) AS status,
          (SELECT current_version_id::text FROM chapters WHERE id = ${chapterId}) AS "currentVersionId"
      `;
      return rows[0]!;
    }

    const rollbackPath = `/api/chapters/${chapterId}/rollback`;
    const waiversPath = `/api/chapters/${chapterId}/waivers`;
    const revisionPath = `/api/chapters/${chapterId}/revision`;
    const abandonPath = `/api/chapters/${chapterId}/revision/abandon`;

    function guardKey(name: string): string {
      return `m2-rb-guard-${name}-${randomUUID().slice(0, 8)}`;
    }

    function messageOf(result: ApiResult<unknown>): string {
      return (result.body as ErrorBody).error.message;
    }

    function detailsOf(result: ApiResult<unknown>): unknown {
      return (result.body as ErrorBody).error.details;
    }

    let ledger = await trace();

    // 每拒一次都重算全表痕迹：除了那条"被拒的意图"必须留下（带错误码，供事后追查），
    // 版本、豁免、提交、指针、租约、事件与审计都不许动。
    async function refused(
      result: ApiResult<unknown>,
      status: number,
      code: string,
      intent: 'intent' | 'none',
    ): Promise<void> {
      expectError(result, status, code);
      const after = await trace();
      expect({ ...after, intents: ledger.intents, failedIntents: ledger.failedIntents }).toEqual(
        ledger,
      );
      if (intent === 'intent') {
        expect(Number(after.intents)).toBe(Number(ledger.intents) + 1);
        expect(Number(after.failedIntents)).toBe(Number(ledger.failedIntents) + 1);
      } else {
        expect(after.intents).toBe(ledger.intents);
        expect(after.failedIntents).toBe(ledger.failedIntents);
      }
      ledger = after;
    }

    async function settle(): Promise<Trace> {
      ledger = await trace();
      return ledger;
    }

    // 起点：上一个用例放弃修订后，章节仍是正典、指针还指第 6 版
    const entry = await settle();
    expect(entry.status).toBe('canon');
    expect(entry.leases).toBe('0');
    if (!entry.currentVersionId) throw new Error('测试章节缺少当前正典版本，无法验证回滚复核');
    const currentVersionId = entry.currentVersionId;

    // ① 目标版本必须属于本章：拿别的章节一个真实存在的版本 id 来，FK 拦得住但服务也要拦住，
    //    而且拒绝只说"不存在或不属于本章"，不泄露它其实在别的工作区章节里。
    const foreignRows = await sql<{ id: string }[]>`
      SELECT v.id FROM canon_versions v
      WHERE v.chapter_id <> ${chapterId}
      ORDER BY v.chapter_id, v.version_no
      LIMIT 1
    `;
    const foreignVersionId = foreignRows[0]?.id;
    if (!foreignVersionId) throw new Error('测试库缺少其他章节的正典版本，无法验证跨章隔离');
    const crossChapter = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('other-chapter'),
      targetVersionId: foreignVersionId,
      expectedCurrentVersionId: currentVersionId,
      reason: '别的章节的正典版本不能当本章的回滚目标',
    });
    await refused(crossChapter, 404, 'VERSION_NOT_FOUND', 'intent');
    expect(messageOf(crossChapter)).toBe('目标版本不存在或不属于本章');

    // ② 目标就是当前正典：没有"回滚到自己"这种空转
    const targetCurrent = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('target-current'),
      targetVersionId: currentVersionId,
      expectedCurrentVersionId: currentVersionId,
      reason: '目标就是当前正典',
    });
    await refused(targetCurrent, 409, 'ROLLBACK_TARGET_CURRENT', 'intent');
    expect(messageOf(targetCurrent)).toBe('目标版本就是当前正典，无需回滚');

    // ③ 指针已变化：乐观并发先拒，并把真正的当前版本回给客户端刷新界面
    const concurrent = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('concurrent'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: v3Id,
      reason: '客户端还以为当前是第 3 版',
    });
    await refused(concurrent, 409, 'CONCURRENT_COMMIT', 'intent');
    expect(messageOf(concurrent)).toBe('当前正典版本已变化，请刷新后重试');
    expect(detailsOf(concurrent)).toEqual({ currentVersionId });

    // ④ 只能回滚到更早的版本：手工塞一个版本号更大的版本行，钉住比较用的是 >=，
    //    同版本号也拒（回滚到"同一版"没有意义）。脚手架用完自己收尾。
    const scaffold = await settle();
    const futureId = randomUUID();
    const futureKey = guardKey('not-prior');
    const futureContent = `${contentB}\n\n这一段是为验证"只能回滚到更早版本"手工塞进库的假未来版本。`;
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id
      )
      VALUES (
        ${futureId}, ${chapterId}, 99, ${futureContent},
        ${sha256(futureContent)}, ${countWords(futureContent)}, ${currentVersionId}, 'human',
        ${owner.me.user.id}
      )
    `;
    await settle();
    const notPrior = await rollback({
      cookie: owner.cookie,
      idempotencyKey: futureKey,
      targetVersionId: futureId,
      expectedCurrentVersionId: currentVersionId,
      reason: '版本号比当前还大的目标不能回滚',
    });
    await refused(notPrior, 409, 'ROLLBACK_TARGET_NOT_PRIOR', 'intent');
    expect(messageOf(notPrior)).toBe('只能回滚到更早的正典版本');
    // 假版本行被自己留下的意图行外键引用着（RESTRICT），先删意图再删版本；
    // 于是这一条是唯一没有留在失败意图账上的拒绝。
    await sql`DELETE FROM commit_intents WHERE idempotency_key = ${futureKey}`;
    await sql`DELETE FROM canon_versions WHERE id = ${futureId}`;
    expect(await trace()).toEqual(scaffold);
    ledger = scaffold;

    // ⑤ 有人正拿着租约时不能回滚：先让状态检查过，再撞租约闸
    const beforeLease = await settle();
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, acquired_at, expires_at)
      VALUES (${chapterId}, ${author.me.user.id}, now(), now() + ${'10 minutes'}::interval)
    `;
    const withLease = await settle();
    expect(Number(withLease.leases)).toBe(Number(beforeLease.leases) + 1);
    const leaseHeld = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('lease-held'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '作者正在编辑这一章',
    });
    await refused(leaseHeld, 409, 'LEASE_HELD', 'intent');
    expect(messageOf(leaseHeld)).toBe(`章节租约由 ${author.me.user.name} 持有，不能回滚`);
    const heldDetails = detailsOf(leaseHeld) as { holder: string; expiresAt: string };
    expect(heldDetails.holder).toBe(author.me.user.name);
    expect(new Date(heldDetails.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // ⑥ 过期租约不算占用：一路走到"目标没有门禁证据"才停，说明挡住的是活的占用而不是历史行
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${chapterId}`;
    await sql`
      INSERT INTO chapter_leases (chapter_id, user_id, acquired_at, expires_at)
      VALUES (${chapterId}, ${author.me.user.id}, now() - interval '20 minutes', now() - interval '10 minutes')
    `;
    await settle();
    const staleLease = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('lease-expired'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '过期租约不该挡住回滚复核',
    });
    await refused(staleLease, 409, 'ROLLBACK_EVIDENCE_REQUIRED', 'intent');
    await sql`DELETE FROM chapter_leases WHERE chapter_id = ${chapterId}`;
    const afterLeasePhase = await settle();
    expect(afterLeasePhase.leases).toBe(beforeLease.leases);
    expect(afterLeasePhase.currentVersionId).toBe(currentVersionId);

    // ⑦ 非正典状态两侧都拒：修订中既不能申请回滚豁免，也不能直接回滚。
    //    状态检查排在租约检查之前——此时发起者手上就有活租约，文案说的仍是状态。
    const started = await call<StartRevisionResponse>(owner.cookie, 'POST', revisionPath);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('revision');
    await settle();
    const waiverNotCanon = await call<ErrorBody>(author.cookie, 'POST', waiversPath, {
      targetVersionId: v1Id,
      gateKey: 'rollback',
      reason: '修订中不能申请回滚豁免',
    });
    await refused(waiverNotCanon, 409, 'CHAPTER_NOT_CANON', 'none');
    expect(messageOf(waiverNotCanon)).toBe('只有正典章节可以申请回滚豁免');
    const rollbackNotCanon = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('not-canon'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '修订中不能直接回滚',
    });
    await refused(rollbackNotCanon, 409, 'CHAPTER_NOT_CANON', 'intent');
    expect(messageOf(rollbackNotCanon)).toBe('章节当前状态 revision，不能回滚正典');

    const abandoned = await call<AbandonRevisionResponse>(owner.cookie, 'POST', abandonPath);
    expect(abandoned.status).toBe(200);
    const canonAgain = await settle();
    expect(canonAgain.status).toBe('canon');
    expect(canonAgain.leases).toBe('0');
    expect(canonAgain.currentVersionId).toBe(currentVersionId);

    // ⑧ M2 只开 rollback 一个豁免口子：契约收六种门禁键，服务端只认回滚，
    //    这一枪在事务之前就被拒，连一条意图都不该留。
    const unsupported = await call<ErrorBody>(author.cookie, 'POST', waiversPath, {
      targetVersionId: v1Id,
      gateKey: 'ai_tone',
      reason: '其余门禁不提供豁免入口',
    });
    await refused(unsupported, 400, 'WAIVER_GATE_UNSUPPORTED', 'none');
    expect(messageOf(unsupported)).toBe('M2 仅支持回滚豁免（rollback）；其余门禁不提供豁免入口');

    // ⑨ 回滚时的豁免复核按 gate → 目标 → 状态 → 批准人 → 是否用过 的顺序来。
    //    查不到就是"不存在或不属于本章"，不区分幽灵 id 与别的章节的豁免。
    const ghostWaiver = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-ghost'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '拿一条不存在的豁免来回滚',
      waiverId: randomUUID(),
    });
    await refused(ghostWaiver, 404, 'WAIVER_NOT_FOUND', 'intent');
    expect(messageOf(ghostWaiver)).toBe('回滚豁免不存在或不属于本章');

    // 目标不符：这条豁免是给 v2 申请的，还没批准就被目标检查拦下（顺序证据）
    const forV2 = await call<WaiverView>(author.cookie, 'POST', waiversPath, {
      targetVersionId: v2Id,
      gateKey: 'rollback',
      reason: '给 v2 申请的豁免，用来验证目标不一致',
    });
    expect(forV2.status).toBe(200);
    expect(forV2.body.status).toBe('pending');
    await settle();
    const targetMismatch = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-target'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '豁免对应的是别的版本',
      waiverId: forV2.body.id,
    });
    await refused(targetMismatch, 409, 'WAIVER_TARGET_MISMATCH', 'intent');
    expect(messageOf(targetMismatch)).toBe('该豁免对应的目标版本不是本次回滚版本');

    // v1 上那条豁免已经在第 3 个用例用掉了：用掉的不挡住重新申请，新申请仍是 pending
    const forV1 = await call<WaiverView>(author.cookie, 'POST', waiversPath, {
      targetVersionId: v1Id,
      gateKey: 'rollback',
      reason: '旧豁免已用过，允许重新申请一条',
    });
    expect(forV1.status).toBe(200);
    expect(forV1.body.id).not.toBe(waiverId);
    const afterRequests = await settle();
    expect(Number(afterRequests.waivers)).toBe(Number(canonAgain.waivers) + 2);
    const pendingRollback = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-pending'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '待审批的豁免不能用来回滚',
      waiverId: forV1.body.id,
    });
    await refused(pendingRollback, 409, 'WAIVER_NOT_APPROVED', 'intent');
    expect(messageOf(pendingRollback)).toBe('该豁免状态为 pending，不能用于回滚');

    // ⑩ 批准人独立性在服务端复核：手工伪造出一条"approved"记录也过不去。
    //    申请人自己当批准人 → 拒；根本没有批准人 → 同一句拒。
    await sql`
      UPDATE waivers
      SET status = 'approved', approved_by = ${author.me.user.id},
          decided_by = ${author.me.user.id}, decided_at = now()
      WHERE id = ${forV1.body.id}
    `;
    const selfApproved = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-selfapproved'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '伪造出申请人自批的记录',
      waiverId: forV1.body.id,
    });
    await refused(selfApproved, 409, 'WAIVER_INVALID', 'intent');
    expect(messageOf(selfApproved)).toBe('豁免缺少独立批准人，不能用于回滚');

    await sql`UPDATE waivers SET approved_by = NULL WHERE id = ${forV1.body.id}`;
    const noApprover = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-noapprover'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '伪造出没有批准人的记录',
      waiverId: forV1.body.id,
    });
    await refused(noApprover, 409, 'WAIVER_INVALID', 'intent');

    // ⑪ 不是回滚豁免就不能用于回滚：gate_key 允许六种值，但复核只认 rollback，
    //    而且它排在目标与状态之前——先把批准人补成独立的人，仍然被 gate 拦下。
    await sql`
      UPDATE waivers SET gate_key = 'ai_tone', approved_by = ${lead.me.user.id}
      WHERE id = ${forV1.body.id}
    `;
    const gateMismatch = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-gate'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '拿别的门禁的豁免来回滚',
      waiverId: forV1.body.id,
    });
    await refused(gateMismatch, 409, 'WAIVER_GATE_MISMATCH', 'intent');
    expect(messageOf(gateMismatch)).toBe('该豁免不是回滚豁免');

    // ⑫ 跨章归属：在别的章节名下造一条"看起来完全合格"的豁免（同目标版本、已批准、
    //     批准人还独立），本章回滚也花不掉——复核先按本章过滤，读不到就是 404，
    //     而不是"找到了但条件不符"。
    const otherChapterRows = await sql<{ id: string }[]>`
      SELECT id FROM chapters WHERE id <> ${chapterId} AND status = 'canon' ORDER BY number LIMIT 1
    `;
    const otherChapterId = otherChapterRows[0]?.id;
    if (!otherChapterId) throw new Error('测试库缺少其他章节，无法验证豁免记录的跨章归属');
    const foreignWaiverId = randomUUID();
    await sql`
      INSERT INTO waivers (
        id, chapter_id, target_version_id, gate_key, reason, status, requested_by, approved_by
      )
      VALUES (
        ${foreignWaiverId}, ${otherChapterId}, ${v1Id}, 'rollback', '别的章节名下已批准的豁免',
        'approved', ${owner.me.user.id}, ${lead.me.user.id}
      )
    `;
    const foreignWaiver = await rollback({
      cookie: owner.cookie,
      idempotencyKey: guardKey('waiver-other-chapter'),
      targetVersionId: v1Id,
      expectedCurrentVersionId: currentVersionId,
      reason: '拿别的章节的豁免来回滚本章',
      waiverId: foreignWaiverId,
    });
    await refused(foreignWaiver, 404, 'WAIVER_NOT_FOUND', 'intent');
    expect(messageOf(foreignWaiver)).toBe('回滚豁免不存在或不属于本章');
    // 收尾要防住一种情况：若这道归属守卫被改坏，这条豁免会被真的花掉并留下引用
    await sql`UPDATE canon_versions SET waiver_id = NULL WHERE waiver_id = ${foreignWaiverId}`;
    await sql`DELETE FROM waivers WHERE id = ${foreignWaiverId}`;

    // 本节手工造的豁免记录自己收尾（事件与审计是真实历史，留着不删）
    await sql`
      DELETE FROM waivers WHERE id IN (${forV1.body.id}, ${forV2.body.id})
    `;
    const afterCleanup = await settle();
    expect(afterCleanup.waivers).toBe(entry.waivers);

    // ⑬ 十六次拒绝合起来的账：正典版本一个没多、提交一条没建、指针与状态原地不动、
    //     回滚审计与回滚事件零增量；只有确实成功的动作（两次豁免申请 + 进入/放弃修订）留下历史。
    const end = await trace();
    expect(end.status).toBe('canon');
    expect(end.currentVersionId).toBe(currentVersionId);
    expect(end.versions).toBe(entry.versions);
    expect(end.commits).toBe(entry.commits);
    expect(end.canonCurrent).toBe(entry.canonCurrent);
    expect(end.leases).toBe(entry.leases);
    expect(end.rollbackAudits).toBe(entry.rollbackAudits);
    expect(end.rollbackEvents).toBe(entry.rollbackEvents);
    expect(Number(end.events)).toBe(Number(entry.events) + 4);
    expect(Number(end.audits)).toBe(Number(entry.audits) + 4);
    expect(Number(end.intents)).toBe(Number(entry.intents) + 13);
    expect(Number(end.failedIntents)).toBe(Number(entry.failedIntents) + 13);

    // 事件与审计只增长在确实成功的动作上：两次豁免申请、进入修订、放弃修订。
    // 十六次拒绝一条事件与审计都不留——带意图的那十三次只在 commit_intents 上留失败码。
    // 豁免的审计记在 waiver 对象上、章节 id 藏在 metadata 里，所以两种归因都要算进来。
    const history = await sql<{ kind: string; n: string }[]>`
      SELECT kind, count(*)::text AS n FROM (
        SELECT 'event:' || event_type AS kind FROM events
          WHERE aggregate_id = ${chapterId} AND created_at >= ${startedAt}
        UNION ALL
        SELECT 'audit:' || action AS kind FROM audit_log
          WHERE (object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId})
            AND created_at >= ${startedAt}
      ) t GROUP BY kind
    `;
    expect(Object.fromEntries(history.map((row) => [row.kind, row.n]))).toEqual({
      'event:waiver.requested': '2',
      'audit:waiver.request': '2',
      'event:chapter.revision_started': '1',
      'audit:chapter.revision.start': '1',
      'event:chapter.revision_abandoned': '1',
      'audit:chapter.revision.abandon': '1',
    });

    // 每一次带意图的拒绝都在账上留下自己的错误码，事后能分清被拒的原因
    const codes = await sql<{ error_code: string | null; n: string }[]>`
      SELECT error_code, count(*)::text AS n FROM commit_intents
      WHERE chapter_id = ${chapterId} AND status = 'failed'
        AND idempotency_key LIKE 'm2-rb-guard-%'
      GROUP BY error_code
    `;
    expect(
      codes.map((row) => [row.error_code, row.n]).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        ['CHAPTER_NOT_CANON', '1'],
        ['CONCURRENT_COMMIT', '1'],
        ['LEASE_HELD', '1'],
        ['ROLLBACK_EVIDENCE_REQUIRED', '1'],
        ['ROLLBACK_TARGET_CURRENT', '1'],
        ['VERSION_NOT_FOUND', '1'],
        ['WAIVER_GATE_MISMATCH', '1'],
        ['WAIVER_INVALID', '2'],
        ['WAIVER_NOT_APPROVED', '1'],
        ['WAIVER_NOT_FOUND', '2'],
        ['WAIVER_TARGET_MISMATCH', '1'],
      ].sort((a, b) => String(a).localeCompare(String(b))),
    );

    // 界面上读到的仍是第 6 版正典；豁免列表只剩本节开始时就有的两条——
    // 第 3 个用例批准并已使用的那条，和它驳回的那条。本节手工申请的两条已收尾，
    // 伪造出来的 approved / ai_tone 状态没有一条留在视图里。
    const detail = await getChapter(owner.cookie);
    expect(detail.currentVersion?.versionNo).toBe(6);
    expect(detail.waivers.map((waiver) => waiver.status).sort()).toEqual(['approved', 'rejected']);
    const used = detail.waivers.find((waiver) => waiver.id === waiverId);
    expect(used?.status).toBe('approved');
    expect(used?.targetVersionId).toBe(v1Id);
  });

  it('提交链的四道复核：目标章节要一致、暂存要属本章且是最新一份、门禁证据的上下文不能变', async () => {
    const SIBLING_TITLE = 'M2 提交链兄弟章节';
    const startedAt = new Date();

    interface Trace {
      versions: string;
      commits: string;
      canonCurrent: string;
      intents: string;
      failedIntents: string;
      drafts: string;
      evaluations: string;
      staged: string;
      leases: string;
      events: string;
      audits: string;
      status: string;
      currentVersionId: string | null;
    }

    async function trace(): Promise<Trace> {
      const rows = await sql<Trace[]>`
        SELECT
          (SELECT count(*)::text FROM canon_versions WHERE chapter_id = ${chapterId}) AS versions,
          (SELECT count(*)::text FROM commits WHERE chapter_id = ${chapterId}) AS commits,
          (SELECT count(*)::text FROM canon_current WHERE chapter_id = ${chapterId}) AS "canonCurrent",
          (SELECT count(*)::text FROM commit_intents WHERE chapter_id = ${chapterId}) AS "intents",
          (SELECT count(*)::text FROM commit_intents
             WHERE chapter_id = ${chapterId} AND status = 'failed') AS "failedIntents",
          (SELECT count(*)::text FROM draft_revisions dr
             JOIN draft_branches b ON b.id = dr.branch_id
             WHERE b.chapter_id = ${chapterId}) AS drafts,
          (SELECT count(*)::text FROM gate_evaluations WHERE chapter_id = ${chapterId}) AS evaluations,
          (SELECT count(*)::text FROM staged_drafts WHERE chapter_id = ${chapterId}) AS staged,
          (SELECT count(*)::text FROM chapter_leases WHERE chapter_id = ${chapterId}) AS leases,
          (SELECT count(*)::text FROM events
             WHERE aggregate_type = 'chapter' AND aggregate_id = ${chapterId}) AS events,
          (SELECT count(*)::text FROM audit_log
             WHERE object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId}) AS audits,
          (SELECT status FROM chapters WHERE id = ${chapterId}) AS status,
          (SELECT current_version_id::text FROM chapters WHERE id = ${chapterId}) AS "currentVersionId"
      `;
      return rows[0]!;
    }

    function guardKey(name: string): string {
      return `m2-cb-guard-${name}-${randomUUID().slice(0, 8)}`;
    }

    function messageOf(result: ApiResult<unknown>): string {
      return (result.body as ErrorBody).error.message;
    }

    let ledger = await trace();

    // 每次拒绝之前先重新取一次基线：拒绝前后的差才是"这次拒绝留下的写痕"，
    // 我自己前面那几步（修订、租约、草稿、门禁）本来就该写行。
    async function settle(): Promise<Trace> {
      ledger = await trace();
      return ledger;
    }

    // 和 §十六/§十七 同一套纪律：一次拒绝除了自己的提交意图（如果那条路径留意图行）
    // 什么都不许留下——草稿、证据、暂存、事件、审计、正典版本、指针、状态全部逐项相同。
    async function refused(
      result: ApiResult<unknown>,
      status: number,
      code: string,
      intent: 'intent' | 'none',
    ): Promise<void> {
      expectError(result, status, code);
      const after = await trace();
      expect({ ...after, intents: ledger.intents, failedIntents: ledger.failedIntents }).toEqual(
        ledger,
      );
      if (intent === 'intent') {
        expect(Number(after.intents)).toBe(Number(ledger.intents) + 1);
        expect(Number(after.failedIntents)).toBe(Number(ledger.failedIntents) + 1);
      } else {
        expect(after.intents).toBe(ledger.intents);
        expect(after.failedIntents).toBe(ledger.failedIntents);
      }
      ledger = after;
    }

    async function commit(input: {
      idempotencyKey: string;
      stagedDraftId: string;
      expectedCurrentVersionId: string | null;
      targetChapterId?: string;
    }): Promise<ApiResult<CommitResponse>> {
      return call<CommitResponse>(owner.cookie, 'POST', `/api/chapters/${chapterId}/commit`, {
        idempotencyKey: input.idempotencyKey,
        targetChapterId: input.targetChapterId ?? chapterId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        stagedDraftId: input.stagedDraftId,
      });
    }

    // 一次完整的「修订 → 租约 → 草稿 → 门禁 → 暂存」，返回这份暂存行的 id
    async function reviseAndStage(content: string): Promise<string> {
      expect((await call(owner.cookie, 'POST', `/api/chapters/${chapterId}/revision`)).status).toBe(
        200,
      );
      expect((await call(owner.cookie, 'POST', `/api/chapters/${chapterId}/lease`)).status).toBe(
        200,
      );
      const saved = await call<SaveDraftResponse>(
        owner.cookie,
        'PUT',
        `/api/chapters/${chapterId}/draft`,
        { content },
      );
      expect(saved.status).toBe(200);
      return gateAndStage(saved.body.draft.contentHash);
    }

    // 只重跑门禁并再暂存一次（正文不动）——用来证明"过期"不是"一律不许"。
    // 被拒的那次提交不会替我取消暂存，而 stageDraft 只收 writing/revision/commit_failed
    // （chapter-service.ts:615-624），所以恢复路径是：取消暂存 → 重跑门禁 → 再暂存。
    async function regateAndStage(): Promise<string> {
      const saved = await call<ChapterDetail>(owner.cookie, 'GET', `/api/chapters/${chapterId}`);
      expect(saved.status).toBe(200);
      if (saved.body.status === 'staged') {
        expect(
          (await call(owner.cookie, 'DELETE', `/api/chapters/${chapterId}/stage`)).status,
        ).toBe(200);
      }
      const draftHash = saved.body.draft?.contentHash;
      if (!draftHash) throw new Error('本章当前没有草稿，无法重跑门禁');
      return gateAndStage(draftHash);
    }

    async function gateAndStage(expectedContentHash: string): Promise<string> {
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
        { evaluationId: evaluation.body.id, expectedContentHash },
      );
      expect(staged.status).toBe(200);
      return staged.body.stagedDraft.id;
    }

    // 门禁上下文哈希吃的是工作区的 settings_version / ledger_version（chapter-data.ts:70），
    // 发布一条设定条目就是真实用户能走到的"上下文变了"。
    let settingId = '';
    async function publishSetting(summary: string): Promise<void> {
      if (!settingId) {
        const created = await call<{ id: string; draftVersion?: { id: string } | null }>(
          owner.cookie,
          'POST',
          '/api/ledger/entries',
          {
            kind: 'setting',
            name: SETTING_NAME,
            aliases: ['更鼓封印'],
            summary: '封印必须在下一声更鼓之前完成',
            payload: { category: 'rule', details: '门框上的封印吃的是施术者的血。', tags: ['封印'] },
          },
        );
        expect(created.status).toBe(200);
        settingId = created.body.id;
        const published = await call(
          owner.cookie,
          'POST',
          `/api/ledger/entries/${settingId}/publish`,
          { expectedDraftVersionId: created.body.draftVersion?.id, changeSummary: '首次发布' },
        );
        expect(published.status).toBe(200);
        return;
      }
      const drafted = await call<{ draftVersion?: { id: string } | null }>(
        owner.cookie,
        'PUT',
        `/api/ledger/entries/${settingId}/draft`,
        { expectedDraftVersionId: null, summary, changeSummary: '改一笔设定' },
      );
      expect(drafted.status).toBe(200);
      const published = await call(
        owner.cookie,
        'POST',
        `/api/ledger/entries/${settingId}/publish`,
        { expectedDraftVersionId: drafted.body.draftVersion?.id, changeSummary: '第二次发布' },
      );
      expect(published.status).toBe(200);
    }

    // ② 需要一个"属于别的章的真实暂存行"：commit_intents.staged_draft_id 是指向
    //    staged_drafts 的外键（0000_init.sql:162），随手编的 uuid 会先崩在意图行插入上，
    //    根本走不到那句 409——和 §十七 的 VERSION_NOT_FOUND 是同一类探针形状。
    const sibling = randomUUID();
    for (const row of await sql<{ id: string }[]>`SELECT id FROM chapters WHERE title = ${SIBLING_TITLE}`) {
      await cleanupChapter(row.id);
    }
    // 设定条目名/别名有唯一约束，上一次失败运行留下的同名条目会让 create 直接撞
    // LEDGER_NAME_CONFLICT，所以和兄弟章节一样先按名字扫一遍。
    const SETTING_NAME = '封印规则';
    async function removeSettingEntry(id: string): Promise<void> {
      await sql`DELETE FROM outbox WHERE payload ->> 'entryId' = ${id}`;
      await sql`DELETE FROM ledger_index_status WHERE entry_id = ${id}`;
      await sql`DELETE FROM events WHERE aggregate_id = ${id}`;
      await sql`DELETE FROM audit_log WHERE object_id = ${id}`;
      await sql`DELETE FROM ledger_entries WHERE id = ${id}`;
    }
    for (const row of await sql<{ id: string }[]>`
      SELECT id FROM ledger_entries WHERE name = ${SETTING_NAME} OR ${SETTING_NAME} = ANY(aliases)
    `) {
      await removeSettingEntry(row.id);
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
    const siblingWordCount = countWords(importedContent);
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (
        ${sibling}, ${location.work_id}, ${location.volume_id}, ${TEST_NUMBER + 2},
        ${SIBLING_TITLE}, 'canon', ${sql.json(jsonValue(plan))}
      )
    `;
    const siblingVersion = randomUUID();
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count,
        parent_version_id, source, actor_id
      )
      VALUES (
        ${siblingVersion}, ${sibling}, 1, ${importedContent}, ${sha256(importedContent)},
        ${siblingWordCount}, NULL, 'import', ${owner.me.user.id}
      )
    `;
    await sql`UPDATE chapters SET current_version_id = ${siblingVersion} WHERE id = ${sibling}`;
    await sql`INSERT INTO canon_current (chapter_id, version_id) VALUES (${sibling}, ${siblingVersion})`;
    await sql`INSERT INTO chapter_metadata (chapter_id, word_count) VALUES (${sibling}, ${siblingWordCount})`;
    await sql`
      INSERT INTO index_status (chapter_id, version_id, status, detail)
      VALUES (${sibling}, ${siblingVersion}, 'not_configured', 'M2 提交链兄弟章节，未接入索引')
    `;

    // 起点：上一个用例结束时本章是 canon、指针指第 6 版、没有租约
    const entry = await settle();
    expect(entry.status).toBe('canon');
    expect(entry.leases).toBe('0');
    expect(Number(entry.versions)).toBe(6);
    const startVersionId = entry.currentVersionId;

    // 兄弟章节走一遍真实流程，只为了拿到它那条暂存行（先开修订、再取租约）
    expect(
      (await call(owner.cookie, 'POST', `/api/chapters/${sibling}/revision`)).status,
    ).toBe(200);
    expect((await call(owner.cookie, 'POST', `/api/chapters/${sibling}/lease`)).status).toBe(200);
    const siblingDraft = await call<SaveDraftResponse>(
      owner.cookie,
      'PUT',
      `/api/chapters/${sibling}/draft`,
      { content: contentA },
    );
    expect(siblingDraft.status).toBe(200);
    const siblingEvaluation = await call<GateEvaluationView>(
      owner.cookie,
      'POST',
      `/api/chapters/${sibling}/gates`,
    );
    expect(siblingEvaluation.status).toBe(200);
    expect(siblingEvaluation.body.status).toBe('passed');
    const siblingStaged = await call<StageResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${sibling}/stage`,
      {
        evaluationId: siblingEvaluation.body.id,
        expectedContentHash: siblingDraft.body.draft.contentHash,
      },
    );
    expect(siblingStaged.status).toBe(200);

    // 本章先暂存一份（A），后面两次拒绝都围着它转
    const stagedA = await reviseAndStage(contentB);

    // ① 目标章节必须和路径里的章节一致：这句守卫排在意图行插入之前（commit-service.ts:75），
    //     所以它是本节唯一一句"连意图行都不留"的提交拒绝——回滚那边正相反，意图行先写。
    await settle();
    const mismatch = await commit({
      idempotencyKey: guardKey('target'),
      stagedDraftId: stagedA,
      expectedCurrentVersionId: startVersionId,
      targetChapterId: sibling,
    });
    await refused(mismatch, 400, 'TARGET_MISMATCH', 'none');
    expect(messageOf(mismatch)).toBe('提交目标章节与当前章节不一致');

    // ② 暂存行必须属于本章：拿兄弟章节那条真暂存行来提交本章
    await settle();
    const foreignStaged = await commit({
      idempotencyKey: guardKey('staged-foreign'),
      stagedDraftId: siblingStaged.body.stagedDraft.id,
      expectedCurrentVersionId: startVersionId,
    });
    await refused(foreignStaged, 409, 'STAGED_DRAFT_NOT_FOUND', 'intent');
    expect(messageOf(foreignStaged)).toBe('暂存草稿不存在或不属于本章');

    // ③ 暂存行还必须是本章最新的一份：取消暂存→改草稿→重新门禁→再暂存（B），
    //     然后拿旧的 A 去提交。取消暂存不删 A 行（§十六 已钉），所以"最新"只能靠比较得出。
    expect(
      (await call(owner.cookie, 'DELETE', `/api/chapters/${chapterId}/stage`)).status,
    ).toBe(200);
    const savedB = await call<SaveDraftResponse>(
      owner.cookie,
      'PUT',
      `/api/chapters/${chapterId}/draft`,
      { content: contentA },
    );
    expect(savedB.status).toBe(200);
    const evaluationB = await call<GateEvaluationView>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/gates`,
    );
    expect(evaluationB.body.status).toBe('passed');
    const stagedBResult = await call<StageResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/stage`,
      {
        evaluationId: evaluationB.body.id,
        expectedContentHash: savedB.body.draft.contentHash,
      },
    );
    expect(stagedBResult.status).toBe(200);
    await settle();
    const staleCommit = await commit({
      idempotencyKey: guardKey('stale'),
      stagedDraftId: stagedA,
      expectedCurrentVersionId: startVersionId,
    });
    await refused(staleCommit, 409, 'STAGED_DRAFT_STALE', 'intent');
    expect(messageOf(staleCommit)).toBe('该暂存草稿已被更新的暂存覆盖');

    // 换成最新那份就能提交：这道闸管的是"是不是最新"，不是一律不许提交
    const commitV7 = await commit({
      idempotencyKey: guardKey('ok-v7'),
      stagedDraftId: stagedBResult.body.stagedDraft.id,
      expectedCurrentVersionId: startVersionId,
    });
    expect(commitV7.status).toBe(200);
    expect(commitV7.body.alreadyCommitted).toBe(false);
    expect(commitV7.body.versionNo).toBe(7);
    const v7Id = commitV7.body.versionId;
    ledger = await trace();
    expect(ledger.status).toBe('canon');
    expect(ledger.currentVersionId).toBe(v7Id);
    expect(Number(ledger.versions)).toBe(7);
    // 提交成功会带走租约（commit-service.ts:278），后面每一步都要重新取
    expect(ledger.leases).toBe('0');

    // ④ 门禁证据的上下文不能变（提交处）：暂存之后发布一条设定条目，
    //     工作区 settings_version +1，contextHashOf 跟着变，旧证据当场失效。
    const stagedC = await reviseAndStage(contentB);
    await publishSetting('封印必须在下一声更鼓之前完成。');
    await settle();
    const contextChanged = await commit({
      idempotencyKey: guardKey('context'),
      stagedDraftId: stagedC,
      expectedCurrentVersionId: v7Id,
    });
    await refused(contextChanged, 409, 'CONTEXT_CHANGED', 'intent');
    expect(messageOf(contextChanged)).toBe('设定或规则版本已变化，请重新跑门禁');

    // 重跑门禁 + 重新暂存就能提交——证据不是坏了，是过期了
    const stagedD = await regateAndStage();
    const commitV8 = await commit({
      idempotencyKey: guardKey('ok-v8'),
      stagedDraftId: stagedD,
      expectedCurrentVersionId: v7Id,
    });
    expect(commitV8.status).toBe(200);
    expect(commitV8.body.versionNo).toBe(8);
    const v8Id = commitV8.body.versionId;
    ledger = await trace();
    expect(Number(ledger.versions)).toBe(8);
    expect(ledger.currentVersionId).toBe(v8Id);

    // ⑤ 同一个码在暂存处还有一句（chapter-service.ts:645）：错误码筛子只数"码有没有被断过"，
    //     命中不等于每个抛出点都测过，所以两个抛出点各钉一次。暂存不在提交链上，没有意图行可留。
    expect(
      (
        await call(owner.cookie, 'POST', `/api/chapters/${chapterId}/revision`)
      ).status,
    ).toBe(200);
    expect(
      (await call(owner.cookie, 'POST', `/api/chapters/${chapterId}/lease`)).status,
    ).toBe(200);
    const savedE = await call<SaveDraftResponse>(
      owner.cookie,
      'PUT',
      `/api/chapters/${chapterId}/draft`,
      { content: contentA },
    );
    expect(savedE.status).toBe(200);
    const evaluationE = await call<GateEvaluationView>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/gates`,
    );
    expect(evaluationE.body.status).toBe('passed');
    await publishSetting('封印吃的是施术者的血，代价不可转让。');
    await settle();
    const stageRefused = await call<StageResponse>(
      owner.cookie,
      'POST',
      `/api/chapters/${chapterId}/stage`,
      {
        evaluationId: evaluationE.body.id,
        expectedContentHash: savedE.body.draft.contentHash,
      },
    );
    await refused(stageRefused, 409, 'CONTEXT_CHANGED', 'none');
    expect(messageOf(stageRefused)).toBe('设定或规则版本已变化，请重新跑门禁');

    // 重跑门禁后暂存成功，再取消暂存、放弃修订，把章节放回 canon 且不留租约
    const stagedF = await regateAndStage();
    expect(stagedF).toBeTruthy();
    expect(
      (await call(owner.cookie, 'DELETE', `/api/chapters/${chapterId}/stage`)).status,
    ).toBe(200);
    expect(
      (await call(owner.cookie, 'POST', `/api/chapters/${chapterId}/revision/abandon`)).status,
    ).toBe(200);

    // 合起来的账（相对本节开始时的 entry）：正典版本 +2（第 7、8 版）、提交 +2、
    // canon_current 仍是每章一行；意图 +5 = 三次带意图的拒绝 + 两次成功提交，
    // 其中三条失败、两条 committed；租约回到零；草稿/证据/暂存的每一次增长都各自归到
    // 一个确实成功的动作上，五次拒绝一条事件与审计都不留。
    //
    // 顺序要求：这几笔账必须在收尾清理之前读。cleanupChapter 连带删除"挂在别的章节名下、
    // 指向本章暂存行"的提交意图——步骤②那条证据正是这样被吃掉过一次（先清后读会少一行）。
    const end = await trace();
    expect(end.status).toBe('canon');
    expect(end.currentVersionId).toBe(v8Id);
    expect(Number(end.versions)).toBe(Number(entry.versions) + 2);
    expect(Number(end.commits)).toBe(Number(entry.commits) + 2);
    expect(end.canonCurrent).toBe(entry.canonCurrent);
    expect(end.leases).toBe('0');
    expect(Number(end.intents)).toBe(Number(entry.intents) + 5);
    expect(Number(end.failedIntents)).toBe(Number(entry.failedIntents) + 3);
    expect(Number(end.drafts)).toBe(Number(entry.drafts) + 7);
    expect(Number(end.evaluations)).toBe(Number(entry.evaluations) + 6);
    expect(Number(end.staged)).toBe(Number(entry.staged) + 5);
    expect(Number(end.events)).toBe(Number(entry.events) + 14);
    expect(Number(end.audits)).toBe(Number(entry.audits) + 14);

    // 事件与审计只长在这一步之前那次成功的提交上：暂存被上下文闸拒掉的那一次
    // 一条事件、一条审计都不留（refused 已经逐项比过整表）。
    const leftover = await sql<{ kind: string; n: string }[]>`
      SELECT kind, count(*)::text AS n FROM (
        SELECT 'event:' || event_type AS kind FROM events
          WHERE aggregate_id = ${chapterId} AND created_at >= ${startedAt}
        UNION ALL
        SELECT 'audit:' || action AS kind FROM audit_log
          WHERE (object_id = ${chapterId} OR metadata ->> 'chapterId' = ${chapterId})
            AND created_at >= ${startedAt}
      ) t GROUP BY kind
    `;
    expect(Object.fromEntries(leftover.map((row) => [row.kind, row.n]))).toEqual({
      'event:chapter.revision_started': '3',
      'audit:chapter.revision.start': '3',
      'event:chapter.revision_abandoned': '1',
      'audit:chapter.revision.abandon': '1',
      'event:chapter.staged': '5',
      'audit:chapter.stage': '5',
      'event:chapter.unstaged': '3',
      'audit:chapter.unstage': '3',
      'event:chapter.committed': '2',
      'audit:chapter.commit': '2',
    });

    // 每次带意图的拒绝都在账上留下自己的码；两次成功提交记成 committed
    const codes = await sql<{ error_code: string | null; status: string; n: string }[]>`
      SELECT error_code, status, count(*)::text AS n FROM commit_intents
      WHERE chapter_id = ${chapterId} AND idempotency_key LIKE 'm2-cb-guard-%'
      GROUP BY error_code, status
    `;
    expect(
      codes
        .map((row) => [`${row.status}:${row.error_code ?? '-'}`, row.n])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['committed:-', '2'],
      ['failed:CONTEXT_CHANGED', '1'],
      ['failed:STAGED_DRAFT_NOT_FOUND', '1'],
      ['failed:STAGED_DRAFT_STALE', '1'],
    ]);

    // 收尾：兄弟章节与本次的设定条目都不许留下痕迹
    await cleanupChapter(sibling);
    if (settingId) {
      await removeSettingEntry(settingId);
    }

    // 整库层面再钉一次：兄弟章节、设定条目都清零，且兄弟章节那种"走真实流程"的
    // 夹具不留暂存/门禁证据/草稿分支/正典版本孤儿——这几张表原来不在清理清单里。
    const residue = await sql<{
      chapters: string;
      entries: string;
      outbox: string;
      siblingVersions: string;
      siblingStaged: string;
      siblingEvaluations: string;
      siblingBranches: string;
    }[]>`
      SELECT
        (SELECT count(*)::text FROM chapters WHERE title = ${SIBLING_TITLE}) AS chapters,
        (SELECT count(*)::text FROM ledger_entries WHERE name = ${SETTING_NAME}) AS entries,
        (SELECT count(*)::text FROM outbox WHERE event_type = 'index.ledger') AS outbox,
        (SELECT count(*)::text FROM canon_versions
           WHERE chapter_id = ${sibling}) AS "siblingVersions",
        (SELECT count(*)::text FROM staged_drafts
           WHERE chapter_id = ${sibling}) AS "siblingStaged",
        (SELECT count(*)::text FROM gate_evaluations
           WHERE chapter_id = ${sibling}) AS "siblingEvaluations",
        (SELECT count(*)::text FROM draft_branches
           WHERE chapter_id = ${sibling}) AS "siblingBranches"
    `;
    expect(residue[0]).toEqual({
      chapters: '0',
      entries: '0',
      outbox: '0',
      siblingVersions: '0',
      siblingStaged: '0',
      siblingEvaluations: '0',
      siblingBranches: '0',
    });

    // 界面上读到的仍是第 8 版正典，且没有残留的暂存草稿
    const detail = await getChapter(owner.cookie);
    expect(detail.currentVersion?.versionNo).toBe(8);
    expect(detail.stagedDraft).toBeNull();
    expect(detail.status).toBe('canon');
  });
});

afterAll(async () => {
  if (!dbAvailable) await closeDb();
});
