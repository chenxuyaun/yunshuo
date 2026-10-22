import type {
  LedgerCharacterLifeState,
  LedgerCharacterPayload,
  LedgerEntryKind,
  LedgerEntryScope,
  LedgerEntrySnapshot,
  LedgerEntryStatus,
  LedgerEntryPayload,
  LedgerForeshadowingImportance,
  LedgerForeshadowingPayload,
  LedgerForeshadowingState,
  LedgerSettingCategory,
  LedgerSettingPayload,
  LedgerVerificationState,
} from '@yunshuo/contracts';

export const LEDGER_KIND_LABELS: Record<LedgerEntryKind, string> = {
  setting: '设定',
  character: '角色',
  foreshadowing: '伏笔',
};

export const LEDGER_STATUS_LABELS: Record<LedgerEntryStatus, string> = {
  draft: '草稿',
  active: '已生效',
  archived: '已归档',
};

export const LEDGER_SCOPE_LABELS: Record<LedgerEntryScope, string> = {
  workspace: '工作区通用',
  work: '作品专属',
};

export const SETTING_CATEGORY_LABELS: Record<LedgerSettingCategory, string> = {
  world: '世界观',
  location: '地点',
  faction: '势力',
  rule: '规则',
  item: '物品',
  other: '其他',
};

export const VERIFICATION_LABELS: Record<LedgerVerificationState, string> = {
  verified: '已核实',
  unverified: '未核实',
  to_design: '待设计',
  deprecated: '已废弃',
};

export const CHARACTER_LIFE_LABELS: Record<LedgerCharacterLifeState, string> = {
  alive: '存活',
  dead: '死亡',
  unknown: '未知',
};

export const FORESHADOWING_STATE_LABELS: Record<LedgerForeshadowingState, string> = {
  planted: '已埋设',
  reinforced: '已强化',
  paid_off: '已回收',
  abandoned: '已放弃',
};

export const FORESHADOWING_IMPORTANCE_LABELS: Record<
  LedgerForeshadowingImportance,
  string
> = {
  low: '低',
  medium: '中',
  high: '高',
};

export const FORESHADOWING_TRANSITIONS: Record<
  LedgerForeshadowingState,
  readonly LedgerForeshadowingState[]
> = {
  planted: ['planted', 'reinforced', 'paid_off', 'abandoned'],
  reinforced: ['reinforced', 'paid_off', 'abandoned'],
  paid_off: ['paid_off'],
  abandoned: ['abandoned'],
};

export function isSettingPayload(payload: LedgerEntryPayload): payload is LedgerSettingPayload {
  return 'category' in payload;
}

export function isCharacterPayload(
  payload: LedgerEntryPayload,
): payload is LedgerCharacterPayload {
  return 'states' in payload && 'speechStyle' in payload;
}

export function isForeshadowingPayload(
  payload: LedgerEntryPayload,
): payload is LedgerForeshadowingPayload {
  return 'seedChapterId' in payload;
}

export function payoffWindowLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `第 ${min}–${max} 章`;
  if (min !== null) return `第 ${min} 章起`;
  if (max !== null) return `第 ${max} 章前`;
  return '未设置计划窗口';
}

export interface LedgerFieldDiff {
  label: string;
  before: string;
  after: string;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function diffLedgerSnapshots(
  before: LedgerEntrySnapshot | null,
  after: LedgerEntrySnapshot,
  chapterLabel: (chapterId: string | null) => string,
): LedgerFieldDiff[] {
  const rows: LedgerFieldDiff[] = [];

  function push(label: string, previous: unknown, next: unknown): void {
    const beforeText = display(previous);
    const afterText = display(next);
    if (beforeText !== afterText) rows.push({ label, before: beforeText, after: afterText });
  }

  push('名称', before?.name, after.name);
  push('别名', before?.aliases, after.aliases);
  push('摘要', before?.summary, after.summary);
  push(
    '来源章节',
    before?.sourceChapterId ? chapterLabel(before.sourceChapterId) : '',
    after.sourceChapterId ? chapterLabel(after.sourceChapterId) : '',
  );

  const previousPayload = before?.payload ?? null;
  const nextPayload = after.payload;
  if (isSettingPayload(nextPayload)) {
    push(
      '分类',
      previousPayload && isSettingPayload(previousPayload)
        ? SETTING_CATEGORY_LABELS[previousPayload.category]
        : '',
      SETTING_CATEGORY_LABELS[nextPayload.category],
    );
    push(
      '核实状态',
      previousPayload && isSettingPayload(previousPayload)
        ? VERIFICATION_LABELS[previousPayload.verification]
        : '',
      VERIFICATION_LABELS[nextPayload.verification],
    );
    push(
      '详细说明',
      previousPayload && isSettingPayload(previousPayload) ? previousPayload.details : '',
      nextPayload.details,
    );
    push(
      '标签',
      previousPayload && isSettingPayload(previousPayload) ? previousPayload.tags : [],
      nextPayload.tags,
    );
    return rows;
  }

  if (isCharacterPayload(nextPayload)) {
    const previousCharacter =
      previousPayload && isCharacterPayload(previousPayload) ? previousPayload : null;
    push('身份', previousCharacter?.role, nextPayload.role);
    push('外貌', previousCharacter?.appearance, nextPayload.appearance);
    push('性格', previousCharacter?.personality, nextPayload.personality);
    push('目标', previousCharacter?.goals, nextPayload.goals);
    push('阵营', previousCharacter?.faction, nextPayload.faction);
    push('能力', previousCharacter?.abilities, nextPayload.abilities);
    push('语言风格', previousCharacter?.speechStyle, nextPayload.speechStyle);
    push(
      '关系',
      previousCharacter?.relationships.map(relationshipText) ?? [],
      nextPayload.relationships.map(relationshipText),
    );
    const beforeStates = new Map(
      (previousCharacter?.states ?? []).map((state) => [
        state.asOfChapterId,
        stateText(state, chapterLabel),
      ]),
    );
    const afterStates = new Map(
      nextPayload.states.map((state) => [state.asOfChapterId, stateText(state, chapterLabel)]),
    );
    const chapterIds = new Set([...beforeStates.keys(), ...afterStates.keys()]);
    for (const chapterId of chapterIds) {
      push(
        `状态 · ${chapterLabel(chapterId)}`,
        beforeStates.get(chapterId) ?? '',
        afterStates.get(chapterId) ?? '',
      );
    }
    return rows;
  }

  if (isForeshadowingPayload(nextPayload)) {
    const previousForeshadowing =
      previousPayload && isForeshadowingPayload(previousPayload) ? previousPayload : null;
    push(
      '状态',
      previousForeshadowing
        ? FORESHADOWING_STATE_LABELS[previousForeshadowing.state]
        : '',
      FORESHADOWING_STATE_LABELS[nextPayload.state],
    );
    push(
      '重要度',
      previousForeshadowing
        ? FORESHADOWING_IMPORTANCE_LABELS[previousForeshadowing.importance]
        : '',
      FORESHADOWING_IMPORTANCE_LABELS[nextPayload.importance],
    );
    push(
      '埋设章节',
      previousForeshadowing ? chapterLabel(previousForeshadowing.seedChapterId) : '',
      chapterLabel(nextPayload.seedChapterId),
    );
    push(
      '计划回收窗口',
      previousForeshadowing
        ? payoffWindowLabel(
            previousForeshadowing.payoffChapterMin,
            previousForeshadowing.payoffChapterMax,
          )
        : '',
      payoffWindowLabel(nextPayload.payoffChapterMin, nextPayload.payoffChapterMax),
    );
    push(
      '回收章节',
      previousForeshadowing?.payoffChapterId
        ? chapterLabel(previousForeshadowing.payoffChapterId)
        : '',
      nextPayload.payoffChapterId ? chapterLabel(nextPayload.payoffChapterId) : '',
    );
    push(
      '回收或放弃说明',
      previousForeshadowing?.resolutionNote,
      nextPayload.resolutionNote,
    );
    push('伏笔说明', previousForeshadowing?.note, nextPayload.note);
    return rows;
  }

  push('内容', previousPayload ? JSON.stringify(previousPayload, null, 2) : '', JSON.stringify(nextPayload, null, 2));
  return rows;
}

function relationshipText(relationship: {
  name: string;
  relation: string;
  notes: string;
}): string {
  return `${relationship.name}（${relationship.relation}）${relationship.notes ? `：${relationship.notes}` : ''}`;
}

function stateText(
  state: {
    life: LedgerCharacterLifeState;
    location: string;
    knowledge: string;
    possessions: string;
    relationshipChanges: string;
  },
  chapterLabel: (chapterId: string | null) => string,
): string {
  return [
    CHARACTER_LIFE_LABELS[state.life],
    state.location ? `地点：${state.location}` : '',
    state.knowledge ? `已知：${state.knowledge}` : '',
    state.possessions ? `持有：${state.possessions}` : '',
    state.relationshipChanges ? `关系变化：${state.relationshipChanges}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function parseListInput(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value.split(/[,，\n]/)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
