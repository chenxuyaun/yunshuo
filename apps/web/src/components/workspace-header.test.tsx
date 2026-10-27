import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MeResponse, WorkspaceMembershipView } from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import type { DevUser } from '../api.js';
import { WorkspaceHeader } from './WorkspaceHeader.js';

const WORKSPACES: WorkspaceMembershipView[] = [
  { id: 'work-1', name: '作品甲', role: 'owner' },
  { id: 'work-2', name: '作品乙', role: 'lead' },
];

function me(role: Role = 'owner'): MeResponse {
  return {
    user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
    workspace: { id: 'work-1', name: '作品甲', settingsVersion: 1, ledgerVersion: 1 },
    role,
  };
}

function render(options: {
  role?: Role;
  workspaces?: WorkspaceMembershipView[];
  devUsers?: DevUser[];
  withLedger?: boolean;
} = {}): string {
  const noop = async () => {};
  return renderToStaticMarkup(
    <WorkspaceHeader
      me={me(options.role ?? 'owner')}
      devUsers={options.devUsers ?? []}
      workspaces={options.workspaces ?? WORKSPACES}
      onSwitchUser={noop}
      onSwitchWorkspace={noop}
      onLogout={noop}
      onOpenAccount={() => {}}
      onOpenProviders={() => {}}
      onOpenAutomation={() => {}}
      onOpenTeam={() => {}}
      onOpenBilling={() => {}}
      onOpenImport={() => {}}
      onOpenWorkStructure={() => {}}
      onOpenLedger={options.withLedger ? () => {} : undefined}
    />,
  );
}

describe('WorkspaceHeader', () => {
  it('读者只看到身份、账号与退出', () => {
    const html = render({ role: 'viewer', workspaces: WORKSPACES.slice(0, 1) });

    expect(html).toContain('<h1>云说</h1>');
    expect(html).toContain('长篇小说协作工坊 · 编辑部');
    expect(html).toContain('context-chip context-workspace">作品甲<');
    expect(html).toContain('context-chip">读者<');
    expect(html).toContain('M1–M5 · 身份与协作');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('开发身份');
    expect(html).not.toContain('设定库');
    expect(html).not.toContain('导入旧章');
    expect(html).not.toContain('作品与卷');
    expect(html).not.toContain('成员与邀请');
    expect(html).not.toContain('自动作业');
    expect(html).not.toContain('模型服务商');
    expect(html).not.toContain('计费');
    expect(html).toContain('>账号<');
    expect(html).toContain('>退出<');
    expect(html.split('class="button button-quiet button-small"').length - 1).toBe(2);
  });

  it('多个工作区时给出带角色标签的切换下拉', () => {
    const html = render();

    expect(html).toContain('<span class="sr-only">切换工作区</span>');
    expect(html).toContain('title="切换工作区；会话与权限随之切换"');
    expect(html).toContain('>作品甲 · 所有者<');
    expect(html).toContain('>作品乙 · 主笔<');
    expect(html).toContain('context-chip">所有者<');
    expect(html).not.toContain('context-chip context-workspace');
  });

  it('作者能导入旧章与打开设定库，但看不到管理入口', () => {
    const html = render({ role: 'author', withLedger: true });

    expect(html).toContain('>导入旧章<');
    expect(html).toContain('>作品与卷<');
    expect(html).toContain('>设定库<');
    expect(html).not.toContain('>成员与邀请<');
    expect(html).not.toContain('>自动作业<');
    expect(html).not.toContain('>模型服务商<');
    expect(html).not.toContain('>计费<');
    expect(html.split('class="button button-quiet button-small"').length - 1).toBe(5);
  });

  it('计费管理员看不到设定库与导入入口', () => {
    const html = render({ role: 'billing', withLedger: true });

    expect(html).not.toContain('>设定库<');
    expect(html).not.toContain('>导入旧章<');
    expect(html).not.toContain('>作品与卷<');
    expect(html).not.toContain('>成员与邀请<');
    expect(html).toContain('context-chip">计费管理员<');
    expect(html.split('class="button button-quiet button-small"').length - 1).toBe(2);
  });

  it('主笔拥有全部管理入口', () => {
    const html = render({ role: 'lead', withLedger: true });

    expect(html).toContain('>设定库<');
    expect(html).toContain('>导入旧章<');
    expect(html).toContain('>作品与卷<');
    expect(html).toContain('>成员与邀请<');
    expect(html).toContain('>自动作业<');
    expect(html).toContain('>模型服务商<');
    expect(html).toContain('>计费<');
    expect(html).toContain('context-chip">主笔<');
    expect(html.split('class="button button-quiet button-small"').length - 1).toBe(9);
  });

  it('没有传入设定库回调时，所有者也不显示设定库', () => {
    const html = render({ role: 'owner' });

    expect(html).not.toContain('>设定库<');
    expect(html).toContain('>成员与邀请<');
  });

  it('开发身份下拉只在有候选时出现，并带角色标签', () => {
    const html = render({
      role: 'lead',
      devUsers: [
        { id: 'user-1', email: 'lin@example.com', name: '林默', role: 'author' },
        { id: 'user-2', email: 'shen@example.com', name: '沈舟', role: 'owner' },
      ],
    });

    expect(html).toContain('开发身份');
    expect(html).toContain('title="仅用于本机验证角色差异"');
    expect(html).toContain('>林默 · 作者<');
    expect(html).toContain('>沈舟 · 所有者<');
  });

  it('AI 主体既不能开设定库也不能导入旧章', () => {
    const html = render({ role: 'ai', withLedger: true });

    expect(html).not.toContain('>设定库<');
    expect(html).not.toContain('>导入旧章<');
    expect(html).not.toContain('>作品与卷<');
    expect(html).toContain('context-chip">AI 主体<');
  });
});
