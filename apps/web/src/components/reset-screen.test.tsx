import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResetScreen } from './ResetScreen.js';

function render(): string {
  return renderToStaticMarkup(<ResetScreen token="reset-token" onFinished={() => {}} />);
}

describe('ResetScreen', () => {
  it('默认展示一次性链接的品牌区与有效期说明', () => {
    const html = render();

    expect(html).toContain('<div class="login-page">');
    expect(html).toContain('<div class="login-ornament" aria-hidden="true"></div>');
    expect(html).toContain('login-card login-card-reset');
    expect(html).toContain('<p class="eyebrow">YUNSHUO · 账号安全</p>');
    expect(html).toContain('<h1>重置密码</h1>');
    expect(html).toContain('brand-seal brand-seal-large" aria-hidden="true">说</div>');
    expect(html).toContain('一次性链接 · 30 分钟有效 · 重置后所有旧会话失效。');
    expect(html).toContain('<h2>设置新密码</h2>');
    expect(html).toContain('<span class="muted">至少 10 位 · 服务端只存 scrypt 哈希</span>');
  });

  it('两个密码框都按新密码语义渲染，只有第一个带占位符', () => {
    const html = render();

    expect(html).toContain('<form class="reset-form">');
    expect(html).toContain('<span>新密码</span>');
    expect(html).toContain('<span>确认新密码</span>');
    expect(html.match(/type="password"/g) ?? []).toHaveLength(2);
    expect(html.match(/placeholder="至少 10 位"/g) ?? []).toHaveLength(1);
    expect(html.match(/autoComplete="new-password"/g) ?? []).toHaveLength(2);
    expect(html.match(/maxLength="200"/g) ?? []).toHaveLength(2);
  });

  it('初次进入显示可提交的重置按钮，不显示进行中、成功或失败态', () => {
    const html = render();

    expect(html).toContain('<button type="submit" class="button button-primary">重置密码</button>');
    expect(html).not.toContain('重置中……');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('无法重置');
    expect(html).not.toContain('notice-error');
    expect(html).not.toContain('密码已重置');
    expect(html).not.toContain('notice-success');
  });

  it('保留“只能用一次”的提示和唯一的返回登录入口', () => {
    const html = render();

    expect(html).toContain('链接只能使用一次。若已过期，请返回登录页重新发送重置请求。');
    // 提示文案里也含“返回登录页”，这里只数真正的入口按钮。
    expect(html.match(/<button type="button" class="link-button">返回登录<\/button>/g) ?? []).toHaveLength(1);
  });

  it('页脚说明令牌存放、会话撤销与明文边界', () => {
    const html = render();

    expect(html).toContain('<footer class="login-foot">');
    expect(html).toContain('<span>一次性令牌 · SHA-256 摘要存库</span>');
    expect(html).toContain('<span>重置后撤销全部会话</span>');
    expect(html).toContain('<span>不记录明文密码</span>');
  });
});
