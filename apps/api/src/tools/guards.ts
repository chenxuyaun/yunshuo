import { sql } from '@yunshuo/db';
import type { AuthContext } from '../auth.js';
import { notFound } from '../errors.js';

/**
 * 工具层的跨工作区闸门。
 *
 * 为什么工具层要自己做：searchCanon 的四条取数查询只带工作区过滤（apps/api/src/services/search-service.ts
 * 里 runLexicalSearch / runVectorSearch / runLedgerLexicalSearch / runLedgerVectorSearch 各自的
 * `workspace_id = …` 条件），传别的作品的 id 只会得到空结果，看起来像"没有命中"；
 * 工具面要的是"404，不区分存在但不可见"。
 * 章节侧 getCharacterContext 自己会 404（ledger-service.ts:1522-1525），这里仍然复用同一个口径与码。
 */

export async function assertWorkVisible(auth: AuthContext, workId: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM works
    WHERE id = ${workId} AND workspace_id = ${auth.workspace.id}
    LIMIT 1
  `;
  if (!rows[0]) throw notFound('WORK_NOT_FOUND', '作品不存在或不属于当前工作区');
}

export async function assertChapterVisible(auth: AuthContext, chapterId: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT c.id
    FROM chapters c
    JOIN works w ON w.id = c.work_id
    WHERE c.id = ${chapterId} AND w.workspace_id = ${auth.workspace.id}
    LIMIT 1
  `;
  if (!rows[0]) throw notFound('CHAPTER_NOT_FOUND', '章节不存在或不属于当前工作区');
}
