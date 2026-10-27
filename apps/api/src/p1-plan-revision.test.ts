import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  ChapterDetail,
  ChapterListItem,
  CommitResponse,
  GateEvaluationView,
  MeResponse,
  RollbackResponse,
  SaveDraftResponse,
  StageResponse,
  StartRevisionResponse,
} from '@yunshuo/contracts';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { countWords, sha256, toGatePlan, type ChapterPlanDocument } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from './auth.js';
import { hashPassword } from './passwords.js';
import { buildServer } from './server.js';
import { contextHashOf, loadChapter, loadRuleset } from './services/chapter-data.js';
import { updateChapterPlan } from './services/plan-service.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_SUFFIX = `@p1-plan-${RUN_ID}.test`;
const PASSWORD = `p1-plan-pass-${randomUUID()}`;
const WORKSPACE_NAME = `章纲版本测试 ${RUN_ID}`;
const WORK_TITLE = `章纲测试作品 ${RUN_ID}`;

const GATE_CONTENT_A = `旧城的雨没有停。林默把最后一张封印符按进门框，指尖的血线已经凝住。他听见巷口传来追兵的马蹄声，知道封印必须在下一声更鼓之前完成。

他把铜钉一枚枚钉进门槛，嘴里默数。门后是整条街的灯火，也是他不能退让的理由。追兵撞开第一道木栅时，封印只差最后一角。林默没有回头，他咬破指尖，把血按在符心。

雨声忽然静了一瞬。门楣上的旧漆裂开，一道暗金色的纹路顺着门框爬满整条街。追兵停在巷口，像被一堵看不见的墙挡住。林默扶住门框，终于听见更鼓响起。

更鼓过后，街角的雨水倒流回檐下。林默低头看见自己的影子被门框上的金光拉得很长。他知道追兵不会就此放弃，下一次来的，或许不只是人。

雨又落下来，落在封印之上。他完成了封印，也知道这只是开始？`;

const GATE_CONTENT_B = `${GATE_CONTENT_A}

更鼓声里，林默把最后一枚铜钉收入袖中。追兵退去，封印仍在，他知道明天的雨会更冷，也知道封印还能撑多久？`;

const EMPTY_DOC: ChapterPlanDocument = {
  summary: '',
  beats: [],
  requiredEntities: [],
  goalKeywords: [],
  obstacleKeywords: [],
};

const GATE_PLAN: ChapterPlanDocument = {
  summary: '林默在更鼓前完成封印，暂时挡住追兵。',
  beats: ['追兵逼近旧城', '林默逐一钉下封印符', '更鼓响起，封印成形'],
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Session {
  cookie: string;
  me: MeResponse;
}

interface ApiResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface PlanStateBody {
  plan: ChapterPlanDocument;
  planRevision: number;
  bodyNeedsRevision: boolean;
  markedPlanRevision: number | null;
  markedCanonVersionId: string | null;
  planUpdatedAt: string | null;
}

interface RevisionsBody {
  revisions: {
    revision: number;
    plan: ChapterPlanDocument;
    bodyPolicy: 'plan_only' | 'mark_body_for_revision' | null;
    canonVersionId: string | null;
    createdBy: string | null;
    createdByName: string | null;
    createdAt: string;
  }[];
  hasMore: boolean;
}

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('章纲版本测试跳过：数据库不可用，请先启动 db 并执行迁移/种子。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;
const passwordHash = dbAvailable ? await hashPassword(PASSWORD) : '';

suite('P1 章纲版本与正文待改标记', () => {
  let app: FastifyInstance;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let workId = '';
  let volumeId = '';
  let owner: Session;
  let reviewer: Session;
  let viewer: Session;
  let billing: Session;
  let otherOwner: Session;

  let plannedId = '';
  let canonId = '';
  let canonVersionId = '';
  let hashChapterId = '';
  let commitChapterId = '';

  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  async function login(email: string): Promise<Session> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof raw !== 'string') throw new Error(`登录 ${email} 未返回会话 Cookie`);
    return { cookie: raw.split(';')[0]!, me: response.json() as MeResponse };
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    workspaceIds.push(id);
    await sql`INSERT INTO workspaces (id, name) VALUES (${id}, ${name})`;
    return id;
  }

  async function createUser(
    targetWorkspaceId: string,
    email: string,
    name: string,
    role: string,
  ): Promise<string> {
    const id = randomUUID();
    userIds.push(id);
    await sql`
      INSERT INTO users (id, email, name, password_hash, password_updated_at)
      VALUES (${id}, ${email}, ${name}, ${passwordHash}, now())
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${targetWorkspaceId}, ${id}, ${role})
    `;
    return id;
  }

  async function call<T>(
    session: Session,
    method: Method,
    url: string,
    payload?: object,
  ): Promise<ApiResult<T>> {
    const response = await app.inject({
      method,
      url,
      headers: { cookie: session.cookie },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() as T };
  }

  function expectError(result: ApiResult<unknown>, status: number, code: string): ErrorBody {
    expect(result.status).toBe(status);
    const body = result.body as ErrorBody;
    expect(body.error.code).toBe(code);
    return body;
  }

  async function createChapter(input: {
    number: number;
    title: string;
    plan?: ChapterPlanDocument;
    canonContent?: string;
  }): Promise<{ id: string; versionId: string | null }> {
    const id = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (
        ${id}, ${workId}, ${volumeId}, ${input.number}, ${input.title}, 'planned',
        ${sql.json(jsonValue(toGatePlan(input.plan ?? EMPTY_DOC)))}
      )
    `;
    await sql`
      UPDATE chapters
      SET plan_summary = ${input.plan?.summary ?? ''},
          plan_beats = ${sql.json(input.plan?.beats ?? [])}
      WHERE id = ${id}
    `;
    if (!input.canonContent) return { id, versionId: null };

    const versionId = randomUUID();
    const content = input.canonContent;
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source, actor_id
      )
      VALUES (
        ${versionId}, ${id}, 1, ${content}, ${sha256(content)}, ${countWords(content)},
        'import', ${owner.me.user.id}
      )
    `;
    await sql`
      UPDATE chapters
      SET status = 'canon', current_version_id = ${versionId}, updated_at = now()
      WHERE id = ${id}
    `;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${id}, ${versionId})
    `;
    return { id, versionId };
  }

  interface ChapterSnapshotRow {
    plan: Record<string, string[]>;
    plan_summary: string;
    plan_beats: string[];
    plan_revision: number;
    plan_updated_at: Date | string | null;
    body_needs_revision: boolean;
    marked_plan_revision: number | null;
    marked_canon_version_id: string | null;
    current_version_id: string | null;
    updated_at: Date | string;
  }

  interface ChapterSnapshot {
    plan: Record<string, string[]>;
    plan_summary: string;
    plan_beats: string[];
    plan_revision: number;
    plan_updated_at: string | null;
    body_needs_revision: boolean;
    marked_plan_revision: number | null;
    marked_canon_version_id: string | null;
    current_version_id: string | null;
    updated_at: string;
  }

  function toIso(value: Date | string): string {
    return new Date(value).toISOString();
  }

  async function snapshot(chapterId: string): Promise<ChapterSnapshot> {
    const rows = await sql<ChapterSnapshotRow[]>`
      SELECT
        plan, plan_summary, plan_beats, plan_revision, plan_updated_at,
        body_needs_revision, marked_plan_revision, marked_canon_version_id,
        current_version_id, updated_at
      FROM chapters WHERE id = ${chapterId}
    `;
    const row = rows[0]!;
    return {
      ...row,
      plan_updated_at: row.plan_updated_at === null ? null : toIso(row.plan_updated_at),
      updated_at: toIso(row.updated_at),
    };
  }

  async function revisionRows(chapterId: string): Promise<
    { revision: number; body_policy: string | null; canon_version_id: string | null }[]
  > {
    return sql`
      SELECT revision, body_policy, canon_version_id
      FROM chapter_plan_revisions
      WHERE chapter_id = ${chapterId}
      ORDER BY revision ASC
    `;
  }

  async function eventRows(
    chapterId: string,
  ): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
    return sql`
      SELECT event_type, payload
      FROM events
      WHERE aggregate_type = 'chapter' AND aggregate_id = ${chapterId}
      ORDER BY id ASC
    `;
  }

  async function auditRows(
    chapterId: string,
  ): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
    return sql`
      SELECT action, metadata
      FROM audit_log
      WHERE object_id = ${chapterId}
      ORDER BY id ASC
    `;
  }

  async function putPlan(
    session: Session,
    chapterId: string,
    plan: ChapterPlanDocument,
    basePlanRevision: number,
    bodyPolicy?: 'plan_only' | 'mark_body_for_revision',
  ): Promise<ApiResult<PlanStateBody>> {
    return call<PlanStateBody>(session, 'PUT', `/api/chapters/${chapterId}/plan`, {
      plan,
      basePlanRevision,
      ...(bodyPolicy === undefined ? {} : { bodyPolicy }),
    });
  }

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'silent';
    app = await buildServer();

    workspaceId = await createWorkspace(WORKSPACE_NAME);
    otherWorkspaceId = await createWorkspace(`章纲隔离 ${RUN_ID}`);

    await createUser(workspaceId, `owner${EMAIL_SUFFIX}`, '章纲所有者', 'owner');
    await createUser(workspaceId, `reviewer${EMAIL_SUFFIX}`, '章纲审阅', 'reviewer');
    await createUser(workspaceId, `viewer${EMAIL_SUFFIX}`, '章纲只读', 'viewer');
    await createUser(workspaceId, `billing${EMAIL_SUFFIX}`, '章纲计费', 'billing');
    await createUser(otherWorkspaceId, `other${EMAIL_SUFFIX}`, '章纲隔离者', 'owner');

    owner = await login(`owner${EMAIL_SUFFIX}`);
    reviewer = await login(`reviewer${EMAIL_SUFFIX}`);
    viewer = await login(`viewer${EMAIL_SUFFIX}`);
    billing = await login(`billing${EMAIL_SUFFIX}`);
    otherOwner = await login(`other${EMAIL_SUFFIX}`);
    expect(owner.me.workspace.id).toBe(workspaceId);
    expect(otherOwner.me.workspace.id).toBe(otherWorkspaceId);

    workId = randomUUID();
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${workId}, ${workspaceId}, ${WORK_TITLE})
    `;
    volumeId = randomUUID();
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '第一卷')
    `;

    ({ id: plannedId } = await createChapter({ number: 1, title: '尚无正典' }));
    const canonChapter = await createChapter({
      number: 2,
      title: '已成正典',
      canonContent: '旧城的雨下了七天。林默把最后一张封印符按进门框。',
    });
    canonId = canonChapter.id;
    canonVersionId = canonChapter.versionId!;
    ({ id: hashChapterId } = await createChapter({
      number: 3,
      title: '哈希对照',
      plan: GATE_PLAN,
    }));

    const commitChapter = await createChapter({
      number: 4,
      title: '提交链对照',
      plan: GATE_PLAN,
    });
    commitChapterId = commitChapter.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!dbAvailable) {
      await closeDb();
      return;
    }
    for (const id of userIds) {
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
      await sql`DELETE FROM memberships WHERE user_id = ${id}`;
    }
    for (const id of workspaceIds) {
      const chapters = await sql<{ id: string }[]>`
        SELECT c.id FROM chapters c JOIN works w ON w.id = c.work_id
        WHERE w.workspace_id = ${id}
      `;
      for (const chapter of chapters) {
        await sql`DELETE FROM commits WHERE chapter_id = ${chapter.id}`;
        await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${chapter.id}`;
      }
      await sql`DELETE FROM workspaces WHERE id = ${id}`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    await closeDb();
  });

  it('planned 章首次保存：revision 0 → 1，计划落库且不建草稿/正典', async () => {
    const before = await call<ChapterDetail>(owner, 'GET', `/api/chapters/${plannedId}`);
    expect(before.status).toBe(200);
    expect(before.body.planRevision).toBe(0);
    expect(before.body.planUpdatedAt).toBeNull();
    expect(before.body.bodyNeedsRevision).toBe(false);
    expect(before.body.plan).toEqual(EMPTY_DOC);

    const saved = await putPlan(owner, plannedId, GATE_PLAN, 0);
    expect(saved.status).toBe(200);
    expect(saved.body.planRevision).toBe(1);
    expect(saved.body.plan).toEqual(GATE_PLAN);
    expect(saved.body.bodyNeedsRevision).toBe(false);
    expect(saved.body.markedPlanRevision).toBeNull();
    expect(saved.body.markedCanonVersionId).toBeNull();
    expect(typeof saved.body.planUpdatedAt).toBe('string');

    const row = await snapshot(plannedId);
    expect(row.plan).toEqual({
      requiredEntities: GATE_PLAN.requiredEntities,
      goalKeywords: GATE_PLAN.goalKeywords,
      obstacleKeywords: GATE_PLAN.obstacleKeywords,
    });
    expect(row.plan_summary).toBe(GATE_PLAN.summary);
    expect(row.plan_beats).toEqual(GATE_PLAN.beats);
    expect(row.plan_revision).toBe(1);

    const revisions = await revisionRows(plannedId);
    expect(revisions).toEqual([{ revision: 1, body_policy: null, canon_version_id: null }]);

    const drafts = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM draft_branches WHERE chapter_id = ${plannedId}
    `;
    const versions = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM canon_versions WHERE chapter_id = ${plannedId}
    `;
    expect(drafts[0]!.n).toBe('0');
    expect(versions[0]!.n).toBe('0');

    const events = await eventRows(plannedId);
    expect(events.map((event) => event.event_type)).toEqual(['chapter.plan_updated']);
    expect(events[0]!.payload).toMatchObject({
      fromRevision: 0,
      revision: 1,
      bodyPolicy: null,
      changedFields: ['summary', 'beats', 'requiredEntities', 'goalKeywords', 'obstacleKeywords'],
    });
    const audits = await auditRows(plannedId);
    expect(audits.map((audit) => audit.action)).toEqual(['chapter.plan.update']);

    const detail = await call<ChapterDetail>(owner, 'GET', `/api/chapters/${plannedId}`);
    expect(detail.body.plan).toEqual(GATE_PLAN);
    expect(detail.body.volumeId).toBe(volumeId);
    expect(detail.body.planRevision).toBe(1);
    expect(detail.body.planUpdatedAt).toBe(saved.body.planUpdatedAt);

    const list = await call<ChapterListItem[]>(owner, 'GET', '/api/chapters');
    const item = list.body.find((entry) => entry.id === plannedId);
    expect(item).toMatchObject({
      volumeId,
      planRevision: 1,
      bodyNeedsRevision: false,
    });
  });

  it('内容等价的保存不推 revision，也不写历史与事件', async () => {
    const before = await snapshot(plannedId);
    const equivalent: ChapterPlanDocument = {
      summary: ` ${GATE_PLAN.summary} `,
      beats: [...GATE_PLAN.beats],
      requiredEntities: [' 林默 ', '林默'],
      goalKeywords: ['封印', '封印'],
      obstacleKeywords: ['追兵'],
    };

    const saved = await putPlan(owner, plannedId, equivalent, 1);
    expect(saved.status).toBe(200);
    expect(saved.body.planRevision).toBe(1);
    expect(saved.body.planUpdatedAt).toBe(before.plan_updated_at);
    expect(saved.body.plan).toEqual(GATE_PLAN);

    expect((await revisionRows(plannedId)).length).toBe(1);
    expect((await eventRows(plannedId)).length).toBe(1);
    const after = await snapshot(plannedId);
    expect(after.plan).toEqual(before.plan);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('陈旧 basePlanRevision：409 且 details 带当前计划', async () => {
    const stale = await putPlan(
      owner,
      plannedId,
      { ...GATE_PLAN, summary: '基于旧版本的覆盖' },
      0,
    );
    expect(stale.status).toBe(409);
    const body = stale.body as unknown as ErrorBody;
    expect(body.error.code).toBe('PLAN_REVISION_CONFLICT');
    expect(body.error.details).toMatchObject({
      planRevision: 1,
      plan: GATE_PLAN,
    });
    expect((await revisionRows(plannedId)).length).toBe(1);
    expect((await snapshot(plannedId)).plan_summary).toBe(GATE_PLAN.summary);
  });

  it('有正典不选策略：422 且零写入', async () => {
    const before = await snapshot(canonId);
    const attempt = await putPlan(
      owner,
      canonId,
      { ...EMPTY_DOC, summary: '正典章的新摘要' },
      0,
    );
    expectError(attempt, 422, 'BODY_POLICY_REQUIRED');
    expect((attempt.body as unknown as ErrorBody).error.message).toContain('仅修改计划');

    const after = await snapshot(canonId);
    expect(after.plan_summary).toBe(before.plan_summary);
    expect(after.plan_revision).toBe(0);
    expect(after.plan_updated_at).toBeNull();
    expect(after.updated_at).toBe(before.updated_at);
    expect(await revisionRows(canonId)).toEqual([]);
    expect(await eventRows(canonId)).toEqual([]);
  });

  it('有正典 plan_only：计划更新、标记为假，正典与版本行不变', async () => {
    const before = await snapshot(canonId);
    const versionsBefore = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM canon_versions WHERE chapter_id = ${canonId}
    `;

    const saved = await putPlan(
      owner,
      canonId,
      { ...EMPTY_DOC, summary: '只改计划，不动正文' },
      0,
      'plan_only',
    );
    expect(saved.status).toBe(200);
    expect(saved.body.planRevision).toBe(1);
    expect(saved.body.bodyNeedsRevision).toBe(false);
    expect(saved.body.markedPlanRevision).toBeNull();
    expect(saved.body.markedCanonVersionId).toBeNull();

    const after = await snapshot(canonId);
    expect(after.current_version_id).toBe(before.current_version_id);
    expect(after.current_version_id).toBe(canonVersionId);
    expect(after.updated_at).not.toBe(before.updated_at);
    const versionsAfter = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM canon_versions WHERE chapter_id = ${canonId}
    `;
    expect(versionsAfter[0]!.n).toBe(versionsBefore[0]!.n);

    expect(await revisionRows(canonId)).toEqual([
      { revision: 1, body_policy: 'plan_only', canon_version_id: canonVersionId },
    ]);
  });

  it('mark_body_for_revision：记录本次 revision 与正典版本，后续 plan_only 不清标记', async () => {
    const marked = await putPlan(
      owner,
      canonId,
      { ...EMPTY_DOC, summary: '正文要跟着计划改', goalKeywords: ['封印'] },
      1,
      'mark_body_for_revision',
    );
    expect(marked.status).toBe(200);
    expect(marked.body.planRevision).toBe(2);
    expect(marked.body.bodyNeedsRevision).toBe(true);
    expect(marked.body.markedPlanRevision).toBe(2);
    expect(marked.body.markedCanonVersionId).toBe(canonVersionId);

    const later = await putPlan(
      owner,
      canonId,
      { ...EMPTY_DOC, summary: '第三次只改计划', goalKeywords: ['封印'] },
      2,
      'plan_only',
    );
    expect(later.status).toBe(200);
    expect(later.body.planRevision).toBe(3);
    expect(later.body.bodyNeedsRevision).toBe(true);
    expect(later.body.markedPlanRevision).toBe(2);
    expect(later.body.markedCanonVersionId).toBe(canonVersionId);

    expect(await revisionRows(canonId)).toEqual([
      { revision: 1, body_policy: 'plan_only', canon_version_id: canonVersionId },
      { revision: 2, body_policy: 'mark_body_for_revision', canon_version_id: canonVersionId },
      { revision: 3, body_policy: 'plan_only', canon_version_id: canonVersionId },
    ]);
  });

  it('无正典却标记正文待改：400 零写入；plan_only 行内策略为空', async () => {
    const before = await snapshot(plannedId);
    const attempt = await putPlan(
      owner,
      plannedId,
      { ...GATE_PLAN, summary: '还没有正典就想标记' },
      1,
      'mark_body_for_revision',
    );
    expectError(attempt, 400, 'BODY_POLICY_NOT_APPLICABLE');
    const after = await snapshot(plannedId);
    expect(after.plan_summary).toBe(before.plan_summary);
    expect(after.body_needs_revision).toBe(false);
    expect(after.marked_plan_revision).toBeNull();
    expect((await revisionRows(plannedId)).length).toBe(1);

    const accepted = await putPlan(
      owner,
      plannedId,
      { ...GATE_PLAN, summary: '无正典也可以只改计划' },
      1,
      'plan_only',
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.planRevision).toBe(2);
    expect(accepted.body.bodyNeedsRevision).toBe(false);

    const revisions = await revisionRows(plannedId);
    expect(revisions.at(-1)).toEqual({
      revision: 2,
      body_policy: null,
      canon_version_id: null,
    });
  });

  it('确认已处理：非 canon / 无标记 / 参数不符 / 成功清标记，并记录两个正典版本', async () => {
    const notCanon = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${plannedId}/plan/body-revision/resolve`,
      { planRevision: 2, addressedCanonVersionId: randomUUID() },
    );
    expectError(notCanon, 409, 'CHAPTER_NOT_CANON');

    const wrongRevision = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${canonId}/plan/body-revision/resolve`,
      { planRevision: 99, addressedCanonVersionId: canonVersionId },
    );
    const wrongRevisionBody = expectError(wrongRevision, 409, 'PLAN_MARKER_CHANGED');
    expect(wrongRevisionBody.error.details).toEqual({
      markedPlanRevision: 2,
      currentCanonVersionId: canonVersionId,
    });

    const wrongCanon = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${canonId}/plan/body-revision/resolve`,
      { planRevision: 2, addressedCanonVersionId: randomUUID() },
    );
    expectError(wrongCanon, 409, 'PLAN_MARKER_CHANGED');

    const resolved = await call<PlanStateBody>(
      owner,
      'POST',
      `/api/chapters/${canonId}/plan/body-revision/resolve`,
      { planRevision: 2, addressedCanonVersionId: canonVersionId },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.bodyNeedsRevision).toBe(false);
    expect(resolved.body.markedPlanRevision).toBeNull();
    expect(resolved.body.markedCanonVersionId).toBeNull();
    expect(resolved.body.planRevision).toBe(3);

    const resolvedAudit = (await auditRows(canonId)).at(-1)!;
    expect(resolvedAudit.action).toBe('chapter.body_revision.resolve');
    expect(resolvedAudit.metadata).toMatchObject({
      markedPlanRevision: 2,
      markedCanonVersionId: canonVersionId,
      currentCanonVersionId: canonVersionId,
      canonUnchanged: true,
    });
    expect((await eventRows(canonId)).at(-1)!.event_type).toBe('chapter.body_revision_resolved');

    const again = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${canonId}/plan/body-revision/resolve`,
      { planRevision: 3, addressedCanonVersionId: canonVersionId },
    );
    expectError(again, 409, 'PLAN_MARKER_NOT_SET');

    // 标记在 v1，正典随后前进到 v2：确认时两个版本不同，payload 必须如实记录。
    const reMarked = await putPlan(
      owner,
      canonId,
      { ...EMPTY_DOC, summary: '标记后正典又前进了一版', goalKeywords: ['封印'] },
      3,
      'mark_body_for_revision',
    );
    expect(reMarked.status).toBe(200);
    expect(reMarked.body.markedPlanRevision).toBe(4);
    expect(reMarked.body.markedCanonVersionId).toBe(canonVersionId);

    const secondVersionId = randomUUID();
    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source, actor_id
      )
      VALUES (
        ${secondVersionId}, ${canonId}, 2, '第二版正文', ${sha256('第二版正文')},
        ${countWords('第二版正文')}, 'human', ${owner.me.user.id}
      )
    `;
    await sql`
      UPDATE chapters SET current_version_id = ${secondVersionId} WHERE id = ${canonId}
    `;
    await sql`
      UPDATE canon_current SET version_id = ${secondVersionId} WHERE chapter_id = ${canonId}
    `;

    const drifted = await call<PlanStateBody>(
      owner,
      'POST',
      `/api/chapters/${canonId}/plan/body-revision/resolve`,
      { planRevision: 4, addressedCanonVersionId: secondVersionId },
    );
    expect(drifted.status).toBe(200);
    const driftedAudit = (await auditRows(canonId)).at(-1)!;
    expect(driftedAudit.action).toBe('chapter.body_revision.resolve');
    expect(driftedAudit.metadata).toMatchObject({
      markedPlanRevision: 4,
      markedCanonVersionId: canonVersionId,
      currentCanonVersionId: secondVersionId,
      canonUnchanged: false,
    });
  });

  it('历史：倒序、before 分页、plan 为完整文档且不含正文', async () => {
    const first = await call<RevisionsBody>(
      owner,
      'GET',
      `/api/chapters/${canonId}/plan/revisions?limit=2`,
    );
    expect(first.status).toBe(200);
    expect(first.body.revisions.map((entry) => entry.revision)).toEqual([4, 3]);
    expect(first.body.hasMore).toBe(true);

    const second = await call<RevisionsBody>(
      owner,
      'GET',
      `/api/chapters/${canonId}/plan/revisions?before=4&limit=2`,
    );
    expect(second.body.revisions.map((entry) => entry.revision)).toEqual([3, 2]);
    expect(second.body.hasMore).toBe(true);
    expect(second.body.revisions[0]).toMatchObject({
      bodyPolicy: 'plan_only',
      canonVersionId: canonVersionId,
      createdBy: owner.me.user.id,
      createdByName: '章纲所有者',
    });
    expect(second.body.revisions[1]!.bodyPolicy).toBe('mark_body_for_revision');
    expect(Object.keys(second.body.revisions[1]!.plan).sort()).toEqual([
      'beats',
      'goalKeywords',
      'obstacleKeywords',
      'requiredEntities',
      'summary',
    ]);
    expect(second.body.revisions[1]!.plan).not.toHaveProperty('content');

    const third = await call<RevisionsBody>(
      owner,
      'GET',
      `/api/chapters/${canonId}/plan/revisions?before=3&limit=2`,
    );
    expect(third.body.revisions.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(third.body.hasMore).toBe(false);
    const invalid = await call<ErrorBody>(
      owner,
      'GET',
      `/api/chapters/${canonId}/plan/revisions?limit=0`,
    );
    expectError(invalid, 400, 'VALIDATION');
  });

  it('权限：审阅/只读/计费/AI 主体/跨工作区各自被拒', async () => {
    const reviewerWrite = await putPlan(
      reviewer,
      canonId,
      { ...EMPTY_DOC, summary: '审阅想改计划' },
      4,
      'plan_only',
    );
    const reviewerBody = expectError(reviewerWrite, 403, 'FORBIDDEN');
    expect(reviewerBody.error.message).toContain('只有所有者、主笔与作者');

    expectError(
      await putPlan(viewer, canonId, { ...EMPTY_DOC, summary: '只读想改计划' }, 4, 'plan_only'),
      403,
      'FORBIDDEN',
    );

    const billingRead = await call<ErrorBody>(
      billing,
      'GET',
      `/api/chapters/${canonId}/plan/revisions`,
    );
    const billingBody = expectError(billingRead, 403, 'FORBIDDEN');
    expect(billingBody.error.message).toContain('计费管理员');

    const reviewerRead = await call<RevisionsBody>(
      reviewer,
      'GET',
      `/api/chapters/${canonId}/plan/revisions`,
    );
    expect(reviewerRead.status).toBe(200);
    expect(reviewerRead.body.revisions.length).toBeGreaterThan(0);

    const aiAuth: AuthContext = {
      ...owner.me,
      sessionId: 'ai-plan-session',
      automation: { jobId: randomUUID(), mandateId: randomUUID() },
    };
    await expect(
      updateChapterPlan(aiAuth, canonId, {
        plan: { ...EMPTY_DOC, summary: 'AI 想改计划' },
        basePlanRevision: 4,
        bodyPolicy: 'plan_only',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'AI 主体不能修改作品结构或章节计划',
    });

    const crossWrite = await putPlan(
      otherOwner,
      canonId,
      { ...EMPTY_DOC, summary: '跨工作区写入' },
      4,
      'plan_only',
    );
    expectError(crossWrite, 404, 'CHAPTER_NOT_FOUND');
    const crossRead = await call<ErrorBody>(
      otherOwner,
      'GET',
      `/api/chapters/${canonId}/plan/revisions`,
    );
    expectError(crossRead, 404, 'CHAPTER_NOT_FOUND');
  });

  it('摘要/节拍改动不动 chapters.plan 与 context_hash；关键词改动才动', async () => {
    const ruleset = await loadRuleset();
    expect(ruleset).not.toBeNull();

    const hashBefore = contextHashOf((await loadChapter(sql, workspaceId, hashChapterId))!, ruleset!.id);
    const planBefore = (await snapshot(hashChapterId)).plan;

    const summaryOnly = await putPlan(
      owner,
      hashChapterId,
      {
        ...GATE_PLAN,
        summary: '只补摘要，不动门禁关键词',
        beats: ['补一节拍'],
      },
      0,
    );
    expect(summaryOnly.status).toBe(200);

    const afterSummary = await snapshot(hashChapterId);
    expect(afterSummary.plan).toEqual(planBefore);
    const hashAfterSummary = contextHashOf(
      (await loadChapter(sql, workspaceId, hashChapterId))!,
      ruleset!.id,
    );
    expect(hashAfterSummary).toBe(hashBefore);

    const keywords = await putPlan(
      owner,
      hashChapterId,
      {
        ...GATE_PLAN,
        summary: '只补摘要，不动门禁关键词',
        beats: ['补一节拍'],
        goalKeywords: ['封印', '护住祠堂'],
      },
      1,
    );
    expect(keywords.status).toBe(200);

    const afterKeywords = await snapshot(hashChapterId);
    expect(afterKeywords.plan.goalKeywords).toEqual(['封印', '护住祠堂']);
    const hashAfterKeywords = contextHashOf(
      (await loadChapter(sql, workspaceId, hashChapterId))!,
      ruleset!.id,
    );
    expect(hashAfterKeywords).not.toBe(hashBefore);
  });

  it('关键词改动后提交被 CONTEXT_CHANGED 拦下，重跑门禁后可提交', async () => {
    expect(
      (await call<unknown>(owner, 'POST', `/api/chapters/${commitChapterId}/lease`)).status,
    ).toBe(200);

    const saved = await call<SaveDraftResponse>(
      owner,
      'PUT',
      `/api/chapters/${commitChapterId}/draft`,
      { content: GATE_CONTENT_A },
    );
    expect(saved.status).toBe(200);

    const firstEvaluation = await call<GateEvaluationView>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/gates`,
    );
    expect(firstEvaluation.status).toBe(200);
    expect(firstEvaluation.body.status).toBe('passed');

    const staged = await call<StageResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/stage`,
      {
        evaluationId: firstEvaluation.body.id,
        expectedContentHash: saved.body.draft.contentHash,
      },
    );
    expect(staged.status).toBe(200);

    // 先暂存、后改关键词：暂存时的门禁证据与当前 context_hash 不再相同。
    const changed = await putPlan(
      owner,
      commitChapterId,
      { ...GATE_PLAN, goalKeywords: ['封印', '更鼓'] },
      0,
    );
    expect(changed.status).toBe(200);

    const rejected = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/commit`,
      {
        idempotencyKey: `p1-context-changed-${RUN_ID}`,
        targetChapterId: commitChapterId,
        expectedCurrentVersionId: null,
        stagedDraftId: staged.body.stagedDraft.id,
      },
    );
    expectError(rejected, 409, 'CONTEXT_CHANGED');

    const unstaged = await call<{ ok: boolean; status: string }>(
      owner,
      'DELETE',
      `/api/chapters/${commitChapterId}/stage`,
    );
    expect(unstaged.status).toBe(200);
    expect(unstaged.body.status).toBe('writing');

    const secondEvaluation = await call<GateEvaluationView>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/gates`,
    );
    expect(secondEvaluation.status).toBe(200);
    expect(secondEvaluation.body.status).toBe('passed');
    expect(secondEvaluation.body.contextHash).not.toBe(firstEvaluation.body.contextHash);

    const restaged = await call<StageResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/stage`,
      {
        evaluationId: secondEvaluation.body.id,
        expectedContentHash: saved.body.draft.contentHash,
      },
    );
    expect(restaged.status).toBe(200);

    const committed = await call<CommitResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/commit`,
      {
        idempotencyKey: `p1-context-recovered-${RUN_ID}`,
        targetChapterId: commitChapterId,
        expectedCurrentVersionId: null,
        stagedDraftId: restaged.body.stagedDraft.id,
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.body.versionNo).toBe(1);
    expect(committed.body.status).toBe('canon');
  });

  it('摘要改动不妨碍回滚复用证据；关键词改动后同一目标需要豁免', async () => {
    const currentAfterFirst = await snapshot(commitChapterId);
    const firstVersionId = currentAfterFirst.current_version_id!;

    const revision = await call<StartRevisionResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/revision`,
    );
    expect(revision.status).toBe(200);
    expect(revision.body.baseVersionId).toBe(firstVersionId);

    const saved = await call<SaveDraftResponse>(
      owner,
      'PUT',
      `/api/chapters/${commitChapterId}/draft`,
      { content: GATE_CONTENT_B },
    );
    expect(saved.status).toBe(200);

    const evaluation = await call<GateEvaluationView>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/gates`,
    );
    expect(evaluation.status).toBe(200);
    expect(evaluation.body.status).toBe('passed');

    const staged = await call<StageResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/stage`,
      {
        evaluationId: evaluation.body.id,
        expectedContentHash: saved.body.draft.contentHash,
      },
    );
    expect(staged.status).toBe(200);

    const secondCommit = await call<CommitResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/commit`,
      {
        idempotencyKey: `p1-second-commit-${RUN_ID}`,
        targetChapterId: commitChapterId,
        expectedCurrentVersionId: firstVersionId,
        stagedDraftId: staged.body.stagedDraft.id,
      },
    );
    expect(secondCommit.status).toBe(200);
    expect(secondCommit.body.versionNo).toBe(2);
    const secondVersionId = secondCommit.body.versionId;

    const summaryOnly = await putPlan(
      owner,
      commitChapterId,
      { ...GATE_PLAN, goalKeywords: ['封印', '更鼓'], summary: '回滚前的摘要改动' },
      1,
      'plan_only',
    );
    expect(summaryOnly.status).toBe(200);
    expect(summaryOnly.body.bodyNeedsRevision).toBe(false);

    const rollback = await call<RollbackResponse>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/rollback`,
      {
        idempotencyKey: `p1-rollback-reuse-${RUN_ID}`,
        targetVersionId: firstVersionId,
        expectedCurrentVersionId: secondVersionId,
        reason: '计划只改了摘要，正文证据仍可复用',
      },
    );
    expect(rollback.status).toBe(200);
    expect(rollback.body.evidence).toBe('reused');
    expect(rollback.body.versionNo).toBe(3);
    const rolledBackVersionId = rollback.body.versionId;

    const keywordChange = await putPlan(
      owner,
      commitChapterId,
      {
        ...GATE_PLAN,
        goalKeywords: ['封印', '更鼓', '带走族老'],
        summary: '回滚前的摘要改动',
      },
      2,
      'plan_only',
    );
    expect(keywordChange.status).toBe(200);

    const blocked = await call<ErrorBody>(
      owner,
      'POST',
      `/api/chapters/${commitChapterId}/rollback`,
      {
        idempotencyKey: `p1-rollback-blocked-${RUN_ID}`,
        targetVersionId: secondVersionId,
        expectedCurrentVersionId: rolledBackVersionId,
        reason: '关键词变了，旧门禁证据应该失效',
      },
    );
    expectError(blocked, 409, 'ROLLBACK_EVIDENCE_REQUIRED');
  });
});
