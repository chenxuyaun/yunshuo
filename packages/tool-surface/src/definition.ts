import type { z } from 'zod';
import type { HandlerKey, ToolName } from './names.js';

/**
 * MCP annotations（docs/云说-模型侧基座研究-2026-10-26.md:49）。
 * 规范自己说这些 hint 不可信：它们只作展示性描述，真正的闸门是服务端校验
 * （设计文档 :100）。不要拿 readOnlyHint=true 代替 handler 里的权限判断。
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * 工具定义 = 名字 + 描述 + zod inputSchema + handler 键名（title/annotations 供 MCP 拾取）。
 *
 * 这个包里没有 handler 实现，也不认识 AuthContext——那是 apps/api 的绑定层
 * （apps/api/src/tools/bind.ts）。所以本包永远是纯数据 + 纯 schema，不产生 IO，
 * 也不会反向依赖 app。
 */
export interface ToolDefinition<
  TName extends ToolName = ToolName,
  TInput extends z.ZodType = z.ZodType,
> {
  readonly name: TName;
  /** MCP Tool 的 title，纯展示。 */
  readonly title: string;
  /** 模型选工具时唯一能依据的文字。 */
  readonly description: string;
  /**
   * 入参唯一真相：OpenAI 的 parameters 与 MCP 的 inputSchema 都从它派生。
   * 派生口径由用例钉住（registry.test.ts）：`z.toJSONSchema(inputSchema, { io: 'input' })`，
   * required 只有真正必填的字段——zod 默认的 output 语义会把带默认值的字段也算进 required，
   * 那不是入参的必填集合。
   */
  readonly inputSchema: TInput;
  /** 绑定层键名；与 name 是两根轴，不要求一一对应。 */
  readonly handlerKey: HandlerKey;
  readonly annotations: ToolAnnotations;
}

/** v1 全部只读、无写类工具（设计文档 :105）；四个 hint 的具体取值按工具类型写死。 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
