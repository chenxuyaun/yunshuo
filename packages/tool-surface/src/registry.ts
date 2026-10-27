import type { z } from 'zod';
import type { ToolDefinition } from './definition.js';
import { getCharacterStateAsOfTool } from './definitions/get-character-state-as-of.js';
import { searchTool } from './definitions/search.js';
import {
  IMPLEMENTED_TOOL_NAMES,
  RESERVED_TOOL_NAMES,
  type ImplementedToolName,
  type ToolName,
} from './names.js';

/** 注册表里能放的定义：名字取全部 5 个槽位，schema 收成最宽的 zod 类型。 */
export type AnyToolDefinition = ToolDefinition<ToolName, z.ZodType>;

/**
 * 登记表：运行时只有 2 条。
 *
 * "结构容 5、条目 2"落在两处，互不替代：
 * - 类型上：`ToolDefinition` 的名字参数是 5 槽的 `ToolName`，往这里加第 3 个只是多一行，
 *   registry 的代码与签名不用改（L1b 是纯追加，docs/adr/0008-l1-split.md:17）。
 * - 运行时：这里只有 2 个键；`RESERVED_TOOL_NAMES` 的 3 个名字查不到定义，
 *   也不会拿空定义冒充（AGENTS.md 硬规则 4）。
 */
export const TOOL_DEFINITIONS = {
  search: searchTool,
  get_character_state_as_of: getCharacterStateAsOfTool,
} as const satisfies Record<ImplementedToolName, AnyToolDefinition>;

/** 每个已实现工具的入参类型，直接从它自己的 zod schema 推导，不另写一份。 */
export type ToolInputFor<K extends ImplementedToolName> =
  (typeof TOOL_DEFINITIONS)[K] extends ToolDefinition<ToolName, infer TSchema>
    ? z.infer<TSchema>
    : never;

export type ToolNameClass = 'implemented' | 'reserved' | 'unknown';

/**
 * 把任意字符串分成三类。L2 要拒绝未注册的工具名并记下这次尝试（设计文档 :135）；
 * "槽位已留、实现未到"和"根本没这个工具"对审计是两回事，不能都并成 null。
 */
export function classifyToolName(name: string): ToolNameClass {
  if ((IMPLEMENTED_TOOL_NAMES as readonly string[]).includes(name)) return 'implemented';
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) return 'reserved';
  return 'unknown';
}

export function isImplementedToolName(name: string): name is ImplementedToolName {
  return classifyToolName(name) === 'implemented';
}

/** 已登记的定义；保留槽位与未知名字都返回 null。 */
export function getToolDefinition(name: string): AnyToolDefinition | null {
  return isImplementedToolName(name) ? TOOL_DEFINITIONS[name] : null;
}

/** 已登记的定义清单（只有 2 条），顺序与 IMPLEMENTED_TOOL_NAMES 一致。 */
export function listToolDefinitions(): AnyToolDefinition[] {
  return IMPLEMENTED_TOOL_NAMES.map((name) => TOOL_DEFINITIONS[name]);
}
