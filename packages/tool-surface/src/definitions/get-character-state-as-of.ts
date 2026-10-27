import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition } from '../definition.js';

/**
 * 角色状态入参：只有章节 id。
 *
 * 时点不由调用方给——服务层固定取"该章之前章号最大的那一章"
 * （apps/api/src/services/ledger-service.ts:1526-1533），这是防剧透裁剪的落点
 * （docs/adr/0008-l1-split.md:15），不是可调参数。
 */
export const getCharacterStateAsOfInputSchema = z.object({
  chapterId: z.string().uuid(),
});

export type GetCharacterStateAsOfToolInput = z.infer<typeof getCharacterStateAsOfInputSchema>;

/**
 * 背后是 ledger-service.ts:1513-1588 的 getCharacterContext：
 * 只取 status='active' 且 current_version_id 已发布的角色（:1534-1549），
 * 逐条把 payload.states 按章号截到 asOf 之前、取最后一条（:1554-1574），
 * 截不到的角色只计入 omittedCharacters；stale 表示最近一条状态早于时点（:1572）。
 * 开篇章（没有更小章号）asOfChapter=null、characters=[]，这是正常结果。
 */
export const getCharacterStateAsOfTool = {
  name: 'get_character_state_as_of',
  title: '读取某章之前的角色状态',
  description:
    '读取某一章"之前"的角色状态快照：时点是该章的上一章（章号更小的最近一章），用来看清人物在这章开头应当知道什么、身在何处，同时不把还没写到的剧情提前交给你。' +
    '只返回已发布且处于 active 的角色；每个角色给出一条截至该时点的最新状态（生命状态、所在地、知情、持有、关系变化），stale=true 表示这条状态早于时点，可能已经过时。' +
    '在该时点之前没有留下状态的角色不会出现，只计入 omittedCharacters；第一段（没有上一章）恒返回空角色列表与 asOfChapter=null，这是正常结果，不是错误。' +
    '入参通常传你正在写的那一章的 id。只读；工作区由服务端身份决定。',
  inputSchema: getCharacterStateAsOfInputSchema,
  handlerKey: 'get_character_state_as_of',
  annotations: READ_ONLY_ANNOTATIONS,
} as const satisfies ToolDefinition<'get_character_state_as_of', typeof getCharacterStateAsOfInputSchema>;
