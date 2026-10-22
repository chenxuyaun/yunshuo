import { describe, expect, it } from 'vitest';
import {
  buildLexicalQuery,
  buildLexicalText,
  isSingleCharQuery,
  toTsQuery,
} from './lexical.js';

describe('lexical tokens', () => {
  it('builds CJK bigrams and keeps single CJK runs', () => {
    expect(buildLexicalText('封印追兵')).toBe('封印 印追 追兵');
    expect(buildLexicalText('封')).toBe('封');
  });

  it('keeps latin words and numbers of length two or more', () => {
    expect(buildLexicalText('Cloud 2026 a test')).toBe('cloud 2026 test');
  });

  it('dedupes and caps query tokens', () => {
    const query = buildLexicalQuery('封印封印追兵');
    expect(query).toEqual(['封印', '印封', '封印', '印追', '追兵'].filter((token, index, all) => all.indexOf(token) === index));
    expect(buildLexicalQuery('封'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('detects single character queries', () => {
    expect(isSingleCharQuery('封')).toBe(true);
    expect(isSingleCharQuery(' 封 ')).toBe(true);
    expect(isSingleCharQuery('封印')).toBe(false);
  });

  it('produces a safe OR tsquery', () => {
    expect(toTsQuery(['封印', 'cloud'])).toBe('封印 | cloud');
    expect(toTsQuery(['封 | 印', '!!'])).toBe('封印');
    expect(toTsQuery(['!!!'])).toBeNull();
  });
});
