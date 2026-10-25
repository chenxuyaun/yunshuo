import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import { AccountDialog } from './AccountDialog.js';

const ME = (role: HumanRole = 'owner'): MeResponse => ({
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role,
});

function render(role: HumanRole = 'owner'): string {
  return renderToStaticMarkup(<AccountDialog me={ME(role)} onClose={() => {}} />);
}

describe('AccountDialog', () => {
  it('渲染账号弹窗骨架与工作区归属', () => {
    const html = render();
    expect(html.startsWith('<div class="modal-backdrop">')).toBe(true);
    expect(html).toContain('class="modal modal-account"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="account-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<header class="modal-head">');
    expect(html).toContain('<p class="eyebrow">云说工坊 · 账号安全</p>');
    expect(html).toContain('<h2 id="account-title">账号</h2>');
    expect(html).toContain('<button type="button" class="modal-close">关闭</button>');
    expect(html).toContain('<button type="button" class="button button-quiet">关闭</button>');
    expect(html.match(/>关闭</g)?.length).toBe(2);
    expect(html).toContain('<span class="commit-foot-hint">安全事件写入账号级 auth_events，不记录密码或密码哈希。</span>');
  });

  it('摘要显示邮箱与当前工作区角色', () => {
    const html = render('lead');
    expect(html).toContain('<div class="account-summary">');
    expect(html).toContain('<span class="eyebrow">邮箱</span>');
    expect(html).toContain('<strong class="mono">lin@example.com</strong>');
    expect(html).toContain('<span class="eyebrow">当前工作区角色</span>');
    expect(html).toContain('<strong>主笔</strong>');
  });

  it('六个角色都映射成中文标签', () => {
    const labels: Array<[HumanRole, string]> = [
      ['owner', '所有者'],
      ['lead', '主笔'],
      ['author', '作者'],
      ['reviewer', '审阅者'],
      ['viewer', '读者'],
      ['billing', '计费管理员'],
    ];
    for (const [role, label] of labels) {
      const html = render(role);
      expect(html).toContain(`<strong>${label}</strong>`);
    }
  });

  it('修改密码表单的三个密码框属性逐字', () => {
    const html = render();
    expect(html.match(/type="password"/g)?.length).toBe(3);
    expect(html.match(/maxLength="200"/g)?.length).toBe(3);
    expect(html.match(/value=""/g)?.length).toBe(3);
    expect(html).toContain('<span>当前密码</span>');
    expect(html).toContain('<span>新密码</span>');
    expect(html).toContain('<span>确认新密码</span>');
    expect(html).toContain('autoComplete="current-password"');
    expect(html.match(/autoComplete="new-password"/g)?.length).toBe(2);
    expect(html.match(/placeholder="至少 10 位"/g)?.length).toBe(1);
    expect(html).toContain('<form class="account-form">');
    expect(html.match(/class="field"/g)?.length).toBe(3);
  });

  it('字段顺序是当前、新、确认', () => {
    const html = render();
    const current = html.indexOf('<span>当前密码</span>');
    const next = html.indexOf('<span>新密码</span>');
    const confirm = html.indexOf('<span>确认新密码</span>');
    expect(current).toBeGreaterThan(-1);
    expect(current).toBeLessThan(next);
    expect(next).toBeLessThan(confirm);
  });

  it('提交按钮初始可点且写「修改密码」', () => {
    const html = render();
    expect(html).toContain('<button type="submit" class="button button-primary">修改密码</button>');
    expect(html).not.toContain('修改中……');
    expect(html).not.toContain('disabled');
  });

  it('说明与区块标题逐字，且初始无提示与错误行', () => {
    const html = render();
    expect(html).toContain('<h3>修改密码</h3>');
    expect(html).toContain('<span class="muted">至少 10 位 · scrypt 哈希 · 不存明文</span>');
    expect(html).toContain(
      '修改密码会撤销该账号在其他工作区的全部会话，并作废未使用的重置链接；当前会话保留。',
    );
    expect(html).toContain('若账号尚未设置密码（例如种子账号），请先在登录页使用“忘记密码”设置。');
    expect(html).not.toContain('provider-notice-success');
    expect(html).not.toContain('class="modal-error"');
  });

  it('账号区块与表单边框包在 modal-body 内', () => {
    const html = render();
    expect(html).toContain('<div class="modal-body">');
    expect(html).toContain('<section class="account-section">');
    expect(html).toContain('<div class="team-section-head">');
    expect(html).toContain('<p class="account-hint muted">');
    expect(html.endsWith('</div></div>')).toBe(true);
  });
});
