import type { ChapterPlan, ChapterPlanDocument } from './types.js';

export function emptyChapterPlanDocument(): ChapterPlanDocument {
  return {
    summary: '',
    beats: [],
    requiredEntities: [],
    goalKeywords: [],
    obstacleKeywords: [],
  };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function normalizeChapterPlanDocument(input: unknown): ChapterPlanDocument {
  const source = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    summary: normalizeText(source.summary),
    beats: normalizeList(source.beats),
    requiredEntities: normalizeList(source.requiredEntities),
    goalKeywords: normalizeList(source.goalKeywords),
    obstacleKeywords: normalizeList(source.obstacleKeywords),
  };
}

// 空清单不落键：存量章节的 chapters.plan 是 '{}'，写空数组会让 context_hash 无谓地变一次。
export function toGatePlan(doc: unknown): ChapterPlan {
  const normalized = normalizeChapterPlanDocument(doc);
  const gate: ChapterPlan = {};
  if (normalized.requiredEntities.length > 0) gate.requiredEntities = normalized.requiredEntities;
  if (normalized.goalKeywords.length > 0) gate.goalKeywords = normalized.goalKeywords;
  if (normalized.obstacleKeywords.length > 0) gate.obstacleKeywords = normalized.obstacleKeywords;
  return gate;
}

// 本模块要能被浏览器直接引用（见 package.json 的 ./plan 子路径），所以不能依赖 node:crypto。
export function planDocumentsEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normalizeChapterPlanDocument(a)) ===
    JSON.stringify(normalizeChapterPlanDocument(b))
  );
}

export interface ChapterPlanFieldDiff {
  added: string[];
  removed: string[];
}

export interface ChapterPlanDiff {
  summaryChanged: boolean;
  beats: ChapterPlanFieldDiff;
  beatsChanged: boolean;
  requiredEntities: ChapterPlanFieldDiff;
  goalKeywords: ChapterPlanFieldDiff;
  obstacleKeywords: ChapterPlanFieldDiff;
  changed: boolean;
}

function diffList(prev: string[], next: string[]): ChapterPlanFieldDiff {
  const before = new Set(prev);
  const after = new Set(next);
  return {
    added: next.filter((item) => !before.has(item)),
    removed: prev.filter((item) => !after.has(item)),
  };
}

function listChanged(prev: string[], next: string[], ordered: boolean): boolean {
  const { added, removed } = diffList(prev, next);
  if (added.length > 0 || removed.length > 0) return true;
  if (!ordered) return false;
  return prev.some((item, index) => item !== next[index]);
}

export function diffChapterPlan(prev: unknown, next: unknown): ChapterPlanDiff {
  const before = normalizeChapterPlanDocument(prev);
  const after = normalizeChapterPlanDocument(next);
  const summaryChanged = before.summary !== after.summary;
  const beats = diffList(before.beats, after.beats);
  const beatsChanged = listChanged(before.beats, after.beats, true);
  const requiredEntities = diffList(before.requiredEntities, after.requiredEntities);
  const goalKeywords = diffList(before.goalKeywords, after.goalKeywords);
  const obstacleKeywords = diffList(before.obstacleKeywords, after.obstacleKeywords);
  return {
    summaryChanged,
    beats,
    beatsChanged,
    requiredEntities,
    goalKeywords,
    obstacleKeywords,
    changed:
      summaryChanged ||
      beatsChanged ||
      requiredEntities.added.length > 0 ||
      requiredEntities.removed.length > 0 ||
      goalKeywords.added.length > 0 ||
      goalKeywords.removed.length > 0 ||
      obstacleKeywords.added.length > 0 ||
      obstacleKeywords.removed.length > 0,
  };
}

export function reorderIds(
  ids: readonly string[],
  movedId: string,
  afterId: string | null,
): string[] | null {
  if (ids.length === 0) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (!ids.includes(movedId)) return null;
  if (afterId !== null && (afterId === movedId || !ids.includes(afterId))) return null;
  const rest = ids.filter((id) => id !== movedId);
  if (afterId === null) return [movedId, ...rest];
  const index = rest.indexOf(afterId);
  return [...rest.slice(0, index + 1), movedId, ...rest.slice(index + 1)];
}
