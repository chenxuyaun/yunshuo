/**
 * 工具名槽位与 handler 键名。
 *
 * 形状按 5 个工具设计、实现只登记 2 个（docs/adr/0008-l1-split.md:17、
 * docs/云说-模型侧基座分层设计-2026-10-26.md:99）——L1b 追加工具时不动这里的结构。
 *
 * 槽位来源（不是自拟）：
 * - `get_chapter_plan`、`list_open_foreshadowing`：docs/adr/0008-l1-split.md:14-15
 * - `get_canon_excerpt`：docs/云说-模型侧基座研究-2026-10-26.md:46 的提案工具表
 * - 研究文档把检索拆成 `search_canon` / `search_ledger` 两个名字（同表 :42），但
 *   `apps/api/src/services/search-service.ts` 的 `searchCanon` 一次调用必然同时产出正典与账本两半，
 *   全仓库没有只跑一路的入口，所以合并成一个 `search` 槽位；空出来的那一格由
 *   `get_canon_excerpt` 占住，槽位总数仍是 5。
 */
export const TOOL_NAME_SLOTS = [
  'search',
  'get_character_state_as_of',
  'get_chapter_plan',
  'list_open_foreshadowing',
  'get_canon_excerpt',
] as const;

export type ToolName = (typeof TOOL_NAME_SLOTS)[number];

/** 本步真正登记了定义的工具名（其余槽位只有名字、没有定义）。 */
export const IMPLEMENTED_TOOL_NAMES = ['search', 'get_character_state_as_of'] as const;

export type ImplementedToolName = (typeof IMPLEMENTED_TOOL_NAMES)[number];

export type ReservedToolName = Exclude<ToolName, ImplementedToolName>;

/**
 * 槽位里还没有定义的名字。查表时必须能与"根本不存在的工具名"区分开：
 * L2 要拒绝未注册的工具名并记下这次尝试（设计文档 :135），
 * 而"留了槽、实现未到"和"没这个工具"对审计是两件事。
 */
export const RESERVED_TOOL_NAMES = TOOL_NAME_SLOTS.filter(
  (name): name is ReservedToolName =>
    !(IMPLEMENTED_TOOL_NAMES as readonly string[]).includes(name),
);

/**
 * 绑定层的键名。刻意与工具名分开：名字是模型可见、会随描述评审改动的契约，
 * 键名是代码里的接线点；一个 handler 可以服务多个工具名（研究文档本来就把检索
 * 拆成 `search_canon` / `search_ledger` 两个名字，背后是同一段代码）。
 *
 * `satisfies readonly ImplementedToolName[]` 钉住每个键都属于已实现工具名，
 * 于是 `HandlerKey` 是 `ImplementedToolName` 的子集，`ToolInputFor<HandlerKey>` 才有意义。
 */
export const HANDLER_KEYS = [
  'search',
  'get_character_state_as_of',
] as const satisfies readonly ImplementedToolName[];

export type HandlerKey = (typeof HANDLER_KEYS)[number];
