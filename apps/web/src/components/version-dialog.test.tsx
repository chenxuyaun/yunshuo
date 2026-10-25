import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { GateEvaluationView, VersionDetail, WaiverView } from '@yunshuo/contracts';
import { VersionDialog } from './VersionDialog.js';

const VERSION_ID = 'version-7';
const CHAPTER_ID = 'chapter-5';

function evaluation(overrides: Partial<GateEvaluationView> = {}): GateEvaluationView {
  return {
    id: 'eval-1',
    chapterId: CHAPTER_ID,
    contentHash: 'abcdef0123456789',
    contextHash: 'context-9876543210abcdef',
    ruleset: {
      id: 'ruleset-1',
      key: 'core',
      version: 2,
      description: '核心规则集',
      isProduction: true,
    },
    status: 'passed',
    results: [
      {
        key: 'word_count',
        label: '字数',
        status: 'passed',
        message: '字数满足下限',
        evidence: { min: 1200, actual: 1234 },
      },
      {
        key: 'ai_tone',
        label: 'AI 腔',
        status: 'failed',
        message: '出现套话',
        evidence: { matches: ['不禁'] },
      },
    ],
    hints: [],
    createdAt: '2026-10-24T00:30:00.000Z',
    ...overrides,
  };
}

function waiver(overrides: Partial<WaiverView> = {}): WaiverView {
  return {
    id: 'waiver-1',
    chapterId: CHAPTER_ID,
    targetVersionId: VERSION_ID,
    gateKey: 'word_count',
    reason: '字数不足，暂以豁免放行',
    status: 'approved',
    requestedBy: 'user-2',
    requestedByName: '陈曦',
    approvedBy: 'user-3',
    approvedByName: '老周',
    approvedAt: '2026-10-24T01:00:00.000Z',
    decidedBy: 'user-3',
    decidedByName: '周野',
    decidedAt: '2026-10-24T02:00:00.000Z',
    decisionNote: '同意一次',
    createdAt: '2026-10-24T00:45:00.000Z',
    ...overrides,
  };
}

function version(overrides: Partial<VersionDetail> = {}): VersionDetail {
  return {
    id: VERSION_ID,
    versionNo: 7,
    source: 'human',
    wordCount: 1234,
    contentHash: 'abcdef0123456789',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'eval-1',
    waiverId: null,
    contentPreview: '第一段。',
    createdAt: '2026-10-24T00:00:00.000Z',
    content: '第一段。\n\n第二段。\n   \n第三段。',
    parentVersionId: 'version-6-0123456789abcdef',
    evaluation: evaluation(),
    waiver: null,
    ...overrides,
  };
}

function setQueryError(client: QueryClient, queryKey: string[], error: unknown): void {
  const query = client.getQueryCache().build(client, { queryKey });
  query.setState({
    status: 'error',
    error,
    fetchStatus: 'idle',
    errorUpdatedAt: Date.now(),
  } as never);
}

function render(options: { value?: VersionDetail; error?: unknown } = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  if (options.value) client.setQueryData(['version', VERSION_ID], options.value);
  if (options.error !== undefined) setQueryError(client, ['version', VERSION_ID], options.error);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <VersionDialog
        versionId={VERSION_ID}
        chapterNumber={5}
        chapterTitle="夜行"
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('VersionDialog', () => {
  it('读取中只显示弹窗骨架与加载文案', () => {
    const html = render();

    expect(html).toContain('<div class="modal-backdrop">');
    expect(html).toContain('<div class="modal modal-version"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="version-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<p class="eyebrow">正典留痕 · 第 5 章</p>');
    expect(html).toContain('<h2 id="version-title">夜行</h2>');
    expect(html).not.toContain(' · v');
    expect(html).toContain('<p class="empty-state">正在读取版本与证据……</p>');
    expect(html).not.toContain('version-meta');
    expect(html).not.toContain('hash-lines');
    expect(html).not.toContain('manuscript-readonly');
    expect(html).not.toContain('version-evidence');
    expect(html).not.toContain('waiver-box');
    expect(html).not.toContain('modal-error');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<button type="button" class="button button-quiet">关闭</button>');
    expect(html.split('>关闭<').length - 1).toBe(2);
  });

  it('完整版本显示元信息、正文分段、门禁证据与豁免', () => {
    const html = render({ value: version({ waiver: waiver() }) });

    expect(html).toContain('<h2 id="version-title">夜行 · v7</h2>');
    expect(html).toContain('<span>人工提交</span>');
    expect(html).toContain('<span>1234 字</span>');
    expect(html).toContain('<span>林默</span>');
    expect(html).toContain('<span>10/24 00:00</span>');
    expect(html).toContain('<span class="badge badge-green">门禁通过</span>');
    expect(html).toContain('<span>正文哈希</span><code>abcdef0123456789</code>');
    expect(html).toContain('<span>父版本</span><code>version-6-</code>');
    expect(html).not.toContain('version-6-0123456789abcdef');
    expect(html).not.toContain('inline-warning');
    expect(html).not.toContain('迁移导入 · 无门禁证据');

    expect(html).toContain('<article class="manuscript-readonly">');
    expect(html).toContain('<p>第一段。</p>');
    expect(html).toContain('<p>第二段。</p>');
    expect(html).toContain('<p>第三段。</p>');
    expect(html.split('<article class="manuscript-readonly">').length - 1).toBe(1);
    expect(html).not.toContain('<p></p>');

    expect(html).toContain('<section class="version-evidence">');
    expect(html).toContain('<ul class="evidence-list">');
    expect(html).toContain('<p class="eyebrow">门禁证据</p>');
    expect(html).toContain('<h3>core v2</h3>');
    expect(html).toContain('<span class="badge badge-green">生产规则集</span>');
    expect(html).toContain('评估时间 10/24 00:30 · 上下文指纹 context-98');
    expect(html).not.toContain('context-9876543210abcdef');
    expect(html).toContain('<span>字数</span>');
    expect(html).toContain('<span class="badge badge-green">通过</span>');
    expect(html).toContain('<p>字数满足下限</p>');
    expect(html).toContain('<span>AI 腔</span>');
    expect(html).toContain('<span class="badge badge-red">未通过</span>');
    expect(html).toContain('<p>出现套话</p>');
    expect(html).toContain('<summary>查看证据</summary>');
    expect(html).toContain('&quot;min&quot;: 1200');
    expect(html).toContain('&quot;actual&quot;: 1234');

    expect(html).toContain('<section class="waiver-box">');
    expect(html).toContain('<p class="eyebrow">显式豁免 · 不等于门禁通过</p>');
    expect(html).toContain('<span class="badge badge-green">已批准</span>');
    expect(html).toContain('<h3>回滚豁免 · 由 陈曦 申请</h3>');
    expect(html).toContain('<p>字数不足，暂以豁免放行</p>');
    expect(html).toContain('审批：周野 · 10/24 02:00 · 备注：同意一次');
    expect(html).toContain(
      '该豁免一次性、绑定具体目标版本；它解除的是指定回滚动作的证据要求， 不会改写任何门禁结论。',
    );
  });

  it('无评估的人工版本如实标未评估，并只说明通用原因', () => {
    const html = render({
      value: version({
        source: 'human',
        gateStatus: 'not_evaluated',
        evaluation: null,
        parentVersionId: null,
      }),
    });

    expect(html).toContain('<span class="badge badge-neutral">未评估</span>');
    expect(html).toContain('<div class="inline-warning">');
    expect(html).toContain('该版本没有门禁评估记录。系统如实标记为“未评估”，不补造通过结论。');
    expect(html).not.toContain('迁移导入正文保留原样');
    expect(html).not.toContain('version-evidence');
    expect(html).not.toContain('<span>父版本</span>');
    expect(html).not.toContain('迁移导入 · 无门禁证据');
    expect(html).toContain('<span>人工提交</span>');
  });

  it('迁移导入且无评估时多给迁移徽标与保留原样说明，操作人回退系统导入', () => {
    const html = render({
      value: version({
        source: 'import',
        gateStatus: 'not_evaluated',
        evaluation: null,
        actorName: null,
        parentVersionId: null,
      }),
    });

    expect(html).toContain('<span>迁移导入</span>');
    expect(html).toContain('<span>系统导入</span>');
    expect(html).toContain('<span class="badge badge-neutral">迁移导入 · 无门禁证据</span>');
    expect(html).toContain(
      '迁移导入正文保留原样，后续修订需重新走门禁。',
    );
    expect(html).not.toContain('林默');
  });

  it('非生产规则集用琥珀徽标标出，版本门禁仍按自身状态着色', () => {
    const html = render({
      value: version({
        gateStatus: 'waived',
        evaluation: evaluation({
          ruleset: {
            id: 'ruleset-2',
            key: 'draft',
            version: 1,
            description: '',
            isProduction: false,
          },
        }),
      }),
    });

    expect(html).toContain('<span class="badge badge-amber">已豁免</span>');
    expect(html).toContain('<span class="badge badge-amber">开发规则集 · 非生产</span>');
    expect(html).toContain('<h3>draft v1</h3>');
    expect(html).not.toContain('生产规则集</span>');
  });

  it('审批信息按决定人/批准人、决定时间/批准时间逐级回退', () => {
    const fallback = render({
      value: version({
        waiver: waiver({
          decidedByName: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        }),
      }),
    });

    expect(fallback).toContain('审批：老周 · 10/24 01:00');
    expect(fallback).not.toContain('备注：');

    const unknown = render({
      value: version({
        waiver: waiver({
          decidedByName: null,
          decidedBy: null,
          decidedAt: null,
          approvedByName: null,
          approvedBy: null,
          approvedAt: null,
          decisionNote: null,
        }),
      }),
    });

    expect(unknown).toContain('审批：未记录');
    expect(unknown).not.toContain('未记录 ·');
  });

  it('读取失败按 Error 原文与字符串兜底，并保留弹窗骨架', () => {
    const error = render({
      error: Object.assign(new Error('网络中断'), { code: 'VERSION_FAILED' }),
    });

    expect(error).toContain('<div class="modal-error">');
    expect(error).toContain('读取失败：网络中断');
    expect(error).not.toContain('VERSION_FAILED');
    expect(error).not.toContain('manuscript-readonly');
    expect(error).toContain('<h2 id="version-title">夜行</h2>');

    const raw = render({ error: 'boom' });
    expect(raw).toContain('读取失败：boom');
  });

  it('门禁明细按失败/错误/未配置分色，版本门禁已豁免用琥珀', () => {
    const html = render({
      value: version({
        gateStatus: 'waived',
        evaluation: evaluation({
          status: 'failed',
          results: [
            {
              key: 'word_count',
              label: '字数',
              status: 'failed',
              message: '字数不足',
              evidence: {},
            },
            {
              key: 'ai_tone',
              label: 'AI 腔',
              status: 'error',
              message: '检测器出错',
              evidence: {},
            },
            {
              key: 'chapter_hook',
              label: '章末钩子',
              status: 'not_configured',
              message: '未配置钩子',
              evidence: {},
            },
          ],
        }),
      }),
    });

    expect(html).toContain('<span class="badge badge-red">未通过</span>');
    expect(html).toContain('<span class="badge badge-red">错误</span>');
    expect(html).toContain('<span class="badge badge-amber">未配置</span>');
    expect(html).toContain('<span class="badge badge-amber">已豁免</span>');
  });

  it('四种来源各自映射标签，正文不因空行多出段落', () => {
    const ai = render({ value: version({ source: 'ai' }) });
    expect(ai).toContain('<span>AI 提交</span>');
    expect(ai).toContain('夜行 · v7');

    const rollback = render({ value: version({ source: 'rollback' }) });
    expect(rollback).toContain('<span>回滚</span>');

    const batch = render({ value: version({ source: 'batch' }) });
    expect(batch).toContain('<span>批量补写</span>');

    const aiParagraphs =
      ai.match(/<article class="manuscript-readonly">([\s\S]*?)<\/article>/)?.[1] ?? '';
    expect(aiParagraphs.split('<p>').length - 1).toBe(3);
    expect(ai).not.toContain('<p>   </p>');
  });
});
