import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  HANDLER_KEYS,
  IMPLEMENTED_TOOL_NAMES,
  RESERVED_TOOL_NAMES,
  TOOL_DEFINITIONS,
  getToolDefinition,
  listToolDefinitions,
} from '@yunshuo/tool-surface';
import type { AuthContext } from '../auth.js';
import { toolHandlerFor, toolHandlers, type ToolHandler } from './bind.js';

describe('绑定表与注册表双向覆盖', () => {
  it('每个 handler 键都有实现，且没有多余键', () => {
    expect(Object.keys(toolHandlers).sort()).toEqual([...HANDLER_KEYS].sort());
  });

  // listToolDefinitions() 由 IMPLEMENTED_TOOL_NAMES 派生，看不见"多登记了一个键"。
  // 这里直接读登记表的原始键，让"多登记"在运行时也红，而不是只靠 tsc 的 TS2353。
  it('登记表原始键与已实现清单一致：多登记一条也会红，不只靠类型', () => {
    expect(Object.keys(TOOL_DEFINITIONS).sort()).toEqual([...IMPLEMENTED_TOOL_NAMES].sort());
  });

  it('定义 → handler：每个已登记的工具都能解析到 handler，并且就是表里那一个', () => {
    expect(listToolDefinitions()).toHaveLength(2);
    for (const definition of listToolDefinitions()) {
      expect(toolHandlerFor(definition.name)).toBe(toolHandlers[definition.handlerKey]);
    }
  });

  it('handler → 定义：没有孤儿 handler，每个键都至少有一个登记它的工具', () => {
    const definitions = listToolDefinitions();
    for (const key of Object.keys(toolHandlers)) {
      const owners = definitions.filter((definition) => definition.handlerKey === key);
      expect(owners.length).toBeGreaterThanOrEqual(1);
    }
    // 当前是一对一：两个工具名、两个 handler 键。
    expect(new Set(definitions.map((definition) => definition.handlerKey)).size).toBe(
      Object.keys(toolHandlers).length,
    );
  });

  it('保留槽位与未知工具名解析不到 handler（不是空实现冒充）', () => {
    for (const name of RESERVED_TOOL_NAMES) {
      expect(toolHandlerFor(name)).toBeNull();
    }
    expect(toolHandlerFor('search_canon')).toBeNull();
    expect(toolHandlerFor('')).toBeNull();
    expect(IMPLEMENTED_TOOL_NAMES).toHaveLength(2);
  });

  it('缺参在进入 handler 之前就被定义里的 schema 拒掉', () => {
    const search = getToolDefinition('search');
    const state = getToolDefinition('get_character_state_as_of');
    expect(search).not.toBeNull();
    expect(state).not.toBeNull();
    expect(() => search!.inputSchema.parse({})).toThrow();
    expect(() => state!.inputSchema.parse({})).toThrow();
  });
});

describe('handler 签名：权限不是注释，是签名', () => {
  it('第一个参数是 AuthContext，第二个是解析后的工具入参', () => {
    const searchHandler: ToolHandler<'search'> = toolHandlers.search;
    const stateHandler: ToolHandler<'get_character_state_as_of'> =
      toolHandlers.get_character_state_as_of;
    expect(searchHandler).toBe(toolHandlers.search);
    expect(stateHandler).toBe(toolHandlers.get_character_state_as_of);

    expectTypeOf(toolHandlers.search).parameter(0).toEqualTypeOf<AuthContext>();
    expectTypeOf(toolHandlers.get_character_state_as_of).parameter(0).toEqualTypeOf<AuthContext>();
  });

  it('运行时形参个数是 2（auth + args）', () => {
    for (const handler of Object.values(toolHandlers)) {
      expect(handler.length).toBe(2);
    }
  });
});
