import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ChapterListItem,
  LedgerCharacterPayload,
  LedgerCharacterTimeline,
  LedgerEntryDetail,
  LedgerEntrySnapshot,
  LedgerEntrySummary,
  LedgerEntryVersionView,
  LedgerForeshadowingPayload,
  LedgerForeshadowingSummary,
  MeResponse,
} from '@yunshuo/contracts';
import { ApiError } from '../api.js';
import {
  CharacterContinuitySection,
  LedgerDialog,
  LedgerEntryDetailView,
  LedgerListItem,
  ledgerChapterLabel,
  ForeshadowingPayloadView,
} from './LedgerDialog.js';

const USER = { id: 'user-1', email: 'lin@example.com', name: '林默' };

const ME: MeResponse = {
  user: USER,
  workspace: { id: 'ws-1', name: '规则档案馆', settingsVersion: 1, ledgerVersion: 1 },
  role: 'author',
};

function meWith(role: MeResponse['role']): MeResponse {
  return { ...ME, role };
}

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'ch-1',
    workId: 'work-1',
    workTitle: '作品甲',
    number: 1,
    title: '夜行',
    status: 'canon',
    volumeTitle: '上卷',
    wordCount: 1200,
    currentVersionNo: 1,
    updatedAt: '2026-10-23T18:00:00.000Z',
    ...overrides,
  };
}

const CHAPTERS: ChapterListItem[] = [
  chapter({ id: 'ch-1', number: 1, title: '夜行' }),
  chapter({ id: 'ch-2', number: 2, title: '王城' }),
  chapter({ id: 'ch-3', workId: 'work-2', workTitle: '作品乙', number: 1, title: '别作' }),
];

const chapterMap = new Map(CHAPTERS.map((item) => [item.id, item]));

function chapterLabel(id: string | null): string {
  if (!id) return '未关联章节';
  const found = chapterMap.get(id);
  return found ? `第 ${found.number} 章 · ${found.title}` : '未知章节';
}

function chapterNumber(id: string): number {
  return chapterMap.get(id)?.number ?? 0;
}

function snapshot(overrides: Partial<LedgerEntrySnapshot> = {}): LedgerEntrySnapshot {
  return {
    name: '王城',
    aliases: ['旧都'],
    summary: '王城概要',
    sourceChapterId: 'ch-2',
    payload: {
      category: 'location',
      details: '旧说明',
      tags: [],
      verification: 'unverified',
    },
    ...overrides,
  };
}

function version(overrides: Partial<LedgerEntryVersionView> = {}): LedgerEntryVersionView {
  return {
    id: 'ver-1',
    versionNo: 1,
    snapshot: snapshot({ payload: { category: 'location', details: '初始说明', tags: [], verification: 'unverified' } }),
    changeSummary: '初版',
    createdBy: USER,
    createdAt: '2026-10-22T09:00:00.000Z',
    ...overrides,
  };
}

const V1 = version({ id: 'ver-1', versionNo: 1, createdBy: null });
const V2 = version({
  id: 'ver-2',
  versionNo: 2,
  snapshot: snapshot({
    payload: { category: 'location', details: '旧说明', tags: [], verification: 'unverified' },
  }),
  changeSummary: '修订',
});
const V3 = version({
  id: 'ver-3',
  versionNo: 3,
  snapshot: snapshot({
    payload: { category: 'location', details: '新说明', tags: ['王城', '河口'], verification: 'verified' },
  }),
  changeSummary: '',
});

function summary(overrides: Partial<LedgerEntrySummary> = {}): LedgerEntrySummary {
  return {
    id: 'entry-1',
    workId: 'work-1',
    kind: 'setting',
    scope: 'work',
    name: '王城',
    aliases: ['旧都'],
    summary: '王城概要',
    status: 'active',
    sourceChapterId: 'ch-2',
    currentVersionNo: 2,
    draftVersionNo: 3,
    foreshadowing: null,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<LedgerEntryDetail> = {}): LedgerEntryDetail {
  return {
    ...summary(),
    currentVersion: V2,
    draftVersion: V3,
    createdBy: USER,
    updatedBy: USER,
    createdAt: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

const ENTRIES_KEY = ['ledgerEntries', 'setting', 'all', '', ''] as const;

function renderDialog(
  options: {
    entries?: LedgerEntrySummary[];
    loaded?: boolean;
    error?: Error;
    me?: MeResponse;
  } = {},
): string {
  const { entries = [], loaded = true, error, me = ME } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  if (loaded) client.setQueryData(ENTRIES_KEY, { entries });
  if (error) {
    // 有缓存时查询才不会被判 stale；否则挂载重取会把错误态冲回读取态。
    client.setQueryData(ENTRIES_KEY, { entries: [] });
    client
      .getQueryCache()
      .find({ queryKey: ENTRIES_KEY })
      ?.setState({ status: 'error', fetchStatus: 'idle', error });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LedgerDialog me={me} chapters={CHAPTERS} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

type DetailProps = ComponentProps<typeof LedgerEntryDetailView>;

function renderDetail(overrides: Partial<DetailProps> = {}): string {
  const props: DetailProps = {
    entry: detail(),
    chapters: CHAPTERS,
    versions: [V3, V2, V1],
    versionsLoading: false,
    versionsError: null,
    canWrite: true,
    chapterLabel,
    chapterNumber,
    timeline: null,
    timelineLoading: false,
    timelineError: null,
    workTitle: '作品甲',
    draftDiffRows: [{ label: '详细说明', before: '旧说明', after: '新说明' }],
    action: null,
    archiveReason: '',
    discardDraft: false,
    rollbackVersionNo: null,
    rollbackReason: '',
    compareVersionId: null,
    publishPending: false,
    archivePending: false,
    rollbackPending: false,
    onStartEdit: () => {},
    onSetAction: () => {},
    onArchiveReasonChange: () => {},
    onDiscardDraftChange: () => {},
    onPublish: () => {},
    onArchive: () => {},
    onStartRollback: () => {},
    onRollbackReasonChange: () => {},
    onRollback: () => {},
    onCancelRollback: () => {},
    onToggleCompare: () => {},
    ...overrides,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['ledgerSuggestions', props.entry.id], { suggestions: [], note: '' });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LedgerEntryDetailView {...props} />
    </QueryClientProvider>,
  );
}

function foreshadowingMeta(
  overrides: Partial<LedgerForeshadowingSummary> = {},
): LedgerForeshadowingSummary {
  return {
    state: 'planted',
    importance: 'medium',
    seedChapter: { id: 'ch-1', number: 1, title: '夜行' },
    payoffChapterMin: 4,
    payoffChapterMax: 6,
    payoffChapter: null,
    resolutionNote: '',
    latestCanonChapter: { id: 'ch-2', number: 3, title: '归途' },
    overdue: false,
    overdueBy: null,
    basis: 'current',
    ...overrides,
  };
}

const CHARACTER_PAYLOAD: LedgerCharacterPayload = {
  role: '捕快',
  appearance: '',
  personality: '谨慎',
  goals: '查明旧案',
  faction: '',
  abilities: '',
  speechStyle: '',
  relationships: [
    { name: '沈砚', relation: '同僚', notes: '互相试探' },
    { name: '老周', relation: '师父', notes: '' },
  ],
  states: [
    {
      asOfChapterId: 'ch-2',
      life: 'dead',
      location: '',
      knowledge: '',
      possessions: '',
      relationshipChanges: '',
    },
    {
      asOfChapterId: 'ch-1',
      life: 'alive',
      location: '河口',
      knowledge: '知道密令',
      possessions: '腰牌',
      relationshipChanges: '与沈砚结盟',
    },
  ],
};

function characterDetail(overrides: Partial<LedgerEntryDetail> = {}): LedgerEntryDetail {
  return detail({
    kind: 'character',
    name: '林默',
    aliases: [],
    summary: '负责旧案的捕快',
    currentVersion: version({
      id: 'ver-2',
      versionNo: 2,
      snapshot: snapshot({
        name: '林默',
        aliases: [],
        summary: '负责旧案的捕快',
        sourceChapterId: 'ch-1',
        payload: CHARACTER_PAYLOAD,
      }),
    }),
    draftVersion: null,
    currentVersionNo: 2,
    draftVersionNo: null,
    sourceChapterId: 'ch-1',
    ...overrides,
  });
}

function timeline(
  overrides: Partial<LedgerCharacterTimeline> = {},
): LedgerCharacterTimeline {
  return {
    entryId: 'entry-1',
    workId: 'work-1',
    name: '林默',
    aliases: [],
    versionNo: 2,
    states: [],
    appearances: [
      { chapter: { id: 'ch-1', number: 1, title: '夜行' }, matches: 3 },
      { chapter: { id: 'ch-2', number: 2, title: '王城' }, matches: 1 },
    ],
    firstAppearance: { id: 'ch-1', number: 1, title: '夜行' },
    latestAppearance: { id: 'ch-2', number: 2, title: '王城' },
    warnings: [],
    scanScope: 'canon_current',
    ...overrides,
  };
}

function renderContinuity(
  options: {
    entry?: LedgerEntryDetail;
    timeline?: LedgerCharacterTimeline | null;
    loading?: boolean;
    error?: unknown;
  } = {},
): string {
  return renderToStaticMarkup(
    <CharacterContinuitySection
      entry={options.entry ?? characterDetail()}
      timeline={options.timeline ?? null}
      loading={options.loading ?? false}
      error={options.error ?? null}
    />,
  );
}

describe('设定与连续性账本弹窗', () => {
  it('外壳、默认设定页签与筛选面逐项渲染', () => {
    const html = renderDialog();

    expect(html).toContain('<div class="modal-backdrop">');
    expect(html).toContain('class="modal modal-ledger"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="ledger-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<p class="eyebrow">规则档案馆 · 设定与连续性账本</p>');
    expect(html).toContain('<h2 id="ledger-title">设定、角色与伏笔</h2>');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');

    expect(html).toContain(
      '<button type="button" role="tab" aria-selected="true" class="ledger-kind-tab ledger-kind-tab-active">设定</button>',
    );
    expect(html).toContain(
      '<button type="button" role="tab" aria-selected="false" class="ledger-kind-tab">角色</button>',
    );
    expect(html).toContain(
      '<button type="button" role="tab" aria-selected="false" class="ledger-kind-tab">伏笔</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">新建设定</button>',
    );
    expect(html).toContain('<span class="muted">共 0 条</span>');

    expect(html).toContain('placeholder="名称、别名或摘要"');
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('<option value="all" selected="">全部未归档</option>');
    expect(html).toContain('<option value="active">已生效</option>');
    expect(html).toContain('<option value="draft">未发布草稿</option>');
    expect(html).toContain('<option value="archived">已归档</option>');
    expect(html).toContain('<option value="" selected="">全部作品</option>');
    expect(html).toContain('<option value="work-1">作品甲</option>');
    expect(html).toContain('<option value="work-2">作品乙</option>');
    expect(html.split('<option value="work-1">').length - 1).toBe(1);

    expect(html).not.toContain('foreshadowing-report-strip');
    expect(html).not.toContain('回收状态');
    expect(html).toContain('尚未选择设定条目。');
    expect(html).toContain('从左侧选择条目查看版本与差异，或新建一条设定。');
    expect(html).toContain(
      '设定、角色与伏笔按工作区隔离；已发布版本不可修改，所有写入进入审计。已发布条目接入检索、AI 上下文引用与门禁提示，提示不改变门禁结论。AI 只能提出状态变更与伏笔回收建议，采纳后仅写入草稿，发布仍由人工完成。',
    );
    expect(html).toContain('<button type="button" class="button button-quiet">关闭</button>');
  });

  it('章节标签区分关联、未关联与未知章节', () => {
    expect(ledgerChapterLabel(CHAPTERS, 'ch-2')).toBe('第 2 章 · 王城');
    expect(ledgerChapterLabel(CHAPTERS, null)).toBe('未关联章节');
    expect(ledgerChapterLabel(CHAPTERS, 'ch-404')).toBe('未知章节');
  });

  it('条目读取时列表与正文各显示读取态', () => {
    const html = renderDialog({ loaded: false });

    expect(html).toContain('<p class="empty-state">正在读取设定条目……</p>');
    expect(html).toContain('尚未选择设定条目。');
    expect(html).not.toContain('<div class="ledger-empty">');
  });

  it('条目读取失败时保留错误码原文', () => {
    const html = renderDialog({
      error: new ApiError(500, 'LEDGER_LIST_FAILED', '读取账本失败'),
    });

    expect(html).toContain(
      '<div class="modal-error">读取失败：读取账本失败（LEDGER_LIST_FAILED）</div>',
    );
    expect(html).not.toContain('尚未建立设定条目。');
  });

  it('空账本给出不伪造示例的说明', () => {
    const html = renderDialog({ entries: [] });

    expect(html).toContain('<p class="empty-state">尚未建立设定条目。</p>');
    expect(html).toContain(
      '设定库为空时不会显示伪造的示例。先登记一条世界观事实，再发布为生效版本。',
    );
    expect(html).toContain('<div class="ledger-empty">');
  });

  it('列表逐条给出状态、摘要、归属与版本事实', () => {
    const html = renderDialog({
      entries: [
        summary(),
        summary({
          id: 'entry-2',
          name: '河口',
          summary: '',
          scope: 'workspace',
          workId: null,
          status: 'draft',
          currentVersionNo: null,
          draftVersionNo: 1,
        }),
      ],
    });

    expect(html).toContain('<span class="muted">共 2 条</span>');
    expect(html).toContain('class="ledger-list-item"');
    expect(html).not.toContain('aria-current');
    expect(html).toContain('<strong>王城</strong>');
    expect(html).toContain('<span class="badge badge-green">已生效</span>');
    expect(html).toMatch(
      /<p class="ledger-list-summary">王城概要<\/p><span class="ledger-list-meta">作品甲 · 生效 v2 · 草稿 v3<\/span>/,
    );
    expect(html.split('ledger-list-summary').length - 1).toBe(1);
    expect(html).toContain('<strong>河口</strong>');
    expect(html).toContain('<span class="badge badge-amber">草稿</span>');
    expect(html).toContain('<span class="ledger-list-meta">工作区通用 · 草稿 v1</span>');
  });

  it('只读角色看不到新建入口', () => {
    const html = renderDialog({ me: meWith('reviewer') });

    expect(html).toContain('<span class="badge badge-neutral">只读</span>');
    expect(html).not.toContain('新建设定');
    expect(html).not.toContain('button button-primary button-small');
  });
});

describe('账本列表项', () => {
  it('选中项高亮、作品标题缺失时回退「作品专属」', () => {
    const html = renderToStaticMarkup(
      <LedgerListItem
        item={summary()}
        workTitle={undefined}
        selected
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('class="ledger-list-item ledger-list-item-active"');
    expect(html).toContain('aria-current="true"');    expect(html).toContain('<span class="ledger-list-meta">作品专属 · 生效 v2 · 草稿 v3</span>');
  });

  it('伏笔条目追加回收状态、窗口、逾期与草稿来源', () => {
    const overdue = renderToStaticMarkup(
      <LedgerListItem
        item={summary({
          kind: 'foreshadowing',
          foreshadowing: foreshadowingMeta({
            state: 'reinforced',
            importance: 'high',
            overdue: true,
            overdueBy: 2,
            basis: 'draft',
          }),
        })}
        workTitle="作品甲"
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(overdue).toContain(
      '<span class="ledger-list-meta ledger-list-foreshadowing">已强化 · 重要度高 · 第 4–6 章 · 逾期 2 章 · 草稿</span>',
    );

    const current = renderToStaticMarkup(
      <LedgerListItem
        item={summary({
          kind: 'foreshadowing',
          foreshadowing: foreshadowingMeta({
            payoffChapterMin: null,
            payoffChapterMax: null,
            latestCanonChapter: null,
          }),
          draftVersionNo: null,
        })}
        workTitle="作品甲"
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(current).toContain('已埋设 · 重要度中 · 未设置计划窗口');
    expect(current).not.toContain('逾期');
    expect(current).not.toContain('草稿');
  });
});

describe('账本详情', () => {
  it('生效条目展示徽标、元信息、草稿差异与版本事实', () => {
    const html = renderDetail();

    expect(html).toContain('<span class="badge badge-green">已生效</span>');
    expect(html).toContain('<span class="badge badge-neutral">设定</span>');
    expect(html).toContain('<span class="badge badge-neutral">作品专属</span>');
    expect(html).toContain('<span class="badge badge-ink">地点</span>');
    expect(html).toContain('<span class="badge badge-green">已核实</span>');
    expect(html).toContain('<h3>王城</h3>');
    expect(html).toContain('<p class="ledger-alias-line">别名：旧都</p>');
    expect(html).toContain('<p class="ledger-detail-summary">王城概要</p>');

    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small">继续编辑草稿</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">发布草稿</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-danger button-small">归档</button>',
    );

    expect(html).toContain('<dt>归属</dt><dd>作品甲</dd>');
    expect(html).toContain('<dt>来源章节</dt><dd>第 2 章 · 王城</dd>');
    expect(html).toContain('<dt>版本</dt><dd>生效 v2 · 草稿 v3</dd>');
    expect(html).toContain('<dt>最后更新</dt><dd>10/23 18:07</dd>');
    expect(html).toContain('<dt>创建者</dt><dd>林默</dd>');
    expect(html).toContain('<dt>最近编辑</dt><dd>林默</dd>');

    expect(html).toContain('<p class="eyebrow">待发布草稿</p>');
    expect(html).toContain('<h4>草稿 v3 与生效 v2 的差异</h4>');
    expect(html).toContain('<span class="badge badge-amber">发布前预览</span>');
    expect(html).toContain(
      '<div class="ledger-diff-head"><span>字段</span><span>之前</span><span>之后</span></div>',
    );
    expect(html).toContain('<span class="ledger-diff-label">详细说明</span>');
    expect(html).toContain('<div class="ledger-diff-value ledger-diff-before">旧说明</div>');
    expect(html).toContain('<div class="ledger-diff-value ledger-diff-after">新说明</div>');

    expect(html).toContain('<p class="eyebrow">草稿内容</p>');
    expect(html).toContain('<span>分类：地点</span>');
    expect(html).toContain('<span>核实状态：已核实</span>');
    expect(html).toContain('<span>标签：王城、河口</span>');
    expect(html).toContain('<div class="ledger-details">新说明</div>');

    expect(html).toContain('<p class="eyebrow">审计留痕</p>');
    expect(html).toContain('<h4>版本历史 · 3</h4>');
    expect(html).toContain('<span class="muted">只追加 · 不删除</span>');
    expect(html).toContain('<span class="ledger-version-no">v3</span>');
    expect(html).toContain('<span class="badge badge-amber">当前草稿</span>');
    expect(html).toContain('<span class="badge badge-green">生效中</span>');
    expect(html).toContain('<p class="ledger-version-summary">修订</p>');
    expect(html).toContain('<p class="ledger-version-summary">初版</p>');
    expect(html).toContain('林默 · 10/22 09:00');
    expect(html).toContain('系统 · 10/22 09:00');
    expect(html).toContain('对比 v2');
    expect(html).toContain('对比 v1');
    expect(html).toContain('查看初始内容');
    expect(html.split('回滚到此版').length - 1).toBe(1);

    expect(html).not.toContain('ledger-readonly-hint');
    expect(html).not.toContain('AI 建议（人工确认）');
  });

  it('只有草稿时标题改写并给出空差异说明', () => {
    const html = renderDetail({
      entry: detail({
        status: 'draft',
        currentVersion: null,
        draftVersion: V3,
        currentVersionNo: null,
      }),
      versions: [V3],
      draftDiffRows: [],
    });

    expect(html).toContain('<h4>草稿 v3（尚未发布）</h4>');
    expect(html).toContain('<p class="empty-state">草稿没有任何字段内容。</p>');
    expect(html).toContain('<dt>版本</dt><dd>尚未发布 · 草稿 v3</dd>');
    expect(html).toContain('<p class="eyebrow">草稿内容</p>');
    expect(html).toContain('查看初始内容');
    expect(html).not.toContain('回滚到此版');
    expect(html).not.toContain('生效中');
  });

  it('已归档条目给出警告并撤掉写操作', () => {
    const html = renderDetail({
      entry: detail({ status: 'archived', draftVersion: null, draftVersionNo: null }),
    });

    expect(html).toContain('<span class="badge badge-muted">已归档</span>');
    expect(html).toContain(
      '该条目已归档：默认列表不再显示，名称可被新条目复用；历史版本仍保留。当前版本未提供取消归档操作。',
    );
    expect(html).not.toContain('ledger-detail-actions');
    expect(html).not.toContain('回滚到此版');
    expect(html).not.toContain('继续编辑草稿');
    expect(html).not.toContain('发布草稿');
    expect(html).not.toContain('button button-danger');
  });

  it('只读角色只能看详情并给出角色限制说明', () => {
    const html = renderDetail({ canWrite: false });

    expect(html).not.toContain('ledger-detail-actions');
    expect(html).not.toContain('回滚到此版');
    expect(html).toContain('<p class="muted ledger-readonly-hint">');
    expect(html).toContain(
      '审阅者与读者可查看账本与历史版本，但不能编辑、发布、归档或回滚。只有所有者、主笔与作者可以写入。',
    );
  });

  it('元信息逐项回退：归属、来源章节与操作人', () => {
    const html = renderDetail({
      entry: detail({
        scope: 'workspace',
        workId: null,
        sourceChapterId: null,
        createdBy: null,
        updatedBy: null,
      }),
      workTitle: undefined,
    });

    expect(html).toContain('<dt>归属</dt><dd>工作区通用 · 所有作品共享</dd>');
    expect(html).toContain('<dt>来源章节</dt><dd>未关联章节</dd>');
    expect(html.split('<dd>未知</dd>').length - 1).toBe(2);

    const workScoped = renderDetail({ workTitle: undefined });
    expect(workScoped).toContain('<dt>归属</dt><dd>作品专属</dd>');

    const unknownChapter = renderDetail({
      entry: detail({ sourceChapterId: 'ch-404' }),
    });
    expect(unknownChapter).toContain('<dt>来源章节</dt><dd>未知章节</dd>');
  });

  it('角色内容：事实回退、关系与按章号排序的状态时间线', () => {
    const html = renderDetail({
      entry: characterDetail(),
      versions: [],
      draftDiffRows: [],
    });

    expect(html.split('未填写').length - 1).toBe(4);
    expect(html).toContain('<dt>身份</dt><dd>捕快</dd>');
    expect(html).toContain('<dt>性格</dt><dd>谨慎</dd>');
    expect(html).toContain('<dt>目标</dt><dd>查明旧案</dd>');
    expect(html).toContain('<h5>人物关系</h5>');
    expect(html).toContain(
      '<li><strong>沈砚</strong><span>同僚</span><p>互相试探</p></li>',
    );
    expect(html).toContain('<li><strong>老周</strong><span>师父</span></li>');

    expect(html).toContain('<h5>状态时间线</h5>');
    expect(html.indexOf('<strong>第 1 章 · 夜行</strong>')).toBeLessThan(
      html.indexOf('<strong>第 2 章 · 王城</strong>'),
    );
    expect(html).toContain('<span class="badge badge-green">存活</span>');
    expect(html).toContain('<span class="badge badge-red">死亡</span>');
    expect(html).toContain('<span>地点：河口</span>');
    expect(html).toContain('<span>持有：腰牌</span>');
    expect(html).toContain('<p>已知：知道密令</p>');
    expect(html).toContain('<p>关系变化：与沈砚结盟</p>');
    expect(html).toContain('<p class="muted">只登记了生死状态。</p>');
    expect(html).toContain('AI 建议（人工确认）');

    const withTimeline = renderDetail({
      entry: characterDetail(),
      timeline: timeline({
        states: [
          {
            chapter: { id: 'ch-1', number: 1, title: '夜行' },
            life: 'alive',
            location: '',
            knowledge: '',
            possessions: '',
            relationshipChanges: '',
          },
        ],
      }),
    });
    expect(withTimeline).toContain('<span class="badge badge-green">最新状态：存活</span>');
  });

  it('伏笔内容：逾期、回收说明与草稿提示', () => {
    const payload: LedgerForeshadowingPayload = {
      seedChapterId: 'ch-1',
      payoffChapterMin: 4,
      payoffChapterMax: 6,
      importance: 'high',
      state: 'paid_off',
      payoffChapterId: 'ch-2',
      note: '旧王城的印玺',
      resolutionNote: '第 2 章亮明印玺来历',
    };
    const html = renderDetail({
      entry: detail({
        kind: 'foreshadowing',
        name: '王城印玺',
        currentVersion: version({
          id: 'ver-2',
          versionNo: 2,
          snapshot: snapshot({ name: '王城印玺', payload }),
        }),
        draftVersion: version({
          id: 'ver-3',
          versionNo: 3,
          snapshot: snapshot({ name: '王城印玺', payload }),
        }),
        foreshadowing: foreshadowingMeta({
          state: 'paid_off',
          importance: 'high',
          payoffChapter: { id: 'ch-2', number: 2, title: '王城' },
          overdue: true,
          overdueBy: 2,
          basis: 'current',
        }),
      }),
    });

    expect(html).toContain('<span class="badge badge-ink">重要度：高</span>');
    expect(html).toContain('<span class="badge badge-green">已回收</span>');
    expect(html).toContain('<span class="badge badge-red">生效版本已逾期 2 章</span>');
    expect(html).toContain('生效版本');
    expect(html).toContain('已逾期 2 章');
    expect(html).toContain('<dt>回收状态</dt><dd>已回收</dd>');
    expect(html).toContain('<dt>重要度</dt><dd>高</dd>');
    expect(html).toContain('<dt>埋设章节</dt><dd>第 1 章 · 夜行</dd>');
    expect(html).toContain('<dt>计划回收窗口</dt><dd>第 4–6 章</dd>');
    expect(html).toContain('<dt>回收章节</dt><dd>第 2 章 · 王城</dd>');
    expect(html).toContain('<dt>当前正典</dt><dd>第 3 章 · 归途</dd>');
    expect(html).toContain('已逾期 2 章：计划最晚在第 6 章回收');
    expect(html).toContain('当前正典已到第 3 章');
    expect(html).toContain('逾期只是提醒，不会自动改变伏笔状态');
    expect(html).toContain(
      '逾期与提醒基于生效 v2；上方展示的是草稿内容，发布后才会进入提醒。',
    );
    expect(html).toContain('<h5>伏笔说明</h5>');
    expect(html).toContain('<div class="ledger-details">旧王城的印玺</div>');
    expect(html).toContain('<h5>回收说明</h5>');
    expect(html).toContain('<div class="ledger-details">第 2 章亮明印玺来历</div>');
  });

  it('伏笔内容：未逾期、放弃原因与缺省回退', () => {
    const abandoned: LedgerForeshadowingPayload = {
      seedChapterId: 'ch-1',
      payoffChapterMin: null,
      payoffChapterMax: 6,
      importance: 'low',
      state: 'abandoned',
      payoffChapterId: null,
      note: '',
      resolutionNote: '线索并入支线',
    };
    const html = renderToStaticMarkup(
      <ForeshadowingPayloadView
        payload={abandoned}
        meta={foreshadowingMeta({ state: 'abandoned', importance: 'low', overdue: false })}
        chapterLabel={chapterLabel}
        hasDraft={false}
        currentVersionNo={2}
      />,
    );

    expect(html).toContain('<dt>计划回收窗口</dt><dd>第 6 章前</dd>');
    expect(html).toContain('<dt>回收章节</dt><dd>未回收</dd>');
    expect(html).toContain('<dt>当前正典</dt><dd>第 3 章 · 归途</dd>');
    expect(html).toContain('还没有填写伏笔说明。');
    expect(html).toContain('<h5>放弃原因</h5>');
    expect(html).toContain('<div class="ledger-details">线索并入支线</div>');
    expect(html).not.toContain('回收说明');
    expect(html).not.toContain('逾期与提醒基于生效');
    expect(html).not.toContain('未逾期');

    const unresolved = renderToStaticMarkup(
      <ForeshadowingPayloadView
        payload={{
          ...abandoned,
          state: 'planted',
          resolutionNote: '',
          note: '旧印玺',
        }}
        meta={foreshadowingMeta({ importance: 'low', overdue: false })}
        chapterLabel={chapterLabel}
        hasDraft={false}
        currentVersionNo={null}
      />,
    );
    expect(unresolved).toContain('未逾期：计划最晚在第 6 章回收；当前正典第 3 章。');
    expect(unresolved).toContain('<div class="ledger-details">旧印玺</div>');
    expect(unresolved).not.toContain('放弃原因');

    const noWindow = renderToStaticMarkup(
      <ForeshadowingPayloadView
        payload={{
          ...abandoned,
          state: 'planted',
          payoffChapterMax: null,
          resolutionNote: '',
        }}
        meta={null}
        chapterLabel={chapterLabel}
        hasDraft={false}
        currentVersionNo={null}
      />,
    );
    expect(noWindow).toContain('<dt>计划回收窗口</dt><dd>未设置计划窗口</dd>');
    expect(noWindow).toContain('<dt>当前正典</dt><dd>尚未读取到正典章节</dd>');
    expect(noWindow).toContain('未填写计划回收结束章，不参与逾期判断。');
  });

  it('发布与归档确认框按待发布草稿与勾选状态禁用', () => {
    const publish = renderDetail({ action: 'publish' });

    expect(publish).toContain('<strong>发布草稿 v3？</strong>');
    expect(publish).toContain(
      '发布后该快照成为生效版本，历史版本保留；已发布版本不可直接修改，后续修改会生成新草稿。',
    );
    expect(publish).toContain(
      '<button type="button" class="button button-primary">确认发布</button>',
    );

    const publishPending = renderDetail({ action: 'publish', publishPending: true });
    expect(publishPending).toContain(
      '<button type="button" class="button button-primary" disabled="">发布中…</button>',
    );

    const archive = renderDetail({ action: 'archive' });
    expect(archive).toContain('<strong>归档「王城」？</strong>');
    expect(archive).toContain(
      '归档后默认列表不再显示，名称可被新条目复用；历史版本全部保留。归档不会删除审计记录。',
    );
    expect(archive).toContain('我确认丢弃未发布草稿 v3（草稿版本仍会留在历史中）');
    expect(archive).toContain('placeholder="例如：世界观重做，旧条目停用"');
    expect(archive).toContain('rows="2"');
    expect(archive.match(/maxLength="1000"/g)).toHaveLength(1);
    expect(archive).toContain(
      '<button type="button" class="button button-danger" disabled="">确认归档</button>',
    );
    expect(archive).not.toContain('checked=""');

    const discard = renderDetail({ action: 'archive', discardDraft: true });
    expect(discard).toContain(
      '<button type="button" class="button button-danger">确认归档</button>',
    );

    const noDraft = renderDetail({
      action: 'archive',
      entry: detail({ draftVersion: null, draftVersionNo: null }),
    });
    expect(noDraft).not.toContain('我确认丢弃未发布草稿');
    expect(noDraft).toContain(
      '<button type="button" class="button button-danger">确认归档</button>',
    );
  });

  it('对比展开与回滚草稿表单按版本与原因字数变化', () => {
    const compare = renderDetail({ compareVersionId: 'ver-2' });

    expect(compare).toContain('收起差异');
    expect(compare).toContain('<p class="muted">v1 → v2</p>');
    expect(compare).toContain('<span class="ledger-diff-label">详细说明</span>');
    expect(compare).toContain('<div class="ledger-diff-value ledger-diff-before">初始说明</div>');
    expect(compare).toContain('<div class="ledger-diff-value ledger-diff-after">旧说明</div>');

    const unchangedVersion = version({
      id: 'ver-9',
      versionNo: 9,
      snapshot: V2.snapshot,
      changeSummary: '',
    });
    const unchanged = renderDetail({
      versions: [unchangedVersion, V2, V1],
      compareVersionId: 'ver-9',
    });
    expect(unchanged).toContain('<p class="muted">v2 → v9</p>');
    expect(unchanged).toContain(
      '<p class="empty-state">与上一版相比没有字段变化。</p>',
    );

    const noDraftDiff = renderDetail({ draftDiffRows: [] });
    expect(noDraftDiff).toContain(
      '<p class="empty-state">草稿与生效版本没有字段差异。</p>',
    );

    const initial = renderDetail({ compareVersionId: 'ver-1' });
    expect(initial).toContain('<p class="muted">v1 初始快照</p>');

    const shortReason = renderDetail({ rollbackVersionNo: 2, rollbackReason: '改回' });
    expect(shortReason).toContain('<strong>从 v2 创建回滚草稿</strong>');
    expect(shortReason).toContain(
      '回滚不会直接改变生效版本，而是生成一份新草稿；发布后才生效。当前未发布草稿会被新草稿取代，旧草稿仍保留在版本历史中。',
    );
    expect(shortReason).toContain('<span>回滚原因（至少 4 个字）</span>');
    expect(shortReason).toContain('placeholder="例如：恢复旧的王城位置设定"');
    expect(shortReason).toContain(
      '<button type="button" class="button button-primary" disabled="">生成回滚草稿</button>',
    );

    const longReason = renderDetail({
      rollbackVersionNo: 2,
      rollbackReason: '改回旧设定',
    });
    expect(longReason).toContain(
      '<button type="button" class="button button-primary">生成回滚草稿</button>',
    );

    const rollingBack = renderDetail({
      rollbackVersionNo: 1,
      rollbackReason: '改回旧设定',
      rollbackPending: true,
    });
    expect(rollingBack).not.toContain('回滚到此版');
    expect(rollingBack).toContain('生成中…');
  });

  it('版本历史分别渲染读取、失败与空态', () => {
    const loading = renderDetail({ versionsLoading: true, versions: [] });
    expect(loading).toContain('<h4>版本历史 · 0</h4>');
    expect(loading).toContain('正在读取版本历史……');

    const failed = renderDetail({
      versions: [],
      versionsError: new ApiError(500, 'LEDGER_VERSION_FAILED', '版本服务不可用'),
    });
    expect(failed).toContain(
      '<div class="modal-error">版本读取失败：版本服务不可用（LEDGER_VERSION_FAILED）</div>',
    );

    const empty = renderDetail({ versions: [] });
    expect(empty).toContain('还没有版本记录。');
    expect(empty).not.toContain('ledger-version-list');
  });
});

describe('角色连续性检查', () => {
  it('时间线给出首末出场、命中次数与逐条警告', () => {
    const html = renderContinuity({
      entry: characterDetail({ draftVersion: V3, draftVersionNo: 3 }),
      timeline: timeline({
        warnings: [
          {
            code: 'dead_revived',
            severity: 'warning',
            message: '第 2 章死亡后在第 3 章复活',
            chapterId: null,
          },
          {
            code: 'relationship_conflict',
            severity: 'warning',
            message: '与沈砚的关系描述前后冲突',
            chapterId: null,
          },
        ],
      }),
    });

    expect(html).toContain('<p class="eyebrow">连续性检查</p>');
    expect(html).toContain('<h4>出场与矛盾警告</h4>');
    expect(html).toContain('<span class="badge badge-neutral">基于生效 v2</span>');
    expect(html).toContain('首次出场：第 1 章 · 夜行');
    expect(html).toContain('最近出场：第 2 章 · 王城');
    expect(html).toContain('<span>扫描范围：当前正典正文</span>');
    expect(html).toContain('<span class="muted">命中 3 次</span>');
    expect(html).toContain('<span class="muted">命中 1 次</span>');
    expect(html).toContain('<span>第 1 章 · 夜行</span>');
    expect(html).toContain('<span>第 2 章 · 王城</span>');
    expect(html).toContain('<span class="badge badge-amber">死亡后复活</span>');
    expect(html).toContain('第 2 章死亡后在第 3 章复活');
    expect(html).toContain('<span class="badge badge-amber">关系描述冲突</span>');
    expect(html).toContain('与沈砚的关系描述前后冲突');
    expect(html).toContain(
      '警告默认不阻断发布；请人工确认是回忆、转述、尸体提及还是时间线错误。AI 只能提示，不能代替人工确认。',
    );
    expect(html).toContain('当前存在草稿 v3，以上结果仍基于生效版本。');
    expect(html).not.toContain('未发现时间线或出场矛盾');
  });

  it('没有出场与警告时给出覆盖范围有限的结论', () => {
    const html = renderContinuity({
      timeline: timeline({
        appearances: [],
        firstAppearance: null,
        latestAppearance: null,
        warnings: [],
      }),
    });

    expect(html.split('未扫描到').length - 1).toBe(2);
    expect(html).toContain('当前正典正文中没有扫描到角色名称或别名。');
    expect(html).toContain(
      '未发现时间线或出场矛盾。该结论只覆盖当前正典正文与已登记状态，不代表绝对无误。',
    );
    expect(html).not.toContain('ledger-warning-list');
    expect(html).not.toContain('当前存在草稿');
  });

  it('未发布、已归档、读取中与失败各自给出说明', () => {
    const unpublished = renderContinuity({
      entry: characterDetail({
        status: 'draft',
        currentVersion: null,
        currentVersionNo: null,
      }),
    });
    expect(unpublished).toContain(
      '角色尚未发布。出场扫描与矛盾警告在发布后基于生效版本生成；当前只展示草稿里登记的角色卡与状态时间线。',
    );

    const archived = renderContinuity({
      entry: characterDetail({ status: 'archived' }),
    });
    expect(archived).toContain(
      '角色已归档，不再提供写作台上下文；历史版本与状态记录仍保留。',
    );

    const loading = renderContinuity({ loading: true });
    expect(loading).toContain('正在扫描当前正典并检查时间线……');

    const failed = renderContinuity({
      error: new ApiError(500, 'TIMELINE_FAILED', '扫描超时'),
    });
    expect(failed).toContain(
      '<div class="modal-error">连续性检查失败：扫描超时（TIMELINE_FAILED）</div>',
    );

    const idle = renderContinuity({ timeline: null });
    expect(idle).not.toContain('ledger-continuity');
  });
});
