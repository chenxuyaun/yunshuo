import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BillingBreakdownView,
  BillingBudgetState,
  BillingMoneyView,
  BillingProviderPriceView,
  BillingReportResponse,
  MeResponse,
  PriceCurrency,
} from '@yunshuo/contracts';
import {
  ApiError,
  getBillingReport,
  updateBillingBudget,
  updateBillingPrice,
} from '../api.js';
import { formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';
import { ProviderBillsSection } from './ProviderBillsSection.js';

interface Props {
  me: MeResponse;
}

const BUDGET_STATE_LABELS: Record<BillingBudgetState, string> = {
  not_configured: '未设置预算',
  ok: '额度正常',
  exhausted: '额度耗尽',
  unpriced_calls: '存在未定价调用',
};

const BUDGET_STATE_TONES: Record<BillingBudgetState, BadgeTone> = {
  not_configured: 'muted',
  ok: 'green',
  exhausted: 'red',
  unpriced_calls: 'amber',
};

const PURPOSES: Array<{ key: 'byPurpose' | 'byMember' | 'byJob' | 'byChapter'; label: string }> = [
  { key: 'byPurpose', label: '按用途' },
  { key: 'byMember', label: '按成员' },
  { key: 'byJob', label: '按作业' },
  { key: 'byChapter', label: '按章节' },
];

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

function formatMoney(value: number, currency: PriceCurrency, digits = 4): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPrice(value: number | null, currency: PriceCurrency): string {
  if (value === null) return '未填写';
  return `${formatMoney(value, currency, 2)} / 百万 tokens`;
}

function MoneyCells({ costs }: { costs: BillingMoneyView[] }) {
  if (costs.length === 0) return <span className="muted">—</span>;
  return (
    <div className="billing-money-list">
      {costs.map((cost) => (
        <span key={cost.currency} className="billing-money">
          {formatMoney(cost.knownCost, cost.currency)}
          {cost.reservedCost > 0 ? (
            <small>进行中预留 {formatMoney(cost.reservedCost, cost.currency)}</small>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function BreakdownTable({ rows }: { rows: BillingBreakdownView[] }) {
  if (rows.length === 0) {
    return <p className="empty-state">本月暂无记录。</p>;
  }
  return (
    <div className="billing-table-wrap">
      <table className="billing-table">
        <thead>
          <tr>
            <th>归属</th>
            <th>估算费用</th>
            <th>已计调用</th>
            <th>费用未知</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <strong>{row.label}</strong>
                {row.detail ? <span className="billing-row-detail">{row.detail}</span> : null}
              </td>
              <td>
                <MoneyCells costs={row.costs} />
              </td>
              <td className="mono">
                {row.costs.reduce((total, cost) => total + cost.calls, 0)}
                {row.costs.some((cost) => cost.activeCalls > 0)
                  ? ` + ${row.costs.reduce((total, cost) => total + cost.activeCalls, 0)} 进行中`
                  : ''}
              </td>
              <td>
                {row.unknownCalls > 0 ? (
                  <Badge tone="amber">{row.unknownCalls} 次</Badge>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderPriceRow({
  provider,
  canManage,
  onSaved,
}: {
  provider: BillingProviderPriceView;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(provider.promptPricePer1m?.toString() ?? '');
  const [completion, setCompletion] = useState(provider.completionPricePer1m?.toString() ?? '');
  const [currency, setCurrency] = useState<PriceCurrency>(provider.priceCurrency);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setPrompt(provider.promptPricePer1m?.toString() ?? '');
    setCompletion(provider.completionPricePer1m?.toString() ?? '');
    setCurrency(provider.priceCurrency);
  }, [provider.updatedAt, provider.promptPricePer1m, provider.completionPricePer1m, provider.priceCurrency]);

  const mutation = useMutation({
    mutationFn: () => {
      const parse = (raw: string): number | null => {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const value = Number(trimmed);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error('价格必须是非负数字，或留空表示未填写。');
        }
        return value;
      };
      return updateBillingPrice(provider.id, {
        promptPricePer1m: parse(prompt),
        completionPricePer1m: provider.purpose === 'embedding' ? null : parse(completion),
        priceCurrency: currency,
      });
    },
    onSuccess: async () => {
      setError(null);
      setNotice('价表已保存。');
      await onSaved();
    },
    onError: (saveError) => {
      setNotice(null);
      setError(errorText(saveError));
    },
  });

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    mutation.mutate();
  }

  return (
    <form className="billing-provider-row" onSubmit={handleSave}>
      <div className="billing-provider-main">
        <div className="billing-provider-name">
          <strong>{provider.name}</strong>
          <Badge tone={provider.isEnabled ? 'green' : 'muted'}>
            {provider.isEnabled ? '已启用' : '已停用'}
          </Badge>
          <Badge tone="neutral">{provider.purpose === 'embedding' ? '嵌入' : '生成'}</Badge>
          <Badge tone={provider.pricingStatus === 'complete' ? 'green' : 'amber'}>
            {provider.pricingStatus === 'complete' ? '价表完整' : '价表不完整'}
          </Badge>
        </div>
        <span className="billing-provider-model mono">{provider.model}</span>
        <span className="muted billing-provider-meta">
          当前：输入 {formatPrice(provider.promptPricePer1m, provider.priceCurrency)}
          {provider.purpose === 'chat'
            ? ` · 输出 ${formatPrice(provider.completionPricePer1m, provider.priceCurrency)}`
            : ' · 嵌入仅按输入计价'}
        </span>
      </div>
      {canManage ? (
        <div className="billing-provider-edit">
          <label>
            <span>输入价 / 百万</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="留空即未填写"
            />
          </label>
          {provider.purpose === 'chat' ? (
            <label>
              <span>输出价 / 百万</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={completion}
                onChange={(event) => setCompletion(event.target.value)}
                placeholder="留空即未填写"
              />
            </label>
          ) : null}
          <label>
            <span>币种</span>
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value as PriceCurrency)}
            >
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <button type="submit" className="button button-quiet button-small" disabled={mutation.isPending}>
            {mutation.isPending ? '保存中…' : '保存价表'}
          </button>
          {error ? <span className="billing-provider-error">{error}</span> : null}
          {notice ? <span className="billing-provider-notice">{notice}</span> : null}
        </div>
      ) : null}
    </form>
  );
}

function BudgetSection({
  report,
  canManage,
  onChanged,
}: {
  report: BillingReportResponse;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const usage = report.budgetUsage;
  const [limit, setLimit] = useState(report.budget.monthlyLimit?.toString() ?? '');
  const [currency, setCurrency] = useState<PriceCurrency>(report.budget.currency);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLimit(report.budget.monthlyLimit?.toString() ?? '');
    setCurrency(report.budget.currency);
  }, [report.budget.monthlyLimit, report.budget.currency, report.budget.updatedAt]);

  const mutation = useMutation({
    mutationFn: (monthlyLimit: number | null) =>
      updateBillingBudget({ monthlyLimit, currency }),
    onSuccess: async (_result, monthlyLimit) => {
      setError(null);
      setNotice(monthlyLimit === null ? '已清除月度预算。' : '工作区月度预算已保存。');
      await onChanged();
    },
    onError: (saveError) => {
      setNotice(null);
      setError(errorText(saveError));
    },
  });

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const trimmed = limit.trim();
    if (!trimmed) {
      if (report.budget.monthlyLimit === null) {
        setNotice('当前未设置预算，无需清除。');
        return;
      }
      mutation.mutate(null);
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) {
      setError('预算必须是非负数字；如需取消预算，请点击「清除预算」。');
      return;
    }
    mutation.mutate(value);
  }

  return (
    <section className="billing-card billing-budget-card">
      <div className="billing-card-head">
        <div>
          <p className="eyebrow">工作区预算 · {report.month}</p>
          <h3>生成预算闸门</h3>
        </div>
        <Badge tone={BUDGET_STATE_TONES[usage.state]}>{BUDGET_STATE_LABELS[usage.state]}</Badge>
      </div>

      <div className="billing-budget-figures">
        <div>
          <span>月度上限</span>
          <strong>
            {usage.monthlyLimit === null
              ? '未设置'
              : formatMoney(usage.monthlyLimit, usage.currency, 2)}
          </strong>
        </div>
        <div>
          <span>已计费用</span>
          <strong>{formatMoney(usage.knownSpent, usage.currency)}</strong>
        </div>
        <div>
          <span>进行中预留</span>
          <strong>{formatMoney(usage.reserved, usage.currency)}</strong>
        </div>
        <div>
          <span>剩余额度</span>
          <strong>
            {usage.remaining === null ? '—' : formatMoney(usage.remaining, usage.currency)}
          </strong>
        </div>
      </div>

      <p className="billing-note">{usage.note}</p>
      <p className="billing-note billing-note-quiet">
        预算只阻断章节生成；索引与检索嵌入照常运行，费用单独计入报表。费用按价表与上游 token
        用量估算，不是供应商账单。并发调用会在发起前预留上限，完成或失败后清算。
      </p>

      {canManage ? (
        <form className="billing-budget-form" onSubmit={handleSave}>
          <label>
            <span>月度上限</span>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder="留空表示不设预算"
            />
          </label>
          <label>
            <span>币种</span>
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value as PriceCurrency)}
            >
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <button type="submit" className="button button-primary button-small" disabled={mutation.isPending}>
            {mutation.isPending ? '保存中…' : '保存预算'}
          </button>
          {report.budget.monthlyLimit !== null ? (
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={mutation.isPending}
              onClick={() => {
                setError(null);
                setNotice(null);
                setLimit('');
                mutation.mutate(null);
              }}
            >
              清除预算
            </button>
          ) : null}
          {error ? <span className="billing-form-error">{error}</span> : null}
          {notice ? <span className="billing-form-notice">{notice}</span> : null}
        </form>
      ) : (
        <p className="muted billing-readonly">
          计费报表对所有所有者、主笔与计费管理员可见；预算与价表仅所有者与计费管理员可修改。
        </p>
      )}
      {report.budget.updatedBy ? (
        <p className="muted billing-updated-by">
          最近更新：{report.budget.updatedBy.name}
          {report.budget.updatedAt ? ` · ${formatDateTime(report.budget.updatedAt)}` : ''}
        </p>
      ) : null}
    </section>
  );
}

export function BillingPanel({ me }: Props) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof PURPOSES)[number]['key']>('byPurpose');
  const reportQuery = useQuery({
    queryKey: ['billingReport'],
    queryFn: getBillingReport,
    refetchInterval: 20_000,
  });

  const canManage = me.role === 'owner' || me.role === 'billing';

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['billingReport'] });
  }

  if (reportQuery.isLoading) {
    return <p className="empty-state">正在读取本月计费报表……</p>;
  }
  if (reportQuery.isError) {
    return (
      <div className="billing-error">
        <p className="eyebrow">计费报表读取失败</p>
        <p className="boot-error">{errorText(reportQuery.error)}</p>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void reportQuery.refetch()}
        >
          重试
        </button>
      </div>
    );
  }

  const report = reportQuery.data;
  if (!report) return null;

  return (
    <div className="billing-panel">
      <section className="billing-card billing-summary-card">
        <div className="billing-card-head">
          <div>
            <p className="eyebrow">归属报表 · {report.month}</p>
            <h3>本月模型调用</h3>
          </div>
          <div className="billing-summary-actions">
            <span className="muted">
              生成于 {formatDateTime(report.generatedAt)} · 每 20 秒刷新
            </span>
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => void reportQuery.refetch()}
            >
              刷新
            </button>
          </div>
        </div>
        <div className="billing-totals">
          {report.totals.length === 0 ? (
            <p className="empty-state">本月暂无已计费调用。</p>
          ) : (
            report.totals.map((total) => (
              <div key={total.currency} className="billing-total">
                <span>{total.currency} 估算总额</span>
                <strong>{formatMoney(total.knownCost + total.reservedCost, total.currency)}</strong>
                <small>
                  已计 {formatMoney(total.knownCost, total.currency)} · 预留{' '}
                  {formatMoney(total.reservedCost, total.currency)}
                </small>
                <small>
                  {total.calls} 次已计调用
                  {total.activeCalls > 0 ? ` · ${total.activeCalls} 次进行中` : ''}
                </small>
              </div>
            ))
          )}
        </div>
        <div className="billing-summary-facts">
          <span>总调用记录 {report.totalCalls}</span>
          <span>费用未知 {report.unknownCallTotal}</span>
          <span>预算阻断 {report.blockedCallTotal}</span>
        </div>
        <p className="billing-note billing-note-quiet">
          统计窗口：{formatDateTime(report.rangeStart)} 至 {formatDateTime(report.rangeEnd)}
          （服务器本地自然月）。阻断调用不产生费用，也不计入上方费用合计。
        </p>
      </section>

      <BudgetSection report={report} canManage={canManage} onChanged={refresh} />

      <section className="billing-card">
        <div className="billing-card-head">
          <div>
            <p className="eyebrow">费用归属</p>
            <h3>按维度拆分</h3>
          </div>
          <div className="billing-tabs">
            {PURPOSES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`billing-tab${tab === item.key ? ' is-active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <BreakdownTable rows={report[tab]} />
      </section>

      <section className="billing-card">
        <div className="billing-card-head">
          <div>
            <p className="eyebrow">价表</p>
            <h3>服务商价格</h3>
          </div>
          <span className="muted">仅显示名称、型号与价格；不会暴露端点或密钥。</span>
        </div>
        {report.providers.length === 0 ? (
          <p className="empty-state">尚未登记模型服务商。</p>
        ) : (
          <div className="billing-provider-list">
            {report.providers.map((provider) => (
              <ProviderPriceRow
                key={provider.id}
                provider={provider}
                canManage={canManage}
                onSaved={refresh}
              />
            ))}
          </div>
        )}
      </section>

      <ProviderBillsSection providers={report.providers} canManage={canManage} />

      <section className="billing-card">
        <div className="billing-card-head">
          <div>
            <p className="eyebrow">未定价</p>
            <h3>费用未知的调用</h3>
          </div>
          <span className="muted">仅列出最近 50 条；总额未估算。</span>
        </div>
        {report.unknownCalls.length === 0 ? (
          <p className="empty-state">本月没有费用未知的调用。</p>
        ) : (
          <div className="billing-table-wrap">
            <table className="billing-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用途</th>
                  <th>服务商 / 型号</th>
                  <th>发起人</th>
                  <th>章节</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                {report.unknownCalls.map((call) => (
                  <tr key={call.id}>
                    <td className="mono">{formatDateTime(call.createdAt)}</td>
                    <td>{call.purposeLabel}</td>
                    <td>
                      <strong>{call.providerName ?? '未绑定服务商'}</strong>
                      <span className="billing-row-detail mono">{call.model}</span>
                    </td>
                    <td>{call.actorName ?? '系统 / 未绑定成员'}</td>
                    <td>
                      {call.chapterNumber !== null
                        ? `第${call.chapterNumber}章`
                        : call.chapterId
                          ? call.chapterId.slice(0, 8)
                          : '—'}
                    </td>
                    <td className="mono">{call.errorCode ?? call.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="billing-note billing-note-quiet">
          这些调用没有可用的上游 token 用量或价表，系统不会猜测费用。若工作区预算已启用，未知费用可能让实际支出超过上限。
        </p>
      </section>
    </div>
  );
}
