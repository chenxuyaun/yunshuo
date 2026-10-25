import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ChapterDetail, VersionSummary, WaiverView } from '@yunshuo/contracts';
import { RollbackDialog } from './RollbackDialog.js';

const CHAPTER_ID = 'chapter-5';

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: 'version-2',
    versionNo: 2,
    source: 'human',
    wordCount: 1234,
    contentHash: 'abcdef0123456789',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'eval-2',
    waiverId: null,
    contentPreview: '井底刻着铜钉。',
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

function waiver(overrides: Partial<WaiverView> = {}): WaiverView {
  return {
    id: 'waiver-1',
    chapterId: CHAPTER_ID,
    targetVersionId: 'version-2',
    gateKey: 'word_count',
    reason: '字数不足，暂以豁免放行',
    status: 'approved',
    requestedBy: 'user-2',
    requestedByName: '陈曦',
    approvedBy: 'user-3',
    approvedByName: '周野',
    approvedAt: '2026-10-24T01:00:00.000Z',
    decidedBy: 'user-3',
    decidedByName: '周野',
    decidedAt: '2026-10-24T01:00:00.000Z',
    decisionNote: null,
    createdAt: '2026-10-24T00:30:00.000Z',
    ...overrides,
  };
}

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  const current = version({ id: 'version-5', versionNo: 5 });
  return {
    id: CHAPTER_ID,
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 5,
    title: '夜行',
    status: 'canon',
    plan: {},
    wordCount: 1234,
    currentVersion: current,
    draft: null,
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions: [current],
    waivers: [],
    indexStatus: null,
    ruleset: null,
    canEdit: true,
    ...overrides,
  };
}

function render(props: {
  chapter?: ChapterDetail;
  target?: VersionSummary;
} = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const noop = () => {};
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RollbackDialog
        chapter={props.chapter ?? chapter()}
        target={props.target ?? version()}
        onClose={noop}
        onRolledBack={noop}
      />
    </QueryClientProvider>,
  );
}

describe('RollbackDialog', () => {
  it('通过门禁时给出可复用说明，并列出可用的已批准豁免', () => {
    const html = render({
      chapter: chapter({ waivers: [waiver()] }),
    });

    expect(html).toContain('<p class="eyebrow">正典回滚 · 生成新版本</p>');
    expect(html).toContain('<h2 id="rollback-title">回滚到 v2</h2>');
    expect(html).toContain('<div class="modal modal-rollback"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="rollback-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<p class="eyebrow">回滚目标</p>');
    expect(html).toContain('<p class="commit-target-title">第 5 章 · 夜行</p>');
    expect(html).toContain('<p class="muted">当前正典：v5 · 目标：v2（门禁通过）</p>');
    expect(html).toContain('<dt>目标正文</dt>');
    expect(html).toContain('<dd>1234 字 · abcdef0123</dd>');
    expect(html).toContain('<dt>目标门禁</dt>');
    expect(html).toContain('<span class="summary-inline">');
    expect(html).toContain('<span class="badge badge-green">门禁通过</span>');
    expect(html).toContain('<span>林默</span>');
    expect(html).toContain('<dt>原始入库时间</dt>');
    expect(html).toContain('<dd>10/24 00:00</dd>');
    expect(html).toContain('<dt>幂等键</dt>');
    expect(html).toContain('<dd class="mono">rollback-chapter-5-version-5-version-2</dd>');
    expect(html).toContain(
      '目标版本曾通过门禁。若规则集与设定上下文至今未变化，回滚会直接复用该证据； 否则仍需已批准的回滚豁免。',
    );
    expect(html).not.toContain('inline-warning');
    expect(html).toContain(
      '<option value="" selected="">自动：优先复用通过的门禁证据</option>',
    );
    expect(html).toContain(
      '<option value="waiver-1">使用已批准豁免 · 陈曦 申请 · 字数不足，暂以豁免放行</option>',
    );
    expect(html).not.toContain('该目标暂无已批准且未使用的回滚豁免。');
    expect(html).toContain('<span>证据来源</span>');
    expect(html.split('class="rollback-field"').length - 1).toBe(2);
    expect(html).toContain('<span>回滚原因</span>');
    expect(html).toContain(
      'placeholder="写明为什么需要回到该版本（至少 4 个字，会写入事件、审计与新版本记录）"',
    );
    expect(html).toContain('rows="3"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('<strong>回滚不是删除</strong>');
    expect(html).toContain(
      '系统会用目标正文生成一个来源为“回滚”的新正典版本，并更新当前正典指针； 现有版本全部保留。',
    );
    expect(html).toContain(
      '现有版本全部保留。新版本、指针、事件、审计、outbox 与索引状态在同一事务内写入。',
    );
    expect(html).toContain(
      '我确认把第 5 章《夜行》回滚到 v2， 并理解这会生成新版本而不是删除历史。',
    );
    expect(html).toContain('<span class="commit-foot-hint">请先勾选上方确认项。</span>');
    expect(html).toContain('<button type="button" class="button button-quiet">取消</button>');
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" disabled="">确认回滚</button>',
    );
    expect(html).not.toContain('正在回滚……');
  });

  it('门禁不是通过态时给出警告，没有可用豁免时提示并只留自动项', () => {
    const html = render({
      target: version({ gateStatus: 'waived', actorName: null }),
    });

    expect(html).toContain('<p class="muted">当前正典：v5 · 目标：v2（已豁免）</p>');
    expect(html).toContain('<span class="badge badge-amber">已豁免</span>');
    expect(html).toContain('<div class="inline-warning">');
    expect(html).toContain(
      '目标版本的门禁状态是“已豁免”。若没有可复用的通过门禁证据， 服务端会拒绝直接回滚，必须使用已批准且未使用的回滚豁免。',
    );
    expect(html).not.toContain('目标版本曾通过门禁');
    expect(html).toContain('<p class="waiver-meta rollback-waiver-hint">该目标暂无已批准且未使用的回滚豁免。</p>');
    expect(html.split('<option').length - 1).toBe(1);
    expect(html).toContain(
      '<dd><span class="summary-inline"><span class="badge badge-amber">已豁免</span></span></dd>',
    );
    expect(html).not.toContain('<span>林默</span>');
  });

  it('未评估目标与无当前正典时，标签两处一致且幂等键写 none', () => {
    const html = render({
      target: version({ gateStatus: 'not_evaluated', id: 'version-2' }),
      chapter: chapter({ currentVersion: null, versions: [] }),
    });

    expect(html).toContain('<p class="muted">当前正典：无 · 目标：v2（未评估）</p>');
    expect(html).toContain('<span class="badge badge-neutral">未评估</span>');
    expect(html).toContain('目标版本的门禁状态是“未评估”。');
    expect(html.split('未评估').length - 1).toBe(3);
    expect(html).toContain('<dd class="mono">rollback-chapter-5-none-version-2</dd>');
  });

  it('只列出目标匹配、已批准且未被任何版本用过的豁免', () => {
    const html = render({
      chapter: chapter({
        versions: [version({ id: 'version-5', versionNo: 5, waiverId: 'waiver-used' })],
        waivers: [
          waiver({ id: 'waiver-ok', reason: '可用豁免' }),
          waiver({ id: 'waiver-used', reason: '已被版本占用' }),
          waiver({ id: 'waiver-pending', status: 'pending', reason: '尚未批准' }),
          waiver({ id: 'waiver-other', targetVersionId: 'version-9', reason: '其他目标' }),
        ],
      }),
    });

    expect(html.split('<option').length - 1).toBe(2);
    expect(html).toContain('<option value="waiver-ok">使用已批准豁免 · 陈曦 申请 · 可用豁免</option>');
    expect(html).not.toContain('已被版本占用');
    expect(html).not.toContain('尚未批准');
    expect(html).not.toContain('其他目标');
    expect(html).not.toContain('该目标暂无已批准且未使用的回滚豁免。');
  });

  it('豁免理由只截前四十个字', () => {
    const longReason =
      '这是一段超过四十个字的豁免理由，用来验证下拉里只显示前四十个字符而不会把整段塞进选项里';
    const html = render({
      chapter: chapter({ waivers: [waiver({ reason: longReason })] }),
    });

    expect(html).toContain(`使用已批准豁免 · 陈曦 申请 · ${longReason.slice(0, 40)}`);
    expect(html).not.toContain(longReason.slice(40));
  });

  it('多条可用豁免按顺序全部列出，默认项仍在最前', () => {
    const html = render({
      chapter: chapter({
        waivers: [
          waiver({ id: 'waiver-a', requestedByName: '陈曦', reason: '第一条' }),
          waiver({ id: 'waiver-b', requestedByName: '周野', reason: '第二条' }),
        ],
      }),
    });

    const options = html.split('<option').length - 1;
    expect(options).toBe(3);
    expect(html.indexOf('自动：优先复用通过的门禁证据')).toBeLessThan(
      html.indexOf('使用已批准豁免 · 陈曦 申请 · 第一条'),
    );
    expect(html.indexOf('使用已批准豁免 · 陈曦 申请 · 第一条')).toBeLessThan(
      html.indexOf('使用已批准豁免 · 周野 申请 · 第二条'),
    );
  });

  it('门禁风险与可用豁免同时存在时，警告保留而缺失提示消失', () => {
    const html = render({
      target: version({ gateStatus: 'waived' }),
      chapter: chapter({ waivers: [waiver()] }),
    });

    expect(html).toContain('<div class="inline-warning">');
    expect(html).not.toContain('目标版本曾通过门禁');
    expect(html).not.toContain('该目标暂无已批准且未使用的回滚豁免。');
    expect(html).toContain('<option value="waiver-1">');
    expect(html).toContain('<span class="badge badge-amber">已豁免</span>');
  });

  it('静态交互面：原因框为空、复选框未勾选、提交保持禁用', () => {
    const html = render({ chapter: chapter({ waivers: [waiver()] }) });

    const textarea = html.match(/<textarea[^>]*>[^<]*<\/textarea>/)?.[0] ?? '';
    expect(textarea).toContain('placeholder="写明为什么需要回到该版本（至少 4 个字，会写入事件、审计与新版本记录）"');
    expect(textarea).toContain('rows="3"');
    expect(textarea).toContain('maxLength="2000"');
    expect(textarea).not.toContain('disabled');

    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(html).toContain('<label class="commit-check">');
    expect(checkbox).not.toContain('checked');
    expect(checkbox).not.toContain('disabled');

    const select = html.match(/<select[^>]*>/)?.[0] ?? '';
    expect(select).not.toContain('disabled');

    expect(html).toContain('<span class="commit-foot-hint">请先勾选上方确认项。</span>');
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" disabled="">确认回滚</button>',
    );
  });
});
