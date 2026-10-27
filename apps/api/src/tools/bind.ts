import type { LedgerCharacterContext } from '@yunshuo/contracts';
import {
  getToolDefinition,
  type HandlerKey,
  type ToolInputFor,
} from '@yunshuo/tool-surface';
import type { AuthContext } from '../auth.js';
import { getCharacterStateAsOfToolHandler } from './character-state-handler.js';
import { searchToolHandler } from './search-handler.js';
import type { ToolSearchResult } from './search-projection.js';

/**
 * 工具绑定层：把工具定义里的 handler 键名接到 apps/api 的真实 handler 上。
 *
 * 形状约束（设计文档 :100）：每个 handler 的第一个参数必须是 AuthContext，
 * 工作区、角色、主体只能来自服务端身份，不从工具参数里读；漏写这个参数过不了 typecheck。
 * 返回值按 handlerKey 精确标注——search 返回投影（带展开正文与步级预算），
 * get_character_state_as_of 原样返回服务契约 LedgerCharacterContext。
 */
export interface ToolResultMap {
  search: ToolSearchResult;
  get_character_state_as_of: LedgerCharacterContext;
}

export type ToolHandler<K extends HandlerKey> = (
  auth: AuthContext,
  args: ToolInputFor<K>,
) => Promise<ToolResultMap[K]>;

/** 键名 → handler。`{ readonly [K in HandlerKey]: ... }` 要求每个键都在，漏一个就 tsc 红。 */
export const toolHandlers: { readonly [K in HandlerKey]: ToolHandler<K> } = {
  search: searchToolHandler,
  get_character_state_as_of: getCharacterStateAsOfToolHandler,
};

export type AnyToolHandler = (typeof toolHandlers)[HandlerKey];

/**
 * 按工具名取 handler；保留槽位与未知工具名都返回 null。
 * 调用方要区分这两种情况时用 `classifyToolName`（两者对审计不是一回事）。
 */
export function toolHandlerFor(name: string): AnyToolHandler | null {
  const definition = getToolDefinition(name);
  return definition ? toolHandlers[definition.handlerKey] : null;
}
