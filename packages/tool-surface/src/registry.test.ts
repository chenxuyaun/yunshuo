import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, type ToolDefinition } from './definition.js';
import { getCharacterStateAsOfTool, getCharacterStateAsOfInputSchema } from './definitions/get-character-state-as-of.js';
import { searchTool, searchToolInputSchema, type SearchToolInput } from './definitions/search.js';
import {
  HANDLER_KEYS,
  IMPLEMENTED_TOOL_NAMES,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_SLOTS,
} from './names.js';
import {
  TOOL_DEFINITIONS,
  classifyToolName,
  getToolDefinition,
  listToolDefinitions,
  type ToolInputFor,
} from './registry.js';

const UUID = '00000000-0000-4000-8000-000000000000';

describe('注册表形状：5 个槽位、2 条登记', () => {
  it('槽位是 5 个互不重复的工具名', () => {
    expect(TOOL_NAME_SLOTS).toHaveLength(5);
    expect(new Set(TOOL_NAME_SLOTS).size).toBe(5);
    expect([...TOOL_NAME_SLOTS].sort()).toEqual([
      'get_canon_excerpt',
      'get_chapter_plan',
      'get_character_state_as_of',
      'list_open_foreshadowing',
      'search',
    ]);
  });

  it('只登记了 2 个，键与已实现清单一致', () => {
    expect(IMPLEMENTED_TOOL_NAMES).toHaveLength(2);
    expect(Object.keys(TOOL_DEFINITIONS).sort()).toEqual([...IMPLEMENTED_TOOL_NAMES].sort());
    expect(listToolDefinitions()).toHaveLength(2);
    expect(listToolDefinitions().map((definition) => definition.name).sort()).toEqual(
      [...IMPLEMENTED_TOOL_NAMES].sort(),
    );
  });

  it('每条定义的 name 与登记键一致，handlerKey 都在绑定清单里', () => {
    for (const name of IMPLEMENTED_TOOL_NAMES) {
      const definition = TOOL_DEFINITIONS[name];
      expect(definition.name).toBe(name);
      expect(HANDLER_KEYS).toContain(definition.handlerKey);
    }
  });

  it('保留槽位可被识别，但查不到定义（不拿空定义冒充）', () => {
    expect(RESERVED_TOOL_NAMES).toHaveLength(3);
    for (const name of RESERVED_TOOL_NAMES) {
      expect(classifyToolName(name)).toBe('reserved');
      expect(getToolDefinition(name)).toBeNull();
      expect(IMPLEMENTED_TOOL_NAMES).not.toContain(name);
    }
    expect(classifyToolName('search')).toBe('implemented');
    expect(classifyToolName('search_canon')).toBe('unknown');
    expect(classifyToolName('')).toBe('unknown');
    expect(getToolDefinition('不存在的工具')).toBeNull();
  });

  it('已登记的工具取到的就是那一份定义', () => {
    expect(getToolDefinition('search')).toBe(searchTool);
    expect(getToolDefinition('get_character_state_as_of')).toBe(getCharacterStateAsOfTool);
  });

  it('结构本身容纳未登记的第 3 个工具：给保留槽位补一份完整定义不改注册表类型', () => {
    // 下件的类型标注是这段的编译期证据：ToolDefinition 的名字参数接受全部 5 个槽位，
    // 所以 L1b 追加工具只是新增定义 + 往 TOOL_DEFINITIONS 添一行。
    const plannedInputSchema = z.object({ chapterId: z.string().uuid() });
    const planned: ToolDefinition<'get_chapter_plan', typeof plannedInputSchema> = {
      name: 'get_chapter_plan',
      title: '读取本章章纲',
      description: '取指定章节的章纲五键文档。',
      inputSchema: plannedInputSchema,
      // handlerKey 与 name 是两根轴：这里故意指向已存在的检索 handler，
      // 只为证明类型不要求一一对应（真正的实现会加自己的键）。
      handlerKey: 'search',
      annotations: READ_ONLY_ANNOTATIONS,
    };
    expect(planned.name).toBe('get_chapter_plan');
    expect(planned.handlerKey).toBe('search');
    // 只构造、不登记：运行时条目仍然是 2。
    expect(getToolDefinition(planned.name)).toBeNull();
    expect(Object.keys(TOOL_DEFINITIONS)).toHaveLength(2);
  });
});

describe('search 工具的入参契约', () => {
  const parse = (raw: unknown) => searchToolInputSchema.parse(raw);

  it('只给 query 时补默认值：mode=auto、limit=8，并 trim 检索词', () => {
    expect(parse({ query: '  封印  ' })).toEqual({ query: '封印', mode: 'auto', limit: 8 });
  });

  it('缺 query / 空串 / 全空白都被拒', () => {
    expect(() => parse({})).toThrow();
    expect(() => parse({ query: '' })).toThrow();
    expect(() => parse({ query: '   ' })).toThrow();
  });

  it('检索词上限 200：200 通过，201 被拒', () => {
    expect(parse({ query: '雨'.repeat(200) }).query).toHaveLength(200);
    expect(() => parse({ query: '雨'.repeat(201) })).toThrow();
  });

  it('limit 取值 1..20，默认 8', () => {
    expect(parse({ query: '雨' }).limit).toBe(8);
    expect(parse({ query: '雨', limit: 1 }).limit).toBe(1);
    expect(parse({ query: '雨', limit: 20 }).limit).toBe(20);
    expect(() => parse({ query: '雨', limit: 0 })).toThrow();
    expect(() => parse({ query: '雨', limit: 21 })).toThrow();
    expect(() => parse({ query: '雨', limit: 1.5 })).toThrow();
  });

  it('mode 只接受 auto / lexical', () => {
    expect(parse({ query: '雨', mode: 'lexical' }).mode).toBe('lexical');
    expect(() => parse({ query: '雨', mode: 'vector' })).toThrow();
  });

  it('workId / excludeChapterId 必须是 uuid', () => {
    expect(parse({ query: '雨', workId: UUID, excludeChapterId: UUID })).toMatchObject({
      workId: UUID,
      excludeChapterId: UUID,
    });
    expect(() => parse({ query: '雨', workId: 'work-1' })).toThrow();
    expect(() => parse({ query: '雨', excludeChapterId: 'chapter-1' })).toThrow();
  });

  it('不接受 workspaceId：工作区只能来自服务端身份', () => {
    expect('workspaceId' in parse({ query: '雨', workspaceId: UUID })).toBe(false);
  });

  it('asOfChapterNumber 可选，且必须是正整数：不传时行为与没有这个参数一致', () => {
    expect(parse({ query: '雨' }).asOfChapterNumber).toBeUndefined();
    expect(parse({ query: '雨', asOfChapterNumber: 1 }).asOfChapterNumber).toBe(1);
    expect(() => parse({ query: '雨', asOfChapterNumber: 0 })).toThrow();
    expect(() => parse({ query: '雨', asOfChapterNumber: 1.5 })).toThrow();
    expect(() => parse({ query: '雨', asOfChapterNumber: '五' })).toThrow();
    // 只有这一个章号参数；别的名字不会被悄悄放行。
    expect('beforeChapterNumber' in parse({ query: '雨', beforeChapterNumber: 5 })).toBe(false);
    expect('maxChapterNumber' in parse({ query: '雨', maxChapterNumber: 5 })).toBe(false);
  });

  // 模型侧（OpenAI 与 MCP 两种调用风格）常把"未提供的可选参数"显式发成 null。
  // 只写 .optional() 会让这种合法调用在进 handler 之前就被拒掉。
  it('可选参数显式发 null 等同未提供，不被 schema 拒', () => {
    expect(parse({ query: '雨', workId: null, excludeChapterId: null })).toEqual({
      query: '雨',
      mode: 'auto',
      limit: 8,
    });
    expect(parse({ query: '雨', asOfChapterNumber: null }).asOfChapterNumber).toBeUndefined();
    expect(parse({ query: '雨', mode: null, limit: null })).toMatchObject({ mode: 'auto', limit: 8 });
  });
});

describe('get_character_state_as_of 工具的入参契约', () => {
  const parse = (raw: unknown) => getCharacterStateAsOfInputSchema.parse(raw);

  it('chapterId 必填且必须是 uuid', () => {
    expect(parse({ chapterId: UUID })).toEqual({ chapterId: UUID });
    expect(() => parse({})).toThrow();
    expect(() => parse({ chapterId: 'chapter-1' })).toThrow();
  });

  it('只有 chapterId 一个入参，时点不交给调用方', () => {
    expect(Object.keys(getCharacterStateAsOfInputSchema.shape)).toEqual(['chapterId']);
  });
});

describe('两个工具的元信息', () => {
  it('都是只读、非破坏性、幂等', () => {
    for (const definition of listToolDefinitions()) {
      expect(definition.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('描述写清了「给什么、不给什么」，不是空文案', () => {
    expect(searchTool.description.length).toBeGreaterThan(120);
    expect(searchTool.description).toContain('ledgerResults');
    expect(searchTool.description).toContain('摘要');
    expect(searchTool.description).toContain('展开后的切块正文');
    expect(searchTool.description).toContain('budget');
    expect(searchTool.description).toContain('asOfChapterNumber');

    expect(getCharacterStateAsOfTool.description.length).toBeGreaterThan(120);
    expect(getCharacterStateAsOfTool.description).toContain('之前');
    expect(getCharacterStateAsOfTool.description).toContain('stale');
    expect(getCharacterStateAsOfTool.description).toContain('omittedCharacters');
  });

  it('handlerKey 与工具名分开登记', () => {
    expect(searchTool.handlerKey).toBe('search');
    expect(getCharacterStateAsOfTool.handlerKey).toBe('get_character_state_as_of');
  });
});

describe('入参类型推导', () => {
  it('ToolInputFor 直接来自各工具的 zod schema，不另写一份', () => {
    expectTypeOf<ToolInputFor<'search'>>().toEqualTypeOf<SearchToolInput>();
    expectTypeOf<ToolInputFor<'search'>>().toEqualTypeOf<z.output<typeof searchToolInputSchema>>();
    expectTypeOf<ToolInputFor<'get_character_state_as_of'>>().toEqualTypeOf<{
      chapterId: string;
    }>();
  });
});

describe('inputSchema 的派生口径（OpenAI 的 parameters 与 MCP 的 inputSchema 共用）', () => {
  it('search：{ io: "input" } 下 required 只有 query，六个入参都在 properties 里', () => {
    const inputJsonSchema = z.toJSONSchema(searchToolInputSchema, { io: 'input' });
    expect(inputJsonSchema.type).toBe('object');
    expect(inputJsonSchema.required).toEqual(['query']);
    expect(Object.keys(inputJsonSchema.properties ?? {}).sort()).toEqual([
      'asOfChapterNumber',
      'excludeChapterId',
      'limit',
      'mode',
      'query',
      'workId',
    ]);
    // 默认的 output 语义会把带默认值的 mode/limit 也算进 required，那不是入参的必填集合
    expect(z.toJSONSchema(searchToolInputSchema).required).toEqual(['query', 'mode', 'limit']);
  });

  it('get_character_state_as_of：同一个口径下 required 只有 chapterId', () => {
    const inputJsonSchema = z.toJSONSchema(getCharacterStateAsOfInputSchema, { io: 'input' });
    expect(inputJsonSchema.type).toBe('object');
    expect(inputJsonSchema.required).toEqual(['chapterId']);
  });
});
