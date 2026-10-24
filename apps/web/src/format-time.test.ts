import { describe, expect, it } from 'vitest';
import { formatClock, formatDateTime } from './format';

describe('formatDateTime', () => {
  it('按 UTC 渲染月日与时分', () => {
    expect(formatDateTime('2026-10-23T18:07:00.000Z')).toBe('10/23 18:07');
  });

  it('月、日、时、分都补零', () => {
    expect(formatDateTime('2026-01-05T00:00:00.000Z')).toBe('01/05 00:00');
  });

  it('年末最后一分钟不跨日', () => {
    expect(formatDateTime('2026-12-31T23:59:00.000Z')).toBe('12/31 23:59');
  });

  it('闰日按日期本身渲染', () => {
    expect(formatDateTime('2024-02-29T05:06:00.000Z')).toBe('02/29 05:06');
  });
});

describe('formatClock', () => {
  it('只渲染时分', () => {
    expect(formatClock('2026-10-23T18:07:00.000Z')).toBe('18:07');
  });

  it('午夜是 00:00，不是 24:00 或 12:00', () => {
    expect(formatClock('2026-01-05T00:00:00.000Z')).toBe('00:00');
  });

  it('不包含日期', () => {
    expect(formatClock('2024-02-29T05:06:00.000Z')).toBe('05:06');
  });
});

describe('时区前提', () => {
  it('测试环境固定在 UTC', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date('2026-10-23T18:07:00.000Z').getTimezoneOffset()).toBe(0);
  });
});
