const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TOKEN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9]+/g;
const QUERY_TOKEN_LIMIT = 64;

function cjkBigrams(run: string, out: string[]): void {
  if (run.length === 1) {
    out.push(run);
    return;
  }
  for (let index = 0; index + 1 < run.length; index += 1) {
    out.push(run.slice(index, index + 2));
  }
}

export function tokenizeLexical(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const run of lower.match(TOKEN_PATTERN) ?? []) {
    if (CJK.test(run)) {
      cjkBigrams(run, tokens);
      continue;
    }
    if (run.length >= 2) tokens.push(run);
  }
  return tokens;
}

export function buildLexicalText(content: string): string {
  return tokenizeLexical(content).join(' ');
}

export function buildLexicalQuery(query: string): string[] {
  const tokens = tokenizeLexical(query).filter((token) => token.trim().length > 0);
  return [...new Set(tokens)].slice(0, QUERY_TOKEN_LIMIT);
}

export function isSingleCharQuery(query: string): boolean {
  return [...query.trim()].length === 1;
}

export function toTsQuery(tokens: string[]): string | null {
  const safe = tokens
    .map((token) => token.replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ''))
    .filter((token) => token.length > 0);
  if (safe.length === 0) return null;
  return safe.join(' | ');
}
