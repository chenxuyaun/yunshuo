import { useQuery } from '@tanstack/react-query';
import { ApiError, getForeshadowingReminders } from '../api.js';
import {
  FORESHADOWING_IMPORTANCE_LABELS,
  FORESHADOWING_STATE_LABELS,
  payoffWindowLabel,
} from '../ledger.js';
import { Badge } from './Badge.js';

interface Props {
  chapterId: string;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

export function ForeshadowingReminderCard({ chapterId }: Props) {
  const remindersQuery = useQuery({
    queryKey: ['foreshadowingReminders', chapterId],
    queryFn: () => getForeshadowingReminders(chapterId),
    retry: false,
  });

  const data = remindersQuery.data;

  return (
    <section className="panel foreshadowing-reminder-panel">
      <header className="panel-head">
        <div>
          <p className="eyebrow">本章计划</p>
          <h2>伏笔提醒</h2>
        </div>
        {data ? (
          <Badge tone={data.reminders.length > 0 ? 'amber' : 'muted'}>
            {data.reminders.length} 条
          </Badge>
        ) : null}
      </header>

      {remindersQuery.isLoading ? (
        <p className="muted">正在读取已发布伏笔台账……</p>
      ) : remindersQuery.isError ? (
        <p className="index-error">读取失败：{formatError(remindersQuery.error)}</p>
      ) : data ? (
        <>
          <p className="foreshadowing-reminder-note">
            本章为第 {data.chapter.number} 章
            {data.latestCanonChapter
              ? `；当前正典已到第 ${data.latestCanonChapter.number} 章 · ${data.latestCanonChapter.title}。`
              : '；当前还没有正典章节。'}
          </p>

          {data.reminders.length === 0 ? (
            <p className="muted">
              {data.note}
            </p>
          ) : (
            <ul className="foreshadowing-reminder-list">
              {data.reminders.map((reminder) => (
                <li
                  key={`${reminder.id}-${reminder.reason}`}
                  className={`foreshadowing-reminder-item foreshadowing-reminder-${reminder.reason}`}
                >
                  <div className="foreshadowing-reminder-head">
                    <strong>{reminder.name}</strong>
                    <Badge tone={reminder.reason === 'overdue' ? 'red' : 'amber'}>
                      {reminder.reason === 'overdue' ? '已逾期' : '进入回收窗口'}
                    </Badge>
                    <Badge tone="neutral">
                      {FORESHADOWING_STATE_LABELS[reminder.state]}
                    </Badge>
                    <span className="muted">
                      重要度 {FORESHADOWING_IMPORTANCE_LABELS[reminder.importance]}
                    </span>
                  </div>
                  <p className="foreshadowing-reminder-message">{reminder.message}</p>
                  <p className="foreshadowing-reminder-meta">
                    埋设于第 {reminder.seedChapter.number} 章 ·{' '}
                    {reminder.seedChapter.title}
                    {' · '}
                    计划回收 {payoffWindowLabel(reminder.payoffChapterMin, reminder.payoffChapterMax)}
                  </p>
                  {reminder.note ? (
                    <p className="foreshadowing-reminder-text">{reminder.note}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <p className="muted foreshadowing-reminder-foot">{data.note}</p>
        </>
      ) : null}
    </section>
  );
}
