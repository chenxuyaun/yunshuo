import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuditReport } from '@yunshuo/contracts';
import type { AuditResult } from '@yunshuo/domain';
import { AuditPanel } from './AuditPanel.js';

function audit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    key: 'punctuation',
    label: '标点',
    status: 'ok',
    message: '没有发现问题',
    advisoryOnly: true,
    ...overrides,
  };
}

function report(audits: AuditResult[]): AuditReport {
  return { audits, advisoryOnly: true };
}

function render(
  value: AuditReport | null,
  options: { busy?: boolean; disabledReason?: string | null; isDirty?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <AuditPanel
      report={value}
      onRun={() => {}}
      busy={options.busy ?? false}
      disabledReason={options.disabledReason ?? null}
      draftHash="0123456789abcdef0123456789abcdef"
      isDirty={options.isDirty ?? false}
    />,
  );
}

describe('AuditPanel', () => {
  it('没有报告时显示空态与回退提示，不渲染审计列表', () => {
    const html = render(null);
    expect(html).toContain('尚未运行审计。');
    expect(html).toContain('点击右上角运行；结果只作提示。');
    expect(html).not.toContain('audit-list');
    expect(html).not.toContain('对象：');
  });

  it('空态提示优先使用禁用原因', () => {
    const html = render(null, { disabledReason: '请先保存草稿' });
    expect(html).toContain('请先保存草稿');
    expect(html).not.toContain('点击右上角运行；结果只作提示。');
  });

  it('三种审计状态渲染成对应文案与色调', () => {
    const html = render(
      report([
        audit({ key: 'punctuation', label: '标点', status: 'ok' }),
        audit({
          key: 'ai_flavor',
          label: 'AI 味',
          status: 'warning',
          message: '检测到套话',
        }),
        audit({
          key: 'typo',
          label: '错别字',
          status: 'not_connected',
          message: '未接入错别字检测器',
        }),
      ]),
    );
    expect(html).toContain('<span class="badge badge-green">未命中</span>');
    expect(html).toContain('<span class="badge badge-amber">提示</span>');
    expect(html).toContain('<span class="badge badge-neutral">未接入</span>');
    expect(html).toContain('检测到套话');
    expect(html).toContain('未接入错别字检测器');
  });

  it('只有带例子的审计项才渲染样本行', () => {
    const html = render(
      report([
        audit({ key: 'punctuation', label: '标点', examples: ['「的地得」×3', '重复逗号'] }),
        audit({ key: 'ai_flavor', label: 'AI 味', status: 'ok', examples: [] }),
        audit({ key: 'typo', label: '错别字', status: 'not_connected' }),
      ]),
    );
    expect(html.split('class="audit-examples"').length - 1).toBe(1);
    expect(html).toContain('「的地得」×3、重复逗号');
  });

  it('草稿哈希只显示前 10 位，未保存内容单独提示', () => {
    const clean = render(report([audit()]));
    expect(clean).toContain('对象：已保存草稿 0123456789 · 审计不产生门禁证据');
    expect(clean).not.toContain('编辑区有未保存内容');

    const dirty = render(report([audit()]), { isDirty: true });
    expect(dirty).toContain('编辑区有未保存内容，这次审计不包含这些修改。');
  });

  it('运行按钮按忙碌与禁用原因切换文案、禁用态和提示', () => {
    const idle = render(report([audit()]));
    expect(idle).toContain('运行审计');
    expect(idle).not.toContain('运行中…');
    expect(idle).not.toContain('disabled=""');
    expect(idle).toContain('title="审计只提示，不改写正文"');

    const busy = render(report([audit()]), { busy: true });
    expect(busy).toContain('运行中…');
    expect(busy).not.toContain('运行审计');
    expect(busy).toContain('disabled=""');

    const blocked = render(report([audit()]), { disabledReason: '请先保存草稿' });
    expect(blocked).toContain('运行审计');
    expect(blocked).toContain('disabled=""');
    expect(blocked).toContain('title="请先保存草稿"');
  });
});
