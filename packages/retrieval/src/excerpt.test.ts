import { describe, expect, it } from 'vitest';
import { buildExcerpt } from './excerpt.js';

describe('buildExcerpt', () => {
  it('returns short content unchanged', () => {
    expect(buildExcerpt('封印松动。', '封印')).toBe('封印松动。');
  });

  it('centers long content around the query', () => {
    const content = `${'甲'.repeat(300)}封印${'乙'.repeat(300)}`;
    const excerpt = buildExcerpt(content, '封印', 80);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('封印');
    expect(excerpt.length).toBeLessThanOrEqual(82);
  });

  it('falls back to the prefix when the query is absent', () => {
    const excerpt = buildExcerpt('甲'.repeat(200), '封印', 60);
    expect(excerpt).toBe(`${'甲'.repeat(60)}…`);
  });

  it('collapses whitespace', () => {
    expect(buildExcerpt('封印\n\n  追兵', '封印')).toBe('封印 追兵');
  });
});
