import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  ChapterDetail,
  DraftView,
  GateEvaluationView,
  IndexStatusView,
  LeaseView,
  MeResponse,
  RulesetView,
  VersionSummary,
} from '@yunshuo/contracts';
import type { ChapterPlan } from '@yunshuo/domain';
import { ChapterStudio } from './ChapterStudio.js';

const RULESET: RulesetView = {
  id: 'ruleset-1',
  key: 'dev-v0',
  version: 3,
  description: '开发规则集：五道硬门禁',
  isProduction: false,
};

const GATE_FIXTURES = [
  ['word_count', '字数下限'],
  ['ai_tone', 'AI 腔'],
  ['core_entity', '核心实体'],
  ['chapter_hook', '章节钩子'],
  ['causality', '因果律'],
] as const;

function gateResults(
  status: GateEvaluationView['results'][number]['status'] = 'passed',
): GateEvaluationView['results'] {
  return GATE_FIXTURES.map(([key, label]) => ({
    key,
    label,
    status,
    message: `${label}检查${status === 'passed' ? '通过' : '未通过'}`,
    evidence: { gate: key },
  }));
}

function evaluation(overrides: Partial<GateEvaluationView> = {}): GateEvaluationView {
  return {
    id: 'eval-1',
    chapterId: 'chapter-1',
    contentHash: 'draft-hash-1',
    contextHash: 'ctx-1',
    ruleset: RULESET,
    status: 'passed',
    results: gateResults(),
    hints: [],
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: 'draft-1',
    branchId: 'branch-1',
    content: '雨夜的门',
    contentHash: 'draft-hash-1',
    wordCount: 480,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function lease(overrides: Partial<LeaseView> = {}): LeaseView {
  return {
    userId: 'user-1',
    userName: '林默',
    expiresAt: '2026-10-23T18:22:00.000Z',
    ...overrides,
  };
}

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: 'version-2',
    versionNo: 2,
    source: 'human',
    wordCount: 1200,
    contentHash: 'canon-hash-0001',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'eval-1',
    waiverId: null,
    contentPreview: '雨停在巷口。',
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

const PLAN: ChapterPlan = {
  requiredEntities: ['林默', '苏晚'],
  goalKeywords: ['保住封印'],
  obstacleKeywords: ['追兵逼近'],
};

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 1,
    title: '第一章 雨夜',
    status: 'planned',
    plan: {},
    wordCount: null,
    currentVersion: null,
    draft: null,
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions: [],
    waivers: [],
    indexStatus: null,
    ruleset: RULESET,
    canEdit: false,
    ...overrides,
  };
}

function me(role: MeResponse['role'] = 'author'): MeResponse {
  return {
    user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
    workspace: { id: 'ws-1', name: '云说工作区', settingsVersion: 1, ledgerVersion: 1 },
    role,
  };
}

function render(
  options: { chapterValue?: ChapterDetail; meValue?: MeResponse; canonContent?: string } = {},
): string {
  const chapterValue = options.chapterValue ?? chapter();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (options.canonContent !== undefined && chapterValue.currentVersion) {
    client.setQueryData(['version', chapterValue.currentVersion.id], {
      ...chapterValue.currentVersion,
      content: options.canonContent,
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChapterStudio
        me={options.meValue ?? me()}
        chapter={chapterValue}
        onOpenVersion={() => {}}
        onOpenChapter={() => {}}
      />
    </QueryClientProvider>,
  );
}

function textareaOf(html: string): string {
  return html.slice(html.indexOf('<textarea'), html.indexOf('</textarea>'));
}

describe('ChapterStudio', () => {
  it('计划章未取租约：四步流程、计划卡与写入口都停在租约前', () => {
    const html = render({
      chapterValue: chapter({ number: 1, title: '第一章 雨夜', plan: PLAN }),
    });

    expect(html).toContain('<p class="eyebrow">第 1 章 · 单章闭环</p>');
    expect(html).toContain('<h1>第一章 雨夜</h1>');
    expect(html).toContain('<span class="badge badge-neutral">计划中</span>');
    expect(html).toContain('<span>正典 尚无</span>');
    expect(html).not.toContain('门禁：');
    expect(html).toContain('核心人物 <strong>林默、苏晚</strong>');
    expect(html).toContain('目标 <strong>保住封印</strong> · 阻碍 <strong>追兵逼近</strong>');

    expect(html).toContain('<div class="lease-bar is-free">');
    expect(html).toContain('<strong>本章尚未分配编辑租约</strong>');
    expect(html).toContain('<span>同一时间只允许一名人类编辑；保存、暂存与提交都要求租约。</span>');
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">取得编辑租约 · 15 分钟</button>',
    );

    expect(html.match(/class="flow-step flow-/g)?.length).toBe(4);
    expect(html).toContain(
      '<li class="flow-step flow-current"><span class="flow-index">壹</span><span class="flow-copy"><strong>草稿落盘</strong><span>未开始</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-todo"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>待草稿</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-todo"><span class="flow-index">叁</span><span class="flow-copy"><strong>隔离暂存</strong><span>待门禁</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-todo"><span class="flow-index">肆</span><span class="flow-copy"><strong>写入正典</strong><span>待提交</span></span></li>',
    );

    expect(html).toContain('<p class="eyebrow">正文草稿</p>');
    expect(html).toContain('<strong>尚未落盘</strong>');
    expect(html).toContain('<span class="save-state is-saved">等待写作</span>');
    expect(textareaOf(html)).toContain('class="manuscript-editor"');
    expect(textareaOf(html)).toContain('readOnly=""');
    expect(textareaOf(html)).toContain('placeholder="取得编辑租约后即可写作。"');
    expect(html).toContain(
      '<span class="editor-count is-low">0 字 · 低于 dev-v0 演示下限 300</span>',
    );
    expect(html).toContain('<span class="muted">已保存草稿哈希 —</span>');

    expect(html).toContain(
      '<button type="button" class="button button-primary" disabled="" title="需要先取得编辑租约">保存草稿</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="请先保存草稿">跑五门禁</button>',
    );
    expect(html).not.toContain('>暂存草稿</button>');
    expect(html).not.toContain('>写入正典…</button>');
    expect(html).not.toContain('>放弃修订</button>');
    expect(html).toContain(
      '<p class="action-hint">先取得编辑租约，再写正文；所有写入动作都要求租约。</p>',
    );

    expect(html).toContain('<h3>续写与加厚</h3>');
    expect(html).toContain('<p class="ai-blocker">需要先取得编辑租约</p>');
    expect(html).not.toContain('class="studio-banner');

    expect(html).toContain('<p>尚无门禁结论。</p>');
    expect(html).toContain('<p>尚未运行审计。</p>');
    expect(html).toContain('正在读取已发布角色档案……');
    expect(html).toContain('正在读取已发布伏笔台账……');
    expect(html).toContain('正在读取本章关联……');
    expect(html).toContain('<h2>正典与账本检索</h2>');
    expect(html).toContain('正典提交后，索引任务会经 outbox 异步排队。');
    expect(html).toContain('<p>本章尚无正典版本。</p>');
    expect(html).not.toContain('<h2>豁免与审批</h2>');
  });

  it('作者持租约且门禁绑定当前草稿：暂存可点，演示填充只出现在第 2 章', () => {
    const html = render({
      chapterValue: chapter({
        number: 2,
        title: '第二章 追兵',
        status: 'writing',
        plan: { requiredEntities: [] },
        draft: draft(),
        lease: lease(),
        latestEvaluation: evaluation(),
      }),
    });

    expect(html).toContain('<span class="badge badge-ink">写作中</span>');
    expect(html).toContain('核心人物 <strong>未设置</strong>');
    expect(html).toContain('<div class="lease-bar is-mine">');
    expect(html).toContain('<strong>你持有本章编辑租约</strong>');
    expect(html).toContain('<span>有效至 18:22；保存、暂存与提交都要求持租约。</span>');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small">续租 15 分钟</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" title="释放后其他编辑可以接手">释放租约</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small demo-fill">填入演示草稿（非 AI 生成）</button>',
    );

    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">壹</span><span class="flow-copy"><strong>草稿落盘</strong><span>480 字</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>已通过</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-current"><span class="flow-index">叁</span><span class="flow-copy"><strong>隔离暂存</strong><span>可暂存</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-todo"><span class="flow-index">肆</span><span class="flow-copy"><strong>写入正典</strong><span>待提交</span></span></li>',
    );

    expect(html).toContain('<strong>已保存 480 字</strong>');
    expect(html).toContain('<span class="muted">已保存草稿哈希 draft-hash</span>');
    expect(html).not.toContain('readOnly=""');
    // SSR 不执行 useEffect，编辑区状态仍是空串，保存门的“没有修改”分支无法在这里出现；
    // 这里只钉住“禁用”，文案留给带 DOM 的测试。
    expect(html).toContain('<button type="button" class="button button-primary" disabled=""');
    expect(html).toContain(
      '<button type="button" class="button button-secondary" title="对已保存草稿运行五道硬门禁">跑五门禁</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-secondary" title="把已通过门禁的草稿放入隔离暂存区">暂存草稿</button>',
    );
    expect(html).not.toContain('>撤回暂存</button>');
    expect(html).not.toContain('>写入正典…</button>');
    expect(html).not.toContain('>放弃修订</button>');
    expect(html).toContain(
      '<p class="action-hint">门禁已通过并绑定当前正文哈希，可以暂存。</p>',
    );

    expect(html).toContain('<span class="ruleset-tag">dev-v0 v3</span>');
    expect(html).toContain('<span class="badge badge-amber">开发规则集 · 非生产</span>');
    expect(html).toContain('<span class="badge badge-green">全部通过</span>');
    expect(html).toContain('<p class="gate-message">字数下限检查通过</p>');

    expect(html).not.toContain('class="ai-blocker"');
    expect(html).not.toContain('studio-banner');
    expect(html).not.toContain('inline-warning');
  });

  it('暂存章：只读横幅、撤回暂存与写入正典，释放租约被锁', () => {
    const html = render({
      chapterValue: chapter({
        status: 'staged',
        draft: draft(),
        lease: lease(),
        latestEvaluation: evaluation(),
        stagedDraft: {
          id: 'staged-1',
          chapterId: 'chapter-1',
          contentHash: 'draft-hash-1',
          wordCount: 480,
          evaluationId: 'eval-1',
          stagedBy: 'user-1',
          stagedByName: '林默',
          stagedAt: '2026-10-23T18:10:00.000Z',
        },
        indexStatus: {
          status: 'pending',
          detail: '等待索引任务',
          versionId: 'version-2',
          versionNo: 2,
          chunkCount: 0,
          providerName: null,
          model: null,
          dimensions: null,
          attempts: 0,
          nextRetryAt: null,
          lastError: null,
          updatedAt: '2026-10-23T18:11:00.000Z',
        } satisfies IndexStatusView,
      }),
    });

    expect(html).toContain('<span class="badge badge-amber">已暂存</span>');
    expect(html).toContain('<div class="studio-banner staged-banner"><strong>暂存稿与正典隔离</strong>');
    expect(html).toContain(
      '<p>暂存正文已绑定门禁证据。提交前请核对目标章节；提交事务失败不会改变当前正典。</p>',
    );
    expect(html).toContain('<p class="eyebrow">暂存正文 · 只读</p>');
    expect(html).toContain('<strong>已保存 480 字</strong>');
    expect(html).toContain('<span class="save-state is-saved">已暂存锁定</span>');
    expect(html).toContain('<div class="manuscript-readonly in-editor">');

    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">叁</span><span class="flow-copy"><strong>隔离暂存</strong><span>已暂存</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-current"><span class="flow-index">肆</span><span class="flow-copy"><strong>写入正典</strong><span>待提交</span></span></li>',
    );

    expect(html).not.toContain('>保存草稿</button>');
    expect(html).toContain(
      '<button type="button" class="button button-secondary" title="对已保存草稿运行五道硬门禁">跑五门禁</button>',
    );
    expect(html).not.toContain('>暂存草稿</button>');
    expect(html).toContain(
      '<button type="button" class="button button-quiet" title="撤回暂存，回到写作中">撤回暂存</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" title="确认目标章节后写入正典">写入正典…</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" disabled="" title="提交前不能释放租约">释放租约</button>',
    );
    expect(html).toContain(
      '<p class="action-hint">暂存稿已绑定门禁证据。确认目标章节后写入正典。</p>',
    );
    expect(html).not.toContain('AI 提案 · 不自动落盘');

    expect(html).toContain('<span class="badge badge-amber">等待索引 worker</span>');
    expect(html).toContain('<p class="index-detail">等待索引任务</p>');
    expect(html).toContain('<dd>v2</dd>');
    expect(html).toContain('<dd>0 次</dd>');
  });

  it('提交失败章：横幅说明正典未动，按钮改为重试提交', () => {
    const html = render({
      chapterValue: chapter({
        status: 'commit_failed',
        draft: draft(),
        lease: lease(),
        latestEvaluation: evaluation(),
        stagedDraft: {
          id: 'staged-1',
          chapterId: 'chapter-1',
          contentHash: 'draft-hash-1',
          wordCount: 480,
          evaluationId: 'eval-1',
          stagedBy: 'user-1',
          stagedByName: '林默',
          stagedAt: '2026-10-23T18:10:00.000Z',
        },
      }),
    });

    expect(html).toContain('<span class="badge badge-red">提交待修复</span>');
    expect(html).toContain('<div class="studio-banner failed-banner"><strong>上次提交失败</strong>');
    expect(html).toContain('<p>正典未被改动。请核对暂存稿与门禁证据后重试提交。</p>');
    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">叁</span><span class="flow-copy"><strong>隔离暂存</strong><span>暂存待重试</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-current"><span class="flow-index">肆</span><span class="flow-copy"><strong>写入正典</strong><span>待提交</span></span></li>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" title="确认目标章节后写入正典">重试提交至正典</button>',
    );
    expect(html).not.toContain('>撤回暂存</button>');
    expect(html).not.toContain('>暂存草稿</button>');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" disabled="" title="提交前不能释放租约">释放租约</button>',
    );
    expect(html).toContain(
      '<p class="action-hint">正典未改变。核对暂存稿与证据后重试提交。</p>',
    );
  });

  it('正典章：正文来自版本详情查询，修订与回滚入口按角色出现', () => {
    const current = version();
    const older = version({
      id: 'version-1',
      versionNo: 1,
      source: 'import',
      wordCount: 1100,
      contentHash: 'canon-hash-0000',
      actorName: null,
      gateStatus: 'waived',
      evaluationId: null,
      createdAt: '2026-10-20T09:00:00.000Z',
    });

    const html = render({
      chapterValue: chapter({
        status: 'canon',
        title: '第三章 封门',
        wordCount: 1200,
        currentVersion: current,
        versions: [current, older],
      }),
      meValue: me('lead'),
      canonContent: '第一段正典\n\n第二段正典',
    });

    expect(html).toContain('<span class="badge badge-green">正典</span>');
    expect(html).toContain('<span>正典 1200 字 · v2</span>');
    expect(html).toContain('<span>门禁：通过</span>');
    expect(html).toContain('<div class="lease-bar is-closed">');
    expect(html).toContain('<strong>正典只读</strong>');
    expect(html).toContain(
      '<span>正典只读；开始修订会自动取得租约，回滚入口在版本历史。</span>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small">查看当前正典</button>',
    );

    expect(html).toContain('<div class="studio-banner canon-banner"><strong>本章已进入正典</strong>');
    expect(html).toContain(
      '<p>编辑区展示当前正典正文（只读）。可开始修订生成新版本，或从右侧版本历史回滚到旧版本； 回滚豁免必须由申请人之外的所有者或主笔批准。</p>',
    );

    expect(html).toContain('<p class="eyebrow">正典正文 · 只读</p>');
    expect(html).toContain('<strong>v2</strong>');
    expect(html).toContain('<span class="save-state is-saved">只读</span>');
    expect(html).toContain('class="manuscript-readonly in-editor"><p>第一段正典</p><p>第二段正典</p></div>');
    expect(html).toContain('<span class="editor-count ">1200 字</span>');
    expect(html).toContain('<span class="muted">正典哈希 canon-hash</span>');

    expect(html).toContain(
      '<button type="button" class="button button-secondary">查看当前正典与证据</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" title="从当前正典复制草稿并取得编辑租约">开始修订</button>',
    );
    expect(html).toContain(
      '<span class="action-note">开始修订会自动取得 15 分钟租约；回滚入口在右侧版本历史。</span>',
    );
    expect(html).not.toContain('>保存草稿</button>');
    expect(html).not.toContain('>跑五门禁</button>');
    expect(html).not.toContain('>暂存草稿</button>');

    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">壹</span><span class="flow-copy"><strong>草稿落盘</strong><span>来自正典</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>通过</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">叁</span><span class="flow-copy"><strong>隔离暂存</strong><span>已入库</span></span></li>',
    );
    expect(html).toContain(
      '<li class="flow-step flow-done"><span class="flow-index">肆</span><span class="flow-copy"><strong>写入正典</strong><span>已入库 v2</span></span></li>',
    );
    expect(html).toContain(
      '<p class="action-hint">正典已锁定。可开始修订，或在版本历史中回滚到旧版本。</p>',
    );

    expect(html).toContain('<span class="muted">2 个版本</span>');
    expect(html).toContain('<span class="badge badge-ink">当前正典</span>');
    expect(html).toContain(
      '<button type="button" class="version-rollback">回滚到此版本…</button>',
    );
    expect(html.match(/version-rollback/g)?.length).toBe(1);
    expect(html).toContain('<h2>豁免与审批</h2>');
    expect(html).toContain('<p class="empty-state waiver-empty">本章还没有豁免记录。</p>');
    expect(html).not.toContain('AI 提案 · 不自动落盘');
    expect(html).toContain('<span class="badge badge-muted">尚未入正典</span>');
  });

  it('正典正文还没读到：只读区只说读取中，不拿空串冒充正文', () => {
    const current = version();
    const html = render({
      chapterValue: chapter({
        status: 'canon',
        wordCount: 1200,
        currentVersion: current,
        versions: [current],
      }),
    });

    expect(html).toContain('<p class="empty-state">正在读取正典正文……</p>');
    expect(html).not.toContain('当前视图没有可展示的正文草稿。');
    expect(html).toContain('<span class="editor-count ">1200 字</span>');
    expect(html).toContain('<span class="muted">正典哈希 canon-hash</span>');
  });

  it('他人持租约与只读角色：两条路径都不会递出“取得租约”按钮', () => {
    const other = render({
      chapterValue: chapter({
        status: 'writing',
        draft: draft(),
        lease: lease({ userId: 'user-2', userName: '苏晚' }),
      }),
    });
    expect(other).toContain('<div class="lease-bar is-other">');
    expect(other).toContain('<strong>苏晚 正在编辑本章</strong>');
    expect(other).toContain('<span>有效至 18:22；等待释放或到期后才能接手。</span>');
    expect(other).toContain(
      '<button type="button" class="button button-quiet button-small">刷新租约状态</button>',
    );
    expect(other).not.toContain('取得编辑租约 · 15 分钟');
    expect(other).not.toContain('>续租 15 分钟</button>');
    expect(other).not.toContain('>释放租约</button>');
    expect(textareaOf(other)).toContain('readOnly=""');
    expect(textareaOf(other)).toContain('placeholder="取得编辑租约后即可写作。"');
    expect(other).toContain(
      '<button type="button" class="button button-primary" disabled="" title="需要先取得编辑租约">保存草稿</button>',
    );

    const viewer = render({
      chapterValue: chapter({ number: 2, status: 'writing', draft: draft() }),
      meValue: me('viewer'),
    });
    expect(viewer).toContain('<span class="muted">当前角色只读</span>');
    expect(viewer).not.toContain('取得编辑租约 · 15 分钟');
    expect(viewer).toContain(
      '<button type="button" class="button button-primary" disabled="" title="当前角色不能写入">保存草稿</button>',
    );
    expect(viewer).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="当前角色不能运行门禁">跑五门禁</button>',
    );
    expect(viewer).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="当前角色不能暂存">暂存草稿</button>',
    );
    expect(viewer).not.toContain('demo-fill');
    expect(viewer).not.toContain('AI 提案 · 不自动落盘');
  });

  it('暂存门禁分叉：缺门禁、未通过、结论过期各有自己的文案与流程态', () => {
    const missing = render({
      chapterValue: chapter({ status: 'writing', draft: draft(), lease: lease() }),
    });
    expect(missing).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="请先运行五门禁">暂存草稿</button>',
    );
    expect(missing).toContain(
      '<li class="flow-step flow-current"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>待运行</span></span></li>',
    );
    expect(missing).toContain(
      '<p class="action-hint">流程：保存草稿 → 跑五门禁 → 暂存 → 写入正典。</p>',
    );
    expect(missing).toContain('<p>尚无门禁结论。</p>');

    const empty = render({
      chapterValue: chapter({ status: 'writing', lease: lease() }),
    });
    expect(empty).toContain(
      '<button type="button" class="button button-primary" disabled="" title="空草稿不落盘">保存草稿</button>',
    );

    const failed = render({
      chapterValue: chapter({
        status: 'writing',
        draft: draft(),
        lease: lease(),
        latestEvaluation: evaluation({ status: 'failed', results: gateResults('failed') }),
      }),
    });
    expect(failed).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="五门禁未全部通过，不能暂存">暂存草稿</button>',
    );
    expect(failed).toContain(
      '<li class="flow-step flow-attention"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>未全部通过</span></span></li>',
    );
    expect(failed).toContain(
      '<p class="action-hint">门禁结论绑定当前正文，但未全部通过；修正后重跑门禁。</p>',
    );
    expect(failed).toContain('<span class="badge badge-red">存在未通过</span>');

    const stale = render({
      chapterValue: chapter({
        status: 'writing',
        draft: draft(),
        lease: lease(),
        latestEvaluation: evaluation({ contentHash: 'old-hash-9999' }),
      }),
    });
    expect(stale).toContain(
      '<button type="button" class="button button-secondary" disabled="" title="门禁结论已过期，请重跑">暂存草稿</button>',
    );
    expect(stale).toContain(
      '<li class="flow-step flow-attention"><span class="flow-index">贰</span><span class="flow-copy"><strong>五门禁</strong><span>结论已过期</span></span></li>',
    );
    expect(stale).toContain(
      '<div class="inline-warning">这份结论对应的是另一版正文，已过期；请保存当前草稿后重跑门禁。</div>',
    );
    expect(stale).toContain(
      '<p class="action-hint">流程：保存草稿 → 跑五门禁 → 暂存 → 写入正典。</p>',
    );
  });
});
