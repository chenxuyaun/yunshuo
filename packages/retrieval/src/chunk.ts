export interface CanonChunk {
  index: number;
  paragraphStart: number;
  paragraphEnd: number;
  charStart: number;
  charEnd: number;
  content: string;
}

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_TARGET = 500;
const DEFAULT_MAX = 800;
const DEFAULT_OVERLAP = 80;

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…']);
const TRAILING = new Set(['”', '’', '」', '』', '）', ')', '】', '》', '"', "'", '…']);

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\u3000';
}

interface Paragraph {
  start: number;
  end: number;
}

function splitParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const pattern = /\n[ \t\u3000]*\n+/g;
  let cursor = 0;

  const add = (from: number, to: number): void => {
    let start = from;
    let end = to;
    while (start < end && isSpace(content[start]!)) start += 1;
    while (end > start && isSpace(content[end - 1]!)) end -= 1;
    if (end > start) paragraphs.push({ start, end });
  };

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    add(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  add(cursor, content.length);
  return paragraphs;
}

function sentenceEnd(content: string, from: number, limit: number): number {
  for (let index = from; index < limit; index += 1) {
    if (!SENTENCE_END.has(content[index]!)) continue;
    let end = index + 1;
    while (end < limit && SENTENCE_END.has(content[end]!)) end += 1;
    while (end < limit && TRAILING.has(content[end]!)) end += 1;
    return end;
  }
  return -1;
}

function avoidSurrogateSplit(content: string, end: number, start: number): number {
  if (end <= start + 1 || end >= content.length) return end;
  const code = content.charCodeAt(end);
  return code >= 0xdc00 && code <= 0xdfff ? end - 1 : end;
}

function paragraphRange(
  paragraphs: Paragraph[],
  start: number,
  end: number,
): { start: number; end: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    if (paragraph.end > start && paragraph.start < end) {
      if (first === null) first = index;
      last = index;
    }
  }
  if (first === null || last === null) return null;
  return { start: first + 1, end: last + 1 };
}

export function chunkCanon(content: string, options: ChunkOptions = {}): CanonChunk[] {
  const target = options.targetChars ?? DEFAULT_TARGET;
  const max = options.maxChars ?? DEFAULT_MAX;
  const overlap = options.overlapChars ?? DEFAULT_OVERLAP;
  if (target < 1 || max < target || overlap < 0 || overlap >= target) {
    throw new Error('切块参数无效：需满足 1 <= targetChars <= maxChars 且 0 <= overlapChars < targetChars');
  }
  if (content.trim().length === 0) return [];

  const paragraphs = splitParagraphs(content);
  if (paragraphs.length === 0) return [];

  const chunks: CanonChunk[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(content.length, start + target);
    if (end < content.length) {
      const limit = Math.min(content.length, start + max);
      const preferred = sentenceEnd(content, end, limit);
      end = preferred > end ? preferred : limit;
    }
    end = avoidSurrogateSplit(content, end, start);
    if (end <= start) break;

    const raw = content.slice(start, end);
    let trimmedStart = 0;
    let trimmedEnd = raw.length;
    while (trimmedStart < trimmedEnd && isSpace(raw[trimmedStart]!)) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && isSpace(raw[trimmedEnd - 1]!)) trimmedEnd -= 1;

    if (trimmedEnd > trimmedStart) {
      const charStart = start + trimmedStart;
      const charEnd = start + trimmedEnd;
      const range = paragraphRange(paragraphs, charStart, charEnd);
      if (range) {
        chunks.push({
          index: chunks.length,
          paragraphStart: range.start,
          paragraphEnd: range.end,
          charStart,
          charEnd,
          content: content.slice(charStart, charEnd),
        });
      }
    }

    if (end >= content.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

export function embeddingInput(
  chunk: Pick<CanonChunk, 'content'>,
  chapterNumber: number,
  chapterTitle: string,
): string {
  const title = chapterTitle.trim();
  return title.length > 0
    ? `第 ${chapterNumber} 章 ${title}\n${chunk.content}`
    : `第 ${chapterNumber} 章\n${chunk.content}`;
}
