import { describe, expect, it } from 'vitest';
import { countChars, shortHash } from './format.js';

describe('格式化的纯函数', () => {
  it('countChars 去掉所有空白后按码点计数', () => {
    expect(countChars('林 默\n苏\t晚')).toBe(4);
    expect(countChars('😀😀')).toBe(2);
    expect(countChars('')).toBe(0);
  });

  it('shortHash 空值显示破折号，有值取前 10 位', () => {
    expect(shortHash(null)).toBe('—');
    expect(shortHash(undefined)).toBe('—');
    expect(shortHash('')).toBe('—');
    expect(shortHash('0123456789abcdef')).toBe('0123456789');
  });
});
