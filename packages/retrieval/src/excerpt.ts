import { tokenizeLexical } from './lexical.js';

const DEFAULT_EXCERPT_CHARS = 160;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildExcerpt(
  content: string,
  query: string,
  maxChars = DEFAULT_EXCERPT_CHARS,
): string {
  const text = collapse(content);
  if (text.length <= maxChars) return text;

  const candidates = [query.trim(), ...tokenizeLexical(query)].filter(
    (candidate) => candidate.length > 0,
  );
  const lower = text.toLowerCase();
  let match = -1;
  for (const candidate of candidates) {
    const index = lower.indexOf(candidate.toLowerCase());
    if (index >= 0 && (match === -1 || index < match)) match = index;
  }
  if (match === -1) return `${text.slice(0, maxChars)}…`;

  const context = Math.max(0, Math.floor((maxChars - query.trim().length) / 3));
  const start = Math.max(0, match - context);
  const end = Math.min(text.length, start + maxChars);
  const sliced = text.slice(start, end);
  return `${start > 0 ? '…' : ''}${sliced}${end < text.length ? '…' : ''}`;
}
