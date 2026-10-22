import type { GateRulesetConfig } from '@yunshuo/domain';

export const DEV_RULESET_KEY = 'dev-v0';
export const DEV_RULESET_VERSION = 1;
export const DEV_RULESET_ID = '99999999-9999-4999-8999-999999999999';
export const DEV_RULESET_DESCRIPTION = '开发规则集 dev-v0（演示用，非生产）';

export const DEV_RULESET: GateRulesetConfig = {
  wordCount: {
    min: 300,
    label: '演示阈值 300 字（非生产）',
  },
  aiTone: {
    bannedPhrases: ['仿佛', '不禁', '嘴角勾起', '眸子'],
    maxHits: 0,
  },
  coreEntity: {},
  chapterHook: {
    markers: ['？', '！', '……', '却', '突然'],
    tailChars: 200,
  },
  causality: {},
};
