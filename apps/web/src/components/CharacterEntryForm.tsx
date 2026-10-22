import { useRef, useState, type FormEvent } from 'react';
import type {
  ChapterListItem,
  LedgerCharacterLifeState,
  LedgerCharacterPayload,
  LedgerEntrySnapshot,
} from '@yunshuo/contracts';
import {
  CHARACTER_LIFE_LABELS,
  isCharacterPayload,
  parseListInput,
} from '../ledger.js';
import { Badge } from './Badge.js';

export interface CharacterDraftInput {
  workId: string;
  name: string;
  aliases: string[];
  summary: string;
  sourceChapterId: string | null;
  payload: LedgerCharacterPayload;
  changeSummary: string;
}

interface WorkOption {
  id: string;
  title: string;
}

interface Props {
  initial: LedgerEntrySnapshot | null;
  initialWorkId: string | null;
  works: WorkOption[];
  chapters: ChapterListItem[];
  submitting: boolean;
  onSubmit: (input: CharacterDraftInput) => void;
  onCancel: () => void;
}

const LIFE_STATES = Object.keys(CHARACTER_LIFE_LABELS) as LedgerCharacterLifeState[];

let rowKey = 0;
function nextKey(): string {
  rowKey += 1;
  return `row-${rowKey}`;
}

interface RelationshipRow {
  key: string;
  name: string;
  relation: string;
  notes: string;
}

interface StateRow {
  key: string;
  asOfChapterId: string;
  life: LedgerCharacterLifeState;
  location: string;
  knowledge: string;
  possessions: string;
  relationshipChanges: string;
}

export function CharacterEntryForm({
  initial,
  initialWorkId,
  works,
  chapters,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const initialPayload =
    initial && isCharacterPayload(initial.payload) ? initial.payload : null;
  const initialWork = initialWorkId ?? works[0]?.id ?? '';

  const [workId, setWorkId] = useState(initialWork);
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('，') ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [sourceChapterId, setSourceChapterId] = useState(initial?.sourceChapterId ?? '');
  const [role, setRole] = useState(initialPayload?.role ?? '');
  const [appearance, setAppearance] = useState(initialPayload?.appearance ?? '');
  const [personality, setPersonality] = useState(initialPayload?.personality ?? '');
  const [goals, setGoals] = useState(initialPayload?.goals ?? '');
  const [faction, setFaction] = useState(initialPayload?.faction ?? '');
  const [abilities, setAbilities] = useState(initialPayload?.abilities ?? '');
  const [speechStyle, setSpeechStyle] = useState(initialPayload?.speechStyle ?? '');
  const [relationships, setRelationships] = useState<RelationshipRow[]>(() =>
    (initialPayload?.relationships ?? []).map((relationship) => ({
      key: nextKey(),
      ...relationship,
    })),
  );
  const [states, setStates] = useState<StateRow[]>(() =>
    (initialPayload?.states ?? []).map((state) => ({
      key: nextKey(),
      ...state,
    })),
  );
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const workLocked = initial !== null;
  const chapterOptions = chapters
    .filter((chapter) => chapter.workId === workId)
    .sort((left, right) => left.number - right.number);
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const usedChapterIds = new Set(states.map((state) => state.asOfChapterId).filter(Boolean));
  const unusedChapter = chapterOptions.find((chapter) => !usedChapterIds.has(chapter.id));

  function chapterLabel(chapterId: string): string {
    const chapter = chapterById.get(chapterId);
    return chapter ? `第 ${chapter.number} 章 · ${chapter.title}` : '未知章节';
  }

  function updateState(key: string, patch: Partial<StateRow>) {
    setStates((current) =>
      current.map((state) => (state.key === key ? { ...state, ...patch } : state)),
    );
  }

  function updateRelationship(key: string, patch: Partial<RelationshipRow>) {
    setRelationships((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function handleWorkChange(nextWorkId: string) {
    setWorkId(nextWorkId);
    setSourceChapterId('');
    setStates([]);
  }

  function handleAddState() {
    setError(null);
    if (!unusedChapter) {
      setError('该作品的每个章节都已登记状态，或作品还没有章节。');
      return;
    }
    setStates((current) => [
      ...current,
      {
        key: nextKey(),
        asOfChapterId: unusedChapter.id,
        life: 'unknown',
        location: '',
        knowledge: '',
        possessions: '',
        relationshipChanges: '',
      },
    ]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写角色名称。');
      return;
    }
    if (!workId) {
      setError('角色档案必须归属于一个作品。');
      return;
    }
    const aliasList = parseListInput(aliases);
    if (aliasList.length > 20) {
      setError('别名最多 20 个。');
      return;
    }
    if (relationships.length > 50) {
      setError('关系最多 50 条。');
      return;
    }
    if (states.length > 200) {
      setError('状态时间线最多 200 条。');
      return;
    }

    const relationshipPayload: LedgerCharacterPayload['relationships'] = [];
    for (const row of relationships) {
      const person = row.name.trim();
      const relation = row.relation.trim();
      if (!person && !relation && !row.notes.trim()) continue;
      if (!person || !relation) {
        setError('每条关系都需要填写姓名与关系；留空的行会被忽略。');
        return;
      }
      if (person.length > 200 || relation.length > 200) {
        setError('关系中的姓名与关系描述不能超过 200 字。');
        return;
      }
      if (row.notes.trim().length > 1000) {
        setError('关系备注不能超过 1000 字。');
        return;
      }
      relationshipPayload.push({
        name: person,
        relation,
        notes: row.notes.trim(),
      });
    }

    const chapterIds = new Set<string>();
    const statePayload: LedgerCharacterPayload['states'] = [];
    for (const row of states) {
      if (!row.asOfChapterId) {
        setError('每条状态都必须绑定章节。');
        return;
      }
      if (chapterIds.has(row.asOfChapterId)) {
        setError(`章节「${chapterLabel(row.asOfChapterId)}」重复登记了状态，请合并为一条。`);
        return;
      }
      chapterIds.add(row.asOfChapterId);
      statePayload.push({
        asOfChapterId: row.asOfChapterId,
        life: row.life,
        location: row.location.trim(),
        knowledge: row.knowledge.trim(),
        possessions: row.possessions.trim(),
        relationshipChanges: row.relationshipChanges.trim(),
      });
    }
    statePayload.sort(
      (left, right) =>
        (chapterById.get(left.asOfChapterId)?.number ?? 0) -
        (chapterById.get(right.asOfChapterId)?.number ?? 0),
    );

    setError(null);
    onSubmit({
      workId,
      name: trimmedName,
      aliases: aliasList,
      summary: summary.trim(),
      sourceChapterId: sourceChapterId || null,
      payload: {
        role: role.trim(),
        appearance: appearance.trim(),
        personality: personality.trim(),
        goals: goals.trim(),
        faction: faction.trim(),
        abilities: abilities.trim(),
        speechStyle: speechStyle.trim(),
        relationships: relationshipPayload,
        states: statePayload,
      },
      changeSummary: changeSummary.trim(),
    });
  }

  return (
    <form className="ledger-form" onSubmit={handleSubmit}>
      <div className="ledger-form-head">
        <div>
          <p className="eyebrow">{initial ? '编辑角色草稿' : '新建角色档案'}</p>
          <h3>{initial ? initial.name : '登记一个会随时间变化的角色'}</h3>
        </div>
        <Badge tone="ink">角色</Badge>
      </div>

      {error ? <div className="modal-error">{error}</div> : null}

      <div className="field-grid">
        <label className="field">
          <span>名称</span>
          <input
            value={name}
            maxLength={120}
            required
            placeholder="例如：林默"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>别名（用逗号分隔）</span>
          <input
            value={aliases}
            placeholder="例如：默哥，林七"
            onChange={(event) => setAliases(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>一句话摘要</span>
        <input
          value={summary}
          maxLength={2000}
          placeholder="给写作者看的一句话说明"
          onChange={(event) => setSummary(event.target.value)}
        />
      </label>

      <div className="field-grid">
        <label className="field">
          <span>所属作品</span>
          <select
            value={workId}
            disabled={workLocked || submitting}
            onChange={(event) => handleWorkChange(event.target.value)}
          >
            {works.map((work) => (
              <option key={work.id} value={work.id}>
                {work.title}
              </option>
            ))}
          </select>
          <small>
            角色档案必须归属作品；归属在创建后不可更改。
            {workLocked ? '' : '切换作品会清空已填写的状态时间线。'}
          </small>
        </label>
        <label className="field">
          <span>来源章节（可选）</span>
          <select
            value={sourceChapterId}
            disabled={submitting}
            onChange={(event) => setSourceChapterId(event.target.value)}
          >
            <option value="">不关联章节</option>
            {chapterOptions.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                第 {chapter.number} 章 · {chapter.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="ledger-form-section">
        <div className="ledger-form-section-head">
          <h4>角色卡</h4>
          <span className="muted">静态档案，不随时间线变化</span>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>身份</span>
            <input
              value={role}
              maxLength={80}
              placeholder="例如：主角 / 北境军斥候"
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <label className="field">
            <span>阵营</span>
            <input
              value={faction}
              maxLength={200}
              placeholder="例如：北境军"
              onChange={(event) => setFaction(event.target.value)}
            />
          </label>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>外貌</span>
            <textarea
              value={appearance}
              rows={2}
              maxLength={5000}
              onChange={(event) => setAppearance(event.target.value)}
            />
          </label>
          <label className="field">
            <span>性格</span>
            <textarea
              value={personality}
              rows={2}
              maxLength={5000}
              onChange={(event) => setPersonality(event.target.value)}
            />
          </label>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>目标</span>
            <textarea
              value={goals}
              rows={2}
              maxLength={5000}
              onChange={(event) => setGoals(event.target.value)}
            />
          </label>
          <label className="field">
            <span>能力</span>
            <textarea
              value={abilities}
              rows={2}
              maxLength={5000}
              onChange={(event) => setAbilities(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>语言风格</span>
          <input
            value={speechStyle}
            maxLength={2000}
            placeholder="例如：话少，常用短句"
            onChange={(event) => setSpeechStyle(event.target.value)}
          />
        </label>
      </section>

      <section className="ledger-form-section">
        <div className="ledger-form-section-head">
          <div>
            <h4>人物关系</h4>
            <p>同名对象可以记录多种关系，时间线里说明变化时点；系统会对冲突给出警告，但不会阻断发布。</p>
          </div>
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={submitting || relationships.length >= 50}
            onClick={() =>
              setRelationships((current) => [
                ...current,
                { key: nextKey(), name: '', relation: '', notes: '' },
              ])
            }
          >
            添加关系
          </button>
        </div>
        {relationships.length === 0 ? (
          <p className="empty-state">还没有登记关系。留空不会写入。</p>
        ) : (
          <div className="ledger-relationship-list">
            {relationships.map((row) => (
              <div key={row.key} className="ledger-relationship-row">
                <label className="field">
                  <span>对象</span>
                  <input
                    value={row.name}
                    maxLength={200}
                    placeholder="例如：苏晚"
                    onChange={(event) => updateRelationship(row.key, { name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>关系</span>
                  <input
                    value={row.relation}
                    maxLength={200}
                    placeholder="例如：同门"
                    onChange={(event) =>
                      updateRelationship(row.key, { relation: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>备注</span>
                  <input
                    value={row.notes}
                    maxLength={1000}
                    placeholder="可选"
                    onChange={(event) =>
                      updateRelationship(row.key, { notes: event.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button button-quiet button-small ledger-row-remove"
                  disabled={submitting}
                  onClick={() =>
                    setRelationships((current) => current.filter((item) => item.key !== row.key))
                  }
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ledger-form-section">
        <div className="ledger-form-section-head">
          <div>
            <h4>状态时间线</h4>
            <p>
              每条状态绑定「截至第 N 章」。写作台只展示上一章之前的最新状态，后续章节的状态不会提前出现。
            </p>
          </div>
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={submitting || states.length >= 200 || !unusedChapter}
            onClick={handleAddState}
          >
            添加状态
          </button>
        </div>
        {chapterOptions.length === 0 ? (
          <p className="empty-state">该作品还没有章节，无法登记状态时间线。</p>
        ) : states.length === 0 ? (
          <p className="empty-state">
            还没有状态记录。没有时间线的角色仍可作为档案发布，但写作台不会显示其状态。
          </p>
        ) : (
          <div className="ledger-state-list">
            {states.map((row) => (
              <div key={row.key} className="ledger-state-row">
                <div className="ledger-row-head">
                  <label className="field">
                    <span>截至章节</span>
                    <select
                      value={row.asOfChapterId}
                      disabled={submitting}
                      onChange={(event) =>
                        updateState(row.key, { asOfChapterId: event.target.value })
                      }
                    >
                      {chapterOptions.map((chapter) => {
                        const taken =
                          usedChapterIds.has(chapter.id) &&
                          chapter.id !== row.asOfChapterId;
                        return (
                          <option key={chapter.id} value={chapter.id} disabled={taken}>
                            第 {chapter.number} 章 · {chapter.title}
                            {taken ? '（已登记）' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="field">
                    <span>生死状态</span>
                    <select
                      value={row.life}
                      disabled={submitting}
                      onChange={(event) =>
                        updateState(row.key, {
                          life: event.target.value as LedgerCharacterLifeState,
                        })
                      }
                    >
                      {LIFE_STATES.map((life) => (
                        <option key={life} value={life}>
                          {CHARACTER_LIFE_LABELS[life]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button button-quiet button-small ledger-row-remove"
                    disabled={submitting}
                    onClick={() =>
                      setStates((current) => current.filter((item) => item.key !== row.key))
                    }
                  >
                    移除
                  </button>
                </div>
                <div className="field-grid">
                  <label className="field">
                    <span>地点</span>
                    <input
                      value={row.location}
                      maxLength={200}
                      placeholder="例如：王城"
                      onChange={(event) =>
                        updateState(row.key, { location: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>持有物</span>
                    <input
                      value={row.possessions}
                      maxLength={2000}
                      placeholder="例如：一枚旧徽章"
                      onChange={(event) =>
                        updateState(row.key, { possessions: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="field">
                  <span>已知信息</span>
                  <textarea
                    value={row.knowledge}
                    rows={2}
                    maxLength={5000}
                    placeholder="截至这一章，角色已经知道什么；不要写入后续章节才揭示的信息。"
                    onChange={(event) =>
                      updateState(row.key, { knowledge: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>关系变化</span>
                  <textarea
                    value={row.relationshipChanges}
                    rows={2}
                    maxLength={2000}
                    placeholder="例如：与苏晚决裂"
                    onChange={(event) =>
                      updateState(row.key, { relationshipChanges: event.target.value })
                    }
                  />
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      {initial ? (
        <label className="field">
          <span>本次修改说明（可选）</span>
          <input
            value={changeSummary}
            maxLength={500}
            placeholder="例如：补充第 3 章后的伤势与所在地"
            onChange={(event) => setChangeSummary(event.target.value)}
          />
        </label>
      ) : null}

      <p className="ledger-form-hint">
        创建与编辑只写入草稿；发布后才会成为生效版本。角色时间线、出场扫描与矛盾警告都在发布后生成。
      </p>

      <div className="ledger-form-actions">
        <button type="button" className="button button-quiet" disabled={submitting} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button button-primary" disabled={submitting}>
          {submitting ? '保存中…' : initial ? '保存草稿' : '创建草稿'}
        </button>
      </div>
    </form>
  );
}
