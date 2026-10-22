import { describe, expect, it } from 'vitest';
import { chunkCanon, embeddingInput } from './chunk.js';

function longChapter(paragraphs: number, sentencesPerParagraph: number): string {
  const paragraph = Array.from({ length: sentencesPerParagraph }, (_, index) => {
    return `这是第${index + 1}句用于测试切块边界与重叠的正文，封印与追兵在此处交汇。`;
  }).join('');
  return Array.from({ length: paragraphs }, () => paragraph).join('\n\n');
}

describe('chunkCanon', () => {
  it('returns no chunks for empty content', () => {
    expect(chunkCanon('')).toEqual([]);
    expect(chunkCanon('   \n\n  ')).toEqual([]);
  });

  it('keeps a short chapter in one chunk', () => {
    const chunks = chunkCanon('第一段。\n\n第二段。');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      paragraphStart: 1,
      paragraphEnd: 2,
      charStart: 0,
      content: '第一段。\n\n第二段。',
    });
    expect(chunks[0]!.charEnd).toBe(chunks[0]!.content.length);
  });

  it('splits long content within the size limits and keeps offsets exact', () => {
    const content = longChapter(6, 8);
    const chunks = chunkCanon(content);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(800);
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
      expect(chunk.paragraphStart).toBeGreaterThanOrEqual(1);
      expect(chunk.paragraphEnd).toBeGreaterThanOrEqual(chunk.paragraphStart);
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });

  it('overlaps adjacent chunks by at most the configured amount', () => {
    const content = longChapter(4, 8);
    const chunks = chunkCanon(content);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      expect(current.charStart).toBeLessThan(previous.charEnd);
      expect(previous.charEnd - current.charStart).toBeLessThanOrEqual(80);
    }
  });

  it('prefers sentence boundaries near the target size', () => {
    const chunks = chunkCanon('第一句。第二句。第三句。', {
      targetChars: 5,
      maxChars: 8,
      overlapChars: 2,
    });
    expect(chunks.map((chunk) => chunk.content)).toEqual(['第一句。第二句。', '句。第三句。']);
  });

  it('respects custom target and max sizes', () => {
    const content = '甲'.repeat(100);
    const chunks = chunkCanon(content, { targetChars: 30, maxChars: 40, overlapChars: 5 });
    expect(chunks.every((chunk) => chunk.content.length <= 40)).toBe(true);
    expect(chunks.length).toBeGreaterThan(2);
  });
});

describe('embeddingInput', () => {
  it('prefixes chapter number and title without changing stored content', () => {
    expect(embeddingInput({ content: '正文。' }, 3, '夜行')).toBe('第 3 章 夜行\n正文。');
    expect(embeddingInput({ content: '正文。' }, 3, '  ')).toBe('第 3 章\n正文。');
  });
});
