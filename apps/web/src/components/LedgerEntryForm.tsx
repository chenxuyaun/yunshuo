import { useState, type FormEvent } from 'react';
import type {
  ChapterListItem,
  LedgerEntryScope,
  LedgerEntrySnapshot,
  LedgerSettingCategory,
  LedgerSettingPayload,
  LedgerVerificationState,
} from '@yunshuo/contracts';
import {
  LEDGER_SCOPE_LABELS,
  SETTING_CATEGORY_LABELS,
  VERIFICATION_LABELS,
  isSettingPayload,
  parseListInput,
} from '../ledger.js';
import { Badge } from './Badge.js';

export interface LedgerDraftInput {
  workId: string | null;
  name: string;
  aliases: string[];
  summary: string;
  sourceChapterId: string | null;
  payload: LedgerSettingPayload;
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
  onSubmit: (input: LedgerDraftInput) => void;
  onCancel: () => void;
}

const CATEGORIES = Object.keys(SETTING_CATEGORY_LABELS) as LedgerSettingCategory[];
const VERIFICATIONS = Object.keys(VERIFICATION_LABELS) as LedgerVerificationState[];

export function LedgerEntryForm({
  initial,
  initialWorkId,
  works,
  chapters,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const [scope, setScope] = useState<LedgerEntryScope>(
    initialWorkId ? 'work' : 'workspace',
  );
  const [workId, setWorkId] = useState(initialWorkId ?? works[0]?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('，') ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [sourceChapterId, setSourceChapterId] = useState(initial?.sourceChapterId ?? '');
  const [category, setCategory] = useState<LedgerSettingCategory>(
    initial && isSettingPayload(initial.payload) ? initial.payload.category : 'world',
  );
  const [verification, setVerification] = useState<LedgerVerificationState>(
    initial && isSettingPayload(initial.payload) ? initial.payload.verification : 'unverified',
  );
  const [details, setDetails] = useState(
    initial && isSettingPayload(initial.payload) ? initial.payload.details : '',
  );
  const [tags, setTags] = useState(
    initial && isSettingPayload(initial.payload) ? initial.payload.tags.join('，') : '',
  );
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const scopeLocked = initial !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写名称。');
      return;
    }
    const aliasList = parseListInput(aliases);
    if (aliasList.length > 20) {
      setError('别名最多 20 个。');
      return;
    }
    const tagList = parseListInput(tags);
    if (tagList.length > 20) {
      setError('标签最多 20 个。');
      return;
    }
    if (scope === 'work' && !workId) {
      setError('请选择条目所属作品。');
      return;
    }
    setError(null);
    onSubmit({
      workId: scope === 'work' ? workId : null,
      name: trimmedName,
      aliases: aliasList,
      summary: summary.trim(),
      sourceChapterId: sourceChapterId || null,
      payload: {
        category,
        details: details.trim(),
        tags: tagList,
        verification,
      },
      changeSummary: changeSummary.trim(),
    });
  }

  const chapterOptions =
    scope === 'work' && workId
      ? chapters.filter((chapter) => chapter.workId === workId)
      : chapters;

  return (
    <form className="ledger-form" onSubmit={handleSubmit}>
      <div className="ledger-form-head">
        <div>
          <p className="eyebrow">{initial ? '编辑设定草稿' : '新建设定'}</p>
          <h3>{initial ? initial.name : '登记一条世界观事实'}</h3>
        </div>
        <Badge tone="ink">设定</Badge>
      </div>

      {error ? <div className="modal-error">{error}</div> : null}

      <div className="field-grid">
        <label className="field">
          <span>名称</span>
          <input
            value={name}
            maxLength={120}
            required
            placeholder="例如：北境王城"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>别名（用逗号分隔）</span>
          <input
            value={aliases}
            placeholder="例如：白城，旧都"
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
          <span>归属</span>
          <select
            value={scope === 'work' ? workId : 'workspace'}
            disabled={scopeLocked || submitting}
            onChange={(event) => {
              if (event.target.value === 'workspace') {
                setScope('workspace');
                setSourceChapterId('');
              } else {
                setScope('work');
                setWorkId(event.target.value);
              }
            }}
          >
            <option value="workspace">工作区通用 · 所有作品共享</option>
            {works.map((work) => (
              <option key={work.id} value={work.id}>
                作品专属 · {work.title}
              </option>
            ))}
          </select>
          {scopeLocked ? (
            <small>归属在条目创建后不可更改；{LEDGER_SCOPE_LABELS[scope]}。</small>
          ) : null}
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
                {scope === 'workspace'
                  ? `${chapter.workTitle} · 第 ${chapter.number} 章 · ${chapter.title}`
                  : `第 ${chapter.number} 章 · ${chapter.title}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>分类</span>
          <select
            value={category}
            disabled={submitting}
            onChange={(event) => setCategory(event.target.value as LedgerSettingCategory)}
          >
            {CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {SETTING_CATEGORY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>核实状态</span>
          <select
            value={verification}
            disabled={submitting}
            onChange={(event) =>
              setVerification(event.target.value as LedgerVerificationState)
            }
          >
            {VERIFICATIONS.map((option) => (
              <option key={option} value={option}>
                {VERIFICATION_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>详细说明</span>
        <textarea
          value={details}
          rows={9}
          maxLength={20_000}
          placeholder="记录这个世界观事实的边界、例证与禁止事项；不要写入未确认的推测。"
          onChange={(event) => setDetails(event.target.value)}
        />
      </label>

      <label className="field">
        <span>标签（用逗号分隔）</span>
        <input
          value={tags}
          placeholder="例如：地理，王权，第一卷"
          onChange={(event) => setTags(event.target.value)}
        />
      </label>

      {initial ? (
        <label className="field">
          <span>本次修改说明（可选）</span>
          <input
            value={changeSummary}
            maxLength={500}
            placeholder="例如：补上王城与北境军的关系"
            onChange={(event) => setChangeSummary(event.target.value)}
          />
        </label>
      ) : null}

      <p className="ledger-form-hint">
        创建与编辑只写入草稿；发布后才会成为生效版本。已发布版本不可修改，回滚会生成新的草稿。
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
