import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/** 中文字数口径：去掉空白后按字符计数，标点计入。 */
export function countWords(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length;
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('');
}
