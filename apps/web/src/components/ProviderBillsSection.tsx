import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BillingProviderPriceView,
  PriceCurrency,
  ProviderBillModelComparison,
  ProviderBillModelStatus,
  ProviderBillStatus,
  ProviderBillView,
} from '@yunshuo/contracts';
import {
  ApiError,
  getProviderBillReconciliation,
  importProviderBill,
  listProviderBills,
  reviewProviderBill,
} from '../api.js';
import { formatDateTime } from '../format.js';
import { Badge, type BadgeTone } from './Badge.js';

interface Props {
  providers: BillingProviderPriceView[];
  canManage: boolean;
}

const STATUS_LABELS: Record<ProviderBillStatus, string> = {
  imported: '待复核',
  reviewed: '已复核',
  disputed: '有争议',
};

const STATUS_TONES: Record<ProviderBillStatus, BadgeTone> = {
  imported: 'amber',
  reviewed: 'green',
  disputed: 'red',
};

const MODEL_STATUS_LABELS: Record<ProviderBillModelStatus, string> = {
  match: '一致',
  amount_mismatch: '金额不一致',
  local_only: '仅本地记录',
  bill_only: '仅账单记录',
  local_unknown: '本地费用未知',
  currency_mismatch: '币种不一致',
};

const MODEL_STATUS_TONES: Record<ProviderBillModelStatus, BadgeTone> = {
  match: 'green',
  amount_mismatch: 'red',
  local_only: 'amber',
  bill_only: 'amber',
  local_unknown: 'amber',
  currency_mismatch: 'red',
};

const CSV_HEADER = 'model,input_tokens,output_tokens,amount,note';

function errorText(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : String(error);
}

function formatMoney(value: number, currency: PriceCurrency, digits = 6): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: Math.min(digits, 2),
    maximumFractionDigits: digits,
  }).format(value);
}

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function currentPeriod(): { start: string; end: string } {
  const now = new Date();
  return {
    start: dateOnly(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: dateOnly(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

function tokenText(value: number | null): string {
  return value === null ? '未提供' : value.toLocaleString('zh-CN');
}

function deltaText(value: number, currency: PriceCurrency): string {
  if (value === 0) return formatMoney(0, currency);
  return `${value > 0 ? '+' : ''}${formatMoney(value, currency)}`;
}

function ComparisonTable({
  rows,
  currency,
}: {
  rows: ProviderBillModelComparison[];
  currency: PriceCurrency;
}) {
  if (rows.length === 0) {
    return <p className="empty-state">账期内没有可对照的本地调用或账单明细。</p>;
  }
  return (
    <div className="billing-table-wrap">
      <table className="billing-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>对照结果</th>
            <th>账单金额</th>
            <th>本地估算</th>
            <th>金额差</th>
            <th>Token 对照</th>
            <th>本地异常</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model}>
              <td className="mono">{row.model}</td>
              <td>
                <Badge tone={MODEL_STATUS_TONES[row.status]}>
                  {MODEL_STATUS_LABELS[row.status]}
                </Badge>
              </td>
              <td>
                {row.billLineCount > 0
                  ? formatMoney(row.billAmount, currency)
                  : <span className="muted">无账单行</span>}
                <span className="billing-row-detail">
                  输入 {tokenText(row.billInputTokens)} · 输出 {tokenText(row.billOutputTokens)}
                </span>
              </td>
              <td>
                {formatMoney(row.localAmount, currency)}
                <span className="billing-row-detail">{row.localCalls} 次已定价调用</span>
              </td>
              <td className="mono">{deltaText(row.deltaAmount, currency)}</td>
              <td>
                {row.tokenStatus === 'not_comparable' ? (
                  <span className="muted">账单未提供 token</span>
                ) : row.tokenStatus === 'match' ? (
                  <Badge tone="green">token 一致</Badge>
                ) : (
                  <span>
                    <Badge tone="red">token 不一致</Badge>
                    <span className="billing-row-detail">
                      输入差 {row.inputTokenDelta === null ? '无法计算' : row.inputTokenDelta.toLocaleString('zh-CN')}
                      {' · '}
                      输出差 {row.outputTokenDelta === null ? '无法计算' : row.outputTokenDelta.toLocaleString('zh-CN')}
                    </span>
                  </span>
                )}
              </td>
              <td>
                {row.unknownCalls > 0 ? (
                  <Badge tone="amber">{row.unknownCalls} 次费用未知</Badge>
                ) : null}
                {row.otherCurrencyCalls > 0 ? (
                  <Badge tone="red">{row.otherCurrencyCalls} 次其他币种</Badge>
                ) : null}
                {row.unknownCalls === 0 && row.otherCurrencyCalls === 0 ? (
                  <span className="muted">—</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProviderBillsSection({ providers, canManage }: Props) {
  const queryClient = useQueryClient();
  const period = currentPeriod();
  const firstProvider = providers[0];
  const [providerId, setProviderId] = useState(firstProvider?.id ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [periodStart, setPeriodStart] = useState(period.start);
  const [periodEnd, setPeriodEnd] = useState(period.end);
  const [currency, setCurrency] = useState<PriceCurrency>(
    firstProvider?.priceCurrency ?? 'CNY',
  );
  const [declaredTotal, setDeclaredTotal] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<'reviewed' | 'disputed'>('reviewed');
  const [reviewNote, setReviewNote] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!providerId && firstProvider) setProviderId(firstProvider.id);
  }, [firstProvider, providerId]);

  const billsQuery = useQuery({
    queryKey: ['providerBills'],
    queryFn: listProviderBills,
  });

  const reconciliationQuery = useQuery({
    queryKey: ['providerBillReconciliation', selectedId],
    queryFn: () => getProviderBillReconciliation(selectedId!),
    enabled: Boolean(selectedId),
  });

  const selectedBill =
    billsQuery.data?.bills.find((bill) => bill.id === selectedId) ??
    reconciliationQuery.data?.bill ??
    null;

  useEffect(() => {
    if (!selectedBill) return;
    setReviewStatus(selectedBill.status === 'disputed' ? 'disputed' : 'reviewed');
    setReviewNote(selectedBill.reviewNote ?? '');
    setReviewError(null);
    setReviewNotice(null);
  }, [selectedBill?.id, selectedBill?.status, selectedBill?.reviewNote]);

  const importMutation = useMutation({
    mutationFn: () =>
      importProviderBill({
        providerId,
        invoiceNo: invoiceNo.trim(),
        periodStart,
        periodEnd,
        currency,
        declaredTotal: declaredTotal.trim() ? Number(declaredTotal) : null,
        csv,
      }),
    onSuccess: async (bill) => {
      setFormError(null);
      setFormNotice(`账单 ${bill.invoiceNo} 已导入，共 ${bill.lineCount} 行。`);
      setInvoiceNo('');
      setDeclaredTotal('');
      setCsv('');
      setFileName(null);
      setSelectedId(bill.id);
      await queryClient.invalidateQueries({ queryKey: ['providerBills'] });
    },
    onError: (error) => {
      setFormNotice(null);
      setFormError(errorText(error));
    },
  });

  const reviewMutation = useMutation({
    mutationFn: () => reviewProviderBill(selectedId!, { status: reviewStatus, note: reviewNote.trim() }),
    onSuccess: async (bill) => {
      setReviewError(null);
      setReviewNotice(
        bill.status === 'reviewed' ? '已标记为已复核。' : '已标记为有争议。',
      );
      await queryClient.invalidateQueries({ queryKey: ['providerBills'] });
      await queryClient.invalidateQueries({
        queryKey: ['providerBillReconciliation', bill.id],
      });
    },
    onError: (error) => {
      setReviewNotice(null);
      setReviewError(errorText(error));
    },
  });

  function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFormNotice(null);
    if (!providerId) {
      setFormError('请先选择账单对应的服务商。');
      return;
    }
    if (!invoiceNo.trim()) {
      setFormError('请填写供应商发票号。');
      return;
    }
    if (!csv.trim()) {
      setFormError('请粘贴 CSV 或选择 CSV 文件。');
      return;
    }
    if (declaredTotal.trim()) {
      const value = Number(declaredTotal);
      if (!Number.isFinite(value) || value < 0) {
        setFormError('账单总额必须是非负数字，或留空表示账单未提供总额。');
        return;
      }
    }
    importMutation.mutate();
  }

  function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReviewError(null);
    setReviewNotice(null);
    if (reviewStatus === 'disputed' && !reviewNote.trim()) {
      setReviewError('标记为有争议时必须填写说明。');
      return;
    }
    reviewMutation.mutate();
  }

  function handleProviderChange(id: string) {
    setProviderId(id);
    const provider = providers.find((item) => item.id === id);
    if (provider) setCurrency(provider.priceCurrency);
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setFormError('CSV 文件超过 1 MB，请拆分后再导入。');
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
    setFormError(null);
  }

  return (
    <section className="billing-card billing-bills-card">
      <div className="billing-card-head">
        <div>
          <p className="eyebrow">供应商账单</p>
          <h3>发票导入与估算对账</h3>
        </div>
        <span className="muted">
          账单金额来自人工导入；本地金额仍是按价表与 token 用量的估算。
        </span>
      </div>

      {canManage ? (
        <form className="billing-bill-form" onSubmit={handleImport}>
          <div className="billing-bill-grid">
            <label>
              <span>服务商</span>
              <select
                value={providerId}
                onChange={(event) => handleProviderChange(event.target.value)}
              >
                {providers.length === 0 ? <option value="">尚无服务商</option> : null}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.purpose === 'embedding' ? '嵌入' : '生成'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>发票号</span>
              <input
                value={invoiceNo}
                onChange={(event) => setInvoiceNo(event.target.value)}
                placeholder="供应商账单唯一编号"
                maxLength={120}
              />
            </label>
            <label>
              <span>账期开始</span>
              <input
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </label>
            <label>
              <span>账期结束（含）</span>
              <input
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
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
            <label>
              <span>账单总额（可选）</span>
              <input
                type="number"
                min="0"
                step="0.000001"
                value={declaredTotal}
                onChange={(event) => setDeclaredTotal(event.target.value)}
                placeholder="留空表示账单只提供明细"
              />
            </label>
          </div>

          <div className="billing-bill-csv">
            <div className="billing-bill-csv-head">
              <label>
                <span>CSV 明细</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
                />
              </label>
              {fileName ? <span className="muted">已读取 {fileName}</span> : null}
            </div>
            <textarea
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setFileName(null);
              }}
              rows={6}
              spellCheck={false}
              placeholder={`${CSV_HEADER}\nstub-model,120000,80000,12.345678,10月生成`}
            />
            <p className="billing-note billing-note-quiet">
              表头必须是 <code>{CSV_HEADER}</code>；每行一个模型，金额最多 6 位小数。
              CSV 只用于本次导入，不会写入服务商配置或调用记录。
            </p>
          </div>

          <div className="billing-bill-actions">
            <button
              type="submit"
              className="button button-primary button-small"
              disabled={importMutation.isPending}
            >
              {importMutation.isPending ? '导入中…' : '导入账单'}
            </button>
            {formError ? <span className="billing-form-error">{formError}</span> : null}
            {formNotice ? <span className="billing-form-notice">{formNotice}</span> : null}
          </div>
        </form>
      ) : (
        <p className="muted billing-readonly">
          计费管理员与所有者可以导入供应商账单；主笔可查看历史账单与对账结果。
        </p>
      )}

      <div className="billing-bill-list-head">
        <h4>已导入账单</h4>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={() => void billsQuery.refetch()}
        >
          刷新
        </button>
      </div>
      {billsQuery.isLoading ? (
        <p className="empty-state">正在读取账单……</p>
      ) : billsQuery.isError ? (
        <p className="boot-error">{errorText(billsQuery.error)}</p>
      ) : billsQuery.data?.bills.length === 0 ? (
        <p className="empty-state">尚未导入供应商账单。</p>
      ) : (
        <div className="billing-bill-list">
          {billsQuery.data!.bills.map((bill) => (
            <button
              key={bill.id}
              type="button"
              className={`billing-bill-item${bill.id === selectedId ? ' is-active' : ''}`}
              onClick={() => setSelectedId(bill.id)}
            >
              <span className="billing-bill-item-main">
                <strong>{bill.providerName}</strong>
                <span className="mono">{bill.invoiceNo}</span>
                <Badge tone={STATUS_TONES[bill.status]}>{STATUS_LABELS[bill.status]}</Badge>
              </span>
              <span className="muted">
                {bill.periodStart} 至 {bill.periodEnd} · {bill.lineCount} 行 ·{' '}
                {formatMoney(bill.linesTotal, bill.currency)}
                {bill.declaredTotal !== null
                  ? ` · 账单总额 ${formatMoney(bill.declaredTotal, bill.currency)}`
                  : ' · 账单未提供总额'}
              </span>
              {bill.reviewNote ? (
                <span className="billing-row-detail">复核说明：{bill.reviewNote}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {!selectedId ? (
        <p className="muted billing-readonly">选择一张账单查看逐模型对账结果。</p>
      ) : reconciliationQuery.isLoading ? (
        <p className="empty-state">正在对照本地调用与账单……</p>
      ) : reconciliationQuery.isError ? (
        <div className="billing-error">
          <p className="boot-error">{errorText(reconciliationQuery.error)}</p>
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={() => void reconciliationQuery.refetch()}
          >
            重试
          </button>
        </div>
      ) : reconciliationQuery.data ? (
        <div className="billing-bill-detail">
          <div className="billing-card-head">
            <div>
              <p className="eyebrow">
                {reconciliationQuery.data.bill.providerName} ·{' '}
                {reconciliationQuery.data.bill.invoiceNo}
              </p>
              <h4>
                账期 {reconciliationQuery.data.bill.periodStart} 至{' '}
                {reconciliationQuery.data.bill.periodEnd}
              </h4>
            </div>
            <Badge tone={STATUS_TONES[reconciliationQuery.data.bill.status]}>
              {STATUS_LABELS[reconciliationQuery.data.bill.status]}
            </Badge>
          </div>

          <div className="billing-bill-summary">
            <div>
              <span>账单明细合计</span>
              <strong>
                {formatMoney(
                  reconciliationQuery.data.summary.billLinesTotal,
                  reconciliationQuery.data.bill.currency,
                )}
              </strong>
            </div>
            <div>
              <span>账单总额</span>
              <strong>
                {reconciliationQuery.data.summary.declaredTotal === null
                  ? '未提供'
                  : formatMoney(
                      reconciliationQuery.data.summary.declaredTotal,
                      reconciliationQuery.data.bill.currency,
                    )}
              </strong>
              {reconciliationQuery.data.summary.declaredVsLines !== null ? (
                <small>
                  与明细差{' '}
                  {deltaText(
                    reconciliationQuery.data.summary.declaredVsLines,
                    reconciliationQuery.data.bill.currency,
                  )}
                </small>
              ) : null}
            </div>
            <div>
              <span>本地估算</span>
              <strong>
                {formatMoney(
                  reconciliationQuery.data.summary.localKnownTotal,
                  reconciliationQuery.data.bill.currency,
                )}
              </strong>
            </div>
            <div>
              <span>账单 − 本地</span>
              <strong>
                {deltaText(
                  reconciliationQuery.data.summary.deltaTotal,
                  reconciliationQuery.data.bill.currency,
                )}
              </strong>
              <small>{reconciliationQuery.data.summary.mismatchModels} 个模型存在差异</small>
            </div>
          </div>

          <div className="billing-summary-facts">
            <span>本地费用未知 {reconciliationQuery.data.summary.unknownCalls} 次</span>
            <span>其他币种 {reconciliationQuery.data.summary.otherCurrencyCalls} 次</span>
            <span>预算阻断 {reconciliationQuery.data.summary.blockedCalls} 次</span>
          </div>

          <ComparisonTable
            rows={reconciliationQuery.data.models}
            currency={reconciliationQuery.data.bill.currency}
          />

          <p className="billing-note billing-note-quiet">{reconciliationQuery.data.note}</p>

          {reconciliationQuery.data.bill.reviewedBy ? (
            <p className="muted billing-updated-by">
              最近复核：{reconciliationQuery.data.bill.reviewedBy.name}
              {reconciliationQuery.data.bill.reviewedAt
                ? ` · ${formatDateTime(reconciliationQuery.data.bill.reviewedAt)}`
                : ''}
            </p>
          ) : null}

          {canManage ? (
            <form className="billing-bill-review" onSubmit={handleReview}>
              <label>
                <span>复核结论</span>
                <select
                  value={reviewStatus}
                  onChange={(event) =>
                    setReviewStatus(event.target.value as 'reviewed' | 'disputed')
                  }
                >
                  <option value="reviewed">已复核</option>
                  <option value="disputed">有争议</option>
                </select>
              </label>
              <label className="billing-bill-review-note">
                <span>说明</span>
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  placeholder="有争议时必填；已复核可选填处理说明"
                />
              </label>
              <button
                type="submit"
                className="button button-primary button-small"
                disabled={reviewMutation.isPending}
              >
                {reviewMutation.isPending ? '保存中…' : '保存复核'}
              </button>
              {reviewError ? <span className="billing-form-error">{reviewError}</span> : null}
              {reviewNotice ? <span className="billing-form-notice">{reviewNotice}</span> : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
