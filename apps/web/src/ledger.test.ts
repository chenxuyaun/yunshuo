import { describe, expect, it } from 'vitest';
import type {
  LedgerCharacterPayload,
  LedgerEntryPayload,
  LedgerEntrySnapshot,
  LedgerForeshadowingPayload,
  LedgerSettingPayload,
} from '@yunshuo/contracts';
import {
  diffLedgerSnapshots,
  isCharacterPayload,
  isForeshadowingPayload,
  isSettingPayload,
  parseListInput,
  payoffWindowLabel,
} from './ledger.js';

const CH1 = '00000000-0000-4000-8000-000000000001';
const CH2 = '00000000-0000-4000-8000-000000000002';
const chapterLabel = (chapterId: string | null): string =>
  chapterId === null ? '—' : chapterId === CH1 ? '第 1 章' : '第 2 章';

function settingPayload(overrides: Partial<LedgerSettingPayload> = {}): LedgerSettingPayload {
  return {
    category: 'world',
    details: '',
    tags: [],
    verification: 'unverified',
    ...overrides,
  };
}

function characterPayload(
  overrides: Partial<LedgerCharacterPayload> = {},
): LedgerCharacterPayload {
  return {
    role: '',
    appearance: '',
    personality: '',
    goals: '',
    faction: '',
    abilities: '',
    speechStyle: '',
    relationships: [],
    states: [],
    ...overrides,
  };
}

function foreshadowingPayload(
  overrides: Partial<LedgerForeshadowingPayload> = {},
): LedgerForeshadowingPayload {
  return {
    seedChapterId: CH1,
    payoffChapterMin: null,
    payoffChapterMax: null,
    importance: 'medium',
    state: 'planted',
    payoffChapterId: null,
    note: '',
    resolutionNote: '',
    ...overrides,
  };
}

function snapshot(
  payload: LedgerEntryPayload,
  overrides: Partial<LedgerEntrySnapshot> = {},
): LedgerEntrySnapshot {
  return {
    name: '封印阵',
    aliases: [],
    summary: '',
    sourceChapterId: null,
    payload,
    ...overrides,
  };
}

describe('账本纯函数', () => {
  it('parseListInput 兼容半角/全角逗号与换行，去空白后按首次出现去重', () => {
    expect(parseListInput(' 林默, 苏晚，林默\n\n陈舟, ')).toEqual(['林默', '苏晚', '陈舟']);
    expect(parseListInput('')).toEqual([]);
    expect(parseListInput(' , ，\n')).toEqual([]);
  });

  it('payoffWindowLabel 四种窗口形状各自成句', () => {
    expect(payoffWindowLabel(10, 20)).toBe('第 10–20 章');
    expect(payoffWindowLabel(10, null)).toBe('第 10 章起');
    expect(payoffWindowLabel(null, 20)).toBe('第 20 章前');
    expect(payoffWindowLabel(null, null)).toBe('未设置计划窗口');
  });

  it('三个类型守卫只认各自的判别字段', () => {
    const setting = settingPayload();
    const character = characterPayload();
    const foreshadowing = foreshadowingPayload();
    expect([isSettingPayload(setting), isCharacterPayload(setting), isForeshadowingPayload(setting)]).toEqual([
      true,
      false,
      false,
    ]);
    expect([
      isSettingPayload(character),
      isCharacterPayload(character),
      isForeshadowingPayload(character),
    ]).toEqual([false, true, false]);
    expect([
      isSettingPayload(foreshadowing),
      isCharacterPayload(foreshadowing),
      isForeshadowingPayload(foreshadowing),
    ]).toEqual([false, false, true]);
    // 角色守卫要求两个标记同时存在：只有 states 的新载荷不能冒充角色。
    expect(isCharacterPayload({ states: [] } as unknown as LedgerEntryPayload)).toBe(false);
  });
});

describe('diffLedgerSnapshots', () => {
  it('草稿从无到有时只列可见差异：空摘要/空别名/空来源不占行', () => {
    const rows = diffLedgerSnapshots(
      null,
      snapshot(
        settingPayload({
          details: '由九块石碑组成',
          tags: ['上古', '禁地'],
          verification: 'verified',
        }),
      ),
      chapterLabel,
    );
    expect(rows).toEqual([
      { label: '名称', before: '—', after: '封印阵' },
      { label: '分类', before: '—', after: '世界观' },
      { label: '核实状态', before: '—', after: '已核实' },
      { label: '详细说明', before: '—', after: '由九块石碑组成' },
      { label: '标签', before: '—', after: '上古、禁地' },
    ]);
  });

  it('快照完全一致时没有任何行', () => {
    const value = snapshot(settingPayload({ details: '不变' }), {
      aliases: ['阵眼'],
      summary: '摘要',
      sourceChapterId: CH1,
    });
    expect(diffLedgerSnapshots(value, value, chapterLabel)).toEqual([]);
  });

  it('角色只列真正变化的身份、关系与状态时间线', () => {
    const before = snapshot(
      characterPayload({
        role: '守阵人',
        relationships: [{ name: '苏晚', relation: '同伴', notes: '' }],
        states: [
          {
            asOfChapterId: CH1,
            life: 'alive',
            location: '山门',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      }),
    );
    const after = snapshot(
      characterPayload({
        role: '主角',
        relationships: [{ name: '苏晚', relation: '同伴', notes: '旧友' }],
        states: [
          {
            asOfChapterId: CH1,
            life: 'alive',
            location: '地宫',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
          {
            asOfChapterId: CH2,
            life: 'dead',
            location: '',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      }),
    );
    expect(diffLedgerSnapshots(before, after, chapterLabel)).toEqual([
      { label: '身份', before: '守阵人', after: '主角' },
      { label: '关系', before: '苏晚（同伴）', after: '苏晚（同伴）：旧友' },
      { label: '状态 · 第 1 章', before: '存活 · 地点：山门', after: '存活 · 地点：地宫' },
      { label: '状态 · 第 2 章', before: '—', after: '死亡' },
    ]);
  });

  it('伏笔用中文标签描述状态与计划窗口，回收信息两边都空时不占行', () => {
    const rows = diffLedgerSnapshots(
      null,
      snapshot(
        foreshadowingPayload({
          state: 'planted',
          importance: 'high',
          payoffChapterMin: 10,
          payoffChapterMax: 20,
          note: '旧钟声',
        }),
      ),
      chapterLabel,
    );
    expect(rows).toEqual([
      { label: '名称', before: '—', after: '封印阵' },
      { label: '状态', before: '—', after: '已埋设' },
      { label: '重要度', before: '—', after: '高' },
      { label: '埋设章节', before: '—', after: '第 1 章' },
      { label: '计划回收窗口', before: '—', after: '第 10–20 章' },
      { label: '伏笔说明', before: '—', after: '旧钟声' },
    ]);
  });

  it('未知载荷退回整段 JSON 对照', () => {
    const payload = { custom: 1 } as unknown as LedgerEntryPayload;
    const rows = diffLedgerSnapshots(null, snapshot(payload), chapterLabel);
    expect(rows.map((row) => row.label)).toEqual(['名称', '内容']);
    expect(rows[1]!.after).toContain('"custom": 1');
  });
});
