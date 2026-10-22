import type { ChapterStatus } from './types.js';

const TRANSITIONS: Record<ChapterStatus, readonly ChapterStatus[]> = {
  planned: ['writing', 'archived'],
  writing: ['staged', 'planned', 'archived'],
  staged: ['canon', 'writing', 'commit_failed', 'archived'],
  commit_failed: ['canon', 'staged', 'writing', 'archived'],
  canon: ['revision', 'archived'],
  revision: ['writing', 'archived'],
  archived: [],
};

export class InvalidTransitionError extends Error {
  readonly from: ChapterStatus;
  readonly to: ChapterStatus;

  constructor(from: ChapterStatus, to: ChapterStatus) {
    super(`章节状态不能从 ${from} 变为 ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: ChapterStatus, to: ChapterStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ChapterStatus, to: ChapterStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isEditable(status: ChapterStatus): boolean {
  return status === 'planned' || status === 'writing' || status === 'revision';
}
