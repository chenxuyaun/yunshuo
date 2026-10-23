import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AutomationJobChapterView,
  AutomationJobView,
  AutomationMandateView,
} from '@yunshuo/contracts';
import { AutomationJobDetail } from './AutomationJobDetail.js';

function mandate(overrides: Partial<AutomationMandateView> = {}): AutomationMandateView {
  return {
    id: 'mandate-1',
    workId: 'work-1',
    workTitle: '作品甲',
    name: '继续二十章',
    mode: 'continue',
    chapterMin: 1,
    chapterMax: 20,
    maxChapters: 20,
    targetWords: 1200,
    instruction: '',
    allowAutoCommit: false,
    allowRemoteModels: true,
    allowNonProductionGates: false,
    budgetLimit: 5,
    budgetCurrency: 'CNY',
    status: 'active',
    expiresAt: '2026-10-24T18:00:00.000Z',
    createdBy: 'user-1',
    createdByName: '林默',
    revokedAt: null,
    revokedByName: null,
    createdAt: '2026-10-23T18:00:00.000Z',
    ...overrides,
  };
}

function chapter(
  overrides: Partial<AutomationJobChapterView> = {},
): AutomationJobChapterView {
  return {
    chapterId: 'chapter-1',
    chapterNumber: 1,
    chapterTitle: '起',
    status: 'committed',
    proposalId: null,
    versionId: null,
    evaluationId: null,
    reason: null,
    cost: null,
    costCurrency: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<AutomationJobView> = {}): AutomationJobView {
  return {
    id: 'job-1',
    workspaceId: 'workspace-1',
    workId: 'work-1',
    workTitle: '作品甲',
    mandateId: 'mandate-1',
    mandateName: '继续二十章',
    status: 'running',
    preflight: {
      ok: true,
      checks: [{ key: 'auto_commit', label: '自动入库', status: 'fail', detail: '' }],
      chapters: [],
      providerNames: ['Atria'],
      unknownCost: false,
      budgetRemaining: 4,
      budgetCurrency: 'CNY',
      generatedAt: '2026-10-23T18:00:00.000Z',
    },
    totalChapters: 20,
    committedChapters: 3,
    stagedChapters: 2,
    failedChapters: 1,
    skippedChapters: 0,
    spent: 0.1234,
    costCurrency: 'CNY',
    costUnknown: false,
    runnerId: 'abcdef123456',
    heartbeatAt: '2026-10-23T18:09:00.000Z',
    currentChapterId: null,
    pauseRequested: false,
    stopRequested: false,
    lastError: null,
    createdBy: 'user-1',
    createdByName: '林默',
    startedAt: '2026-10-23T18:08:00.000Z',
    completedAt: null,
    createdAt: '2026-10-23T18:07:00.000Z',
    updatedAt: '2026-10-23T18:09:00.000Z',
    chapters: [chapter()],
    ...overrides,
  };
}

function render(
  jobValue: AutomationJobView,
  mandateValue: AutomationMandateView | null = mandate(),
  busyAction: 'pause' | 'resume' | 'stop' | 'revoke' | null = null,
): string {
  return renderToStaticMarkup(
    <AutomationJobDetail
      job={jobValue}
      mandate={mandateValue}
      busyAction={busyAction}
      onPause={() => {}}
      onResume={() => {}}
      onStop={() => {}}
      onRevoke={() => {}}
      onOpenChapter={() => {}}
    />,
  );
}

function buttonTag(html: string, label: string): string {
  for (const segment of html.split('<button').slice(1)) {
    const close = segment.indexOf('</button>');
    if (close >= 0 && segment.slice(0, close).includes(label)) {
      return `<button${segment.slice(0, close + '</button>'.length)}`;
    }
  }
  throw new Error(`找不到按钮：${label}`);
}

describe('AutomationJobDetail', () => {
  it('运行中写出进度、四项统计、费用与授权信息', () => {
    const html = render(job());

    expect(html).toContain('作品甲 · 授权「继续二十章」');
    expect(html).toContain('<h3>20 章无人值守作业</h3>');
    expect(html).toContain('由 林默 创建于 10/23 18:07 · 开始于 10/23 18:08');
    expect(html).toContain('badge-ink">运行中');
    expect(html).toContain('30% 已到检查点');
    expect(html).toContain('6 / 20 章已处理');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('width:30%');
    expect(html).toContain('<dt>已入库</dt><dd>3</dd>');
    expect(html).toContain('<dt>已暂存</dt><dd>2</dd>');
    expect(html).toContain('<dt>门禁/生成失败</dt><dd>1</dd>');
    expect(html).toContain('<dt>已跳过</dt><dd>0</dd>');
    expect(html).toContain('¥0.1234');
    expect(html).toContain('<dt>入库策略</dt><dd>仅暂存</dd>');
    expect(html).toContain('badge-green">有效');
    expect(html).toContain('预算 ¥5.0000');
    expect(html).toContain('远程模型：已授权');
    expect(html).toContain('执行心跳：10/23 18:09 · abcdef12');
    expect(html).not.toContain('已请求暂停');
    expect(html).not.toContain('已请求停止');
    expect(html).not.toContain('作业已中断');

    const withSkip = render(job({ skippedChapters: 1 }));
    expect(withSkip).toContain('35% 已到检查点');
    expect(withSkip).toContain('7 / 20 章已处理');
  });

  it('运行中的暂停与停止按钮可用，恢复不可用', () => {
    const html = render(job());

    expect(buttonTag(html, '请求暂停（章节结束后生效）')).not.toContain('disabled');
    expect(buttonTag(html, '人工恢复')).toContain('disabled=""');
    expect(buttonTag(html, '停止作业')).not.toContain('disabled');
    expect(buttonTag(html, '撤销授权')).not.toContain('disabled');
  });

  it('已请求暂停时说明生效时机并锁住暂停按钮', () => {
    const html = render(job({ pauseRequested: true }));

    expect(html).toContain('已请求暂停：runner 会在当前章节结束后停下。');
    expect(buttonTag(html, '请求暂停（章节结束后生效）')).toContain('disabled=""');
    expect(html).toContain('暂停请求已记录。');
  });

  it('已请求停止时单独说明，不与暂停文案混用', () => {
    const html = render(job({ stopRequested: true }));

    expect(html).toContain('已请求停止：runner 会在当前章节结束后停止，不再处理后续章节。');
    expect(html).not.toContain('已请求暂停');
  });

  it('中断作业只能人工恢复，并写清中断原因', () => {
    const html = render(job({ status: 'interrupted', completedAt: '2026-10-23T19:00:00.000Z' }));

    expect(html).toContain('badge-amber">已中断');
    expect(html).toContain('作业已中断（runner 心跳超过 5 分钟或服务关闭）');
    expect(html).toContain('· 结束于 10/23 19:00');
    expect(buttonTag(html, '暂停作业')).toContain('disabled=""');
    expect(buttonTag(html, '人工恢复')).not.toContain('disabled');
    expect(buttonTag(html, '停止作业')).not.toContain('disabled');
  });

  it('授权缺失或已过期时如实说明，不再给撤销入口', () => {
    const missing = render(
      job({
        status: 'completed',
        startedAt: null,
        completedAt: '2026-10-23T19:00:00.000Z',
        heartbeatAt: null,
        runnerId: null,
      }),
      null,
    );

    expect(missing).toContain('badge-green">已完成');
    expect(missing).toContain('授权：读取中…');
    expect(missing).toContain('远程模型：未授权');
    expect(missing).toContain('执行心跳：—');
    expect(missing).not.toContain('撤销授权');
    expect(missing).not.toContain('· 开始于');

    const expired = render(
      job(),
      mandate({
        status: 'expired',
        budgetLimit: null,
        allowRemoteModels: false,
        allowAutoCommit: true,
      }),
    );
    expect(expired).toContain('badge-amber">已过期');
    expect(expired).toContain('未设预算');
    expect(expired).toContain('远程模型：未授权');
    expect(expired).toContain('<dt>入库策略</dt><dd>自动入库 · batch</dd>');
    expect(expired).not.toContain('撤销授权');
  });

  it('失败、未知费用与自动入库回退都按真实数据写', () => {
    const html = render(
      job({
        status: 'failed',
        lastError: '模型连续超时，作业已停止',
        costUnknown: true,
        spent: 1.5,
        costCurrency: 'USD',
      }),
      mandate({ allowAutoCommit: false }),
    );

    expect(html).toContain('badge-red">失败');
    expect(html).toContain('模型连续超时，作业已停止');
    expect(html).toContain('$1.5000');
    expect(html).toContain('含未知费用');
    expect(html).toContain('<dt>入库策略</dt><dd>仅暂存</dd>');
  });

  it('章节行按状态给徽标、费用与原因回退', () => {
    const html = render(
      job({
        chapters: [
          chapter({ chapterId: 'c1', chapterNumber: 1, chapterTitle: '起' }),
          chapter({
            chapterId: 'c2',
            chapterNumber: 2,
            chapterTitle: '承',
            status: 'pending',
          }),
          chapter({
            chapterId: 'c3',
            chapterNumber: 3,
            chapterTitle: '转',
            status: 'running',
          }),
          chapter({
            chapterId: 'c4',
            chapterNumber: 4,
            chapterTitle: '合',
            status: 'staged',
            cost: 0.01,
            costCurrency: 'USD',
          }),
          chapter({
            chapterId: 'c5',
            chapterNumber: 5,
            chapterTitle: '门',
            status: 'gate_failed',
            reason: '门禁 continuity 未通过',
          }),
          chapter({
            chapterId: 'c6',
            chapterNumber: 6,
            chapterTitle: '空',
            status: 'no_output',
          }),
          chapter({
            chapterId: 'c7',
            chapterNumber: 7,
            chapterTitle: '跳',
            status: 'skipped',
          }),
        ],
      }),
    );

    expect(html).toContain('badge-green">已入库');
    expect(html).toContain('五门禁通过并已写入正典。');
    expect(html).toContain('badge-neutral">待处理');
    expect(html).toContain('等待 runner 处理。');
    expect(html).toContain('badge-ink">生成中');
    expect(html).toContain('正在生成或评估。');
    expect(html).toContain('badge-amber">已暂存');
    expect(html).toContain('$0.0100');
    expect(html).toContain('badge-red">门禁未通过');
    expect(html).toContain('门禁 continuity 未通过');
    expect(html).toContain('badge-amber">空正文');
    expect(html).toContain('badge-muted">已跳过');
    expect(html.match(/—<\/p>/g)?.length).toBe(3);
  });

  it('动作提交中时按钮文案与禁用同步', () => {
    const pausing = render(job(), mandate(), 'pause');

    expect(pausing).toContain('>提交中…<');
    expect(buttonTag(pausing, '提交中…')).toContain('disabled=""');
    expect(buttonTag(pausing, '人工恢复')).toContain('disabled=""');
    expect(buttonTag(pausing, '停止作业')).toContain('disabled=""');
    expect(buttonTag(pausing, '撤销授权')).toContain('disabled=""');

    const resuming = render(job({ status: 'paused' }), mandate(), 'resume');
    expect(resuming).toContain('>恢复中…<');
    expect(buttonTag(resuming, '恢复中…')).toContain('disabled=""');
  });
});
