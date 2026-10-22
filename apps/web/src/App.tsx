import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@yunshuo/contracts';
import {
  ApiError,
  getChapter,
  getMe,
  getMyWorkspaces,
  listChapters,
  listDevUsers,
  login,
  logout,
  switchWorkspace,
} from './api.js';
import { LoginScreen } from './components/LoginScreen.js';
import { InviteAcceptScreen } from './components/InviteAcceptScreen.js';
import { ResetScreen } from './components/ResetScreen.js';
import { WorkspaceHeader } from './components/WorkspaceHeader.js';
import { ChapterList } from './components/ChapterList.js';
import { ChapterStudio } from './components/ChapterStudio.js';
import { AccountDialog } from './components/AccountDialog.js';
import { ProviderSettingsDialog } from './components/ProviderSettingsDialog.js';
import { AutomationDialog } from './components/AutomationDialog.js';
import { VersionDialog } from './components/VersionDialog.js';
import { TeamDialog } from './components/TeamDialog.js';
import { BillingDialog } from './components/BillingDialog.js';
import { BillingPanel } from './components/BillingPanel.js';
import { ImportChaptersDialog } from './components/ImportChaptersDialog.js';
import { LedgerDialog } from './components/LedgerDialog.js';

interface VersionDialogState {
  versionId: string;
  chapterNumber: number;
  chapterTitle: string;
}

function readInviteToken(pathname: string): string | null {
  const match = /^\/invite\/([A-Za-z0-9_-]{20,200})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

function readResetToken(pathname: string): string | null {
  const match = /^\/reset\/([A-Za-z0-9_-]{20,200})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function App() {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    readInviteToken(window.location.pathname),
  );
  const [resetToken, setResetToken] = useState<string | null>(() =>
    readResetToken(window.location.pathname),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versionDialog, setVersionDialog] = useState<VersionDialogState | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [billingDialogOpen, setBillingDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [ledgerDialogOpen, setLedgerDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((result) => {
        if (!cancelled) setMe(result);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onInviteScreen = inviteToken !== null;
  const onPublicRoute = onInviteScreen || resetToken !== null;

  const devUsersQuery = useQuery({
    queryKey: ['devUsers'],
    queryFn: listDevUsers,
    enabled: Boolean(me) && !onPublicRoute,
  });

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: getMyWorkspaces,
    enabled: Boolean(me) && !onPublicRoute,
  });

  const chaptersQuery = useQuery({
    queryKey: ['chapters'],
    queryFn: listChapters,
    enabled: Boolean(me) && !onPublicRoute && me?.role !== 'billing',
  });

  const chapterQuery = useQuery({
    queryKey: ['chapter', selectedId],
    queryFn: () => getChapter(selectedId!),
    enabled: Boolean(me && selectedId) && !onPublicRoute && me?.role !== 'billing',
    refetchInterval: (query) => {
      const status = query.state.data?.indexStatus?.status;
      return status === 'pending' || status === 'indexing' ? 2000 : false;
    },
  });

  useEffect(() => {
    const chapters = chaptersQuery.data;
    if (!chapters) return;
    if (selectedId && chapters.some((chapter) => chapter.id === selectedId)) return;
    const next = chapters.find((chapter) => chapter.status !== 'canon') ?? chapters[0];
    setSelectedId(next?.id ?? null);
  }, [chaptersQuery.data, selectedId]);

  useEffect(() => {
    if (chaptersQuery.error instanceof ApiError && chaptersQuery.error.status === 401) {
      queryClient.clear();
      setMe(null);
    }
  }, [chaptersQuery.error, queryClient]);

  function resetSessionState(next: MeResponse | null) {
    queryClient.clear();
    setSelectedId(null);
    setVersionDialog(null);
    setAccountDialogOpen(false);
    setProviderDialogOpen(false);
    setAutomationDialogOpen(false);
    setTeamDialogOpen(false);
    setBillingDialogOpen(false);
    setImportDialogOpen(false);
    setLedgerDialogOpen(false);
    setMe(next);
  }

  function navigateHome() {
    window.history.replaceState({}, '', '/');
    setInviteToken(null);
    setResetToken(null);
  }

  async function handleSwitchUser(email: string) {
    const next = await login(email);
    resetSessionState(next);
  }

  async function handleSwitchWorkspace(workspaceId: string) {
    const next = await switchWorkspace(workspaceId);
    resetSessionState(next);
  }

  async function handleSessionRefresh() {
    const next = await getMe();
    setMe(next);
    if (next.role !== 'owner' && next.role !== 'lead') setTeamDialogOpen(false);
    if (next.role !== 'owner' && next.role !== 'lead' && next.role !== 'billing') {
      setBillingDialogOpen(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      resetSessionState(null);
    }
  }

  function handleInviteAccepted(next: MeResponse) {
    navigateHome();
    resetSessionState(next);
  }

  if (checking) {
    return (
      <BootScreen
        title="正在校验会话"
        detail="读取工作区、角色与提交链状态……"
      />
    );
  }

  if (resetToken) {
    return (
      <ResetScreen
        token={resetToken}
        onFinished={() => {
          navigateHome();
          resetSessionState(null);
        }}
      />
    );
  }

  if (onInviteScreen && inviteToken) {
    return (
      <InviteAcceptScreen
        token={inviteToken}
        me={me}
        onAccepted={handleInviteAccepted}
        onExit={navigateHome}
        onLogout={handleLogout}
      />
    );
  }

  if (!me) {
    return (
      <LoginScreen
        onLoggedIn={(next) => {
          resetSessionState(next);
        }}
      />
    );
  }

  const seenDevEmails = new Set<string>();
  const devUsers = (devUsersQuery.data ?? []).filter((user) => {
    if (seenDevEmails.has(user.email)) return false;
    seenDevEmails.add(user.email);
    return true;
  });
  const workspaces =
    workspacesQuery.data?.workspaces ??
    (me.role === 'ai'
      ? []
      : [{ id: me.workspace.id, name: me.workspace.name, role: me.role }]);

  if (me.role === 'billing') {
    return (
      <div className="app-shell">
        <WorkspaceHeader
          me={me}
          devUsers={devUsers}
          workspaces={workspaces}
          onSwitchUser={handleSwitchUser}
          onSwitchWorkspace={handleSwitchWorkspace}
          onLogout={handleLogout}
          onOpenAccount={() => setAccountDialogOpen(true)}
          onOpenProviders={() => setProviderDialogOpen(true)}
          onOpenAutomation={() => setAutomationDialogOpen(true)}
          onOpenTeam={() => setTeamDialogOpen(true)}
          onOpenBilling={() => setBillingDialogOpen(true)}
          onOpenImport={() => setImportDialogOpen(true)}
        />
        <main className="billing-console">
          <div className="billing-console-intro">
            <p className="eyebrow">计费管理员视图</p>
            <h1>工作区计费</h1>
            <p className="muted">
              只展示费用归属、工作区预算与服务商价表；作品正文、草稿、检索内容、服务商端点与密钥不在本视图范围内。
            </p>
          </div>
          <BillingPanel me={me} />
        </main>
        {accountDialogOpen ? (
          <AccountDialog me={me} onClose={() => setAccountDialogOpen(false)} />
        ) : null}
      </div>
    );
  }

  if (chaptersQuery.isLoading) {
    return <BootScreen title="正在读取章节目录" detail="加载正典指针、字数与索引状态……" />;
  }

  if (chaptersQuery.isError) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <div className="brand-seal brand-seal-large" aria-hidden="true">
            说
          </div>
          <p className="eyebrow">YUNSHUO · 编辑部</p>
          <h1>无法读取章节目录</h1>
          <p className="boot-error">
            {chaptersQuery.error instanceof ApiError
              ? `${chaptersQuery.error.message}（${chaptersQuery.error.code}）`
              : chaptersQuery.error instanceof Error
                ? chaptersQuery.error.message
                : String(chaptersQuery.error)}
          </p>
          <p className="muted">请确认 API（3100）与 PostgreSQL（5433）已启动。</p>
          <div className="boot-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void chaptersQuery.refetch()}
            >
              重试
            </button>
            <button type="button" className="button button-quiet" onClick={() => void handleLogout()}>
              退出登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  const chapters = chaptersQuery.data ?? [];
  const chapter = chapterQuery.data ?? null;

  return (
    <div className="app-shell">
      <WorkspaceHeader
        me={me}
        devUsers={devUsers}
        workspaces={workspaces}
        onSwitchUser={handleSwitchUser}
        onSwitchWorkspace={handleSwitchWorkspace}
        onLogout={handleLogout}
        onOpenAccount={() => setAccountDialogOpen(true)}
        onOpenProviders={() => setProviderDialogOpen(true)}
        onOpenAutomation={() => setAutomationDialogOpen(true)}
        onOpenTeam={() => setTeamDialogOpen(true)}
        onOpenBilling={() => setBillingDialogOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        onOpenLedger={() => setLedgerDialogOpen(true)}
      />

      <div className="workspace-body">
        <ChapterList
          chapters={chapters}
          selectedId={selectedId}
          onSelect={(chapterId) => {
            setSelectedId(chapterId);
            setVersionDialog(null);
          }}
        />

        <main className="studio-column">
          {chapterQuery.isLoading && selectedId ? (
            <div className="studio-loading">
              <p className="eyebrow">正在读取章节</p>
              <p className="muted">载入正文、租约、门禁与版本记录……</p>
            </div>
          ) : chapterQuery.isError ? (
            <div className="studio-loading">
              <p className="eyebrow">章节读取失败</p>
              <p className="boot-error">
                {chapterQuery.error instanceof ApiError
                  ? `${chapterQuery.error.message}（${chapterQuery.error.code}）`
                  : chapterQuery.error instanceof Error
                    ? chapterQuery.error.message
                    : String(chapterQuery.error)}
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void chapterQuery.refetch()}
              >
                重试
              </button>
            </div>
          ) : chapter ? (
            <ChapterStudio
              me={me}
              chapter={chapter}
              onOpenVersion={(versionId) => {
                setVersionDialog({
                  versionId,
                  chapterNumber: chapter.number,
                  chapterTitle: chapter.title,
                });
              }}
              onOpenChapter={(chapterId) => {
                setSelectedId(chapterId);
                setVersionDialog(null);
              }}
            />
          ) : (
            <div className="studio-loading">
              <p className="eyebrow">还没有章节</p>
              <p className="muted">
                {me.role === 'owner' || me.role === 'lead' || me.role === 'author'
                  ? '导入旧稿作为“迁移导入”版本开始。导入章不会被补造门禁结论，界面会如实显示“未评估”。'
                  : '当前工作区还没有可读章节。请联系所有者或主笔导入旧稿。'}
              </p>
              {me.role === 'owner' || me.role === 'lead' || me.role === 'author' ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setImportDialogOpen(true)}
                >
                  导入旧章
                </button>
              ) : null}
            </div>
          )}
        </main>
      </div>

      {versionDialog ? (
        <VersionDialog
          versionId={versionDialog.versionId}
          chapterNumber={versionDialog.chapterNumber}
          chapterTitle={versionDialog.chapterTitle}
          onClose={() => setVersionDialog(null)}
        />
      ) : null}

      {accountDialogOpen ? (
        <AccountDialog me={me} onClose={() => setAccountDialogOpen(false)} />
      ) : null}

      {providerDialogOpen ? (
        <ProviderSettingsDialog me={me} onClose={() => setProviderDialogOpen(false)} />
      ) : null}

      {automationDialogOpen ? (
        <AutomationDialog
          me={me}
          chapters={chapters}
          onClose={() => setAutomationDialogOpen(false)}
          onOpenChapter={(chapterId) => {
            setAutomationDialogOpen(false);
            setSelectedId(chapterId);
            setVersionDialog(null);
          }}
        />
      ) : null}

      {teamDialogOpen ? (
        <TeamDialog
          me={me}
          onClose={() => setTeamDialogOpen(false)}
          onSessionRefresh={handleSessionRefresh}
          onLogout={handleLogout}
        />
      ) : null}

      {billingDialogOpen ? (
        <BillingDialog me={me} onClose={() => setBillingDialogOpen(false)} />
      ) : null}

      {importDialogOpen ? (
        <ImportChaptersDialog
          onClose={() => setImportDialogOpen(false)}
          onImported={(chapterId) => {
            setImportDialogOpen(false);
            setVersionDialog(null);
            setSelectedId(chapterId);
          }}
        />
      ) : null}

      {ledgerDialogOpen ? (
        <LedgerDialog
          me={me}
          chapters={chapters}
          onClose={() => setLedgerDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

function BootScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="boot-screen">
      <div className="boot-card">
        <div className="brand-seal brand-seal-large" aria-hidden="true">
          说
        </div>
        <p className="eyebrow">YUNSHUO · M5</p>
        <h1>{title}</h1>
        <p className="muted">{detail}</p>
        <span className="boot-pulse" aria-hidden="true" />
      </div>
    </div>
  );
}
