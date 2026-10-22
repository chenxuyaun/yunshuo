import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { closeDb, jsonValue, sql } from '@yunshuo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  processLedgerIndexJob,
  type ClaimedOutboxJob,
  type IndexPipelineOptions,
} from './pipeline.js';

const dbAvailable = await sql`SELECT 1`
  .then(() => true)
  .catch(() => {
    console.warn('worker 账本索引测试跳过：数据库不可用。');
    return false;
  });

const suite = dbAvailable ? describe : describe.skip;

interface LedgerFixture {
  entryId: string;
  versionId: string;
  jobVersionId: string;
  outboxId: number;
}

suite('worker 账本索引管线', () => {
  let stub: Server;
  let stubPort = 0;
  let stubCalls = 0;
  let stubInputs: string[][] = [];
  let workspaceId = '';
  let userId = '';
  let workId = '';
  let volumeId = '';
  let providerId = '';

  const options: IndexPipelineOptions = {
    sleep: async () => undefined,
  };

  async function createLedgerFixture(params: {
    kind: 'setting' | 'character' | 'foreshadowing';
    name: string;
    versionNo?: number;
    status?: 'draft' | 'active' | 'archived';
    jobVersionNo?: number;
    content?: string;
    scope?: 'work' | 'workspace';
    sourceChapterId?: string | null;
  }): Promise<LedgerFixture> {
    const entryId = randomUUID();
    const versionId = randomUUID();
    const versionNo = params.versionNo ?? 1;
    const status = params.status ?? 'active';
    const content =
      params.content ??
      '王城坐落于河谷北岸，城门由银纹铜钉加固。守夜人只在月缺时更换门钉，旧钉会被投入护城河。';
    const snapshot = {
      name: params.name,
      aliases: ['旧钉'],
      summary: 'worker 账本索引测试条目',
      sourceChapterId: params.sourceChapterId ?? null,
      payload:
        params.kind === 'setting'
          ? {
              category: 'location',
              details: content,
              tags: ['王城', '地理'],
              verification: 'verified',
            }
          : params.kind === 'character'
            ? {
                role: '守夜人',
                faction: '王城',
                appearance: '',
                personality: '',
                goals: '',
                abilities: '',
                speechStyle: '',
                relationships: [],
                states: [],
              }
            : {
                state: 'planted',
                importance: 'high',
                seedChapterId: null,
                payoffChapterMin: 3,
                payoffChapterMax: 5,
                payoffChapterId: null,
                note: content,
                resolutionNote: '',
              },
    };

    await sql`
      INSERT INTO ledger_entries (
        id, workspace_id, work_id, kind, scope, name, aliases, summary, status, created_by
      )
      VALUES (
        ${entryId}, ${workspaceId}, ${params.scope === 'workspace' ? null : workId},
        ${params.kind}, ${params.scope ?? 'work'},
        ${params.name}, ${sql.array(['旧钉'])}, ${snapshot.summary}, ${status}, ${userId}
      )
    `;
    await sql`
      INSERT INTO ledger_entry_versions (
        id, entry_id, workspace_id, version_no, snapshot, change_summary, created_by
      )
      VALUES (
        ${versionId}, ${entryId}, ${workspaceId}, ${versionNo},
        ${sql.json(jsonValue(snapshot))}, 'worker 索引测试', ${userId}
      )
    `;
    await sql`
      UPDATE ledger_entries
      SET current_version_id = ${status === 'draft' ? null : versionId}
      WHERE id = ${entryId}
    `;

    const jobVersionId = randomUUID();
    const jobVersionNo = params.jobVersionNo ?? versionNo;
    if (jobVersionNo !== versionNo) {
      await sql`
        INSERT INTO ledger_entry_versions (
          id, entry_id, workspace_id, version_no, snapshot, change_summary, created_by
        )
        VALUES (
          ${jobVersionId}, ${entryId}, ${workspaceId}, ${jobVersionNo},
          ${sql.json(jsonValue(snapshot))}, '旧版本测试', ${userId}
        )
      `;
    }
    const effectiveJobVersionId = jobVersionNo === versionNo ? versionId : jobVersionId;

    const payload = jsonValue({
      entryId,
      versionId: effectiveJobVersionId,
      workspaceId,
    });
    const outboxRows = await sql<{ id: number }[]>`
      INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
      VALUES (
        'index.ledger', ${sql.json(payload)},
        ${`worker-ledger-test:${randomUUID()}`}, now()
      )
      RETURNING id
    `;

    return {
      entryId,
      versionId,
      jobVersionId: effectiveJobVersionId,
      outboxId: outboxRows[0]!.id,
    };
  }

  function jobOf(fixture: LedgerFixture, attempts = 1): ClaimedOutboxJob {
    return {
      id: fixture.outboxId,
      event_type: 'index.ledger',
      payload: {
        entryId: fixture.entryId,
        versionId: fixture.jobVersionId,
        workspaceId,
      },
      attempts,
    };
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
          const parsed = JSON.parse(raw) as { input?: unknown };
          if (Array.isArray(parsed.input)) {
            inputs = parsed.input.map((item) => String(item));
          }
        } catch {
          inputs = [];
        }
        stubInputs.push(inputs);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: inputs.map((_, index) => ({
              object: 'embedding',
              index,
              embedding: [1, 0, 0, 0],
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

    await sql`INSERT INTO workspaces (id, name) VALUES (${workspaceId}, 'worker 账本索引测试工作区')`;
    await sql`
      INSERT INTO users (id, email, name)
      VALUES (${userId}, ${`worker-ledger-${userId.slice(0, 8)}@test.local`}, 'Ledger Worker Tester')
    `;
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')
    `;
    await sql`
      INSERT INTO works (id, workspace_id, title)
      VALUES (${workId}, ${workspaceId}, 'worker 账本测试作品')
    `;
    await sql`
      INSERT INTO volumes (id, work_id, number, title)
      VALUES (${volumeId}, ${workId}, 1, '账本测试第一卷')
    `;
    await sql`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency
      )
      VALUES (
        ${providerId}, ${workspaceId}, 'worker ledger stub embedding',
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

  it('账本条目切块、向量与 ready 状态落库，重复任务被跳过', async () => {
    stubCalls = 0;
    stubInputs = [];
    const fixture = await createLedgerFixture({ kind: 'setting', name: '王城铜钉' });

    const outcome = await processLedgerIndexJob(jobOf(fixture), options);
    expect(outcome.outcome).toBe('ready');
    if (outcome.outcome !== 'ready') return;
    expect(outcome.chunks).toBeGreaterThan(0);
    expect(outcome.model).toBe('stub-embed');
    expect(outcome.dimensions).toBe(4);

    const statusRows = await sql<
      {
        status: string;
        chunk_count: number;
        version_id: string;
        provider_name: string;
        model: string;
        dimensions: number;
      }[]
    >`SELECT * FROM ledger_index_status WHERE entry_id = ${fixture.entryId}`;
    expect(statusRows[0]?.status).toBe('ready');
    expect(statusRows[0]?.version_id).toBe(fixture.versionId);
    expect(statusRows[0]?.chunk_count).toBe(outcome.chunks);
    expect(statusRows[0]?.provider_name).toBe('worker ledger stub embedding');
    expect(statusRows[0]?.model).toBe('stub-embed');
    expect(statusRows[0]?.dimensions).toBe(4);

    const chunkRows = await sql<{ count: number; with_embedding: number; with_lexical: number }[]>`
      SELECT count(*)::int AS count,
             count(lce.chunk_id)::int AS with_embedding,
             count(*) FILTER (WHERE lch.lexical_text <> '')::int AS with_lexical
      FROM ledger_chunks lch
      LEFT JOIN ledger_chunk_embeddings lce ON lce.chunk_id = lch.id
      WHERE lch.entry_id = ${fixture.entryId}
    `;
    expect(chunkRows[0]?.count).toBe(outcome.chunks);
    expect(chunkRows[0]?.with_embedding).toBe(outcome.chunks);
    expect(chunkRows[0]?.with_lexical).toBe(outcome.chunks);
    expect(stubInputs[0]?.[0]).toContain('账本设定《王城铜钉》v1');

    const calls = await sql<{ chapter_id: string | null; purpose: string }[]>`
      SELECT chapter_id, purpose FROM model_calls
      WHERE workspace_id = ${workspaceId} AND purpose = 'embedding'
    `;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.chapter_id === null)).toBe(true);

    const callsBefore = stubCalls;
    const again = await processLedgerIndexJob(jobOf(fixture, 2), options);
    expect(again.outcome).toBe('skipped');
    expect(stubCalls).toBe(callsBefore);
    const chunkCountAfter = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_chunks WHERE entry_id = ${fixture.entryId}
    `;
    expect(chunkCountAfter[0]?.count).toBe(outcome.chunks);
  }, 30_000);

  it('工作区级设定按来源章节标注章节名，而不是“未登记章节”', async () => {
    stubCalls = 0;
    const chapterId = randomUUID();
    await sql`
      INSERT INTO chapters (id, work_id, volume_id, number, title)
      VALUES (${chapterId}, ${workId}, ${volumeId}, 7, '北门夜雨')
    `;
    const fixture = await createLedgerFixture({
      kind: 'setting',
      name: '北门铜钉',
      scope: 'workspace',
      sourceChapterId: chapterId,
    });

    const outcome = await processLedgerIndexJob(jobOf(fixture), options);
    expect(outcome.outcome).toBe('ready');
    const rows = await sql<{ content: string }[]>`
      SELECT content FROM ledger_chunks
      WHERE entry_id = ${fixture.entryId} AND version_id = ${fixture.versionId}
      ORDER BY chunk_index ASC
    `;
    const joined = rows.map((row) => row.content).join('\n');
    expect(joined).toContain('来源章节：第 7 章《北门夜雨》');
    expect(joined).not.toContain('未登记章节');
  }, 30_000);

  it('归档条目不参与索引，旧投影与状态被清理', async () => {
    stubCalls = 0;
    const fixture = await createLedgerFixture({ kind: 'setting', name: '归档铜钉' });
    const first = await processLedgerIndexJob(jobOf(fixture), options);
    expect(first.outcome).toBe('ready');

    await sql`UPDATE ledger_entries SET status = 'archived' WHERE id = ${fixture.entryId}`;
    const skipped = await processLedgerIndexJob(jobOf(fixture, 2), options);
    expect(skipped.outcome).toBe('skipped');
    if (skipped.outcome === 'skipped') {
      expect(skipped.reason).toContain('归档');
    }

    const chunks = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_chunks WHERE entry_id = ${fixture.entryId}
    `;
    expect(chunks[0]?.count).toBe(0);
    const status = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_index_status WHERE entry_id = ${fixture.entryId}
    `;
    expect(status[0]?.count).toBe(0);
  }, 30_000);

  it('旧版本任务被丢弃，当前版本索引不被旧版本覆盖', async () => {
    stubCalls = 0;
    const fixture = await createLedgerFixture({
      kind: 'character',
      name: '守夜人阿岑',
      versionNo: 2,
      jobVersionNo: 1,
    });
    const outcome = await processLedgerIndexJob(jobOf(fixture), options);
    expect(outcome.outcome).toBe('skipped');
    expect(stubCalls).toBe(0);

    const chunks = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_chunks
      WHERE entry_id = ${fixture.entryId} AND version_id = ${fixture.versionId}
    `;
    expect(chunks[0]?.count).toBe(0);
    const status = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ledger_index_status
      WHERE entry_id = ${fixture.entryId} AND version_id = ${fixture.versionId}
    `;
    expect(status[0]?.count).toBe(0);
  }, 30_000);

  it('没有嵌入服务商时建立词法索引，标记 not_configured 且不写向量', async () => {
    stubCalls = 0;
    await sql`UPDATE model_providers SET is_enabled = false WHERE id = ${providerId}`;
    try {
      const fixture = await createLedgerFixture({ kind: 'foreshadowing', name: '黑潮预兆' });
      const outcome = await processLedgerIndexJob(jobOf(fixture), options);
      expect(outcome.outcome).toBe('not_configured');
      if (outcome.outcome === 'not_configured') {
        expect(outcome.reason).toContain('嵌入服务商');
      }
      expect(stubCalls).toBe(0);

      const status = await sql<
        { status: string; chunk_count: number; detail: string; model: string | null }[]
      >`
        SELECT status, chunk_count, detail, model
        FROM ledger_index_status WHERE entry_id = ${fixture.entryId}
      `;
      expect(status[0]?.status).toBe('not_configured');
      expect(status[0]?.chunk_count).toBeGreaterThan(0);
      expect(status[0]?.detail).toContain('词法');
      expect(status[0]?.model).toBeNull();

      const chunks = await sql<{ count: number; with_embedding: number }[]>`
        SELECT count(*)::int AS count,
               count(lce.chunk_id)::int AS with_embedding
        FROM ledger_chunks lch
        LEFT JOIN ledger_chunk_embeddings lce ON lce.chunk_id = lch.id
        WHERE lch.entry_id = ${fixture.entryId}
      `;
      expect(chunks[0]?.count).toBe(status[0]?.chunk_count);
      expect(chunks[0]?.with_embedding).toBe(0);

      const again = await processLedgerIndexJob(jobOf(fixture, 2), options);
      expect(again.outcome).toBe('skipped');
      const after = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ledger_chunks WHERE entry_id = ${fixture.entryId}
      `;
      expect(after[0]?.count).toBe(status[0]?.chunk_count);
    } finally {
      await sql`UPDATE model_providers SET is_enabled = true WHERE id = ${providerId}`;
    }
  }, 30_000);
});
