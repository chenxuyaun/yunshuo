import type { ChapterPlanDocument } from '@yunshuo/domain';
import { diffChapterPlan, normalizeChapterPlanDocument } from '@yunshuo/domain/plan';

export function parseLines(text: string): string[] {
  const result: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const item = line.trim();
    if (item !== '') result.push(item);
  }
  return result;
}

export function parseKeywordInput(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(/[,，、;；\n]+/)) {
    const item = raw.trim();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function keywordInput(items: string[]): string {
  return items.join('、');
}

export function beatsInput(items: string[]): string {
  return items.join('\n');
}

export interface PlanFields {
  summary: string;
  beats: string;
  entities: string;
  goals: string;
  obstacles: string;
}

export function planFromFields(fields: PlanFields): ChapterPlanDocument {
  return normalizeChapterPlanDocument({
    summary: fields.summary,
    beats: parseLines(fields.beats),
    requiredEntities: parseKeywordInput(fields.entities),
    goalKeywords: parseKeywordInput(fields.goals),
    obstacleKeywords: parseKeywordInput(fields.obstacles),
  });
}

export function planSummaryHeadline(plan: ChapterPlanDocument): string {
  const first = plan.summary.replace(/\r\n?/g, '\n').split('\n')[0]?.trim() ?? '';
  return first === '' ? '未填写摘要' : first;
}

function diffListLine(
  label: string,
  diff: { added: string[]; removed: string[] },
): string | null {
  if (diff.added.length === 0 && diff.removed.length === 0) return null;
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.join('、')}`);
  if (diff.removed.length > 0) parts.push(`移除 ${diff.removed.join('、')}`);
  return `${label}：${parts.join('；')}`;
}

export function planDiffLines(prev: unknown, next: unknown): string[] {
  const diff = diffChapterPlan(prev, next);
  if (!diff.changed) return ['无字段变化'];
  const lines: string[] = [];
  if (diff.summaryChanged) lines.push('摘要已改');
  if (diff.beatsChanged) {
    if (diff.beats.added.length === 0 && diff.beats.removed.length === 0) {
      lines.push('节拍：顺序调整');
    } else {
      lines.push(diffListLine('节拍', diff.beats)!);
    }
  }
  for (const [label, field] of [
    ['核心人物', diff.requiredEntities],
    ['目标关键词', diff.goalKeywords],
    ['阻碍关键词', diff.obstacleKeywords],
  ] as const) {
    const line = diffListLine(label, field);
    if (line) lines.push(line);
  }
  return lines;
}

// evidenceAt 取门禁证据的产生时间：重跑门禁后证据更新，横幅就该撤下。
export function planChangedAfterEvidence(planUpdatedAt: string | null, evidenceAt: string): boolean {
  if (!planUpdatedAt) return false;
  return new Date(planUpdatedAt).getTime() > new Date(evidenceAt).getTime();
}
