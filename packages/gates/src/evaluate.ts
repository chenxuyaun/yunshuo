import {
  GATE_LABELS,
  type ChapterPlan,
  type GateEvaluationResult,
  type GateResult,
  type GateRulesetConfig,
  type GateStatus,
} from '@yunshuo/domain';

export interface GateEvaluationInput {
  content: string;
  wordCount: number;
  plan: ChapterPlan;
  ruleset: GateRulesetConfig;
}

function result(
  key: GateResult['key'],
  status: GateStatus,
  message: string,
  evidence: Record<string, unknown> = {},
): GateResult {
  return {
    key,
    label: GATE_LABELS[key],
    status,
    message,
    evidence,
  };
}

function safeGate(
  key: GateResult['key'],
  evaluate: () => GateResult,
): GateResult {
  try {
    return evaluate();
  } catch (error) {
    return result(key, 'error', error instanceof Error ? error.message : String(error));
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function tailChars(text: string, count: number): string {
  return Array.from(text).slice(-count).join('');
}

export function evaluateGates(input: GateEvaluationInput): GateEvaluationResult {
  const { content, wordCount, plan, ruleset } = input;

  const results: GateResult[] = [
    safeGate('word_count', () => {
      const config = ruleset.wordCount;
      if (!config || config.min <= 0) {
        return result('word_count', 'not_configured', '字数门槛未配置，不能判定通过。');
      }
      const passed = wordCount >= config.min;
      return result(
        'word_count',
        passed ? 'passed' : 'failed',
        passed
          ? `字数 ${wordCount}，达到下限 ${config.min}${config.label ? `（${config.label}）` : ''}。`
          : `字数 ${wordCount}，未达到下限 ${config.min}${config.label ? `（${config.label}）` : ''}。`,
        { wordCount, min: config.min, label: config.label ?? null },
      );
    }),

    safeGate('ai_tone', () => {
      const config = ruleset.aiTone;
      if (!config || (config.bannedPhrases.length === 0 && config.maxHits <= 0)) {
        return result('ai_tone', 'not_configured', 'AI 腔调规则未配置，不能判定通过。');
      }
      const hits = config.bannedPhrases
        .map((phrase) => ({ phrase, count: countOccurrences(content, phrase) }))
        .filter((hit) => hit.count > 0);
      const total = hits.reduce((sum, hit) => sum + hit.count, 0);
      const passed = total <= (config.maxHits ?? 0);
      return result(
        'ai_tone',
        passed ? 'passed' : 'failed',
        passed
          ? `违禁短语命中 ${total} 次，未超过上限 ${config.maxHits ?? 0}。`
          : `违禁短语命中 ${total} 次，超过上限 ${config.maxHits ?? 0}：${hits
              .map((hit) => `${hit.phrase}×${hit.count}`)
              .join('、')}。`,
        { hits, maxHits: config.maxHits ?? 0 },
      );
    }),

    safeGate('core_entity', () => {
      const required = ruleset.coreEntity?.requiredEntities ?? plan.requiredEntities ?? [];
      if (required.length === 0) {
        return result('core_entity', 'not_configured', '核心实体清单未配置，不能判定通过。');
      }
      const present = required.filter((entity) => content.includes(entity));
      const missing = required.filter((entity) => !content.includes(entity));
      const passed = missing.length === 0;
      return result(
        'core_entity',
        passed ? 'passed' : 'failed',
        passed
          ? `核心实体全部出现：${required.join('、')}。`
          : `缺少核心实体：${missing.join('、')}。`,
        { required, present, missing },
      );
    }),

    safeGate('chapter_hook', () => {
      const config = ruleset.chapterHook;
      if (!config || config.markers.length === 0 || config.tailChars <= 0) {
        return result('chapter_hook', 'not_configured', '章末钩子规则未配置，不能判定通过。');
      }
      const tail = tailChars(content, config.tailChars);
      const found = config.markers.filter((marker) => tail.includes(marker));
      const passed = found.length > 0;
      return result(
        'chapter_hook',
        passed ? 'passed' : 'failed',
        passed
          ? `章末 ${config.tailChars} 字命中钩子标记：${found.join('、')}。`
          : `章末 ${config.tailChars} 字未命中钩子标记（${config.markers.join('、')}）。`,
        { tailChars: config.tailChars, found, markers: config.markers, tailPreview: tail },
      );
    }),

    safeGate('causality', () => {
      const goals = ruleset.causality?.goalKeywords ?? plan.goalKeywords ?? [];
      const obstacles =
        ruleset.causality?.obstacleKeywords ?? plan.obstacleKeywords ?? [];
      if (goals.length === 0 && obstacles.length === 0) {
        return result('causality', 'not_configured', '因果律关键词未配置，不能判定通过。');
      }
      const missingGoals = goals.filter((keyword) => !content.includes(keyword));
      const missingObstacles = obstacles.filter((keyword) => !content.includes(keyword));
      const passed = missingGoals.length === 0 && missingObstacles.length === 0;
      return result(
        'causality',
        passed ? 'passed' : 'failed',
        passed
          ? '目标关键词与阻力关键词均出现。'
          : `缺少因果关键词：${[...missingGoals, ...missingObstacles].join('、')}。`,
        { goals, obstacles, missingGoals, missingObstacles },
      );
    }),
  ];

  const hasFailed = results.some((item) => item.status === 'failed');
  const hasBlocked = results.some(
    (item) => item.status === 'not_configured' || item.status === 'error',
  );

  return {
    status: hasFailed ? 'failed' : hasBlocked ? 'blocked' : 'passed',
    results,
  };
}
