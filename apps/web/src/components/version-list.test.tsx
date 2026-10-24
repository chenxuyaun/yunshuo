import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VersionSummary } from '@yunshuo/contracts';
import { VersionList } from './VersionList.js';

function version(overrides: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: 'version-1',
    versionNo: 1,
    source: 'human',
    wordCount: 1200,
    contentHash: '0123456789abcdef0123456789abcdef',
    actorName: '林默',
    gateStatus: 'passed',
    evaluationId: 'evaluation-1',
    waiverId: null,
    contentPreview: '风从窗缝里钻进来。',
    createdAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function render(
  versions: VersionSummary[],
  currentVersionId: string | null = null,
  options: { canRollback?: boolean; onRollback?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <VersionList
      versions={versions}
      currentVersionId={currentVersionId}
      onOpen={() => {}}
      canRollback={options.canRollback ?? false}
      onRollback={options.onRollback === false ? undefined : () => {}}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('VersionList', () => {
  it('没有版本时只显示空态与 0 个版本', () => {
    const html = render([]);
    expect(html).toContain('0 个版本');
    expect(html).toContain('本章尚无正典版本。');
    expect(html).not.toContain('version-list');
    expect(html).not.toContain('当前正典');
  });

  it('版本行按来源、字数、作者与时间拼出事实行', () => {
    const html = render([
      version({ id: 'v1', versionNo: 1, source: 'human', actorName: '林默' }),
      version({
        id: 'v2',
        versionNo: 2,
        source: 'import',
        actorName: null,
        gateStatus: 'not_evaluated',
      }),
    ]);
    expect(html).toContain('2 个版本');
    expect(html).toContain('人工提交 · 1200 字 · 林默 · 10/23 18:07');
    expect(html).toContain('迁移导入 · 1200 字 · 系统导入 · 10/23 18:07');
    expect(html).toContain('风从窗缝里钻进来。');
  });

  it('当前正典徽标只挂在当前版本上，门禁徽标各自显示', () => {
    const html = render(
      [
        version({ id: 'v1', versionNo: 1, gateStatus: 'passed' }),
        version({ id: 'v2', versionNo: 2, gateStatus: 'waived' }),
        version({ id: 'v3', versionNo: 3, gateStatus: 'not_evaluated' }),
      ],
      'v2',
    );
    expect(count(html, '当前正典')).toBe(1);
    expect(html).toContain('<span class="badge badge-green">门禁通过</span>');
    expect(html).toContain('<span class="badge badge-amber">已豁免</span>');
    expect(html).toContain('<span class="badge badge-neutral">未评估</span>');
    const currentIndex = html.indexOf('当前正典');
    const entry = html.slice(
      html.lastIndexOf('class="version-entry"', currentIndex),
      html.indexOf('</li>', currentIndex),
    );
    expect(entry).toContain('>v2<');
    expect(entry).not.toContain('>v1<');
    expect(entry).not.toContain('>v3<');
  });

  it('只有非当前版本在可回滚时提供回滚按钮', () => {
    const versions = [
      version({ id: 'v1', versionNo: 1 }),
      version({ id: 'v2', versionNo: 2 }),
      version({ id: 'v3', versionNo: 3 }),
    ];
    const rollbackable = render(versions, 'v3', { canRollback: true });
    expect(count(rollbackable, 'version-rollback')).toBe(2);
    expect(count(rollbackable, '回滚到此版本…')).toBe(2);
  });

  it('未授权或没有回调时一个回滚按钮都不渲染', () => {
    const versions = [version({ id: 'v1' }), version({ id: 'v2', versionNo: 2 })];
    const notAllowed = render(versions, 'v2', { canRollback: false });
    expect(count(notAllowed, 'version-rollback')).toBe(0);

    const noHandler = render(versions, 'v2', { canRollback: true, onRollback: false });
    expect(count(noHandler, 'version-rollback')).toBe(0);
  });
});
