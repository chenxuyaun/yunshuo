import { useQuery } from '@tanstack/react-query';
import type { LedgerCharacterLifeState } from '@yunshuo/contracts';
import { ApiError, getCharacterContext } from '../api.js';
import { CHARACTER_LIFE_LABELS } from '../ledger.js';
import { Badge, type BadgeTone } from './Badge.js';

interface Props {
  chapterId: string;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

function lifeTone(life: LedgerCharacterLifeState): BadgeTone {
  if (life === 'alive') return 'green';
  if (life === 'dead') return 'red';
  return 'neutral';
}

export function CharacterContextCard({ chapterId }: Props) {
  const contextQuery = useQuery({
    queryKey: ['characterContext', chapterId],
    queryFn: () => getCharacterContext(chapterId),
    retry: false,
  });

  const context = contextQuery.data;

  return (
    <section className="panel character-context-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">连续性</p>
          <h2>角色状态 · 截至上一章</h2>
        </div>
        {context ? (
          <Badge tone={context.characters.length > 0 ? 'ink' : 'muted'}>
            {context.characters.length} 个角色
          </Badge>
        ) : null}
      </header>

      {contextQuery.isLoading ? (
        <p className="muted">正在读取已发布角色档案……</p>
      ) : contextQuery.isError ? (
        <p className="index-error">读取失败：{formatError(contextQuery.error)}</p>
      ) : context ? (
        <>
          <p className="character-context-note">
            {context.asOfChapter
              ? `本章为第 ${context.chapter.number} 章；状态截至第 ${context.asOfChapter.number} 章 · ${context.asOfChapter.title}。`
              : `本章为开篇第 ${context.chapter.number} 章，没有上一章。`}
          </p>

          {context.characters.length === 0 ? (
            <p className="muted">
              {context.omittedCharacters > 0
                ? context.asOfChapter
                  ? '已发布的角色在上一章及之前都没有登记状态，因此没有可展示的状态；写作者需要人工确认。'
                  : '开篇没有上一章，因此不展示角色状态；写作者需要人工确认。'
                : '还没有已发布的角色档案。发布角色后，这里会显示其在上一章之前的最新状态；不会显示草稿或后续章节的状态。'}
            </p>
          ) : (
            <ul className="character-context-list">
              {context.characters.map((character) => (
                <li key={character.id} className="character-context-item">
                  <div className="character-context-head">
                    <strong>{character.name}</strong>
                    <Badge tone={lifeTone(character.state.life)}>
                      {CHARACTER_LIFE_LABELS[character.state.life]}
                    </Badge>
                    <span className="character-context-source">
                      截至第 {character.state.chapter.number} 章
                    </span>
                  </div>

                  <div className="character-context-body">
                    {character.stale ? (
                      <p className="character-context-stale">
                        状态停在更早的章节，上一章没有新的状态记录。
                      </p>
                    ) : null}
                    <dl className="character-context-grid">
                      {character.state.location ? (
                        <div>
                          <dt>地点</dt>
                          <dd>{character.state.location}</dd>
                        </div>
                      ) : null}
                      {character.state.knowledge ? (
                        <div>
                          <dt>已知</dt>
                          <dd>{character.state.knowledge}</dd>
                        </div>
                      ) : null}
                      {character.state.possessions ? (
                        <div>
                          <dt>持有</dt>
                          <dd>{character.state.possessions}</dd>
                        </div>
                      ) : null}
                      {character.state.relationshipChanges ? (
                        <div>
                          <dt>关系变化</dt>
                          <dd>{character.state.relationshipChanges}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {!character.state.location &&
                    !character.state.knowledge &&
                    !character.state.possessions &&
                    !character.state.relationshipChanges ? (
                      <p className="muted">该状态只登记了生死，没有其它细节。</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {context.characters.length > 0 && context.omittedCharacters > 0 ? (
            <p className="muted">
              另有 {context.omittedCharacters} 个已发布角色在该时点前没有状态记录，已隐藏。
            </p>
          ) : null}

          <p className="muted character-context-foot">{context.note}</p>
        </>
      ) : null}
    </section>
  );
}
