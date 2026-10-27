import { describe, expect, it } from 'vitest';
import {
  diffChapterPlan,
  emptyChapterPlanDocument,
  normalizeChapterPlanDocument,
  planDocumentsEqual,
  reorderIds,
  toGatePlan,
} from './plan.js';

describe('normalizeChapterPlanDocument', () => {
  it('trims, drops blanks and duplicates, and fills missing fields', () => {
    expect(
      normalizeChapterPlanDocument({
        summary: '  林默夜探封印塔  ',
        beats: [' 推开塔门 ', '', '推开塔门', '听见钟声'],
        requiredEntities: ['  林默', '封印塔', '林默'],
      }),
    ).toEqual({
      summary: '林默夜探封印塔',
      beats: ['推开塔门', '听见钟声'],
      requiredEntities: ['林默', '封印塔'],
      goalKeywords: [],
      obstacleKeywords: [],
    });
  });

  it('keeps only the five known keys and survives non-object input', () => {
    const withExtra = { summary: '雨夜', extra: '应当丢弃' } as unknown;
    expect(Object.keys(normalizeChapterPlanDocument(withExtra)).sort()).toEqual([
      'beats',
      'goalKeywords',
      'obstacleKeywords',
      'requiredEntities',
      'summary',
    ]);
    expect(normalizeChapterPlanDocument(null)).toEqual(emptyChapterPlanDocument());
    expect(normalizeChapterPlanDocument('不是对象')).toEqual(emptyChapterPlanDocument());
  });

  it('ignores non-string entries instead of coercing them', () => {
    expect(normalizeChapterPlanDocument({ beats: ['钟声', 3, null] }).beats).toEqual(['钟声']);
  });
});

describe('planDocumentsEqual', () => {
  it('treats empty and defaulted documents as equal', () => {
    expect(planDocumentsEqual({}, emptyChapterPlanDocument())).toBe(true);
    expect(planDocumentsEqual({ requiredEntities: [] }, {})).toBe(true);
  });

  it('ignores whitespace-only differences', () => {
    expect(planDocumentsEqual({ summary: ' 雨夜 ' }, { summary: '雨夜' })).toBe(true);
    expect(planDocumentsEqual({ beats: ['钟声', '钟声'] }, { beats: ['钟声'] })).toBe(true);
  });

  it('detects real differences', () => {
    expect(planDocumentsEqual({ goalKeywords: ['开门'] }, { goalKeywords: ['关门'] })).toBe(false);
    expect(planDocumentsEqual({ summary: '雨夜' }, { summary: '雨夜', beats: ['钟声'] })).toBe(false);
  });
});

describe('toGatePlan', () => {
  it('keeps the three gate lists and drops prose', () => {
    const gate = toGatePlan({
      summary: '林默夜探封印塔',
      beats: ['推开塔门', '听见钟声'],
      requiredEntities: ['林默'],
      goalKeywords: ['推开塔门'],
      obstacleKeywords: ['封印'],
    });
    expect(gate).toEqual({
      requiredEntities: ['林默'],
      goalKeywords: ['推开塔门'],
      obstacleKeywords: ['封印'],
    });
    expect('summary' in gate).toBe(false);
    expect('beats' in gate).toBe(false);
  });

  it('omits empty lists so an untouched chapter stays {}', () => {
    expect(toGatePlan(emptyChapterPlanDocument())).toEqual({});
    expect(toGatePlan({ summary: '只有摘要', beats: ['一拍'] })).toEqual({});
  });
});

describe('diffChapterPlan', () => {
  it('reports additions, removals and modifications per field', () => {
    const diff = diffChapterPlan(
      { goalKeywords: ['开门', '守夜'], obstacleKeywords: ['封印'] },
      { goalKeywords: ['开门', '破阵'], requiredEntities: ['林默'] },
    );
    expect(diff.goalKeywords).toEqual({ added: ['破阵'], removed: ['守夜'] });
    expect(diff.obstacleKeywords).toEqual({ added: [], removed: ['封印'] });
    expect(diff.requiredEntities).toEqual({ added: ['林默'], removed: [] });
    expect(diff.changed).toBe(true);
  });

  it('reports summary and beat changes separately', () => {
    const diff = diffChapterPlan(
      { summary: '旧', beats: ['一', '二'] },
      { summary: '新', beats: ['二', '一'] },
    );
    expect(diff.summaryChanged).toBe(true);
    expect(diff.beatsChanged).toBe(true);
    expect(diff.beats).toEqual({ added: [], removed: [] });
    expect(diff.changed).toBe(true);
  });

  it('reports no change for equivalent documents', () => {
    const diff = diffChapterPlan(
      { summary: ' 雨夜 ', beats: ['钟声'] },
      normalizeChapterPlanDocument({ summary: '雨夜', beats: [' 钟声 '] }),
    );
    expect(diff.changed).toBe(false);
    expect(diff.summaryChanged).toBe(false);
    expect(diff.beatsChanged).toBe(false);
  });
});

describe('reorderIds', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves an id to the front, middle and end', () => {
    expect(reorderIds(ids, 'd', null)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderIds(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIds(ids, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('keeps the order when the id is already in place', () => {
    expect(reorderIds(ids, 'b', 'a')).toEqual(ids);
    expect(reorderIds(ids, 'a', null)).toEqual(ids);
  });

  it('returns null for unknown, duplicated or self-referencing input', () => {
    expect(reorderIds(ids, 'z', null)).toBeNull();
    expect(reorderIds(ids, 'a', 'z')).toBeNull();
    expect(reorderIds(ids, 'b', 'b')).toBeNull();
    expect(reorderIds(['a', 'a'], 'a', null)).toBeNull();
    expect(reorderIds([], 'a', null)).toBeNull();
  });
});
