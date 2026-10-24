import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IndexStatusView } from '@yunshuo/contracts';
import { IndexStatusCard } from './IndexStatusCard.js';

function status(overrides: Partial<IndexStatusView> = {}): IndexStatusView {
  return {
    status: 'ready',
    detail: '已切分 12 个片段',
    versionId: 'version-3',
    versionNo: 3,
    chunkCount: 12,
    providerName: 'Ollama',
    model: 'bge-m3',
    dimensions: 1024,
    attempts: 2,
    nextRetryAt: null,
    lastError: null,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function render(
  value: IndexStatusView | null,
  role: 'owner' | 'lead' | 'author' | 'viewer' = 'owner',
): string {
  return renderToStaticMarkup(
    <IndexStatusCard chapterId="chapter-1" role={role} status={value} />,
  );
}

describe('IndexStatusCard', () => {
  it('尚未入正典时只给异步排队说明，不显示索引事实与按钮', () => {
    const html = render(null);
    expect(html).toContain('badge-muted">尚未入正典<');
    expect(html).toContain('正典提交后，索引任务会经 outbox 异步排队。');
    expect(html).not.toContain('index-meta');
    expect(html).not.toContain('重建本章索引');
  });

  it('就绪状态显示徽标、详情、六项事实与更新时间', () => {
    const html = render(status());
    expect(html).toContain('badge-green">索引就绪<');
    expect(html).toContain('已切分 12 个片段');
    expect(html).toContain('v3');
    expect(html).toContain('12');
    expect(html).toContain('bge-m3');
    expect(html).toContain('1024');
    expect(html).toContain('Ollama');
    expect(html).toContain('尝试');
    expect(html).toContain('2 次');
    expect(html).toContain('更新于 10/23 18:07');
    expect(html).not.toContain('预计重试');
    expect(html).not.toContain('index-error');
  });

  it('失败状态给重试时间与错误原文，缺失字段各自回退', () => {
    const html = render(
      status({
        status: 'failed',
        detail: null,
        versionNo: null,
        providerName: null,
        model: null,
        dimensions: null,
        attempts: 4,
        nextRetryAt: '2026-10-23T19:07:00.000Z',
        lastError: '嵌入服务返回 502',
      }),
    );
    expect(html).toContain('badge-red">索引失败<');
    expect(html).toContain('无详情');
    expect(html).toContain('正典版本</dt><dd>未知</dd>');
    expect(html).toContain('维度</dt><dd>未知</dd>');
    expect(html.split('未配置').length - 1).toBe(2);
    expect(html).toContain('4 次');
    expect(html).toContain('预计重试：10/23 19:07');
    expect(html).toContain('嵌入服务返回 502');
  });

  it('五种索引状态各有自己的文案与色调', () => {
    const pending = render(status({ status: 'pending' }));
    expect(pending).toContain('badge-amber">等待索引 worker<');
    const indexing = render(status({ status: 'indexing' }));
    expect(indexing).toContain('badge-amber">索引进行中<');
    const notConfigured = render(status({ status: 'not_configured' }));
    expect(notConfigured).toContain('badge-neutral">未配置嵌入服务<');
  });

  it('只有所有者与主笔能重建，作者看到禁用按钮与原因', () => {
    const owner = render(status(), 'owner');
    const ownerButton = owner.slice(owner.lastIndexOf('<button', owner.indexOf('重建本章索引')));
    expect(ownerButton).not.toContain('disabled=""');
    expect(ownerButton).toContain('title="按当前正典重新切块并嵌入"');
    expect(owner).not.toContain('仅所有者与主笔可重建<');

    const lead = render(status(), 'lead');
    expect(lead).not.toContain('仅所有者与主笔可重建<');

    const author = render(status(), 'author');
    const authorButton = author.slice(
      author.lastIndexOf('<button', author.indexOf('重建本章索引')),
    );
    expect(authorButton).toContain('disabled=""');
    expect(authorButton).toContain('title="仅所有者与主笔可以重建索引"');
    expect(author).toContain('仅所有者与主笔可重建<');

    const viewer = render(status(), 'viewer');
    expect(viewer).toContain('仅所有者与主笔可重建<');
  });

  it('索引进行中时连所有者也不能重复触发', () => {
    const html = render(status({ status: 'indexing' }), 'owner');
    const button = html.slice(html.lastIndexOf('<button', html.indexOf('重建本章索引')));
    expect(button).toContain('disabled=""');
    expect(html).not.toContain('仅所有者与主笔可重建<');
  });
});
