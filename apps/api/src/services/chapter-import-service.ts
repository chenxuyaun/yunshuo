import { randomUUID } from 'node:crypto';
import type {
  ImportChaptersInput,
  ImportChaptersResponse,
  ImportedChapterSummary,
} from '@yunshuo/contracts';
import { jsonValue, sql } from '@yunshuo/db';
import { countWords, sha256 } from '@yunshuo/domain';
import { assertCanWrite, type AuthContext } from '../auth.js';
import { AppError } from '../errors.js';

function duplicateNumbers(numbers: number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const number of numbers) {
    if (seen.has(number)) duplicates.add(number);
    seen.add(number);
  }
  return [...duplicates].sort((a, b) => a - b);
}

export async function importChapters(
  auth: AuthContext,
  input: ImportChaptersInput,
): Promise<ImportChaptersResponse> {
  assertCanWrite(auth.role);

  const duplicates = duplicateNumbers(input.chapters.map((chapter) => chapter.number));
  if (duplicates.length > 0) {
    throw new AppError(
      409,
      'CHAPTER_NUMBER_DUPLICATED',
      `导入内容中章节号重复：${duplicates.join('、')}`,
      { numbers: duplicates },
    );
  }

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`chapter-import:${auth.workspace.id}`}))`;

    const workRows = await tx<{ id: string; title: string }[]>`
      SELECT id, title FROM works
      WHERE workspace_id = ${auth.workspace.id} AND title = ${input.workTitle}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    let workId = workRows[0]?.id;
    let workTitle = workRows[0]?.title ?? input.workTitle;
    if (!workId) {
      workId = randomUUID();
      workTitle = input.workTitle;
      await tx`
        INSERT INTO works (id, workspace_id, title)
        VALUES (${workId}, ${auth.workspace.id}, ${workTitle})
      `;
    }

    const volumeRows = await tx<{ id: string; title: string }[]>`
      SELECT id, title FROM volumes
      WHERE work_id = ${workId} AND number = ${input.volumeNumber}
      LIMIT 1
    `;
    let volumeId: string;
    let volumeTitle = volumeRows[0]?.title ?? input.volumeTitle;
    if (volumeRows[0]) {
      volumeId = volumeRows[0].id;
      if (volumeTitle !== input.volumeTitle) {
        throw new AppError(
          409,
          'VOLUME_TITLE_MISMATCH',
          `作品《${workTitle}》第 ${input.volumeNumber} 卷已存在，标题为《${volumeTitle}》；请使用相同卷名或更换卷号`,
          { existingTitle: volumeTitle, requestedTitle: input.volumeTitle },
        );
      }
    } else {
      volumeId = randomUUID();
      volumeTitle = input.volumeTitle;
      await tx`
        INSERT INTO volumes (id, work_id, number, title)
        VALUES (${volumeId}, ${workId}, ${input.volumeNumber}, ${volumeTitle})
      `;
    }

    const existingRows = await tx<{ number: number }[]>`
      SELECT number FROM chapters WHERE work_id = ${workId}
    `;
    const existing = new Set(existingRows.map((row) => row.number));
    const conflicts = input.chapters
      .map((chapter) => chapter.number)
      .filter((number) => existing.has(number))
      .sort((a, b) => a - b);
    if (conflicts.length > 0) {
      throw new AppError(
        409,
        'CHAPTER_NUMBER_EXISTS',
        `作品《${workTitle}》中已存在章节号：${conflicts.join('、')}，本次未写入任何章节`,
        { numbers: conflicts },
      );
    }

    const embeddingProviders = await tx<{ id: string }[]>`
      SELECT id FROM model_providers
      WHERE workspace_id = ${auth.workspace.id} AND purpose = 'embedding' AND is_enabled = true
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `;
    const autoIndex = embeddingProviders.length > 0;

    const imported: ImportedChapterSummary[] = [];
    for (const item of input.chapters) {
      const chapterId = randomUUID();
      const versionId = randomUUID();
      const contentHash = sha256(item.content);
      const wordCount = countWords(item.content);

      await tx`
        INSERT INTO chapters (
          id, work_id, volume_id, number, title, status, current_version_id, plan
        )
        VALUES (
          ${chapterId}, ${workId}, ${volumeId}, ${item.number}, ${item.title},
          'canon', NULL, ${tx.json(jsonValue({}))}
        )
      `;
      await tx`
        INSERT INTO canon_versions (
          id, chapter_id, version_no, content, content_hash, word_count,
          parent_version_id, source, actor_id, evaluation_id, waiver_id
        )
        VALUES (
          ${versionId}, ${chapterId}, 1, ${item.content}, ${contentHash}, ${wordCount},
          NULL, 'import', ${auth.user.id}, NULL, NULL
        )
      `;
      await tx`
        UPDATE chapters
        SET current_version_id = ${versionId}, updated_at = now()
        WHERE id = ${chapterId}
      `;
      await tx`
        INSERT INTO canon_current (chapter_id, version_id)
        VALUES (${chapterId}, ${versionId})
      `;
      await tx`
        INSERT INTO chapter_metadata (chapter_id, word_count)
        VALUES (${chapterId}, ${wordCount})
      `;
      await tx`
        INSERT INTO index_status (chapter_id, version_id, status, detail)
        VALUES (
          ${chapterId}, ${versionId},
          ${autoIndex ? 'pending' : 'not_configured'},
          ${
            autoIndex
              ? '迁移导入章节已排队建立索引，等待 worker 处理'
              : '迁移导入章节尚未建立索引；当前未配置启用的嵌入服务，配置后可在检索面板重建'
          }
        )
      `;
      if (autoIndex) {
        await tx`
          INSERT INTO outbox (event_type, payload, dedupe_key, next_attempt_at)
          VALUES (
            'index.chapter',
            ${tx.json(jsonValue({ chapterId, versionId, workspaceId: auth.workspace.id }))},
            ${`index:${versionId}:reindex`},
            now()
          )
          ON CONFLICT (dedupe_key) DO NOTHING
        `;
      }
      await tx`
        INSERT INTO events (
          workspace_id, aggregate_type, aggregate_id, event_type, payload, actor_id
        )
        VALUES (
          ${auth.workspace.id}, 'chapter', ${chapterId}, 'chapter.imported',
          ${tx.json(jsonValue({ versionId, source: 'import' }))}, ${auth.user.id}
        )
      `;
      await tx`
        INSERT INTO audit_log (
          workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
        )
        VALUES (
          ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, 'chapter.import',
          'chapter', ${chapterId}, 'success',
          ${tx.json(
            jsonValue({
              versionId,
              evidence: 'not_evaluated',
              workTitle,
              volumeNumber: input.volumeNumber,
            }),
          )}
        )
      `;

      imported.push({ id: chapterId, number: item.number, title: item.title, wordCount });
    }

    return {
      workId,
      workTitle,
      volumeId,
      volumeTitle,
      imported,
    };
  });
}
