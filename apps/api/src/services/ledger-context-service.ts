import { sql } from '@yunshuo/db';
import type { ChapterPlan } from '@yunshuo/domain';
import type {
  AiContextSectionView,
  AiLedgerCitationView,
  AiLedgerContextView,
  GateHintView,
  GateLedgerHintEntryView,
  LedgerCharacterPayload,
  LedgerEntryKind,
  LedgerEntryScope,
  LedgerEntrySnapshot,
  LedgerForeshadowingPayload,
  LedgerSettingPayload,
} from '@yunshuo/contracts';

const KIND_ORDER: LedgerEntryKind[] = ['setting', 'character', 'foreshadowing'];

const KIND_LABELS: Record<LedgerEntryKind, string> = {
  setting: '设定',
  character: '角色',
  foreshadowing: '伏笔',
};

const CATEGORY_LABELS: Record<string, string> = {
  world: '世界',
  location: '地点',
  faction: '势力',
  rule: '规则',
  item: '物品',
  other: '其他',
};

const VERIFICATION_LABELS: Record<string, string> = {
  verified: '已核验',
  unverified: '未核验',
  to_design: '待设计',
  deprecated: '已废弃',
};

const LIFE_LABELS: Record<string, string> = {
  alive: '存活',
  dead: '死亡',
  unknown: '未知',
};

const FORESHADOWING_STATE_LABELS: Record<string, string> = {
  planted: '已埋设',
  reinforced: '已强化',
  paid_off: '已回收',
  abandoned: '已放弃',
};

const IMPORTANCE_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

const AI_ITEM_CHARS: Record<LedgerEntryKind, number> = {
  setting: 700,
  character: 900,
  foreshadowing: 700,
};

const AI_SECTION_CHARS: Record<LedgerEntryKind, number> = {
  setting: 2600,
  character: 4200,
  foreshadowing: 2200,
};

const SECTION_KEYS: Record<LedgerEntryKind, string> = {
  setting: 'ledger_settings',
  character: 'ledger_characters',
  foreshadowing: 'ledger_foreshadowing',
};

const SECTION_LABELS: Record<LedgerEntryKind, string> = {
  setting: '设定集',
  character: '角色档案',
  foreshadowing: '伏笔台账',
};

interface ActiveLedgerRow {
  id: string;
  kind: LedgerEntryKind;
  scope: LedgerEntryScope;
  work_id: string | null;
  name: string;
  aliases: string[];
  current_version_id: string;
  version_no: number;
  snapshot: LedgerEntrySnapshot;
}

interface ChapterRefRow {
  id: string;
  number: number;
  title: string;
}

async function loadActiveLedgerRows(
  workspaceId: string,
  workId: string,
): Promise<ActiveLedgerRow[]> {
  const rows = await sql<ActiveLedgerRow[]>`
    SELECT e.id, e.kind, e.scope, e.work_id, e.name, e.aliases,
           e.current_version_id, v.version_no, v.snapshot
    FROM ledger_entries e
    JOIN ledger_entry_versions v ON v.id = e.current_version_id
    WHERE e.workspace_id = ${workspaceId}
      AND e.status = 'active'
      AND (e.work_id = ${workId} OR (e.kind = 'setting' AND e.work_id IS NULL))
    ORDER BY e.kind ASC, e.name ASC
  `;
  return rows;
}

function aliasSuffix(aliases: string[]): string {
  return aliases.length > 0 ? `（别名：${aliases.join('、')}）` : '';
}

function formatChapterRef(ref: ChapterRefRow | undefined): string {
  return ref ? `第${ref.number}章《${ref.title}》` : '未知章节';
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

function pickLatestState(
  payload: LedgerCharacterPayload,
  chapterById: Map<string, ChapterRefRow>,
  currentChapterNumber: number,
) {
  let latest: { chapter: ChapterRefRow; state: LedgerCharacterPayload['states'][number] } | null =
    null;
  for (const state of payload.states) {
    const chapter = chapterById.get(state.asOfChapterId);
    if (!chapter || chapter.number > currentChapterNumber) continue;
    if (!latest || chapter.number > latest.chapter.number) {
      latest = { chapter, state };
    }
  }
  return latest;
}

function settingText(row: ActiveLedgerRow, ref: string): string {
  const payload = row.snapshot.payload as LedgerSettingPayload;
  const lines = [
    `[${ref}] ${KIND_LABELS[row.kind]}《${row.snapshot.name}》v${row.version_no}${aliasSuffix(
      row.snapshot.aliases,
    )}`,
  ];
  if (row.snapshot.summary) lines.push(`摘要：${row.snapshot.summary}`);
  const meta = [
    `类别：${CATEGORY_LABELS[payload.category] ?? payload.category}`,
    `核验：${VERIFICATION_LABELS[payload.verification] ?? payload.verification}`,
  ];
  if (payload.tags.length > 0) meta.push(`标签：${payload.tags.join('、')}`);
  lines.push(meta.join('；'));
  if (payload.details) lines.push(`详情：${payload.details}`);
  return lines.join('\n');
}

function characterText(
  row: ActiveLedgerRow,
  ref: string,
  chapterById: Map<string, ChapterRefRow>,
  currentChapterNumber: number,
): string {
  const payload = row.snapshot.payload as LedgerCharacterPayload;
  const lines = [
    `[${ref}] ${KIND_LABELS[row.kind]}《${row.snapshot.name}》v${row.version_no}${aliasSuffix(
      row.snapshot.aliases,
    )}`,
  ];
  if (row.snapshot.summary) lines.push(`摘要：${row.snapshot.summary}`);
  const profile: string[] = [];
  if (payload.role) profile.push(`身份：${payload.role}`);
  if (payload.faction) profile.push(`阵营：${payload.faction}`);
  if (payload.appearance) profile.push(`外貌：${payload.appearance}`);
  if (payload.personality) profile.push(`性格：${payload.personality}`);
  if (payload.goals) profile.push(`目标：${payload.goals}`);
  if (payload.abilities) profile.push(`能力：${payload.abilities}`);
  if (payload.speechStyle) profile.push(`说话风格：${payload.speechStyle}`);
  if (profile.length > 0) lines.push(profile.join('\n'));
  if (payload.relationships.length > 0) {
    lines.push(
      `关系：${payload.relationships
        .map((item) => `${item.name}（${item.relation}${item.notes ? `：${item.notes}` : ''}）`)
        .join('；')}`,
    );
  }
  const latest = pickLatestState(payload, chapterById, currentChapterNumber);
  if (latest) {
    const state = latest.state;
    const details = [
      `生死：${LIFE_LABELS[state.life] ?? state.life}`,
      state.location ? `位置：${state.location}` : '',
      state.knowledge ? `知情：${state.knowledge}` : '',
      state.possessions ? `持有：${state.possessions}` : '',
      state.relationshipChanges ? `关系变化：${state.relationshipChanges}` : '',
    ].filter((item) => item.length > 0);
    lines.push(`截至${formatChapterRef(latest.chapter)}的状态：${details.join('；')}`);
  } else {
    lines.push('截至本章尚无状态记录。');
  }
  return lines.join('\n');
}

function foreshadowingText(
  row: ActiveLedgerRow,
  ref: string,
  chapterById: Map<string, ChapterRefRow>,
): string {
  const payload = row.snapshot.payload as LedgerForeshadowingPayload;
  const lines = [
    `[${ref}] ${KIND_LABELS[row.kind]}《${row.snapshot.name}》v${row.version_no}${aliasSuffix(
      row.snapshot.aliases,
    )}`,
  ];
  if (row.snapshot.summary) lines.push(`摘要：${row.snapshot.summary}`);
  const window =
    payload.payoffChapterMin !== null && payload.payoffChapterMax !== null
      ? `第 ${payload.payoffChapterMin}–${payload.payoffChapterMax} 章`
      : payload.payoffChapterMin !== null
        ? `第 ${payload.payoffChapterMin} 章起`
        : payload.payoffChapterMax !== null
          ? `第 ${payload.payoffChapterMax} 章前`
          : '未设置计划窗口';
  lines.push(
    `状态：${FORESHADOWING_STATE_LABELS[payload.state] ?? payload.state}；重要度：${
      IMPORTANCE_LABELS[payload.importance] ?? payload.importance
    }；埋设：${formatChapterRef(chapterById.get(payload.seedChapterId))}；计划回收：${window}`,
  );
  if (payload.payoffChapterId) {
    lines.push(`实际回收：${formatChapterRef(chapterById.get(payload.payoffChapterId))}`);
  }
  if (payload.note) lines.push(`说明：${payload.note}`);
  if (payload.resolutionNote) lines.push(`回收/放弃说明：${payload.resolutionNote}`);
  return lines.join('\n');
}

async function loadChapterRefs(ids: string[]): Promise<Map<string, ChapterRefRow>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Map();
  const rows = await sql<ChapterRefRow[]>`
    SELECT id, number, title FROM chapters
    WHERE id = ANY(${sql.array(unique)}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

function characterStateChapterIds(rows: ActiveLedgerRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'character') continue;
    const payload = row.snapshot.payload as LedgerCharacterPayload;
    for (const state of payload.states) ids.push(state.asOfChapterId);
  }
  return ids;
}

function foreshadowingChapterIds(rows: ActiveLedgerRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'foreshadowing') continue;
    const payload = row.snapshot.payload as LedgerForeshadowingPayload;
    ids.push(payload.seedChapterId);
    if (payload.payoffChapterId) ids.push(payload.payoffChapterId);
  }
  return ids;
}

export interface AiLedgerSection {
  key: string;
  label: string;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface AiLedgerContextBundle {
  view: AiLedgerContextView;
  sections: AiLedgerSection[];
}

export async function loadAiLedgerContext(input: {
  workspaceId: string;
  workId: string;
  currentChapterNumber: number;
}): Promise<AiLedgerContextBundle> {
  const rows = await loadActiveLedgerRows(input.workspaceId, input.workId);
  if (rows.length === 0) {
    return {
      view: {
        status: 'unavailable',
        reason: '尚未发布设定、角色或伏笔条目，AI 上下文未注入账本',
        citations: [],
        usedCharacters: [],
        truncated: false,
      },
      sections: [],
    };
  }

  const chapterById = await loadChapterRefs([
    ...characterStateChapterIds(rows),
    ...foreshadowingChapterIds(rows),
  ]);

  const citations: AiLedgerCitationView[] = [];
  const usedCharacters: string[] = [];
  const sections: AiLedgerSection[] = [];
  let truncated = false;

  const ordered = [...rows].sort((left, right) => {
    const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
    if (byKind !== 0) return byKind;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });

  for (const kind of KIND_ORDER) {
    const kindRows = ordered.filter((row) => row.kind === kind);
    if (kindRows.length === 0) continue;
    const items: string[] = [];
    let usedChars = 0;
    let contentChars = 0;
    let sectionTruncated = false;

    for (const row of kindRows) {
      const ref = `L${citations.length + 1}`;
      const full =
        kind === 'setting'
          ? settingText(row, ref)
          : kind === 'character'
            ? characterText(row, ref, chapterById, input.currentChapterNumber)
            : foreshadowingText(row, ref, chapterById);
      const clipped = truncateText(full, AI_ITEM_CHARS[kind]);
      if (usedChars + clipped.text.length > AI_SECTION_CHARS[kind]) {
        sectionTruncated = true;
        continue;
      }
      items.push(clipped.text);
      usedChars += clipped.text.length;
      contentChars += full.length;
      if (clipped.truncated) sectionTruncated = true;
      citations.push({
        ref,
        entryId: row.id,
        kind: row.kind,
        name: row.name,
        scope: row.scope,
        workId: row.work_id,
        versionId: row.current_version_id,
        versionNo: row.version_no,
        chars: clipped.text.length,
      });
      if (kind === 'character') usedCharacters.push(row.name);
    }

    if (items.length > 0) {
      sections.push({
        key: SECTION_KEYS[kind],
        label: SECTION_LABELS[kind],
        text: items.join('\n\n'),
        chars: contentChars,
        truncated: sectionTruncated,
      });
      if (sectionTruncated) truncated = true;
    } else if (kindRows.length > 0) {
      truncated = true;
    }
  }

  return {
    view: {
      status: citations.length > 0 ? 'ok' : 'unavailable',
      reason:
        citations.length > 0
          ? null
          : '账本条目正文超出预算，未注入任何条目',
      citations,
      usedCharacters,
      truncated,
    },
    sections,
  };
}

export function ledgerContextSections(
  bundle: AiLedgerContextBundle,
): AiContextSectionView[] {
  return bundle.sections.map((section) => ({
    key: section.key,
    label: section.label,
    chars: section.chars,
    usedChars: section.text.length,
    truncated: section.truncated,
  }));
}

function normalizeTerm(value: string): string {
  return value.trim();
}

function contentMatches(terms: string[], content: string): string[] {
  return terms.filter((term) => term.length >= 2 && content.includes(term));
}

function hintEntry(row: ActiveLedgerRow): GateLedgerHintEntryView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    versionNo: row.version_no,
  };
}

function unique(values: string[], limit = 12): string[] {
  return [...new Set(values)].slice(0, limit);
}

export async function loadGateHints(input: {
  workspaceId: string;
  workId: string;
  chapterId: string;
  chapterNumber: number;
  content: string;
  plan: ChapterPlan;
}): Promise<GateHintView[]> {
  const rows = await loadActiveLedgerRows(input.workspaceId, input.workId);
  if (rows.length === 0) return [];

  const hints: GateHintView[] = [];
  const content = input.content;

  const coreRows = rows.filter((row) => row.kind === 'character' || row.kind === 'setting');
  const coreMatched = coreRows
    .map((row) => ({
      row,
      terms: contentMatches(
        [row.name, ...row.aliases].map(normalizeTerm).filter((term) => term.length > 0),
        content,
      ),
    }))
    .filter((item) => item.terms.length > 0);

  const required = input.plan.requiredEntities ?? [];
  const missing = required.filter((entity) => !content.includes(entity));
  const aliasSaves: { missing: string; kind: LedgerEntryKind; alias: string; name: string }[] = [];
  for (const entity of missing) {
    for (const row of coreRows) {
      if (row.name !== entity) continue;
      const alias = row.aliases
        .map(normalizeTerm)
        .find((term) => term.length >= 2 && content.includes(term));
      if (alias) aliasSaves.push({ missing: entity, kind: row.kind, alias, name: row.name });
    }
  }

  if (coreMatched.length > 0 || aliasSaves.length > 0) {
    const terms = unique(coreMatched.flatMap((item) => item.terms));
    const entries = coreMatched.slice(0, 8).map((item) => hintEntry(item.row));
    const nameList = coreMatched
      .slice(0, 5)
      .map((item) => `${KIND_LABELS[item.row.kind]}《${item.row.name}》`)
      .join('、');
    let message = aliasSaves.length
      ? aliasSaves
          .map(
            (item) =>
              `核心实体「${item.missing}」未以原名出现，但正文出现${KIND_LABELS[item.kind]}《${
                item.name
              }》的别名「${item.alias}」。`,
          )
          .join('')
      : `正文命中账本条目：${nameList}。`;
    message += '硬门禁仍按计划中的实体原名判定，本提示不影响结论。';
    hints.push({ gate: 'core_entity', terms, message, entries });
  }

  const causalityRows = rows.filter(
    (row) => row.kind === 'foreshadowing' || row.kind === 'setting',
  );
  const causalityMatches: {
    row: ActiveLedgerRow;
    terms: string[];
    reason: string;
  }[] = [];
  for (const row of causalityRows) {
    const terms = contentMatches(
      [row.name, ...row.aliases].map(normalizeTerm).filter((term) => term.length > 0),
      content,
    );
    if (terms.length > 0) {
      causalityMatches.push({ row, terms, reason: '正文提及' });
      continue;
    }
    if (row.kind !== 'foreshadowing') continue;
    const payload = row.snapshot.payload as LedgerForeshadowingPayload;
    if (payload.seedChapterId === input.chapterId) {
      causalityMatches.push({ row, terms: ['本章埋设'], reason: '本章埋设' });
      continue;
    }
    if (payload.payoffChapterId === input.chapterId) {
      causalityMatches.push({ row, terms: ['本章回收'], reason: '本章回收' });
      continue;
    }
    const inWindow =
      payload.state !== 'paid_off' &&
      payload.state !== 'abandoned' &&
      (payload.payoffChapterMin === null ||
        input.chapterNumber >= payload.payoffChapterMin) &&
      (payload.payoffChapterMax === null ||
        input.chapterNumber <= payload.payoffChapterMax) &&
      (payload.payoffChapterMin !== null || payload.payoffChapterMax !== null);
    if (inWindow) {
      causalityMatches.push({
        row,
        terms: ['回收窗口'],
        reason: '处于计划回收窗口',
      });
    }
  }

  if (causalityMatches.length > 0) {
    const entries = causalityMatches.slice(0, 8).map((item) => hintEntry(item.row));
    const terms = unique(causalityMatches.flatMap((item) => item.terms));
    const summary = causalityMatches
      .slice(0, 5)
      .map((item) => `${KIND_LABELS[item.row.kind]}《${item.row.name}》（${item.reason}）`)
      .join('、');
    hints.push({
      gate: 'causality',
      terms,
      message: `以下账本条目与本章相关：${summary}。因果门禁仍按目标/阻力关键词判定，本提示不影响结论。`,
      entries,
    });
  }

  return hints;
}
