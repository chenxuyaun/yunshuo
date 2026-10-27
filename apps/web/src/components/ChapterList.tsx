import type { ChapterListItem } from '@yunshuo/contracts';
import { ChapterStatusBadge } from './Badge.js';

interface Props {
  chapters: ChapterListItem[];
  selectedId: string | null;
  onSelect: (chapterId: string) => void;
}

export function ChapterList({ chapters, selectedId, onSelect }: Props) {
  const groups: {
    key: string;
    workTitle: string;
    volumeTitle: string;
    chapters: ChapterListItem[];
  }[] = [];
  for (const chapter of chapters) {
    const key = `${chapter.workId}::${chapter.volumeId}`;
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = {
        key,
        workTitle: chapter.workTitle,
        volumeTitle: chapter.volumeTitle,
        chapters: [],
      };
      groups.push(group);
    }
    group.chapters.push(chapter);
  }
  const workTitles = [...new Set(chapters.map((chapter) => chapter.workTitle))];
  const active = chapters.find((chapter) => chapter.id === selectedId);
  const headline =
    workTitles.length === 1 ? workTitles[0]! : (active?.workTitle ?? '全部作品');

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <p className="eyebrow">当前作品</p>
        <h2>{headline}</h2>
        <p className="muted">同一条提交链：草稿 → 门禁 → 暂存 → 正典。</p>
      </div>

      <nav className="chapter-nav" aria-label="章节目录">
        {chapters.length === 0 ? (
          <div className="chapter-empty">
            <p>还没有章节。</p>
            <p className="muted">先在“作品与卷”里新建作品、卷与章节，或导入旧稿。</p>
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.key} className="volume-group">
            {workTitles.length > 1 ? (
              <p className="work-group-title">{group.workTitle}</p>
            ) : null}
            <h3 className="volume-title">{group.volumeTitle}</h3>
            <div className="chapter-items">
              {group.chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  className={`chapter-item${chapter.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => onSelect(chapter.id)}
                >
                  <span className="chapter-item-top">
                    <span className="chapter-no">第 {chapter.number} 章</span>
                    <ChapterStatusBadge status={chapter.status} />
                  </span>
                  <span className="chapter-name">{chapter.title}</span>
                  <span className="chapter-facts">
                    {chapter.wordCount != null ? `${chapter.wordCount} 字` : '尚无正典'}
                    {chapter.currentVersionNo != null ? ` · v${chapter.currentVersionNo}` : ''}
                  </span>
                  {chapter.bodyNeedsRevision ? (
                    <span className="chapter-flag">待改稿</span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="sidebar-foot">
        {active ? (
          <p className="sidebar-current">
            当前：{active.title}
            <br />
            <span className="muted">最近更新 {new Date(active.updatedAt).toLocaleDateString('zh-CN')}</span>
          </p>
        ) : null}
        <div className="honesty-note">
          <strong>数据口径</strong>
          <p>导入章节保留“未评估”，不伪造门禁结论；索引未接入时如实显示“未配置”。</p>
        </div>
        <div className="honesty-note honesty-note-amber">
          <strong>dev-v0 是演示规则</strong>
          <p>五门禁阈值仅用于验证链路，不是生产标准。</p>
        </div>
      </div>
    </aside>
  );
}
