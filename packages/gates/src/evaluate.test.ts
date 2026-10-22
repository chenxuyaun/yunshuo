import { countWords, type ChapterPlan, type GateRulesetConfig } from '@yunshuo/domain';
import { describe, expect, it } from 'vitest';
import { runAudits } from './audits.js';
import { DEV_RULESET } from './dev-v0.js';
import { evaluateGates } from './evaluate.js';
import { checkGateFeasibility } from './feasibility.js';

const plan: ChapterPlan = {
  requiredEntities: ['林默'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

function gate(content: string, ruleset: GateRulesetConfig = DEV_RULESET) {
  return evaluateGates({
    content,
    wordCount: countWords(content),
    plan,
    ruleset,
  });
}

describe('evaluateGates', () => {
  it('passes all five gates for a compliant draft', () => {
    const content =
      '林默把封印符压进门框，追兵在巷口停下，雨声盖住了脚步。'.repeat(20) +
      '铜钉滚进水沟。他听见门后的声音，问：“你打算拿什么封？”';
    const result = gate(content);

    expect(result.status).toBe('passed');
    expect(result.results).toHaveLength(5);
    expect(result.results.every((item) => item.status === 'passed')).toBe(true);
  });

  it('fails short, missing-entity, banned-phrase, and hook drafts', () => {
    const content = '林默仿佛走了一步。';
    const result = gate(content);
    const byKey = Object.fromEntries(result.results.map((item) => [item.key, item]));

    expect(result.status).toBe('failed');
    expect(byKey.word_count?.status).toBe('failed');
    expect(byKey.ai_tone?.status).toBe('failed');
    expect(byKey.core_entity?.status).toBe('passed');
    expect(byKey.chapter_hook?.status).toBe('failed');
    expect(byKey.causality?.status).toBe('failed');
  });

  it('blocks rather than passes when required rules are not configured', () => {
    const result = gate('林默把封印符压进门框，追兵在巷口停下。', {});
    const byKey = Object.fromEntries(result.results.map((item) => [item.key, item]));

    expect(result.status).toBe('blocked');
    expect(byKey.word_count?.status).toBe('not_configured');
    expect(byKey.ai_tone?.status).toBe('not_configured');
    expect(byKey.chapter_hook?.status).toBe('not_configured');
    expect(byKey.core_entity?.status).toBe('passed');
    expect(byKey.causality?.status).toBe('passed');
  });
});

describe('runAudits', () => {
  it('keeps advisory checks honest', () => {
    const audits = runAudits('他仿佛笑了一下,然后说：好。');
    const byKey = Object.fromEntries(audits.map((item) => [item.key, item]));

    expect(byKey.ai_flavor?.status).toBe('warning');
    expect(byKey.punctuation?.status).toBe('warning');
    expect(byKey.typos?.status).toBe('not_connected');
    expect(byKey.coherence?.status).toBe('not_connected');
    expect(audits.every((item) => item.advisoryOnly)).toBe(true);
  });
});

describe('checkGateFeasibility', () => {
  it('accepts the dev ruleset with a complete plan', () => {
    const result = checkGateFeasibility({ plan, ruleset: DEV_RULESET, targetWords: 800 });
    expect(result.feasible).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it('rejects missing gate configuration before any model call', () => {
    const result = checkGateFeasibility({ plan: {}, ruleset: {} });
    expect(result.feasible).toBe(false);
    expect(result.blockers).toHaveLength(5);
  });

  it('rejects contradictory banned and required terms', () => {
    const result = checkGateFeasibility({
      plan: { requiredEntities: ['眸子'], goalKeywords: ['封印'], obstacleKeywords: ['追兵'] },
      ruleset: DEV_RULESET,
    });
    expect(result.feasible).toBe(false);
    expect(result.blockers.join('')).toContain('眸子');
  });

  it('warns when the target word count is below the gate floor', () => {
    const result = checkGateFeasibility({ plan, ruleset: DEV_RULESET, targetWords: 200 });
    expect(result.feasible).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
