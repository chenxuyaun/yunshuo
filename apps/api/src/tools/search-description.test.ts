import { searchTool } from '@yunshuo/tool-surface';
import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_CHUNK_CHARS,
  RETRIEVAL_PER_CHAPTER,
  RETRIEVAL_RESULT_LIMIT,
  RETRIEVAL_TOTAL_CHARS,
} from '../services/retrieval-budget.js';

/**
 * 描述是模型看到的"说明书"，里面的预算数字必须与服务层常量同源，不能各写一份。
 * 这条用例放在 api 侧：packages/tool-surface 不依赖 api（ADR-0002），
 * 所以只有这里能同时看到描述与 retrieval-budget.ts 的常量。
 * 常量一改而描述没跟着改，这里立刻变红。
 */
describe('search 描述的预算数字与 retrieval-budget 常量对齐', () => {
  it('每半条数 / 每半字数 / 单块字数 / 每章条数四处数字都来自常量', () => {
    const description = searchTool.description;
    expect(description).toContain(`每半最多 ${RETRIEVAL_RESULT_LIMIT} 条`);
    expect(description).toContain(`每半最多 ${RETRIEVAL_TOTAL_CHARS} 字`);
    expect(description).toContain(`单块最多 ${RETRIEVAL_CHUNK_CHARS} 字`);
    expect(description).toContain(`每章 ${RETRIEVAL_PER_CHAPTER} 条只作用于正典半`);
  });

  it('描述不再把预算说成两个半区共用的一个合计', () => {
    const description = searchTool.description;
    expect(description).not.toContain(`合计 ${RETRIEVAL_TOTAL_CHARS} 字`);
    expect(description).not.toContain(`合计 ${RETRIEVAL_RESULT_LIMIT} 条`);
    expect(description).toContain('两个半区各套一套');
    expect(description).toContain('合计上限是两倍');
  });
});
