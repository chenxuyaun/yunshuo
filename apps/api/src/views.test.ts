import type { GateEvaluationResult } from '@yunshuo/domain';
import { describe, expect, it } from 'vitest';
import {
  gateStatusOf,
  mapEvaluation,
  mapVersionSummary,
  previewOf,
  type EvaluationRow,
  type VersionRow,
} from './views.js';

const versionRow: VersionRow = {
  id: 'version-1',
  chapter_id: 'chapter-1',
  version_no: 1,
  source: 'human',
  word_count: 366,
  content_hash: 'a'.repeat(64),
  content: '旧城的雨没有停。\n\n林默按住门框。',
  parent_version_id: null,
  actor_name: '林编辑',
  evaluation_id: null,
  evaluation_status: null,
  waiver_id: null,
  created_at: '2026-10-20T08:00:00.000Z',
};

describe('gateStatusOf', () => {
  it('keeps imported versions unevaluated', () => {
    expect(gateStatusOf(versionRow)).toBe('not_evaluated');
  });

  it('reports passed evaluation and waiver precedence', () => {
    expect(
      gateStatusOf({ ...versionRow, evaluation_id: 'eval-1', evaluation_status: 'passed' }),
    ).toBe('passed');
    expect(
      gateStatusOf({
        ...versionRow,
        evaluation_id: 'eval-1',
        evaluation_status: 'passed',
        waiver_id: 'waiver-1',
      }),
    ).toBe('waived');
  });
});

describe('mapVersionSummary', () => {
  it('flattens the preview and keeps evidence ids', () => {
    const summary = mapVersionSummary({
      ...versionRow,
      evaluation_id: 'eval-1',
      evaluation_status: 'passed',
    });

    expect(summary.contentPreview).toBe('旧城的雨没有停。 林默按住门框。');
    expect(summary.gateStatus).toBe('passed');
    expect(summary.evaluationId).toBe('eval-1');
    expect(summary.createdAt).toBe('2026-10-20T08:00:00.000Z');
  });
});

describe('mapEvaluation', () => {
  it('returns the results array, never the wrapper object', () => {
    const evaluation: GateEvaluationResult = {
      status: 'passed',
      results: [
        {
          key: 'word_count',
          label: '字数',
          status: 'passed',
          message: '字数 366，达到下限 300。',
          evidence: { wordCount: 366, min: 300 },
        },
      ],
    };
    const row: EvaluationRow = {
      id: 'eval-1',
      chapter_id: 'chapter-1',
      content_hash: 'a'.repeat(64),
      context_hash: 'b'.repeat(64),
      status: 'passed',
      results: evaluation.results,
      created_at: '2026-10-20T08:00:00.000Z',
      ruleset_id: 'ruleset-1',
      ruleset_key: 'dev-v0',
      ruleset_version: 1,
      ruleset_description: '开发规则集 dev-v0（演示用，非生产）',
      ruleset_is_production: false,
    };

    const view = mapEvaluation(row);

    expect(Array.isArray(view.results)).toBe(true);
    expect(view.results).toHaveLength(1);
    expect(view.results[0]?.key).toBe('word_count');
    expect(view.ruleset.isProduction).toBe(false);
  });
});

describe('previewOf', () => {
  it('truncates long content without newlines', () => {
    const preview = previewOf('雨'.repeat(100));

    expect(preview).toHaveLength(81);
    expect(preview.endsWith('…')).toBe(true);
  });
});
