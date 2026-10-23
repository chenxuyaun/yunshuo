import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GateEvaluationView, GateHintView } from '@yunshuo/contracts';
import { GatePanel } from './GatePanel.js';

function evaluation(overrides: Partial<GateEvaluationView> = {}): GateEvaluationView {
  return {
    id: 'evaluation-1',
    chapterId: 'chapter-1',
    contentHash: '0123456789abcdef0123456789abcdef',
    contextHash: 'context-1',
    ruleset: {
      id: 'ruleset-1',
      key: 'dev-v0',
      version: 3,
      description: '开发期规则集',
      isProduction: true,
    },
    status: 'passed',
    results: [
      {
        key: 'word_count',
        label: '字数',
        status: 'passed',
        message: '字数达标',
        evidence: { count: 1200 },
      },
      {
        key: 'core_entity',
        label: '核心实体',
        status: 'not_configured',
        message: '本章未配置实体清单',
        evidence: {},
      },
    ],
    hints: [],
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function hint(overrides: Partial<GateHintView> = {}): GateHintView {
  return {
    gate: 'core_entity',
    terms: ['林默', '铜钉'],
    message: '正文提到了账本里的核心实体',
    entries: [
      { id: 'entry-1', kind: 'character', name: '林默', scope: 'work', versionNo: 2 },
    ],
    ...overrides,
  };
}

function render(
  value: GateEvaluationView | null,
  draftHash: string | null = null,
  isDirty = false,
): string {
  return renderToStaticMarkup(
    <GatePanel evaluation={value} draftHash={draftHash} isDirty={isDirty} />,
  );
}

describe('GatePanel', () => {
  it('没有结论时只显示空态，不显示提示区', () => {
    const html = render(null, 'anything');
    expect(html).toContain('尚无门禁结论。');
    expect(html).not.toContain('账本提示');
    expect(html).not.toContain('全部通过');
  });

  it('通过的生产结论显示规则集、门禁结果与证据入口', () => {
    const html = render(evaluation());
    expect(html).toContain('全部通过');
    expect(html).toContain('dev-v0 v3');
    expect(html).toContain('生产规则集');
    expect(html).not.toContain('开发规则集 · 非生产');
    expect(html).toContain('字数达标');
    expect(html).toContain('未配置');
    expect(html).toContain('查看证据');
    expect(html).toContain('0123456789');
    expect(html).toContain('10/23 18:07');
  });

  it('未通过的非生产结论同时亮出失败与开发徽标', () => {
    const html = render(
      evaluation({
        status: 'failed',
        ruleset: {
          id: 'ruleset-1',
          key: 'dev-v0',
          version: 3,
          description: '开发期规则集',
          isProduction: false,
        },
      }),
    );
    expect(html).toContain('存在未通过');
    expect(html).toContain('开发规则集 · 非生产');
    expect(html).not.toContain('生产规则集</span>');
  });

  it('结论哈希与当前草稿不一致时提示已过期', () => {
    const current = evaluation();
    const stale = render(current, 'ffffffffffffffffffffffffffffffff');
    expect(stale).toContain('这份结论对应的是另一版正文，已过期');
    const fresh = render(current, current.contentHash);
    expect(fresh).not.toContain('这份结论对应的是另一版正文，已过期');
  });

  it('草稿哈希未知不报过期，但未保存内容单独提示', () => {
    const html = render(evaluation(), null, true);
    expect(html).not.toContain('这份结论对应的是另一版正文，已过期');
    expect(html).toContain('编辑区有未保存内容');
  });

  it('账本提示明确标注不参与硬门禁，并给出来源与命中词', () => {
    const html = render(evaluation({ hints: [hint()] }));
    expect(html).toContain('账本提示');
    expect(html).toContain('不参与硬门禁结论');
    expect(html).toContain('通过或未通过仍以上面的硬门禁为准');
    expect(html).toContain('核心实体');
    expect(html).toContain('角色');
    expect(html).toContain('林默');
    expect(html).toContain('v2 · 作品专属');
    expect(html).toContain('命中：林默、铜钉');
  });

  it('提示没有条目与命中词时不渲染空列表', () => {
    const html = render(
      evaluation({ hints: [hint({ gate: 'causality', entries: [], terms: [] })] }),
    );
    expect(html).toContain('因果律');
    expect(html).not.toContain('gate-hint-entries');
    expect(html).not.toContain('gate-hint-terms');
  });
});
