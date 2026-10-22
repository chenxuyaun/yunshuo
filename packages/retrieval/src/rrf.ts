export interface ChannelHit {
  chunkId: string;
  chapterId: string;
  versionId: string;
  paragraphStart: number;
  paragraphEnd: number;
  score: number;
}

export interface FusedHit {
  chunkId: string;
  chapterId: string;
  versionId: string;
  paragraphStart: number;
  paragraphEnd: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

export interface FusionOptions {
  k?: number;
  limit?: number;
}

interface Accumulator {
  chunkId: string;
  chapterId: string;
  versionId: string;
  paragraphStart: number;
  paragraphEnd: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number;
  order: number;
}

const DEFAULT_K = 60;
const DEFAULT_LIMIT = 8;

function addChannel(
  channel: 'lexical' | 'vector',
  hits: ChannelHit[],
  k: number,
  merged: Map<string, Accumulator>,
  order: { next: number },
): void {
  hits.forEach((hit, index) => {
    const rank = index + 1;
    let entry = merged.get(hit.chunkId);
    if (!entry) {
      entry = {
        chunkId: hit.chunkId,
        chapterId: hit.chapterId,
        versionId: hit.versionId,
        paragraphStart: hit.paragraphStart,
        paragraphEnd: hit.paragraphEnd,
        lexicalRank: null,
        vectorRank: null,
        lexicalScore: null,
        vectorScore: null,
        rrfScore: 0,
        order: order.next++,
      };
      merged.set(hit.chunkId, entry);
    }
    entry.rrfScore += 1 / (k + rank);
    if (channel === 'lexical') {
      entry.lexicalRank = rank;
      entry.lexicalScore = hit.score;
    } else {
      entry.vectorRank = rank;
      entry.vectorScore = hit.score;
    }
  });
}

function overlaps(a: Accumulator, b: Accumulator): boolean {
  return (
    a.chapterId === b.chapterId &&
    a.paragraphStart <= b.paragraphEnd &&
    b.paragraphStart <= a.paragraphEnd
  );
}

export function fuseHybrid(
  lexical: ChannelHit[],
  vector: ChannelHit[],
  options: FusionOptions = {},
): FusedHit[] {
  const k = options.k ?? DEFAULT_K;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const merged = new Map<string, Accumulator>();
  const order = { next: 0 };
  addChannel('lexical', lexical, k, merged, order);
  addChannel('vector', vector, k, merged, order);

  const sorted = [...merged.values()].sort(
    (a, b) => b.rrfScore - a.rrfScore || a.order - b.order,
  );
  const accepted: Accumulator[] = [];
  for (const candidate of sorted) {
    if (accepted.some((existing) => overlaps(existing, candidate))) continue;
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }

  return accepted.map((entry) => ({
    chunkId: entry.chunkId,
    chapterId: entry.chapterId,
    versionId: entry.versionId,
    paragraphStart: entry.paragraphStart,
    paragraphEnd: entry.paragraphEnd,
    lexicalRank: entry.lexicalRank,
    vectorRank: entry.vectorRank,
    lexicalScore: entry.lexicalScore,
    vectorScore: entry.vectorScore,
    rrfScore: Math.round(entry.rrfScore * 1_000_000) / 1_000_000,
  }));
}
