/**
 * 检索正文预算：整章装配（apps/api/src/services/ai-service.ts 的 loadProposalRetrieval）
 * 与工具面（apps/api/src/tools/）共用同一组常量，避免两处各写一份、慢慢漂移。
 *
 * 重要边界：这四个值是**从整章装配借来的，不是为单次工具调用标定的**
 * （见 docs/adr/0008-l1-split.md 的「L1a 实施补记」）。整章装配只消费正典一路；
 * 工具面要同时展开正典与账本，所以两个半区各套一次，单次调用的合计上限是两倍。
 * 将来要按工具调用标定，改这里就要同时重新看整章装配的行为。
 */
export const RETRIEVAL_RESULT_LIMIT = 6;
export const RETRIEVAL_TOTAL_CHARS = 2400;
export const RETRIEVAL_CHUNK_CHARS = 500;
export const RETRIEVAL_PER_CHAPTER = 2;
