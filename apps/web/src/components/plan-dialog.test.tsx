import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ChapterDetail, MeResponse, VersionSummary } from '@yunshuo/contracts';
import type { ChapterPlanDocument } from '@yunshuo/domain';
import { PlanConflictPanel, PlanDialog, PlanHistoryList } from './PlanDialog.js';
import {
  parseKeywordInput,
  planChangedAfterEvidence,
  planDiffLines,
  planFromFields,
  planSummaryHeadline,
} from '../plan.js';

const PLAN: ChapterPlanDocument = {
  summary: '林默赶到旧宅\n发现封印已经被换过',
  beats: ['林默赶到旧宅', '追兵封住巷口', '他用血补完封印'],
  requiredEntities: ['林默', '老周'],
  goalKeywords: ['封印'],
  obstacleKeywords: ['追兵'],
};

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

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 1,
    title: '第一章 雨夜',
    status: 'planned',
    plan: PLAN,
    planRevision: 2,
    planUpdatedAt: '2026-10-23T18:07:00.000Z',
    bodyNeedsRevision: false,
    markedPlanRevision: null,
    markedCanonVersionId: null,
    wordCount: null,
    currentVersion: null,
    draft: null,
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions: [],
    waivers: [],
    indexStatus: null,
    ruleset: null,
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

function renderDialog(options: {
  chapterValue?: ChapterDetail;
  role?: MeResponse['role'];
  initialTab?: 'plan' | 'history';
} = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlanDialog
        me={me(options.role ?? 'author')}
        chapter={options.chapterValue ?? chapter()}
        initialTab={options.initialTab ?? 'plan'}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('PlanDialog', () => {
  it('默认展示当前计划与 r 版本，字段按顿号反填', () => {
    const html = renderDialog();

    expect(html).toContain('计划 r2 · 改计划不写正文');
    expect(html).toContain('<h2 id="plan-dialog-title">编辑本章计划</h2>');
    expect(html).toContain('林默赶到旧宅\n发现封印已经被换过');
    expect(html).toContain('林默赶到旧宅\n追兵封住巷口\n他用血补完封印');
    expect(html).toContain('林默、老周');
    expect(html).toContain('保存计划不需要编辑租约，也不会改正文、草稿或版本');
    expect(html).toContain('<button type="button" class="button button-primary">保存计划</button>');
  });

  it('已有正典时必须选正文策略，未选前保存被禁用', () => {
    const html = renderDialog({
      chapterValue: chapter({ status: 'canon', currentVersion: version(), wordCount: 1200 }),
    });

    expect(html).toContain('本章已有正典 v2，请选择改计划后的正文策略（必选）');
    expect(html).toContain('value="plan_only"');
    expect(html).toContain('仅修改计划：正文、草稿与正典都不动');
    expect(html).toContain('value="mark_body_for_revision"');
    expect(html).toContain('标记正文待改：正典不动，写作台会出现“待改稿”横幅');
    expect(html).toContain('<button type="button" class="button button-primary" disabled="">保存计划</button>');

    const noCanon = renderDialog();
    expect(noCanon).toContain('本章还没有正典正文，保存计划不需要选择正文策略。');
    expect(noCanon).not.toContain('plan-policy');
  });

  it('只读角色不能保存，归档章节给出单独说明', () => {
    const viewer = renderDialog({ role: 'viewer' });
    expect(viewer).not.toContain('>保存计划</button>');
    expect(viewer).toContain('<span class="muted">当前角色只读</span>');
    expect(viewer).toContain('<textarea rows="4" maxLength="2000" disabled=""');
    expect(viewer.split('<input disabled=""').length - 1).toBe(3);

    const archived = renderDialog({ chapterValue: chapter({ status: 'archived' }) });
    expect(archived).not.toContain('>保存计划</button>');
    expect(archived).toContain('已归档章节不能编辑计划');
  });

  it('历史页签独立：打开即请求历史，并说明只比较相邻版本', () => {
    const html = renderDialog({ initialTab: 'history' });

    expect(html).toContain('aria-selected="true" class="plan-tab is-active">历史</button>');
    expect(html).toContain('aria-selected="false" class="plan-tab">计划</button>');
    expect(html).toContain('按版本倒序列出每次保存；差异只对比相邻版本，不展示正文。');
    expect(html).toContain('正在读取计划历史……');
  });
});

describe('PlanConflictPanel', () => {
  it('并列展示服务端版本与我的输入，两个动作都在', () => {
    const mine: ChapterPlanDocument = {
      ...PLAN,
      goalKeywords: ['封印', '旧宅'],
      obstacleKeywords: [],
    };
    const html = renderToStaticMarkup(
      <PlanConflictPanel
        serverRevision={3}
        serverPlan={PLAN}
        minePlan={mine}
        onLoadLatest={() => {}}
        onKeepMine={() => {}}
      />,
    );

    expect(html).toContain('<h3>服务端已经是 r3</h3>');
    expect(html).toContain('<strong>服务端计划 r3</strong>');
    expect(html).toContain('<strong>我的输入</strong>');
    expect(html).toContain('目标关键词：封印');
    expect(html).toContain('目标关键词：封印、旧宅');
    expect(html).toContain('载入最新再改');
    expect(html).toContain('基于最新版保留我的输入');
  });
});

describe('PlanHistoryList', () => {
  it('倒序展示逐版差异、策略与当前标记，空历史有兜底文案', () => {
    const older: ChapterPlanDocument = {
      summary: '林默赶到旧宅',
      beats: ['林默赶到旧宅', '他用血补完封印', '追兵封住巷口'],
      requiredEntities: ['林默'],
      goalKeywords: ['封印'],
      obstacleKeywords: ['追兵', '雨'],
    };
    const html = renderToStaticMarkup(
      <PlanHistoryList
        currentRevision={3}
        revisions={[
          {
            revision: 3,
            plan: PLAN,
            bodyPolicy: 'mark_body_for_revision',
            canonVersionId: 'version-2',
            createdBy: 'user-1',
            createdByName: '林默',
            createdAt: '2026-10-24T09:00:00.000Z',
          },
          {
            revision: 2,
            plan: older,
            bodyPolicy: 'plan_only',
            canonVersionId: null,
            createdBy: 'user-1',
            createdByName: '林默',
            createdAt: '2026-10-23T18:00:00.000Z',
          },
        ]}
      />,
    );

    expect(html.indexOf('>r3<')).toBeLessThan(html.indexOf('>r2<'));
    expect(html).toContain('<strong>r3</strong><span class="badge badge-green">当前</span>');
    expect(html).not.toContain('<strong>r2</strong><span class="badge badge-green">当前</span>');
    expect(html).toContain('摘要已改');
    expect(html).toContain('节拍：顺序调整');
    expect(html).toContain('核心人物：新增 老周');
    expect(html).toContain('阻碍关键词：移除 雨');
    expect(html).toContain('标记正文待改');
    expect(html).toContain('仅修改计划');
    expect(html).toContain('林默');

    const empty = renderToStaticMarkup(<PlanHistoryList revisions={[]} currentRevision={0} />);
    expect(empty).toContain('还没有计划历史。第一次保存后会记录逐版差异。');
  });

  it('首版对比空计划，字段全部记为新增', () => {
    const html = renderToStaticMarkup(
      <PlanHistoryList
        currentRevision={1}
        revisions={[
          {
            revision: 1,
            plan: PLAN,
            bodyPolicy: null,
            canonVersionId: null,
            createdBy: null,
            createdByName: null,
            createdAt: '2026-10-23T18:00:00.000Z',
          },
        ]}
      />,
    );

    expect(html).toContain('摘要已改');
    expect(html).toContain('节拍：新增 林默赶到旧宅、追兵封住巷口、他用血补完封印');
    expect(html).toContain('核心人物：新增 林默、老周');
    expect(html).toContain('未知操作者');
    expect(html).not.toContain('标记正文待改');
  });
});

describe('plan 纯函数', () => {
  it('摘要首行与空摘要兜底', () => {
    expect(planSummaryHeadline(PLAN)).toBe('林默赶到旧宅');
    expect(planSummaryHeadline({ ...PLAN, summary: '   ' })).toBe('未填写摘要');
    expect(planSummaryHeadline({ ...PLAN, summary: '\n第二行' })).toBe('未填写摘要');
  });

  it('关键词输入去掉空项与重复，支持半角/全角分隔', () => {
    expect(parseKeywordInput(' 林默，老周、林默;苏晚；\n老周 ')).toEqual([
      '林默',
      '老周',
      '苏晚',
    ]);
    expect(parseKeywordInput(' ，、；')).toEqual([]);
    expect(planFromFields({ summary: ' s ', beats: ' 一 \n\n 二 ', entities: '甲、甲', goals: '', obstacles: '' })).toEqual({
      summary: 's',
      beats: ['一', '二'],
      requiredEntities: ['甲'],
      goalKeywords: [],
      obstacleKeywords: [],
    });
  });

  it('差异行覆盖无变化、顺序调整与增删', () => {
    expect(planDiffLines(PLAN, PLAN)).toEqual(['无字段变化']);
    expect(
      planDiffLines(PLAN, {
        ...PLAN,
        beats: ['追兵封住巷口', '林默赶到旧宅', '他用血补完封印'],
      }),
    ).toEqual(['节拍：顺序调整']);
    expect(
      planDiffLines(PLAN, {
        ...PLAN,
        goalKeywords: ['封印', '旧宅'],
        obstacleKeywords: [],
      }),
    ).toEqual(['目标关键词：新增 旧宅', '阻碍关键词：移除 追兵']);
  });

  it('计划改动晚于证据时间才算失效，严格大于，缺时间戳不算改变', () => {
    expect(planChangedAfterEvidence('2026-10-23T18:10:00.000Z', '2026-10-23T18:10:00.000Z')).toBe(
      false,
    );
    expect(planChangedAfterEvidence('2026-10-23T18:11:00.000Z', '2026-10-23T18:10:00.000Z')).toBe(
      true,
    );
    expect(planChangedAfterEvidence('2026-10-23T18:09:00.000Z', '2026-10-23T18:10:00.000Z')).toBe(
      false,
    );
    expect(planChangedAfterEvidence(null, '2026-10-23T18:10:00.000Z')).toBe(false);
  });
});
