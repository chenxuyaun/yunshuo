import { describe, expect, it } from 'vitest';
import { countWords, isBlank, sha256, truncate } from './text.js';

describe('text helpers', () => {
  it('counts CJK characters after removing whitespace, punctuation included', () => {
    expect(countWords('林默 按住\n门框。')).toBe(7);
    expect(countWords('   ')).toBe(0);
  });

  it('hashes deterministically with sha256 hex', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('abc')).toHaveLength(64);
  });

  it('truncates by code point without splitting surrogate pairs', () => {
    expect(truncate('雨夜封印', 2)).toBe('雨夜');
    expect(truncate('雨夜封印', 9)).toBe('雨夜封印');
    expect(truncate('𠮷野家', 1)).toBe('𠮷');
  });

  it('detects blank text', () => {
    expect(isBlank(' \n\t ')).toBe(true);
    expect(isBlank('雨')).toBe(false);
  });
});
