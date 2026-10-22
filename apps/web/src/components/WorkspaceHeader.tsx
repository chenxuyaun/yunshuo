import { useState } from 'react';
import type { MeResponse, WorkspaceMembershipView } from '@yunshuo/contracts';
import type { DevUser } from '../api.js';
import { ROLE_LABELS } from '../format.js';

interface Props {
  me: MeResponse;
  devUsers: DevUser[];
  workspaces: WorkspaceMembershipView[];
  onSwitchUser: (email: string) => Promise<void>;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onOpenAccount: () => void;
  onOpenProviders: () => void;
  onOpenAutomation: () => void;
  onOpenTeam: () => void;
  onOpenBilling: () => void;
  onOpenImport: () => void;
}

export function WorkspaceHeader({
  me,
  devUsers,
  workspaces,
  onSwitchUser,
  onSwitchWorkspace,
  onLogout,
  onOpenAccount,
  onOpenProviders,
  onOpenAutomation,
  onOpenTeam,
  onOpenBilling,
  onOpenImport,
}: Props) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSwitch(action: () => Promise<void>) {
    setSwitching(true);
    setError(null);
    try {
      await action();
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setSwitching(false);
    }
  }

  function handleSwitchUser(email: string) {
    if (email === me.user.email) return;
    void runSwitch(() => onSwitchUser(email));
  }

  function handleSwitchWorkspace(workspaceId: string) {
    if (workspaceId === me.workspace.id) return;
    void runSwitch(() => onSwitchWorkspace(workspaceId));
  }

  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-seal" aria-hidden="true">
          说
        </div>
        <div className="brand-copy">
          <h1>云说</h1>
          <p>长篇小说协作工坊 · 编辑部</p>
        </div>
      </div>

      <div className="topbar-context">
        {workspaces.length > 1 ? (
          <label className="workspace-switch">
            <span className="sr-only">切换工作区</span>
            <select
              value={me.workspace.id}
              disabled={switching}
              title="切换工作区；会话与权限随之切换"
              onChange={(event) => handleSwitchWorkspace(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} · {ROLE_LABELS[workspace.role]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="context-chip context-workspace">{me.workspace.name}</span>
        )}
        <span className="context-chip">{ROLE_LABELS[me.role]}</span>
        <span className="context-chip context-m1">M1–M5 · 身份与协作</span>
      </div>

      <div className="account-block">
        {error ? <span className="account-error">{error}</span> : null}
        {devUsers.length > 0 ? (
          <label className="dev-switch">
            <span>开发身份</span>
            <select
              value={me.user.email}
              disabled={switching}
              onChange={(event) => handleSwitchUser(event.target.value)}
              title="仅用于本机验证角色差异"
            >
              {devUsers.map((user) => (
                <option key={`${user.id}-${user.role}`} value={user.email}>
                  {user.name} · {ROLE_LABELS[user.role]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {me.role === 'owner' || me.role === 'lead' || me.role === 'author' ? (
          <button
            type="button"
            className="button button-quiet button-small"
            title="把旧稿作为迁移导入版本写入正典；门禁显示未评估"
            onClick={onOpenImport}
          >
            导入旧章
          </button>
        ) : null}
        {me.role === 'owner' || me.role === 'lead' ? (
          <>
            <button
              type="button"
              className="button button-quiet button-small"
              title="查看成员、调整角色、发出或撤销邀请"
              onClick={onOpenTeam}
            >
              成员与邀请
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              title="显式授权下的无人值守续写；逐章评估五门禁"
              onClick={onOpenAutomation}
            >
              自动作业
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              title="登记 OpenAI 兼容端点并测试连接"
              onClick={onOpenProviders}
            >
              模型服务商
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              title="本月调用费用归属、工作区预算与服务商价表"
              onClick={onOpenBilling}
            >
              计费
            </button>
          </>
        ) : null}
        <span className="account-name">{me.user.name}</span>
        <button
          type="button"
          className="button button-quiet button-small"
          title="修改密码与账号安全"
          onClick={onOpenAccount}
        >
          账号
        </button>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={() => void onLogout()}
        >
          退出
        </button>
      </div>
    </header>
  );
}
