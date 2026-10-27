import type { LedgerCharacterContext } from '@yunshuo/contracts';
import type { GetCharacterStateAsOfToolInput } from '@yunshuo/tool-surface';
import type { AuthContext } from '../auth.js';
import { assertCanReadManuscript } from '../auth.js';
import { getCharacterContext } from '../services/ledger-service.js';

/**
 * get_character_state_as_of 工具 handler：只做适配，不改服务的口径。
 *
 * - 计费闸门在工具层重放一次（服务层 getCharacterContext 自己也会 assertCanReadLedger，
 *   但那是同一条账本读路径的兜底，不代表工具入口可以省）。
 * - 跨工作区 404 由服务产生（ledger-service.ts:1518-1525 按 w.workspace_id 过滤后抛 CHAPTER_NOT_FOUND）。
 * - as-of / stale / omittedCharacters 全部保留服务原样：时点固定是该章之前章号最大的那一章。
 */
export async function getCharacterStateAsOfToolHandler(
  auth: AuthContext,
  args: GetCharacterStateAsOfToolInput,
): Promise<LedgerCharacterContext> {
  assertCanReadManuscript(auth.role);
  return getCharacterContext(auth, args.chapterId);
}
