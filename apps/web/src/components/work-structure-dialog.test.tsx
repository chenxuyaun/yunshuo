import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChapterListItem, WorkView } from '@yunshuo/contracts';
import { WorkStructureBody } from './WorkStructureDialog.js';

const WORKS: WorkView[] = [
  {
    id: 'work-1',
    title: '规则档案馆',
    createdAt: '2026-10-20T09:00:00.000Z',
    volumes: [
      { id: 'volume-1', number: 1, title: '上卷 · 旧城' },
      { id: 'volume-2', number: 2, title: '下卷 · 封印' },
    ],
    chapterCount: 2,
    canonCount: 1,
  },
  {
    id: 'work-2',
    title: '第二部',
    createdAt: '2026-10-21T09:00:00.000Z',
    volumes: [{ id: 'volume-9', number: 1, title: '第一卷' }],
    chapterCount: 0,
    canonCount: 0,
  },
];

function chapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: 'chapter-1',
    workId: 'work-1',
    workTitle: '规则档案馆',
    number: 1,
    title: '第一章 旧城雨夜',
    status: 'canon',
    volumeId: 'volume-1',
    volumeTitle: '上卷 · 旧城',
    planRevision: 2,
    bodyNeedsRevision: true,
    wordCount: 1200,
    currentVersionNo: 2,
    updatedAt: '2026-10-23T18:07:00.000Z',
    ...overrides,
  };
}

const CHAPTERS: ChapterListItem[] = [
  chapter(),
  chapter({
    id: 'chapter-2',
    number: 2,
    title: '第二章 封印之前',
    status: 'planned',
    volumeId: 'volume-2',
    volumeTitle: '下卷 · 封印',
    planRevision: 0,
    bodyNeedsRevision: false,
    wordCount: null,
    currentVersionNo: null,
  }),
];

function render(
  overrides: Partial<Parameters<typeof WorkStructureBody>[0]> = {},
): string {
  return renderToStaticMarkup(
    <WorkStructureBody
      canManage
      works={WORKS}
      chapters={CHAPTERS}
      selectedWorkId="work-1"
      loading={false}
      error={null}
      busy={false}
      onSelectWork={() => {}}
      onCreateWork={() => {}}
      onRenameWork={() => {}}
      onCreateVolume={() => {}}
      onRenameVolume={() => {}}
      onMoveVolume={() => {}}
      onCreateChapter={() => {}}
      onRenameChapter={() => {}}
      onMoveChapter={() => {}}
      {...overrides}
    />,
  );
}

describe('WorkStructureBody', () => {
  it('还没有作品时给出开书提示与新建入口', () => {
    const html = render({ works: [], chapters: [], selectedWorkId: null });

    expect(html).toContain('<span class="muted">0 部</span>');
    expect(html).toContain('还没有作品。先新建一部作品，再建卷与章节。');
    expect(html).toContain('placeholder="新作品名"');
    expect(html).toContain('>新建作品</button>');
    expect(html).not.toContain('structure-volumes');
  });

  it('作品列表显示卷章与正典计数，当前作品可改名', () => {
    const html = render();

    expect(html).toContain('<span class="muted">2 部</span>');
    expect(html).toContain('<strong>规则档案馆</strong>');
    expect(html).toContain('2 卷 · 2 章 · 正典 1');
    expect(html).toContain('<strong>第二部</strong>');
    expect(html).toContain('1 卷 · 0 章 · 正典 0');
    expect(html).toContain('class="structure-work is-active"');
    expect(html).toContain('创建于 2026/10/20');
    expect(html).toContain('aria-label="作品名"');
    expect(html).toContain('>改名</button>');
  });

  it('卷按编号列出，首尾的上下移按钮各自禁用', () => {
    const html = render();

    expect(html).toContain('<span class="mono">第 1 卷</span>');
    expect(html).toContain('<span class="mono">第 2 卷</span>');
    expect(html).toContain('上卷 · 旧城');
    expect(html).toContain('下卷 · 封印');
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" aria-label="上移第 1 卷" title="上移" disabled="">↑</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button button-quiet button-small" aria-label="下移第 2 卷" title="下移" disabled="">↓</button>',
    );
    expect(html).toContain('placeholder="新卷名（卷号自动取下一个）"');
  });

  it('章节行带卷归属、待改稿标记与正典版本，插入提示跟随所选章', () => {
    const html = render();

    expect(html).toContain('章号按全书排序；插入或移卷会重排章号，正典不改');
    expect(html).toContain('<span class="mono">第 1 章</span>');
    expect(html).toContain('第一章 旧城雨夜');
    expect(html).toContain('<span class="chapter-flag">待改稿</span>');
    expect(html).toContain('<span class="muted">正典 v2</span>');
    expect(html).toContain('<span class="mono">第 2 章</span>');
    expect(html).toContain('第二章 封印之前');
    expect(html).toContain('<span class="muted">尚无正典</span>');
    expect(html).not.toContain('正典 vnull');
    expect(html).toContain('默认插在所选卷的卷末');
    expect(html).toContain('aria-label="新章节所属卷"');
    expect(html).toContain('第 1 卷 · 上卷 · 旧城');
    expect(html).toContain('aria-label="把第 1 章移到其他卷"');
    expect(html).toContain('<option value="volume-2">下卷 · 封印</option>');
    expect(html).toContain('>新建章节</button>');
  });

  it('只读角色看不到任何写入口', () => {
    const html = render({ canManage: false });

    expect(html).toContain('当前角色只读：可以查看作品、卷与章节，不能新建或调整。');
    expect(html).not.toContain('>新建作品</button>');
    expect(html).not.toContain('>新建卷</button>');
    expect(html).not.toContain('>新建章节</button>');
    expect(html).not.toContain('>改名</button>');
    expect(html).not.toContain('>在此后插入</button>');
    expect(html).not.toContain('移卷…');
  });

  it('加载、错误与卷/章节为空各有可见提示', () => {
    const loading = render({ loading: true, works: [], chapters: [], selectedWorkId: null });
    expect(loading).toContain('正在读取作品与章节结构……');

    const error = render({ error: '网络中断（NETWORK）' });
    expect(error).toContain('<div class="modal-error">网络中断（NETWORK）</div>');

    const emptyVolume = render({
      works: [
        {
          id: 'work-3',
          title: '新作品',
          createdAt: '2026-10-22T09:00:00.000Z',
          volumes: [],
          chapterCount: 0,
          canonCount: 0,
        },
      ],
      chapters: [],
      selectedWorkId: 'work-3',
    });
    expect(emptyVolume).toContain('还没有卷。');
    expect(emptyVolume).toContain('这部作品还没有章节。');
    expect(emptyVolume).toContain(
      '<button type="button" class="button button-primary button-small" disabled="">新建章节</button>',
    );
  });

  it('有作品但未选中时只提示先选作品', () => {
    const html = render({ selectedWorkId: null });

    expect(html).toContain('先选择一个作品。');
    expect(html).not.toContain('structure-volumes');
  });
});
