import type { SearchToolInput } from '@yunshuo/tool-surface';
import type { AuthContext } from '../auth.js';
import { assertCanReadManuscript } from '../auth.js';
import { searchCanon } from '../services/search-service.js';
import { assertChapterVisible, assertWorkVisible } from './guards.js';
import { projectSearchOutcome, type ToolSearchResult } from './search-projection.js';

/**
 * search 工具 handler。
 *
 * 顺序是刻意的：先过计费闸门（服务层的 searchCanon 内部没有角色检查，403 只在路由层，
 * apps/api/src/routes/search.ts:7-11——工具层必须自己补），再对入参里的资源 id 做跨工作区 404，
 * 最后才发检索。一次调用同时算正典与账本两半（search-service.ts 的 searchCanon），
 * 不在这里拆成两次，否则覆盖度聚合、词法 SQL 与查询向量都要付两遍。
 */
export async function searchToolHandler(
  auth: AuthContext,
  args: SearchToolInput,
): Promise<ToolSearchResult> {
  assertCanReadManuscript(auth.role);
  if (args.workId !== undefined) await assertWorkVisible(auth, args.workId);
  if (args.excludeChapterId !== undefined) {
    await assertChapterVisible(auth, args.excludeChapterId);
  }

  const outcome = await searchCanon({
    workspaceId: auth.workspace.id,
    query: args.query,
    workId: args.workId,
    excludeChapterId: args.excludeChapterId,
    mode: args.mode,
    limit: args.limit,
    asOfChapterNumber: args.asOfChapterNumber,
  });

  return projectSearchOutcome({
    response: outcome.response,
    contents: outcome.contents,
    ledgerContents: outcome.ledgerContents,
    scope: {
      workId: args.workId ?? null,
      excludeChapterId: args.excludeChapterId ?? null,
      asOfChapterNumber: args.asOfChapterNumber ?? null,
    },
  });
}
