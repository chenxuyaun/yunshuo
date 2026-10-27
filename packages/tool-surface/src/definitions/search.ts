import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition } from '../definition.js';

/**
 * 检索入参。
 *
 * 字段名用服务层的 `query`，不是 HTTP query string 的 `q`
 * （packages/contracts/src/index.ts:191-197 的 searchCanonSchema 是给 query string 用的形状）。
 * 边界对齐服务层实际口径：默认 8、封顶 20（apps/api/src/services/search-service.ts 的 searchCanon
 * 开头那行 `Math.min(20, Math.max(1, input.limit ?? 8))`），
 * 检索词上限 200 与 searchCanonSchema 同口径。这是第二份声明，行为由 registry.test.ts 钉住；
 * 服务端改边界时要同步改这里。
 *
 * 没有 workspaceId：它只能来自服务端身份（AuthContext），模型无权填。
 * 章号上界只有 asOfChapterNumber 一个（只作用于正典两路，见
 * apps/api/src/services/search-service.ts 的 asOfFilter）；不传时行为与没有这个参数完全一致。
 */
/**
 * 模型侧常把「未提供的可选参数」显式发成 null（OpenAI 与 MCP 两种调用风格都会）。
 * schema 若只写 .optional()，null 会在进 handler 之前就被拒掉；这里把 null 当「未提供」处理。
 */
function absentIfNull<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema);
}

export const searchToolInputSchema = z.object({
  query: z.string().trim().min(1, '请输入检索词').max(200),
  workId: absentIfNull(z.string().uuid().optional()),
  excludeChapterId: absentIfNull(z.string().uuid().optional()),
  mode: absentIfNull(z.enum(['auto', 'lexical']).default('auto')),
  limit: absentIfNull(z.coerce.number().int().min(1).max(20).default(8)),
  asOfChapterNumber: absentIfNull(z.coerce.number().int().min(1).optional()),
});

export type SearchToolInput = z.infer<typeof searchToolInputSchema>;

/**
 * 一次调用同时取正典与账本两半——这是服务层的既有形状，不是这里的设计选择：
 * searchCanon 必然同时计算两半（search-service.ts 的 searchCanon 里，正典与账本的词法行、向量行
 * 分两组 Promise.all 一起取回），拆成两个工具只会让同一份
 * 覆盖度聚合、词法 SQL 与查询向量付两遍（M6 回顾审计里那条"一次查询向量两通道共用"）。
 */
export const searchTool = {
  name: 'search',
  title: '检索正典与账本',
  description:
    '按检索词查当前工作区的正典切块与账本条目；一次调用同时返回两半：results（正典命中）与 ledgerResults（账本命中）。' +
    '每条命中带摘要 excerpt（约 160 字）、展开后的切块正文 text（单块最多 500 字，超出会截断并标 textTruncated；它仍不是整章正文）与版本身份 versionId/versionNo；账本条目另带名称、类型、作用域与来源章（来源章不是状态时点）。' +
    '一次调用能展开的条数与字数有上限：budget 会说明这一步用了多少、有没有因预算丢弃命中；命中变少时先看 budget 与 coverage，再决定是否换更精确的检索词。' +
    '结果为空不等于"没有这类内容"：先看 coverage / ledgerCoverage 的索引状态与 semanticReason / ledgerReason，判断是确实没有、向量通道被阈值弃用，还是索引尚未就绪。' +
    'mode=auto 融合词法与向量两路，mode=lexical 只走词法；limit 是每半融合后的条数上限（默认 8，最多 20），' +
    '但单次调用还能展开多少条另有步级预算：正典与账本两个半区各套一套（每半最多 6 条、每半最多 2400 字，每章 2 条只作用于正典半），所以单次调用的合计上限是两倍；实际返回条数是 limit 与预算上限取小，被预算丢掉的数量记在 budget.dropped。' +
    '默认不按章号截断，可能命中写作位之后（更大章号）的章节；要排除当前章请传 excludeChapterId，要只看写作位之前（含该章号）请传 asOfChapterNumber——这两个都只限制正典半，账本半不受限。' +
    '只读。工作区由服务端身份决定，入参无法越界；workId 可把范围收窄到一部作品。',
  inputSchema: searchToolInputSchema,
  handlerKey: 'search',
  annotations: READ_ONLY_ANNOTATIONS,
} as const satisfies ToolDefinition<'search', typeof searchToolInputSchema>;
