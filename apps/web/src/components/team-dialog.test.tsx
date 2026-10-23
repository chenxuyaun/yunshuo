import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  InviteStatus,
  InviteView,
  MeResponse,
  MemberView,
} from '@yunshuo/contracts';
import type { HumanRole } from '@yunshuo/domain';
import { TeamDialog } from './TeamDialog.js';

const ME = (role: HumanRole): MeResponse => ({
  user: { id: 'user-1', email: 'lin@example.com', name: '林默' },
  workspace: { id: 'ws-1', name: '云说工坊', settingsVersion: 1, ledgerVersion: 1 },
  role,
});

function member(overrides: Partial<MemberView> = {}): MemberView {
  return {
    userId: 'user-1',
    email: 'lin@example.com',
    name: '林默',
    role: 'owner',
    kind: 'human',
    joinedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

function invite(status: InviteStatus, overrides: Partial<InviteView> = {}): InviteView {
  return {
    id: `inv-${status}`,
    email: `${status}@example.com`,
    role: 'author',
    status,
    expiresAt: '2026-10-26T18:07:00.000Z',
    createdAt: '2026-10-23T18:07:00.000Z',
    invitedBy: { id: 'user-1', name: '林默' },
    ...overrides,
  };
}

function render(options: {
  role?: HumanRole;
  members?: MemberView[];
  invites?: InviteView[];
  loaded?: boolean;
} = {}): string {
  const { role = 'owner', members = [member()], invites = [], loaded = true } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (loaded) {
    client.setQueryData(['members'], { members });
    client.setQueryData(['invites'], { invites });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TeamDialog
        me={ME(role)}
        onClose={() => {}}
        onSessionRefresh={async () => {}}
        onLogout={async () => {}}
      />
    </QueryClientProvider>,
  );
}

describe('TeamDialog', () => {
  it('缓存缺失时只说正在读取，不画成员与邀请区', () => {
    const html = render({ loaded: false });

    expect(html).toContain('云说工坊 · 成员与邀请');
    expect(html).toContain('正在读取成员与邀请……');
    expect(html).not.toContain('发出邀请');
    expect(html).not.toContain('最近邀请');
    expect(html.match(/>关闭<\/button>/g)?.length).toBe(2);
    expect(html).toContain('邀请令牌以 SHA-256 哈希存库');
  });

  it('所有者看到角色下拉、移除入口与全部六个可邀请角色', () => {
    const html = render({
      members: [
        member(),
        member({
          userId: 'user-2',
          email: 'shen@example.com',
          name: '沈舟',
          role: 'author',
          joinedAt: '2026-10-22T09:00:00.000Z',
        }),
        member({ userId: 'ai-1', email: 'ai@example.com', name: 'AI 主编', role: 'ai', kind: 'ai' }),
      ],
      invites: [
        invite('pending'),
        invite('accepted', { email: 'accepted@example.com', role: 'reviewer' }),
      ],
    });

    expect(html).toContain('所有者可邀请成员、调整角色与移除成员。');
    expect(html).toContain('<h3>成员 · 3</h3>');
    expect(html).toContain('<strong>林默</strong><span class="team-self">你</span>');
    expect(html).toContain('<span class="team-self">你</span>');
    expect(html.match(/class="team-self"/g)?.length).toBe(1);
    expect(html).toContain('加入于 10/23 18:07 · 工作区与预算控制；可写入');
    expect(html).toContain('加入于 10/22 09:00 · 写稿、跑门禁、提交自己的章节');
    expect(html.match(/<select/g)?.length).toBe(4);
    expect(html).toContain('<option value="owner">所有者</option>');
    expect(html).toContain('<option value="billing">计费管理员</option>');
    expect(html.match(/>移除<\/button>/g)?.length).toBe(2);
    expect(html).toContain('badge-ink">AI 主体');
    expect(html).toContain('<input type="email"');
    expect(html).toContain('maxLength="320"');
    expect(html).toContain('placeholder="teammate@example.com"');
    expect(html).toMatch(/<option value="author"[^>]*>作者 · 写稿、跑门禁、提交自己的章节<\/option>/);
    expect(html).toContain('<option value="24">24 小时</option>');
    expect(html).toMatch(/<option value="72"[^>]*>72 小时<\/option>/);
    expect(html).toContain('<option value="168">7 天</option>');
    expect(html).toContain('<h4>最近邀请 · 2</h4>');
    expect(html).toContain('badge-amber">待接受');
    expect(html).toContain('badge-green">已接受');
    expect(html).toContain('作者 · 由 林默 邀请于 10/23 18:07 · 到期 10/26 18:07');
    expect(html).toContain('审阅者 · 由 林默 邀请于 10/23 18:07 · 到期 10/26 18:07');
    expect(html.match(/>撤销<\/button>/g)?.length).toBe(1);
  });

  it('主笔看不到角色下拉与移除，可邀请角色排除所有者与主笔', () => {
    const html = render({
      role: 'lead',
      members: [
        member({ role: 'lead' }),
        member({
          userId: 'user-2',
          email: 'shen@example.com',
          name: '沈舟',
          role: 'author',
          joinedAt: '2026-10-22T09:00:00.000Z',
        }),
      ],
    });

    expect(html).toContain('主笔可查看成员并邀请作者、审阅者、读者或计费管理员');
    expect(html).toContain('<select');
    expect(html.match(/<select/g)?.length).toBe(2);
    expect(html).not.toContain('>移除</button>');
    expect(html).not.toContain('<option value="owner">');
    expect(html).not.toContain('<option value="lead">');
    expect(html).toMatch(/<option value="author"[^>]*>作者 · 写稿、跑门禁、提交自己的章节<\/option>/);
    expect(html).toContain('<option value="reviewer">审阅者 · 阅读、评论、跑审计；不直接入库</option>');
    expect(html).toContain('<option value="viewer">读者 · 只读</option>');
    expect(html).toContain('<option value="billing">计费管理员 · 供应商与预算；不接触正文</option>');
    expect(html.match(/badge-neutral/g)?.length).toBe(2);
  });

  it('没有邀请时明确说还没有发出邀请', () => {
    const html = render({ invites: [] });

    expect(html).toContain('<h4>最近邀请 · 0</h4>');
    expect(html).toContain('还没有发出邀请。');
    expect(html).not.toContain('badge-amber">待接受');
  });

  it('四种邀请状态各有中文与色调，只有待接受能撤销', () => {
    const html = render({
      invites: [invite('pending'), invite('accepted'), invite('expired'), invite('revoked')],
    });

    expect(html).toContain('<h4>最近邀请 · 4</h4>');
    expect(html).toContain('badge-amber">待接受');
    expect(html).toContain('badge-green">已接受');
    expect(html.match(/badge-muted">已过期/g)?.length).toBe(1);
    expect(html.match(/badge-muted">已撤销/g)?.length).toBe(1);
    expect(html.match(/>撤销<\/button>/g)?.length).toBe(1);
  });

  it('AI 主体只显示角色徽标，不给角色下拉与移除', () => {
    const html = render({
      members: [
        member(),
        member({ userId: 'ai-1', email: 'ai@example.com', name: 'AI 主编', role: 'ai', kind: 'ai' }),
      ],
    });

    expect(html).toContain('<h3>成员 · 2</h3>');
    expect(html.match(/badge-ink">AI 主体/g)?.length).toBe(2);
    expect(html.match(/>移除<\/button>/g)?.length).toBe(1);
    expect(html.match(/<select/g)?.length).toBe(3);
  });
});
