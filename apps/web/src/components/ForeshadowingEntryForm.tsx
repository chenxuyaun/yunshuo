import { useState, type FormEvent } from 'react';
import type {
  ChapterListItem,
  LedgerEntrySnapshot,
  LedgerForeshadowingImportance,
  LedgerForeshadowingPayload,
  LedgerForeshadowingState,
} from '@yunshuo/contracts';
import {
  FORESHADOWING_IMPORTANCE_LABELS,
  FORESHADOWING_STATE_LABELS,
  FORESHADOWING_TRANSITIONS,
  isForeshadowingPayload,
  parseListInput,
} from '../ledger.js';
import { Badge } from './Badge.js';

export interface ForeshadowingDraftInput {
  workId: string;
  name: string;
  aliases: string[];
  summary: string;
  sourceChapterId: string | null;
  payload: LedgerForeshadowingPayload;
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
  onSubmit: (input: ForeshadowingDraftInput) => void;
  onCancel: () => void;
}

const STATE_ORDER: LedgerForeshadowingState[] = [
  'planted',
  'reinforced',
  'paid_off',
  'abandoned',
];
const IMPORTANCE_ORDER: LedgerForeshadowingImportance[] = ['low', 'medium', 'high'];

function parseOptionalChapter(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99_999) return 'invalid';
  return parsed;
}

export function ForeshadowingEntryForm({
  initial,
  initialWorkId,
  works,
  chapters,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const initialPayload =
    initial && isForeshadowingPayload(initial.payload) ? initial.payload : null;
  const initialWork = initialWorkId ?? works[0]?.id ?? '';
  const initialChapterId =
    initialPayload?.seedChapterId ??
    chapters
      .filter((chapter) => chapter.workId === initialWork)
      .sort((left, right) => left.number - right.number)[0]?.id ??
    '';

  const [workId, setWorkId] = useState(initialWork);
  const [name, setName] = useState(initial?.name ?? '');
  const [aliases, setAliases] = useState(initial?.aliases.join('，') ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [sourceChapterId, setSourceChapterId] = useState(initial?.sourceChapterId ?? '');
  const [seedChapterId, setSeedChapterId] = useState(initialChapterId);
  const [payoffChapterMin, setPayoffChapterMin] = useState(
    initialPayload?.payoffChapterMin?.toString() ?? '',
  );
  const [payoffChapterMax, setPayoffChapterMax] = useState(
    initialPayload?.payoffChapterMax?.toString() ?? '',
  );
  const [importance, setImportance] = useState<LedgerForeshadowingImportance>(
    initialPayload?.importance ?? 'medium',
  );
  const [state, setState] = useState<LedgerForeshadowingState>(
    initialPayload?.state ?? 'planted',
  );
  const [payoffChapterId, setPayoffChapterId] = useState(
    initialPayload?.payoffChapterId ?? '',
  );
  const [note, setNote] = useState(initialPayload?.note ?? '');
  const [resolutionNote, setResolutionNote] = useState(
    initialPayload?.resolutionNote ?? '',
  );
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const workLocked = initial !== null;
  const chapterOptions = chapters
    .filter((chapter) => chapter.workId === workId)
    .sort((left, right) => left.number - right.number);
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const allowedStates = initialPayload
    ? FORESHADOWING_TRANSITIONS[initialPayload.state]
    : STATE_ORDER;
  const terminal = state === 'paid_off' || state === 'abandoned';

  function chapterLabel(chapterId: string): string {
    const chapter = chapterById.get(chapterId);
    return chapter ? `第 ${chapter.number} 章 · ${chapter.title}` : '未知章节';
  }

  function chapterNumber(chapterId: string): number {
    return chapterById.get(chapterId)?.number ?? 0;
  }

  function handleWorkChange(nextWorkId: string): void {
    setWorkId(nextWorkId);
    setSourceChapterId('');
    const first = chapters
      .filter((chapter) => chapter.workId === nextWorkId)
      .sort((left, right) => left.number - right.number)[0];
    setSeedChapterId(first?.id ?? '');
    setPayoffChapterMin('');
    setPayoffChapterMax('');
    setPayoffChapterId('');
  }

  function handleStateChange(nextState: LedgerForeshadowingState): void {
    setState(nextState);
    if (nextState !== 'paid_off') setPayoffChapterId('');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写伏笔名称或简述。');
      return;
    }
    if (!workId) {
      setError('伏笔台账必须归属于一个作品。');
      return;
    }
    if (!seedChapterId) {
      setError('必须选择埋设章节。');
      return;
    }
    const min = parseOptionalChapter(payoffChapterMin);
    const max = parseOptionalChapter(payoffChapterMax);
    if (min === 'invalid' || max === 'invalid') {
      setError('计划回收窗口必须填写正整数章节号，或留空。');
      return;
    }
    if (min !== null && max !== null && min > max) {
      setError('计划回收起始章不能大于结束章。');
      return;
    }
    const seedNumber = chapterNumber(seedChapterId);
    if (!seedNumber) {
      setError('埋设章节不属于当前作品，请重新选择。');
      return;
    }
    if ((min !== null && min < seedNumber) || (max !== null && max < seedNumber)) {
      setError('计划回收窗口不能早于埋设章节。');
      return;
    }
    if (state === 'paid_off') {
      if (!payoffChapterId) {
        setError('已回收伏笔必须选择回收章节。');
        return;
      }
      const payoffNumber = chapterNumber(payoffChapterId);
      if (!payoffNumber) {
        setError('回收章节不属于当前作品，请重新选择。');
        return;
      }
      if (payoffNumber < seedNumber) {
        setError('回收章节不能早于埋设章节。');
        return;
      }
      if (
        (min !== null && payoffNumber < min) ||
        (max !== null && payoffNumber > max)
      ) {
        setError('回收章节不在计划回收窗口内；请调整窗口或回收章节。');
        return;
      }
      if (resolutionNote.trim().length < 4) {
        setError('已回收伏笔必须填写至少 4 个字的回收说明。');
        return;
      }
    }
    if (state === 'abandoned' && resolutionNote.trim().length < 4) {
      setError('已放弃伏笔必须填写至少 4 个字的放弃原因。');
      return;
    }
    const aliasList = parseListInput(aliases);
    if (aliasList.length > 20) {
      setError('别名最多 20 个。');
      return;
    }

    setError(null);
    onSubmit({
      workId,
      name: trimmedName,
      aliases: aliasList,
      summary: summary.trim(),
      sourceChapterId: sourceChapterId || null,
      payload: {
        seedChapterId,
        payoffChapterMin: min,
        payoffChapterMax: max,
        importance,
        state,
        payoffChapterId: state === 'paid_off' ? payoffChapterId : null,
        note: note.trim(),
        resolutionNote: resolutionNote.trim(),
      },
      changeSummary: changeSummary.trim(),
    });
  }

  return (
    <form className="ledger-form" onSubmit={handleSubmit}>
      <div className="ledger-form-head">
        <div>
          <p className="eyebrow">{initial ? '编辑伏笔草稿' : '新建伏笔'}</p>
          <h3>{initial ? initial.name : '登记一条需要回收的伏笔'}</h3>
        </div>
        <Badge tone="ink">伏笔</Badge>
      </div>

      {error ? <div className="modal-error">{error}</div> : null}

      <div className="field-grid">
        <label className="field">
          <span>名称 / 简述</span>
          <input
            value={name}
            maxLength={120}
            required
            placeholder="例如：旧徽章的纹章"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>别名（用逗号分隔）</span>
          <input
            value={aliases}
            placeholder="例如：王室徽记"
            onChange={(event) => setAliases(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>一句话摘要</span>
        <input
          value={summary}
          maxLength={2000}
          placeholder="给写作者看的一句话提醒"
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
            伏笔必须归属作品；归属在创建后不可更改。
            {workLocked ? '' : '切换作品会清空埋设章节与计划窗口。'}
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
          <div>
            <h4>埋设与回收窗口</h4>
            <p>
              计划窗口只用于提醒与逾期判断，不会自动改写章节；结束章留空时不会判定逾期。
            </p>
          </div>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>埋设章节</span>
            <select
              value={seedChapterId}
              disabled={submitting}
              onChange={(event) => setSeedChapterId(event.target.value)}
            >
              <option value="">请选择章节</option>
              {chapterOptions.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  第 {chapter.number} 章 · {chapter.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>重要度</span>
            <select
              value={importance}
              disabled={submitting}
              onChange={(event) =>
                setImportance(event.target.value as LedgerForeshadowingImportance)
              }
            >
              {IMPORTANCE_ORDER.map((value) => (
                <option key={value} value={value}>
                  {FORESHADOWING_IMPORTANCE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>计划回收起始章</span>
            <input
              value={payoffChapterMin}
              inputMode="numeric"
              placeholder="可留空"
              onChange={(event) => setPayoffChapterMin(event.target.value)}
            />
          </label>
          <label className="field">
            <span>计划回收结束章</span>
            <input
              value={payoffChapterMax}
              inputMode="numeric"
              placeholder="可留空；填写后用于逾期判断"
              onChange={(event) => setPayoffChapterMax(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="ledger-form-section">
        <div className="ledger-form-section-head">
          <div>
            <h4>状态与回收</h4>
            <p>
              状态只能向前流转：已埋设 → 已强化 → 已回收 / 已放弃；已回收与已放弃不能再打开。
              需要恢复历史状态只能通过版本回滚。
            </p>
          </div>
        </div>
        <label className="field">
          <span>伏笔状态</span>
          <select
            value={state}
            disabled={submitting}
            onChange={(event) => handleStateChange(event.target.value as LedgerForeshadowingState)}
          >
            {STATE_ORDER.map((value) => {
              const allowed = allowedStates.includes(value);
              return (
                <option key={value} value={value} disabled={!allowed}>
                  {FORESHADOWING_STATE_LABELS[value]}
                  {allowed ? '' : '（不允许从当前状态流转）'}
                </option>
              );
            })}
          </select>
          {initialPayload ? (
            <small>
              当前生效状态：{FORESHADOWING_STATE_LABELS[initialPayload.state]}。
              服务端会再次校验状态流转。
            </small>
          ) : null}
        </label>

        {state === 'paid_off' ? (
          <label className="field">
            <span>回收章节</span>
            <select
              value={payoffChapterId}
              disabled={submitting}
              onChange={(event) => setPayoffChapterId(event.target.value)}
            >
              <option value="">请选择回收章节</option>
              {chapterOptions.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  第 {chapter.number} 章 · {chapter.title}
                </option>
              ))}
            </select>
            <small>
              回收章节必须在计划窗口内；当前选择：
              {payoffChapterId ? chapterLabel(payoffChapterId) : '未选择'}。
            </small>
          </label>
        ) : null}

        {terminal ? (
          <label className="field">
            <span>
              {state === 'paid_off' ? '回收说明（至少 4 个字）' : '放弃原因（至少 4 个字）'}
            </span>
            <textarea
              value={resolutionNote}
              rows={3}
              maxLength={5000}
              placeholder={
                state === 'paid_off'
                  ? '说明这一章如何回收了伏笔，避免只写“已回收”'
                  : '说明为什么放弃这条伏笔，便于以后回溯'
              }
              onChange={(event) => setResolutionNote(event.target.value)}
            />
          </label>
        ) : null}
      </section>

      <label className="field">
        <span>伏笔说明</span>
        <textarea
          value={note}
          rows={3}
          maxLength={10000}
          placeholder="记录伏笔的具体内容、线索和注意事项"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {initial ? (
        <label className="field">
          <span>本次修改说明（可选）</span>
          <input
            value={changeSummary}
            maxLength={500}
            placeholder="例如：第 12 章已回收旧徽章"
            onChange={(event) => setChangeSummary(event.target.value)}
          />
        </label>
      ) : null}

      <p className="ledger-form-hint">
        创建与编辑只写入草稿；发布后才会进入提醒与报告。已回收/已放弃状态必须填写说明，服务端会校验。
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
