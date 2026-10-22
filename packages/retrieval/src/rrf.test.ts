import { describe, expect, it } from 'vitest';
import { fuseHybrid, type ChannelHit } from './rrf.js';

function hit(
  chunkId: string,
  score: number,
  overrides: Partial<ChannelHit> = {},
): ChannelHit {
  return {
    chunkId,
    chapterId: 'chapter-1',
    versionId: 'version-1',
    paragraphStart: 1,
    paragraphEnd: 1,
    score,
    ...overrides,
  };
}

describe('fuseHybrid', () => {
  it('ranks chunks appearing in both channels first', () => {
    const fused = fuseHybrid(
      [hit('a', 0.9, { paragraphStart: 1, paragraphEnd: 1 }), hit('b', 0.8, { paragraphStart: 3, paragraphEnd: 3 })],
      [hit('b', 0.7, { paragraphStart: 3, paragraphEnd: 3 }), hit('c', 0.6, { paragraphStart: 5, paragraphEnd: 5 })],
      { k: 60, limit: 3 },
    );
    expect(fused.map((entry) => entry.chunkId)).toEqual(['b', 'a', 'c']);
    expect(fused[0]).toMatchObject({ lexicalRank: 2, vectorRank: 1 });
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 5);
  });

  it('drops overlapping chunks from the same chapter', () => {
    const fused = fuseHybrid(
      [hit('a', 0.9, { paragraphStart: 1, paragraphEnd: 2 }), hit('b', 0.8, { paragraphStart: 2, paragraphEnd: 3 })],
      [],
    );
    expect(fused.map((entry) => entry.chunkId)).toEqual(['a']);
  });

  it('keeps overlapping paragraphs from different chapters', () => {
    const fused = fuseHybrid(
      [
        hit('a', 0.9, { chapterId: 'chapter-1', paragraphStart: 1, paragraphEnd: 2 }),
        hit('b', 0.8, { chapterId: 'chapter-2', paragraphStart: 2, paragraphEnd: 3 }),
      ],
      [],
    );
    expect(fused.map((entry) => entry.chunkId)).toEqual(['a', 'b']);
  });

  it('respects the result limit', () => {
    const fused = fuseHybrid(
      Array.from({ length: 20 }, (_, index) =>
        hit(`chunk-${index}`, 1, { paragraphStart: index * 2 + 1, paragraphEnd: index * 2 + 1 }),
      ),
      [],
      { limit: 5 },
    );
    expect(fused).toHaveLength(5);
  });
});
