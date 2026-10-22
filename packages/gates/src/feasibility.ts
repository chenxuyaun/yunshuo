import type { ChapterPlan, GateRulesetConfig } from '@yunshuo/domain';

export interface GateFeasibilityInput {
  plan: ChapterPlan;
  ruleset: GateRulesetConfig;
  targetWords?: number;
}

export interface GateFeasibilityResult {
  feasible: boolean;
  blockers: string[];
  warnings: string[];
}

export function checkGateFeasibility(input: GateFeasibilityInput): GateFeasibilityResult {
  const { plan, ruleset, targetWords } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const wordFloor = ruleset.wordCount?.min ?? 0;
  if (wordFloor <= 0) {
    blockers.push('字数门槛未配置，门禁永远无法判定通过。');
  } else if (targetWords !== undefined && targetWords < wordFloor) {
    warnings.push(`目标字数 ${targetWords} 低于字数下限 ${wordFloor}，生成结果可能无法过门禁。`);
  }

  const tone = ruleset.aiTone;
  if (!tone || (tone.bannedPhrases.length === 0 && tone.maxHits <= 0)) {
    blockers.push('AI 腔调规则未配置，门禁永远无法判定通过。');
  }

  const requiredEntities = ruleset.coreEntity?.requiredEntities ?? plan.requiredEntities ?? [];
  if (requiredEntities.length === 0) {
    blockers.push('核心实体清单未配置（规则集与章节计划都为空），门禁永远无法判定通过。');
  }

  const hook = ruleset.chapterHook;
  if (!hook || hook.markers.length === 0 || hook.tailChars <= 0) {
    blockers.push('章末悬念钩子规则未配置，门禁永远无法判定通过。');
  }

  const goals = ruleset.causality?.goalKeywords ?? plan.goalKeywords ?? [];
  const obstacles = ruleset.causality?.obstacleKeywords ?? plan.obstacleKeywords ?? [];
  if (goals.length === 0 && obstacles.length === 0) {
    blockers.push('因果律关键词未配置（规则集与章节计划都为空），门禁永远无法判定通过。');
  }

  if (tone && tone.maxHits === 0 && tone.bannedPhrases.length > 0) {
    const banned = new Set(tone.bannedPhrases);
    const conflicts = [...new Set([...requiredEntities, ...goals, ...obstacles])].filter((item) =>
      banned.has(item),
    );
    if (conflicts.length > 0) {
      blockers.push(`门禁互相矛盾：${conflicts.join('、')} 同时是必现内容与零命中违禁短语。`);
    }
  }

  return { feasible: blockers.length === 0, blockers, warnings };
}
