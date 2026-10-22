import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { countWords, sha256 } from '@yunshuo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  processIndexJob,
  recoverStaleOutbox,
  type ClaimedOutboxJob,
  type IndexPipelineOptions,
} from './pipeline.js';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('worker 集成测试跳过：数据库不可用，请先启动 db 并执行迁移。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

type StubMode = 'ok' | 'http500' | 'auth401' | 'dim-drift';

function longContent(): string {
  return Array.from({ length: 200 }, (_, index) => {
    const paragraph = `第${index + 1}段。林默沿着长街向前，雨水从檐角落下，追兵的马蹄声在雾里忽远忽近。他把封印的铜钉按进门槛，听见远处有人低声念出旧名。`;
    return paragraph;
  }).join('\n\n');
}

suite('worker 索引管线', () => {
  let stub: Server;
  let stubPort = 0;
  let stubMode: StubMode = 'ok';
  let stubCalls = 0;
  let stubInputs: string[][] = [];
  let workspaceId = '';
  let userId = '';
  let workId = '';
  let volumeId = '';
  let providerId = '';
  let chapterNumber = 8800;

  const options: IndexPipelineOptions = {
    sleep: async () => undefined,
  };

  interface ChapterFixture {
    chapterId: string;
    versionId: string;
    versionNo: number;
    jobVersionId: string;
    jobVersionNo: number;
    outboxId: number;
  }

  async function createCanonChapter(params: {
    content: string;
    title?: string;
    versionNo?: number;
    jobVersionNo?: number;
  }): Promise<ChapterFixture> {
    const chapterId = randomUUID();
    chapterNumber += 1;
    const versionId = randomUUID();
    const versionNo = params.versionNo ?? 1;
    const content = params.content;
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title, status, plan)
      VALUES (
        ${chapterId}, ${workId}, ${volumeId}, ${chapterNumber},
        ${params.title ?? `worker 测试章节 ${chapterNumber}`}, 'canon', '{}'::jsonb
      )
    `;

    await sql`
      INSERT INTO canon_versions (
        id, chapter_id, version_no, content, content_hash, word_count, source
      )
      VALUES (
        ${versionId}, ${chapterId}, ${versionNo}, ${content}, ${sha256(content)},
        ${countWords(content)}, 'human'
      )
    `;
    await sql`UPDATE chapters SET current_version_id = ${versionId} WHERE id = ${chapterId}`;
    await sql`
      INSERT INTO canon_current (chapter_id, version_id)
      VALUES (${chapterId}, ${versionId})
    `;

    const jobVersionId = randomUUID();
    const jobVersionNo = params.jobVersionNo ?? versionNo;
    if (jobVersionNo !== versionNo) {
      await sql`
        INSERT INTO canon_versions (
          id, chapter_id, version_no, content, content_hash, word_count, source
        )
        VALUES (
          ${jobVersionId}, ${chapterId}, ${jobVersionNo}, ${content}, ${sha256(`${content}-old`)},
          ${countWords(content)}, 'human'
        )
      `;
    }
    const effectiveJobVersionId = jobVersionNo === versionNo ? versionId : jobVersionId;

    await sql`
      INSERT INTO index_status (chapter_id, version_id, status, detail)
      VALUES (${chapterId}, ${effectiveJobVersionId}, 'pending', '测试排队')
    `;

    const payload = jsonValue({
      chapterId,
      versionId: effectiveJobVersionId,
      workspaceId,
    });
    const outboxRows = await sql<{ id: number }[]>`
      INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
      VALUES (
        'index.chapter', ${sql.json(payload)},
        ${`worker-test:${randomUUID()}`}, now()
      )
      RETURNING id
    `;
    return {
      chapterId,
      versionId,
      versionNo,
      jobVersionId: effectiveJobVersionId,
      jobVersionNo,
      outboxId: outboxRows[0]!.id,
    };
  }

  function jobOf(fixture: ChapterFixture, attempts = 1): ClaimedOutboxJob {
    return {
      id: fixture.outboxId,
      event_type: 'index.chapter',
      payload: {
        chapterId: fixture.chapterId,
        versionId: fixture.jobVersionId,
        workspaceId,
      },
      attempts,
    };
  }

  async function cleanupChapter(chapterId: string): Promise<void> {
    await sql`DELETE FROM outbox WHERE payload->>'chapterId' = ${chapterId}`;
  }

  beforeAll(async () => {
    stub = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        stubCalls += 1;
        let inputs: string[] = [];
        try {
          const parsed = JSON.parse(raw) as { input?: unknown; model?: unknown };
          if (Array.isArray(parsed.input)) {
            inputs = parsed.input.map((item) => String(item));
          }
        } catch {
          inputs = [];
        }
        stubInputs.push(inputs);

        if (stubMode === 'http500') {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 500' } }));
          return;
        }
        if (stubMode === 'auth401') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'stub 401' } }));
          return;
        }

        const dimensions = stubMode === 'dim-drift' && stubCalls > 1 ? 3 : 4;
        const vector = [1, 0, 0, 0].slice(0, dimensions);
        while (vector.length < dimensions) vector.push(0);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_, index) => ({
              object: 'embedding',
              index,
              embedding: vector,
            })),
            usage: { prompt_tokens: 42 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
    const address = stub.address();
    stubPort = typeof address === 'object' && address ? address.port : 0;

    workspaceId = randomUUID();
    userId = randomUUID();
    workId = randomUUID();
    volumeId = randomUUID();
    providerId = randomUUID();

    await sql`
      INSERT INTO workspaces (id, name) VALUES (${workspaceId}, 'worker 索引测试工作区')
    `;
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${userId}, ${`worker-${userId.slice(0, 8)}@test.local`}, 'Worker Tester')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')
    `;
    await sql`
      INSERT INTO works (id, workspace_id, title) VALUES (${workId}, ${workspaceId}, 'worker 测试作品')
    `;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '第一卷')
    `;
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency
      )
      VALUES (
        ${providerId}, ${workspaceId}, 'worker stub embedding',
        ${`http://127.0.0.1:${stubPort}/v1`}, 'stub-embed', 'embedding', true, 10,
        2, NULL, 'CNY'
      )
    `;
  });

  afterAll(async () => {
    if (workspaceId) {
      await sql`DELETE FROM outbox WHERE payload->>'workspaceId' = ${workspaceId}`;
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    }
    if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
    await closeDb();
  });

  it('嵌入成功后写入版本绑定片段、向量、成本与 ready 状态', async () => {
    stubMode = 'ok';
    stubCalls = 0;
    stubInputs = [];
    const fixture = await createCanonChapter({ content: longContent() });

    const outcome = await processIndexJob(jobOf(fixture), options);
    expect(outcome.outcome).toBe('ready');
    if (outcome.outcome !== 'ready') return;
    expect(outcome.dimensions).toBe(4);
    expect(outcome.model).toBe('stub-embed');
    expect(outcome.chunks).toBeGreaterThan(16);

    const statusRows = await sql<
      {
        status: string;
        chunk_count: number;
        provider_name: string;
        model: string;
        dimensions: number;
        attempts: number;
        next_retry_at: Date | null;
        last_error: string | null;
        version_id: string;
      }[]
    >`SELECT * FROM index_status WHERE chapter_id = ${fixture.chapterId}`;
    const status = statusRows[0]!;
    expect(status.status).toBe('ready');
    expect(status.version_id).toBe(fixture.versionId);
    expect(status.chunk_count).toBe(outcome.chunks);
    expect(status.provider_name).toBe('worker stub embedding');
    expect(status.model).toBe('stub-embed');
    expect(status.dimensions).toBe(4);
    expect(status.attempts).toBe(1);
    expect(status.next_retry_at).toBeNull();
    expect(status.last_error).toBeNull();

    const chunkRows = await sql<{ count: number; min_dim: number; max_dim: number }[]>`
      SELECT count(*)::int AS count,
             min(ce.dimensions)::int AS min_dim,
             max(ce.dimensions)::int AS max_dim
      FROM canon_chunks ch
      JOIN chunk_embeddings ce ON ce.chunk_id = ch.id
      WHERE ch.version_id = ${fixture.versionId}
    `;
    expect(chunkRows[0]?.count).toBe(outcome.chunks);
    expect(chunkRows[0]?.min_dim).toBe(4);
    expect(chunkRows[0]?.max_dim).toBe(4);

    const lexical = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM canon_chunks
      WHERE version_id = ${fixture.versionId} AND lexical_text <> ''
    `;
    expect(lexical[0]?.count).toBe(outcome.chunks);

    const batchCount = Math.ceil(outcome.chunks / 16);
    expect(stubCalls).toBe(batchCount);
    expect(stubInputs[0]?.[0]).toContain('第 ');

    const callRows = await sql<
      { status: string; purpose: string; prompt_tokens: number; cost: string; currency: string }[]
    >`
      SELECT status, purpose, prompt_tokens, cost, cost_currency AS currency
      FROM model_calls
      WHERE chapter_id = ${fixture.chapterId}
      ORDER BY created_at ASC
    `;
    expect(callRows).toHaveLength(batchCount);
    for (const call of callRows) {
      expect(call.status).toBe('ok');
      expect(call.purpose).toBe('embedding');
      expect(call.prompt_tokens).toBe(42);
      expect(Number(call.cost)).toBe(0.0001);
      expect(call.currency).toBe('CNY');
    }

    const outboxRows = await sql<{ status: string; locked_at: Date | null }[]>`
      SELECT status, locked_at FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('processed');
    expect(outboxRows[0]?.locked_at).toBeNull();

    const chunkIdsBefore = await sql<{ id: string }[]>`
      SELECT id FROM canon_chunks
      WHERE version_id = ${fixture.versionId}
      ORDER BY chunk_index ASC
    `;
    const callsBeforeDuplicate = stubCalls;
    const again = await processIndexJob(jobOf(fixture, 2), options);
    expect(again.outcome).toBe('skipped');
    if (again.outcome === 'skipped') expect(again.reason).toContain('已就绪');
    expect(stubCalls).toBe(callsBeforeDuplicate);
    const chunkIdsAfter = await sql<{ id: string }[]>`
      SELECT id FROM canon_chunks
      WHERE version_id = ${fixture.versionId}
      ORDER BY chunk_index ASC
    `;
    expect(chunkIdsAfter.map((row) => row.id)).toEqual(chunkIdsBefore.map((row) => row.id));

    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('已就绪索引不会被迟到任务降级或重写', async () => {
    stubMode = 'ok';
    stubCalls = 0;
    const fixture = await createCanonChapter({
      content: longContent(),
      title: '迟到任务章节',
    });
    const first = await processIndexJob(jobOf(fixture, 1), options);
    expect(first.outcome).toBe('ready');

    const before = await sql<{ status: string; chunk_count: number }[]>`
      SELECT status, chunk_count FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    const chunkIdsBefore = await sql<{ id: string }[]>`
      SELECT id FROM canon_chunks
      WHERE version_id = ${fixture.versionId}
      ORDER BY chunk_index ASC
    `;
    const callsBefore = stubCalls;

    stubMode = 'http500';
    const late = await processIndexJob(jobOf(fixture, 4), options);
    expect(late.outcome).toBe('skipped');
    expect(stubCalls).toBe(callsBefore);

    const after = await sql<{ status: string; chunk_count: number }[]>`
      SELECT status, chunk_count FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(after[0]).toEqual(before[0]);
    const chunkIdsAfter = await sql<{ id: string }[]>`
      SELECT id FROM canon_chunks
      WHERE version_id = ${fixture.versionId}
      ORDER BY chunk_index ASC
    `;
    expect(chunkIdsAfter.map((row) => row.id)).toEqual(chunkIdsBefore.map((row) => row.id));

    const outboxRows = await sql<{ status: string }[]>`
      SELECT status FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('processed');

    stubMode = 'ok';
    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('可重试错误写回 pending，并按 1/5/15/60 分钟退避', async () => {
    stubMode = 'http500';
    stubCalls = 0;
    const fixture = await createCanonChapter({ content: '林默在雨夜守住门。', title: '重试章节' });
    const delays: number[] = [];
    const outcome = await processIndexJob(jobOf(fixture, 1), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(outcome.outcome).toBe('retry');
    if (outcome.outcome !== 'retry') return;
    expect(outcome.delayMinutes).toBe(1);
    expect(delays).toEqual([600]);
    expect(stubCalls).toBe(2);

    const statusRows = await sql<
      { status: string; attempts: number; next_retry_at: Date | null; last_error: string | null }[]
    >`SELECT status, attempts, next_retry_at, last_error FROM index_status WHERE chapter_id = ${fixture.chapterId}`;
    const status = statusRows[0]!;
    expect(status.status).toBe('pending');
    expect(status.attempts).toBe(1);
    expect(status.next_retry_at).not.toBeNull();
    expect(status.next_retry_at!.getTime()).toBeGreaterThan(Date.now());

    const outboxRows = await sql<{ status: string; next_attempt_at: Date }[]>`
      SELECT status, next_attempt_at FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('pending');
    expect(outboxRows[0]?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    const failedCalls = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_calls
      WHERE chapter_id = ${fixture.chapterId} AND status = 'failed'
    `;
    expect(failedCalls[0]?.count).toBe(2);

    stubMode = 'ok';
    const recovered = await processIndexJob(jobOf(fixture, 2), options);
    expect(recovered.outcome).toBe('ready');

    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('尝试次数耗尽后标记 failed，不再无限重试', async () => {
    stubMode = 'http500';
    stubCalls = 0;
    const fixture = await createCanonChapter({ content: '耗尽测试正文。', title: '耗尽章节' });
    const outcome = await processIndexJob(jobOf(fixture, 5), options);
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.code).toBe('EMBEDDING_HTTP_ERROR');

    const statusRows = await sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(statusRows[0]?.status).toBe('failed');
    expect(statusRows[0]?.attempts).toBe(5);

    const outboxRows = await sql<{ status: string }[]>`
      SELECT status FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('failed');
    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('401 立即失败，不进行第二次尝试', async () => {
    stubMode = 'auth401';
    stubCalls = 0;
    const fixture = await createCanonChapter({ content: '鉴权失败测试。', title: '鉴权章节' });
    const outcome = await processIndexJob(jobOf(fixture, 1), options);
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.code).toBe('EMBEDDING_AUTH');
    expect(stubCalls).toBe(1);

    const statusRows = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(statusRows[0]?.status).toBe('failed');
    expect(statusRows[0]?.last_error).toContain('401');
    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('没有可用的嵌入服务商时如实标记 not_configured', async () => {
    stubMode = 'ok';
    await sql`UPDATE model_providers SET is_enabled = false WHERE id = ${providerId}`;
    const fixture = await createCanonChapter({ content: '没有嵌入服务。', title: '未配置章节' });
    const outcome = await processIndexJob(jobOf(fixture, 1), options);
    expect(outcome.outcome).toBe('not_configured');

    const statusRows = await sql<{ status: string; chunk_count: number }[]>`
      SELECT status, chunk_count FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(statusRows[0]?.status).toBe('not_configured');
    expect(statusRows[0]?.chunk_count).toBe(0);

    const outboxRows = await sql<{ status: string }[]>`
      SELECT status FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('processed');
    await sql`UPDATE model_providers SET is_enabled = true WHERE id = ${providerId}`;
    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('同一任务内维度漂移直接失败，不混用不同维度向量', async () => {
    stubMode = 'dim-drift';
    stubCalls = 0;
    const fixture = await createCanonChapter({ content: longContent(), title: '维度漂移章节' });
    const outcome = await processIndexJob(jobOf(fixture, 1), options);
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.code).toBe('EMBEDDING_DIMENSION_DRIFT');

    const chunkCount = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM canon_chunks WHERE version_id = ${fixture.versionId}
    `;
    expect(chunkCount[0]?.count).toBe(0);

    const statusRows = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(statusRows[0]?.status).toBe('failed');
    expect(statusRows[0]?.last_error).toContain('维度漂移');
    await cleanupChapter(fixture.chapterId);
  }, 30_000);

  it('旧版本任务被丢弃，不覆盖当前正典索引状态', async () => {
    stubMode = 'ok';
    stubCalls = 0;
    const content = '旧版本正文。追兵已经离去。';
    const fixture = await createCanonChapter({
      content,
      title: '旧版本章节',
      versionNo: 2,
      jobVersionNo: 1,
    });

    const outcome = await processIndexJob(jobOf(fixture, 1), options);
    expect(outcome.outcome).toBe('skipped');
    expect(stubCalls).toBe(0);

    const statusRows = await sql<{ status: string; version_id: string }[]>`
      SELECT status, version_id FROM index_status WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(statusRows[0]?.version_id).toBe(fixture.jobVersionId);
    expect(statusRows[0]?.version_id).not.toBe(fixture.versionId);
    const chunkCount = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM canon_chunks WHERE chapter_id = ${fixture.chapterId}
    `;
    expect(chunkCount[0]?.count).toBe(0);

    const outboxRows = await sql<{ status: string }[]>`
      SELECT status FROM outbox WHERE id = ${fixture.outboxId}
    `;
    expect(outboxRows[0]?.status).toBe('processed');
    await cleanupChapter(fixture.chapterId);
  });

  it('正文为空时标记 EMPTY_CONTENT', async () => {
    stubMode = 'ok';
    const fixture = await createCanonChapter({ content: '', title: '空正文章节' });
    const outcome = await processIndexJob(jobOf(fixture, 1), options);
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.code).toBe('EMPTY_CONTENT');
    await cleanupChapter(fixture.chapterId);
  });

  it('回收超过 5 分钟仍处于 processing 的任务', async () => {
    const staleId = randomUUID();
    const freshId = randomUUID();
    const dedupeStale = `worker-stale:${staleId}`;
    const dedupeFresh = `worker-fresh:${freshId}`;
    await sql`
      INSERT INTO outbox (event_type, payload, status, locked_at, dedupe_key)
      VALUES (
        'index.chapter', ${sql.json(jsonValue({ workspaceId }))}, 'processing',
        now() - interval '10 minutes', ${dedupeStale}
      )
    `;
    await sql`
      INSERT INTO outbox (event_type, payload, status, locked_at, dedupe_key)
      VALUES (
        'index.chapter', ${sql.json(jsonValue({ workspaceId }))}, 'processing',
        now(), ${dedupeFresh}
      )
    `;

    await recoverStaleOutbox();
    const rows = await sql<{ dedupe_key: string; status: string; locked_at: Date | null }[]>`
      SELECT dedupe_key, status, locked_at FROM outbox
      WHERE dedupe_key IN (${dedupeStale}, ${dedupeFresh})
      ORDER BY dedupe_key ASC
    `;
    const stale = rows.find((row) => row.dedupe_key === dedupeStale);
    const fresh = rows.find((row) => row.dedupe_key === dedupeFresh);
    expect(stale?.status).toBe('pending');
    expect(stale?.locked_at).toBeNull();
    expect(fresh?.status).toBe('processing');

    await sql`DELETE FROM outbox WHERE dedupe_key IN (${dedupeStale}, ${dedupeFresh})`;
  });
});
