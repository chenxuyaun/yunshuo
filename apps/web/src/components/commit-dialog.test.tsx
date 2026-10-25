import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  ChapterDetail,
  GateEvaluationView,
  StagedDraftView,
  VersionSummary,
} from '@yunshuo/contracts';
import { CommitDialog } from './CommitDialog.js';

const CHAPTER_ID = 'chapter-5';

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: 'version-3',
    versionNo: 3,
    source: 'human',
    wordCount: 1200,
    contentHash: 'feedfacecafebeef',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'eval-0123456789ab',
    waiverId: null,
    contentPreview: '封印在雨里松了。',
    createdAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

function staged(overrides: Partial<StagedDraftView> = {}): StagedDraftView {
  return {
    id: 'staged-1',
    chapterId: CHAPTER_ID,
    contentHash: 'abcdef0123456789',
    wordCount: 1234,
    evaluationId: 'eval-0123456789ab',
    stagedBy: 'user-1',
    stagedByName: '林默',
    stagedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function evaluation(overrides: Partial<GateEvaluationView> = {}): GateEvaluationView {
  return {
    id: 'eval-0123456789ab',
    chapterId: CHAPTER_ID,
    contentHash: 'abcdef0123456789',
    contextHash: 'ctx-0123456789ab',
    ruleset: { id: 'rs-1', key: 'core', version: 2, description: '核心规则', isProduction: true },
    status: 'passed',
    results: [
      { key: 'word_count', label: '字数', status: 'passed', message: '达标', evidence: {} },
      { key: 'ai_tone', label: 'AI 腔', status: 'passed', message: '未命中', evidence: {} },
    ],
    hints: [],
    createdAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function chapter(overrides: Partial<ChapterDetail> = {}): ChapterDetail {
  return {
    id: CHAPTER_ID,
    workId: 'work-1',
    volumeId: 'volume-1',
    number: 5,
    title: '夜行',
    status: 'staged',
    plan: {},
    wordCount: 1234,
    currentVersion: version(),
    draft: null,
    lease: null,
    latestEvaluation: null,
    stagedDraft: null,
    versions: [version()],
    waivers: [],
    indexStatus: null,
    ruleset: null,
    canEdit: true,
    ...overrides,
  };
}

function render(value: ChapterDetail): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const noop = () => {};
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CommitDialog chapter={value} onClose={noop} onCommitted={noop} />
    </QueryClientProvider>,
  );
}

describe('CommitDialog', () => {
  it('没有暂存与门禁证据时给出阻断说明，三处空值都写破折号', () => {
    const html = render(
      chapter({
        currentVersion: null,
        stagedDraft: null,
        latestEvaluation: null,
        ruleset: null,
      }),
    );

    expect(html).toContain('<p class="eyebrow">不可逆操作 · 单事务写入</p>');
    expect(html).toContain('<div class="modal modal-commit"');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<p class="eyebrow">提交目标</p>');
    expect(html).toContain('<h2 id="commit-title">把暂存稿写入正典</h2>');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="commit-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<p class="commit-target-title">第 5 章 · 夜行</p>');
    expect(html).toContain('无（本章首次入库）');
    expect(html).toContain('<dd>0 字 · —</dd>');
    expect(html).toContain('<dt>暂存正文</dt>');
    expect(html).toContain('<dt>门禁证据</dt>');
    expect(html).toContain('<dt>规则集</dt>');
    expect(html).toContain('<dt>幂等键</dt>');
    expect(html).toContain('<span class="badge badge-red">缺少门禁证据</span>');
    expect(html).toContain('<dd class="mono">—</dd>');
    expect(html).toContain('暂存草稿缺少门禁证据，提交会在服务端被拒绝。请撤回暂存并重新跑门禁。');
    expect(html).not.toContain('commit-gates');
    expect(html).not.toContain('请先勾选上方确认项');
    expect(html).toContain('我确认目标是第 5 章《夜行》，并已核对暂存正文与门禁证据。');
    expect(html).toContain(
      '<div class="commit-transaction-note"><strong>写入范围</strong><p>',
    );
    expect(html).toContain(
      '新版本、当前正典指针、章节状态、字数元数据、事件、审计、outbox 与索引状态在同一个事务里提交；',
    );
    expect(html).toContain(' 任一步失败都会整体回滚，不会留下半截正典。');
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" disabled="">确认写入正典</button>',
    );
    expect(html).not.toContain('正在提交……');
    expect(html).toContain('<button type="button" class="button button-quiet">取消</button>');
    expect(html.split('—').length - 1).toBe(3);
  });

  it('通过态显示暂存摘要、门禁徽标、生产规则集与幂等键', () => {
    const html = render(
      chapter({
        stagedDraft: staged(),
        latestEvaluation: evaluation(),
      }),
    );

    expect(html).toContain('<dd>1234 字 · abcdef0123</dd>');
    expect(html).toContain('<span class="summary-inline">');
    expect(html).toContain('<span class="badge badge-green">全部通过</span>');
    expect(html).toContain('<span>eval-01234</span>');
    expect(html).toContain('<dd>core v2</dd>');
    expect(html).not.toContain('非生产');
    expect(html).toContain('<dd class="mono">commit-staged-1</dd>');
    expect(html).toContain('<ul class="commit-gates">');
    expect(html).toContain('<li><span>字数</span><span class="badge badge-green">通过</span></li>');
    expect(html).toContain('<li><span>AI 腔</span><span class="badge badge-green">通过</span></li>');
    expect(html).toContain('当前正典：v3');
    expect(html).toContain('请先勾选上方确认项，确认按钮才会启用。');
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" disabled="">确认写入正典</button>',
    );
    expect(html).not.toContain('modal-error');
  });

  it('未通过态按门禁状态分色，并标出非生产规则集', () => {
    const html = render(
      chapter({
        stagedDraft: staged(),
        latestEvaluation: evaluation({
          status: 'failed',
          ruleset: { id: 'rs-2', key: 'draft', version: 1, description: '草稿规则', isProduction: false },
          results: [
            { key: 'word_count', label: '字数', status: 'failed', message: '不足', evidence: {} },
            { key: 'core_entity', label: '核心实体', status: 'error', message: '异常', evidence: {} },
            { key: 'chapter_hook', label: '章末钩子', status: 'not_configured', message: '未配', evidence: {} },
          ],
        }),
      }),
    );

    expect(html).toContain('<span class="badge badge-red">未全部通过</span>');
    expect(html).toContain('<dd>draft v1<span class="muted"> · 非生产</span></dd>');
    expect(html).toContain('<li><span>字数</span><span class="badge badge-red">未通过</span></li>');
    expect(html).toContain('<li><span>核心实体</span><span class="badge badge-red">错误</span></li>');
    expect(html).toContain(
      '<li><span>章末钩子</span><span class="badge badge-amber">未配置</span></li>',
    );
    expect(html).not.toContain('badge badge-green">全部通过');

    const blocked = render(
      chapter({ stagedDraft: staged(), latestEvaluation: evaluation({ status: 'blocked' }) }),
    );
    expect(blocked).toContain('<span class="badge badge-red">未全部通过</span>');
  });

  it('缺少门禁证据时规则集退回章节自带配置', () => {
    const html = render(
      chapter({
        stagedDraft: staged(),
        latestEvaluation: null,
        ruleset: { id: 'rs-3', key: 'legacy', version: 4, description: '旧规则', isProduction: true },
      }),
    );

    expect(html).toContain('<dd>legacy v4</dd>');
    expect(html).not.toContain('非生产');
    expect(html).toContain('<span class="badge badge-red">缺少门禁证据</span>');
    expect(html).toContain('暂存草稿缺少门禁证据，提交会在服务端被拒绝。请撤回暂存并重新跑门禁。');
    expect(html).toContain('<dd class="mono">commit-staged-1</dd>');
  });

  it('门禁证据自带规则集优先于章节规则集', () => {
    const html = render(
      chapter({
        stagedDraft: staged(),
        latestEvaluation: evaluation({
          ruleset: { id: 'rs-9', key: 'eval-rule', version: 7, description: '评估规则', isProduction: true },
        }),
        ruleset: { id: 'rs-3', key: 'legacy', version: 4, description: '旧规则', isProduction: true },
      }),
    );

    expect(html).toContain('<dd>eval-rule v7</dd>');
    expect(html).not.toContain('legacy v4');
  });

  it('短哈希原样显示，长哈希只截前十位', () => {
    const html = render(
      chapter({
        stagedDraft: staged({ contentHash: 'abc' }),
        latestEvaluation: evaluation({ id: 'eval-7' }),
      }),
    );

    expect(html).toContain('<dd>1234 字 · abc</dd>');
    expect(html).toContain('<span>eval-7</span>');
  });

  it('有暂存但无门禁时仍先要求勾选确认，且提交保持禁用', () => {
    const html = render(
      chapter({
        stagedDraft: staged({ wordCount: 0 }),
        latestEvaluation: null,
      }),
    );

    expect(html).toContain('<dd>0 字 · abcdef0123</dd>');
    expect(html).toContain('请先勾选上方确认项，确认按钮才会启用。');
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(checkbox).not.toContain('disabled');
    expect(checkbox).not.toContain('checked');
    expect(html).toContain(
      '<button type="button" class="button button-vermilion" disabled="">确认写入正典</button>',
    );
  });

  it('首次入库时当前正典写无，幂等键仍绑定暂存草稿', () => {
    const html = render(
      chapter({
        currentVersion: null,
        versions: [],
        stagedDraft: staged({ id: 'staged-9' }),
        latestEvaluation: evaluation(),
      }),
    );

    expect(html).toContain('无（本章首次入库）');
    expect(html).toContain('<dd>1234 字 · abcdef0123</dd>');
    expect(html).toContain('<dd class="mono">commit-staged-9</dd>');
    expect(html).toContain('<dd>core v2</dd>');
  });
});
