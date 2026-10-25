import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  AutomationJobView,
  AutomationMandateView,
  AutomationPreflightView,
  ChapterListItem,
  MeResponse,
} from '@yunshuo/contracts';
import { ApiError } from '../api.js';
import {
  AutomationDialog,
  PreflightPanel,
  defaultForm,
  money,
  positiveInt,
  suggestedRange,
  uniqueWorks,
} from './AutomationDialog.js';

const ME: MeResponse = {
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role: 'owner',
};

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'ch-1',
    workId: 'work-1',
    workTitle: '规则档案馆',
    number: 1,
    title: '旧城雨夜',
    status: 'planned',
    volumeTitle: '第一卷',
    wordCount: null,
    currentVersionNo: null,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function mandate(overrides: Partial<AutomationMandateView> = {}): AutomationMandateView {
  return {
    id: 'mandate-1',
    workId: 'work-1',
    workTitle: '规则档案馆',
    name: '第三卷续写',
    mode: 'continue',
    chapterMin: 3,
    chapterMax: 5,
    maxChapters: 2,
    targetWords: 800,
    instruction: '',
    allowAutoCommit: true,
    allowRemoteModels: false,
    allowNonProductionGates: false,
    budgetLimit: null,
    budgetCurrency: 'CNY',
    status: 'active',
    expiresAt: '2026-10-24T00:00:00.000Z',
    createdBy: 'user-1',
    createdByName: '林默',
    revokedAt: null,
    revokedByName: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    ...overrides,
  };
}

function preflight(overrides: Partial<AutomationPreflightView> = {}): AutomationPreflightView {
  return {
    ok: true,
    checks: [
      { key: 'range', label: '章节范围', status: 'pass', detail: '范围内有 2 章可续写。' },
      { key: 'budget', label: '预算', status: 'warn', detail: '预算较紧，注意剩余额度。' },
      { key: 'gates', label: '门禁规则集', status: 'fail', detail: '未接受非生产规则集。' },
    ],
    chapters: [],
    providerNames: ['本机 llama.cpp', '远程 A'],
    unknownCost: false,
    budgetRemaining: 12.5,
    budgetCurrency: 'CNY',
    generatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function job(overrides: Partial<AutomationJobView> = {}): AutomationJobView {
  return {
    id: 'job-1',
    workspaceId: 'ws-1',
    workId: 'work-1',
    workTitle: '规则档案馆',
    mandateId: 'mandate-1',
    mandateName: '第三卷续写',
    status: 'running',
    preflight: preflight(),
    totalChapters: 2,
    committedChapters: 1,
    stagedChapters: 0,
    failedChapters: 0,
    skippedChapters: 0,
    spent: 0.12,
    costCurrency: 'CNY',
    costUnknown: false,
    runnerId: 'runner-a',
    heartbeatAt: '2026-10-23T18:07:00.000Z',
    currentChapterId: null,
    pauseRequested: false,
    stopRequested: false,
    lastError: null,
    createdBy: 'user-1',
    createdByName: '林默',
    startedAt: '2026-10-23T18:00:00.000Z',
    completedAt: null,
    createdAt: '2026-10-23T17:59:00.000Z',
    updatedAt: '2026-10-23T18:07:00.000Z',
    chapters: [],
    ...overrides,
  };
}

function render(
  options: {
    jobs?: AutomationJobView[];
    mandates?: AutomationMandateView[];
    chapters?: ChapterListItem[];
    jobError?: string;
    loaded?: boolean;
  } = {},
): string {
  const { jobs = [], mandates = [], chapters = [], jobError, loaded = true } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  if (loaded) {
    client.setQueryData(['automationJobs'], { jobs });
    client.setQueryData(['automationMandates'], { mandates });
  }
  if (jobError) {
    // 有缓存时查询才不会被判 stale；否则挂载重取会把错误态冲回读取态。
    client.setQueryData(['automationJobs'], { jobs: [] });
    client.setQueryData(['automationMandates'], { mandates: [] });
    client
      .getQueryCache()
      .find({ queryKey: ['automationJobs'] })
      ?.setState({
        status: 'error',
        fetchStatus: 'idle',
        error: new ApiError(500, 'INTERNAL', jobError),
      });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AutomationDialog me={ME} chapters={chapters} onClose={() => {}} onOpenChapter={() => {}} />
    </QueryClientProvider>,
  );
}

describe('自动化作业弹窗的纯规则', () => {
  it('按作品分组章节并保持首次出现顺序', () => {
    const works = uniqueWorks([
      chapter({ id: 'a', workId: 'w-2', workTitle: '夜航', number: 1 }),
      chapter({ id: 'b', workId: 'w-1', number: 1 }),
      chapter({ id: 'c', workId: 'w-2', number: 2 }),
    ]);

    expect(works.map((work) => work.id)).toEqual(['w-2', 'w-1']);
    expect(works[0]?.title).toBe('夜航');
    expect(works[0]?.chapters.map((item) => item.id)).toEqual(['a', 'c']);
    expect(uniqueWorks([])).toEqual([]);
  });

  it('建议范围从最大章号加一开始，空作品从第 1 章起', () => {
    expect(suggestedRange([], 'w-1')).toEqual({ min: 1, max: 10 });
    expect(
      suggestedRange(
        [
          chapter({ id: 'a', workId: 'w-1', number: 3 }),
          chapter({ id: 'b', workId: 'w-1', number: 7 }),
          chapter({ id: 'c', workId: 'w-2', number: 99 }),
        ],
        'w-1',
      ),
    ).toEqual({ min: 8, max: 17 });
  });

  it('默认表单取首个作品的建议范围与固定策略', () => {
    const form = defaultForm(
      [
        chapter({ id: 'a', workId: 'w-1', number: 4 }),
        chapter({ id: 'b', workId: 'w-2', number: 1 }),
      ],
      'w-2',
    );

    expect(form).toEqual({
      workId: 'w-2',
      name: '',
      chapterMin: '2',
      chapterMax: '11',
      maxChapters: '5',
      targetWords: '800',
      instruction: '',
      allowAutoCommit: true,
      allowRemoteModels: false,
      allowNonProductionGates: false,
      budgetEnabled: false,
      budgetLimit: '',
      budgetCurrency: 'CNY',
      expiresInHours: '24',
    });
  });

  it('正整数解析只收十进制数字且要求安全整数', () => {
    expect(positiveInt('5')).toBe(5);
    expect(positiveInt(' 12 ')).toBe(12);
    expect(positiveInt('0007')).toBe(7);
    expect(positiveInt('0')).toBe(0);
    for (const bad of ['', '   ', '-1', '1.5', '1e3', 'abc', '１２', '9007199254740992']) {
      expect(positiveInt(bad)).toBeNull();
    }
  });

  it('金额按币种前缀并固定四位小数', () => {
    expect(money(1.5, 'CNY')).toBe('¥1.5000');
    expect(money(0.02, 'USD')).toBe('$0.0200');
    expect(money(0, 'CNY')).toBe('¥0.0000');
  });
});

describe('PreflightPanel', () => {
  it('通过态写明预检结果、只读边界与三类检查', () => {
    const html = renderToStaticMarkup(<PreflightPanel view={preflight()} />);

    expect(html.startsWith('<div class="automation-preflight">')).toBe(true);
    expect(html).toContain('<span class="badge badge-green">预检通过，可以启动</span>');
    expect(html).toContain('生成于 10/23 18:07 · 预检只读数据库，不发起模型调用');
    expect(html).toContain('<li class="automation-check automation-check-pass">');
    expect(html).toContain('<li class="automation-check automation-check-warn">');
    expect(html).toContain('<li class="automation-check automation-check-fail">');
    expect(html).toContain('<span class="badge badge-green">通过</span>');
    expect(html).toContain('<span class="badge badge-amber">提醒</span>');
    expect(html).toContain('<span class="badge badge-red">阻止</span>');
    expect(html).toContain('<strong>章节范围</strong>');
    expect(html).toContain('<p>范围内有 2 章可续写。</p>');
    expect(html).toContain('服务商：本机 llama.cpp、远程 A · 预算剩余 ¥12.5000');
    expect(html).not.toContain('存在未定价服务商');
  });

  it('未通过态、无服务商、无预算与未定价都如实写出', () => {
    const html = renderToStaticMarkup(
      <PreflightPanel
        view={preflight({
          ok: false,
          providerNames: [],
          budgetRemaining: null,
          unknownCost: true,
        })}
      />,
    );

    expect(html).toContain('<span class="badge badge-red">预检未通过，不能启动</span>');
    expect(html).toContain('服务商：无可用服务商 · 未设置预算 · 存在未定价服务商');
  });
});

describe('AutomationDialog', () => {
  it('弹窗外壳、两个页签与头尾两个关闭', () => {
    const html = render();

    expect(html.startsWith('<div class="modal-backdrop">')).toBe(true);
    expect(html).toContain('class="modal modal-automation"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="automation-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<p class="eyebrow">M4-B · 显式授权下的无人值守续写</p>');
    expect(html).toContain('<h2 id="automation-title">自动作业</h2>');
    expect(html).toContain('<div class="automation-tabs" role="tablist">');
    expect(html).toContain(
      '<button type="button" role="tab" aria-selected="true" class="automation-tab is-active">作业</button>',
    );
    expect(html).toContain(
      '<button type="button" role="tab" aria-selected="false" class="automation-tab">授权与预检</button>',
    );
    expect(html).toContain('<div class="modal-body automation-body">');
    expect(html).toContain('<footer class="modal-foot">');
    expect(html.match(/>关闭</g)?.length).toBe(2);
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<button type="button" class="button button-quiet">关闭</button>');
  });

  it('页脚写明当前身份与三条硬边界', () => {
    const html = render();

    expect(html).toContain(
      '当前身份：林默 · AI 无豁免权 · 门禁失败不入库 · 预算=调用级 max_tokens + 章节检查点',
    );
  });

  it('作业列表读取时侧栏只显示读取态', () => {
    const html = render({ loaded: false });

    expect(html).toContain('<p class="empty-state">正在读取作业……</p>');
    expect(html).not.toContain('automation-job-list');
    expect(html).not.toContain('automation-side-empty');
  });

  it('作业读取失败时侧栏给出原文，启动器仍提示没有有效授权', () => {
    const html = render({ jobError: '作业列表读取失败' });

    expect(html).toContain(
      '<p class="automation-side-empty">读取失败：作业列表读取失败</p>',
    );
    expect(html).toContain('<p>没有有效授权，不能启动作业。</p>');
  });

  it('没有作业也没有授权：侧栏空态与「去创建授权」都在，且没有返回作业', () => {
    const html = render();

    expect(html).toContain('<p class="eyebrow">最近作业</p>');
    expect(html).toContain('<p class="muted">共 0 个</p>');
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">新建作业</button>',
    );
    expect(html).toContain(
      '<p class="automation-side-empty">还没有作业。创建授权后，选择章节并预检即可启动。</p>',
    );
    expect(html).toContain('<p>没有有效授权，不能启动作业。</p>');
    expect(html).toContain('授权必须由所有者或主笔显式创建，并限定章节范围、章数与有效期。');
    expect(html).toContain(
      '<button type="button" class="button button-primary button-small">去创建授权</button>',
    );
    expect(html).not.toContain('返回作业');
  });

  it('有有效授权时启动器列出选项、摘要、章节可选性与两道预检门', () => {
    const html = render({
      mandates: [mandate()],
      chapters: [
        chapter({ id: 'ch-1', number: 1, status: 'planned' }),
        chapter({ id: 'ch-2', number: 3, title: '封印之前', status: 'writing' }),
        chapter({ id: 'ch-3', number: 4, status: 'canon' }),
        chapter({ id: 'ch-4', number: 5, status: 'planned' }),
        chapter({ id: 'ch-9', workId: 'work-2', workTitle: '夜航', number: 9 }),
      ],
    });

    expect(html).toContain('<p class="eyebrow">新建无人值守作业</p>');
    expect(html).toContain('<h3>选择授权与章节</h3>');
    expect(html).toContain(
      '<option value="mandate-1" selected="">第三卷续写 · 规则档案馆 · 第 3–5 章</option>',
    );
    expect(html).toContain('作品：<strong>规则档案馆</strong>');
    expect(html).toContain('范围：第 3–5 章');
    expect(html).toContain('最多 2 章 · 每章约 800 字');
    expect(html).toContain('截止 10/24 00:00');
    expect(html).toContain('<span class="badge badge-green">通过即自动入库</span>');
    expect(html).toContain('<span class="badge badge-neutral">仅本机模型</span>');
    expect(html).toContain('<span class="badge badge-neutral">未确认非生产门禁</span>');
    expect(html).toContain('章节 · 已选 0 / 最多 2');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small">全选可续写章节</button>',
    );
    expect(html).toContain(
      '<label class="automation-chapter-option is-disabled"><input type="checkbox" disabled=""/><span class="chapter-no">第 1 章</span><span class="automation-chapter-title">旧城雨夜</span><span class="muted">超出授权范围</span></label>',
    );
    expect(html).toContain(
      '<label class="automation-chapter-option"><input type="checkbox"/><span class="chapter-no">第 3 章</span><span class="automation-chapter-title">封印之前</span><span class="muted">写作中</span></label>',
    );
    expect(html).toContain(
      '<label class="automation-chapter-option is-disabled"><input type="checkbox" disabled=""/><span class="chapter-no">第 4 章</span><span class="automation-chapter-title">旧城雨夜</span><span class="muted">已入正典</span></label>',
    );
    expect(html).toContain(
      '<label class="automation-chapter-option"><input type="checkbox"/><span class="chapter-no">第 5 章</span><span class="automation-chapter-title">旧城雨夜</span><span class="muted">规划中</span></label>',
    );
    expect(html).not.toContain('第 9 章');
    expect(html).toContain(
      '<button type="button" class="button button-secondary" disabled="">运行预检（不调用模型）</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-primary" disabled="">启动无人值守作业</button>',
    );
    expect(html).toContain('启动前必须先运行预检；预检只读取数据库与授权，不发起任何模型调用。');
    expect(html).toContain(
      '只有规划中/写作中且在授权范围内的章节可选；同一工作区一次只运行一个作业。',
    );
    expect(html).toContain('<strong>执行边界</strong>');
    expect(html).toContain('<strong>预算与备份</strong>');
    expect(html).toContain('<strong>门禁</strong>');
    expect(html).toContain('自动备份尚未接入，启动前请运行 scripts/backup-db.sh 并验证恢复。');
  });

  it('放行远程模型与非生产门禁时摘要改用警示徽标', () => {
    const html = render({
      mandates: [mandate({ allowRemoteModels: true, allowNonProductionGates: true })],
      chapters: [chapter()],
    });

    expect(html).toContain('<span class="badge badge-amber">允许远程模型</span>');
    expect(html).toContain('<span class="badge badge-amber">已接受非生产门禁</span>');
  });

  it('授权范围内没有可续写章节时全选禁用并给出空态说明', () => {
    const html = render({
      mandates: [mandate({ chapterMin: 6, chapterMax: 8 })],
      chapters: [chapter({ id: 'ch-1', number: 1, status: 'planned' })],
    });

    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" disabled="">全选可续写章节</button>',
    );
    expect(html).toContain('当前授权范围内没有可续写章节。已入正典的章节不会被重复生成。');
    expect(html).toContain('超出授权范围');
  });

  it('授权指向的作品没有章节时给出专门空态', () => {
    const html = render({
      mandates: [mandate({ workId: 'work-9', workTitle: '空作品' })],
      chapters: [chapter()],
    });

    expect(html).toContain('<p class="automation-side-empty">该作品还没有章节。</p>');
    expect(html).not.toContain('automation-chapter-picker');
  });

  it('有作业时侧栏列出作业事实、当前项高亮并渲染作业详情', () => {
    const html = render({
      jobs: [job()],
      mandates: [mandate()],
      chapters: [chapter()],
    });

    expect(html).toContain('<p class="muted">共 1 个</p>');
    expect(html).toContain('class="automation-job-item is-active"');
    expect(html).toContain('<strong>第三卷续写</strong>');
    expect(html).toContain('<span class="badge badge-ink">运行中</span>');
    expect(html).toContain('规则档案馆 · 作业 2 章');
    expect(html).toContain('入库 1 · 暂存 0 · 失败 0');
    expect(html).toContain('<span class="automation-job-time">10/23 18:07</span>');
    expect(html).toContain('<article class="automation-detail">');
    expect(html).toContain('<h3>2 章无人值守作业</h3>');
    expect(html).not.toContain('新建无人值守作业');
    expect(html).not.toContain('没有有效授权');
  });

  it('费用未知的作业在时间后面标注', () => {
    const html = render({ jobs: [job({ costUnknown: true })], mandates: [mandate()] });

    expect(html).toContain(
      '<span class="automation-job-time">10/23 18:07 · 费用未知</span>',
    );
  });
});
