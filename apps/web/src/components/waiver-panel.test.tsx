import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ChapterDetail, MeResponse, VersionSummary, WaiverView } from '@yunshuo/contracts';
import { WaiverPanel } from './WaiverPanel.js';

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: 'v1',
    versionNo: 1,
    source: 'human',
    wordCount: 1200,
    contentHash: 'hash-1',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'evaluation-1',
    waiverId: null,
    contentPreview: '正文',
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function waiver(overrides: Partial<WaiverView> = {}): WaiverView {
  return {
    id: 'waiver-1',
    chapterId: 'chapter-1',
    targetVersionId: 'v1',
    gateKey: 'rollback',
    reason: '目标版本证据缺失',
    status: 'pending',
    requestedBy: 'user-1',
    requestedByName: '林默',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function me(role: MeResponse['role']): MeResponse {
  return {
    user: { id: 'user-1', email: 'owner@demo.local', name: '林默' },
    workspace: { id: 'workspace-1', name: '演示', settingsVersion: 1, ledgerVersion: 1 },
    role,
  };
}

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  const versions = [
    version({ id: 'v1', versionNo: 1, gateStatus: 'passed' }),
    version({ id: 'v2', versionNo: 2, gateStatus: 'waived' }),
    version({ id: 'v3', versionNo: 3 }),
  ];
  return {
    id: 'chapter-1',
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 1,
    title: '第一章',
    status: 'canon',
    plan: {
      summary: '',
      beats: [],
      requiredEntities: [],
      goalKeywords: [],
      obstacleKeywords: [],
    },
    planRevision: 0,
    planUpdatedAt: null,
    bodyNeedsRevision: false,
    markedPlanRevision: null,
    markedCanonVersionId: null,
    wordCount: 1200,
    currentVersion: versions[2]!,
    draft: null,
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions,
    waivers: [],
    indexStatus: null,
    ruleset: null,
    canEdit: true,
    ...overrides,
  };
}

function render(meValue: MeResponse, chapterValue: ChapterDetail): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WaiverPanel me={meValue} chapter={chapterValue} />
    </QueryClientProvider>,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('WaiverPanel', () => {
  it('没有豁免记录时显示空态与记录数', () => {
    const html = render(me('owner'), chapter({ waivers: [] }));
    expect(html).toContain('本章还没有豁免记录。');
    expect(html).toContain('0 条记录');
    expect(html).not.toContain('项待审批');
    expect(html).toContain('“已豁免”不等于“已通过”');
  });

  it('待审记录给出目标版本与记录数，已用记录加徽标', () => {
    const html = render(
      me('owner'),
      chapter({
        waivers: [waiver({ id: 'w1' }), waiver({ id: 'w2', status: 'approved' })],
        versions: [
          version({ id: 'v1', versionNo: 1 }),
          version({ id: 'v2', versionNo: 2, waiverId: 'w2' }),
          version({ id: 'v3', versionNo: 3 }),
        ],
      }),
    );
    expect(html).toContain('1 项待审批');
    expect(html).toContain('回滚至 v1');
    expect(count(html, '已用于回滚')).toBe(1);
  });

  it('申请人不能看到自己的审批按钮', () => {
    const html = render(
      me('owner'),
      chapter({ waivers: [waiver({ requestedBy: 'user-1' })] }),
    );
    expect(html).toContain('等待另一位所有者或主笔审批。');
    expect(html).not.toContain('审批备注（可选）');
    expect(html).not.toContain('>批准<');
    expect(html).not.toContain('>拒绝<');
  });

  it('别的所有者或主笔才能看到审批区', () => {
    const lead = render(
      me('lead'),
      chapter({ waivers: [waiver({ requestedBy: 'user-2' })] }),
    );
    expect(lead).toContain('审批备注（可选）');
    expect(lead).toContain('>批准<');
    expect(lead).toContain('>拒绝<');
    expect(lead).not.toContain('仅所有者或主笔可以审批。');

    const author = render(
      me('author'),
      chapter({ waivers: [waiver({ requestedBy: 'user-2' })] }),
    );
    expect(author).toContain('仅所有者或主笔可以审批。');
    expect(author).not.toContain('>批准<');
  });

  it('只有正典章节的可写角色能申请，选项只列更早版本', () => {
    const html = render(me('owner'), chapter());
    expect(html).toContain('申请回滚豁免');
    expect(html).toContain('v1 · 门禁通过 · 1200 字');
    expect(html).toContain('v2 · 已豁免 · 1200 字');
    expect(html).not.toContain('v3 · 未评估 · 1200 字');
    expect(html).toContain('提交豁免申请');
    expect(count(html, 'disabled=""')).toBe(1);

    const viewer = render(me('viewer'), chapter());
    expect(viewer).not.toContain('申请回滚豁免');

    const writing = render(me('owner'), chapter({ status: 'writing' }));
    expect(writing).not.toContain('申请回滚豁免');
  });

  it('没有更早版本时说明暂不能申请', () => {
    const html = render(
      me('owner'),
      chapter({
        versions: [version({ id: 'v1', versionNo: 1 })],
        currentVersion: version({ id: 'v1', versionNo: 1 }),
      }),
    );
    expect(html).toContain('当前没有可回滚的更早版本，暂不能申请回滚豁免。');
    expect(html).not.toContain('class="waiver-request"');
  });

  it('已决记录写清批准或拒绝的人与备注', () => {
    const html = render(
      me('owner'),
      chapter({
        waivers: [
          waiver({
            id: 'w1',
            status: 'approved',
            decidedByName: '李四',
            decidedAt: '2026-10-23T19:00:00.000Z',
            decisionNote: '证据确实缺失',
          }),
          waiver({
            id: 'w2',
            status: 'rejected',
            targetVersionId: 'v2',
            decidedByName: null,
            approvedByName: null,
          }),
        ],
      }),
    );
    expect(html).toContain('批准：李四 · 10/23 19:00 · 备注：证据确实缺失');
    expect(html).toContain('拒绝：未记录');
  });
});
