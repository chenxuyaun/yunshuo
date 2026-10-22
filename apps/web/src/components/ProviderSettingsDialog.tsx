import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MeResponse,
  ModelProviderPurpose,
  ModelProviderView,
  PriceCurrency,
} from '@yunshuo/contracts';
import {
  ApiError,
  createModelProvider,
  deleteModelProvider,
  discoverProviderModels,
  listModelProviders,
  probeEmbeddingEndpoint,
  testModelProvider,
  updateModelProvider,
} from '../api.js';
import { formatDateTime } from '../format.js';
import { Badge } from './Badge.js';

interface Props {
  me: MeResponse;
  onClose: () => void;
}

interface FormState {
  name: string;
  baseUrl: string;
  model: string;
  purpose: ModelProviderPurpose;
  apiKey: string;
  reuseKeyFromProviderId: string;
  isEnabled: boolean;
  clearKey: boolean;
  priority: string;
  promptPrice: string;
  completionPrice: string;
  priceCurrency: PriceCurrency;
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  model: '',
  purpose: 'chat',
  apiKey: '',
  reuseKeyFromProviderId: '',
  isEnabled: true,
  clearKey: false,
  priority: '100',
  promptPrice: '',
  completionPrice: '',
  priceCurrency: 'CNY',
};

const PURPOSE_LABEL: Record<ModelProviderPurpose, string> = {
  chat: '聊天生成',
  embedding: '嵌入检索',
};

function formatPrice(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
}

function currencySymbol(currency: PriceCurrency): string {
  return currency === 'USD' ? '$' : '¥';
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

export function ProviderSettingsDialog({ me, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['modelProviders'],
    queryFn: listModelProviders,
  });

  const canManage = me.role === 'owner';
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<ModelProviderView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeNotice, setProbeNotice] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelNotice, setModelNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  function resetDiscovery() {
    setModels([]);
    setModelNotice(null);
    setProbeNotice(null);
  }

  function startCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    resetDiscovery();
    setMode('form');
    setError(null);
    setNotice(null);
  }

  function startEdit(provider: ModelProviderView) {
    setEditing(provider);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      purpose: provider.purpose,
      apiKey: '',
      reuseKeyFromProviderId: '',
      isEnabled: provider.isEnabled,
      clearKey: false,
      priority: String(provider.priority),
      promptPrice:
        provider.promptPricePer1m === null ? '' : String(provider.promptPricePer1m),
      completionPrice:
        provider.completionPricePer1m === null ? '' : String(provider.completionPricePer1m),
      priceCurrency: provider.priceCurrency,
    });
    resetDiscovery();
    setMode('form');
    setError(null);
    setNotice(null);
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['modelProviders'] });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (!name || !baseUrl || !model) {
      setError('服务商名称、基础地址与模型 ID 都不能为空。');
      return;
    }

    const priorityText = form.priority.trim();
    const priority = Number(priorityText);
    if (!/^\d+$/.test(priorityText) || priority < 1 || priority > 999) {
      setError('路由优先级必须是 1–999 的整数，数字越小越先尝试。');
      return;
    }
    const promptText = form.promptPrice.trim();
    const completionText = form.completionPrice.trim();
    if (form.purpose === 'embedding') {
      if (completionText.length > 0) {
        setError('嵌入服务商只填写输入价，输出价必须留空。');
        return;
      }
    } else if ((promptText.length > 0) !== (completionText.length > 0)) {
      setError('输入价与输出价必须同时填写或同时留空。');
      return;
    }
    let promptPrice: number | null = null;
    let completionPrice: number | null = null;
    const validPrice = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100_000;
    if (promptText.length > 0) {
      promptPrice = Number(promptText);
      if (!validPrice(promptPrice)) {
        setError('输入价必须是 0–100000 之间的数字。');
        return;
      }
    }
    if (form.purpose !== 'embedding' && completionText.length > 0) {
      completionPrice = Number(completionText);
      if (!validPrice(completionPrice)) {
        setError('输出价必须是 0–100000 之间的数字。');
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const basePayload = {
        name,
        baseUrl,
        model,
        isEnabled: form.isEnabled,
        priority,
        promptPricePer1m: promptPrice,
        completionPricePer1m: completionPrice,
        priceCurrency: form.priceCurrency,
      };
      if (editing) {
        const payload = { ...basePayload } as typeof basePayload & { apiKey?: string };
        if (form.apiKey.length > 0) payload.apiKey = form.apiKey;
        else if (form.clearKey) payload.apiKey = '';
        await updateModelProvider(editing.id, payload);
        const connectionChanged =
          baseUrl !== editing.baseUrl ||
          model !== editing.model ||
          form.apiKey.length > 0 ||
          form.clearKey;
        setNotice({
          tone: 'success',
          text: connectionChanged
            ? `已更新「${name}」。连接信息已变更，旧测试结果已清除，请重新测试。`
            : `已更新「${name}」。`,
        });
      } else {
        await createModelProvider({
          ...basePayload,
          purpose: form.purpose,
          ...(form.reuseKeyFromProviderId
            ? { reuseKeyFromProviderId: form.reuseKeyFromProviderId }
            : form.apiKey.length > 0
              ? { apiKey: form.apiKey }
              : {}),
        });
        setNotice({
          tone: 'success',
          text:
            form.purpose === 'embedding'
              ? `已登记嵌入服务商「${name}」。请重建索引后再检索。`
              : `已登记「${name}」。下一步可测试连接。`,
        });
      }
      await refresh();
      setMode('list');
      setEditing(null);
      resetDiscovery();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscoverModels() {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      setError('请先填写基础地址，再拉取模型列表。');
      return;
    }

    setDiscovering(true);
    setError(null);
    setModelNotice(null);
    try {
      const result = await discoverProviderModels({
        baseUrl,
        ...(form.apiKey.length > 0 ? { apiKey: form.apiKey } : {}),
        ...(editing && form.apiKey.length === 0 && !form.clearKey
          ? { providerId: editing.id }
          : {}),
      });
      setModels(result.models);
      setModelNotice({
        tone: result.models.length > 0 ? 'success' : 'error',
        text: `${result.message}（${result.latencyMs}ms）`,
      });
    } catch (discoverError) {
      setModels([]);
      setModelNotice({ tone: 'error', text: errorMessage(discoverError) });
    } finally {
      setDiscovering(false);
    }
  }

  async function handleProbeEmbedding() {
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (!baseUrl || !model) {
      setError('请先填写基础地址与嵌入模型 ID。');
      return;
    }
    const providerId =
      editing && form.apiKey.length === 0 && !form.clearKey
        ? editing.id
        : !editing && form.reuseKeyFromProviderId
          ? form.reuseKeyFromProviderId
          : undefined;

    setProbing(true);
    setError(null);
    setProbeNotice(null);
    try {
      const result = await probeEmbeddingEndpoint({
        baseUrl,
        model,
        ...(form.apiKey.length > 0 && !form.reuseKeyFromProviderId
          ? { apiKey: form.apiKey }
          : {}),
        ...(providerId ? { providerId } : {}),
      });
      setProbeNotice({
        tone: result.supported ? 'success' : 'error',
        text: `${result.message}（${result.latencyMs}ms${
          result.dimensions ? ` · ${result.dimensions} 维` : ''
        }）`,
      });
    } catch (probeError) {
      setProbeNotice({ tone: 'error', text: errorMessage(probeError) });
    } finally {
      setProbing(false);
    }
  }

  async function handleTest(provider: ModelProviderView) {
    setTestingId(provider.id);
    setError(null);
    setNotice(null);
    try {
      const response = await testModelProvider(provider.id);
      setNotice({
        tone: response.result.status === 'ok' ? 'success' : 'error',
        text: `${response.result.message}（${response.result.latencyMs}ms）`,
      });
      await refresh();
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(provider: ModelProviderView) {
    setDeletingId(provider.id);
    setError(null);
    try {
      await deleteModelProvider(provider.id);
      setConfirmDeleteId(null);
      setNotice({ tone: 'success', text: `已删除「${provider.name}」。` });
      await refresh();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setDeletingId(null);
    }
  }

  const providers = query.data?.providers ?? [];

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-provider"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-head">
          <div>
            <p className="eyebrow">工作区设置 · 仅登记与测试</p>
            <h2 id="provider-title">模型服务商</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <p className="provider-intro">
            这里登记 OpenAI 兼容端点、用途、路由顺序与计价。聊天服务商用于生成正文，
            按优先级路由；嵌入服务商用于正典索引与检索，会把正典片段和检索查询发送到该端点。
          </p>

          {notice ? (
            <div className={`provider-notice provider-notice-${notice.tone}`}>{notice.text}</div>
          ) : null}
          {error ? <div className="modal-error">{error}</div> : null}

          {query.isLoading ? (
            <p className="empty-state">正在读取服务商配置……</p>
          ) : query.isError ? (
            <div className="modal-error">
              读取失败：
              {query.isError ? errorMessage(query.error) : ''}
            </div>
          ) : mode === 'form' ? (
            <form className="provider-form" onSubmit={(event) => void handleSave(event)}>
              <div className="provider-form-head">
                <h3>{editing ? `编辑「${editing.name}」` : '新增服务商'}</h3>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => {
                    setMode('list');
                    setEditing(null);
                    setError(null);
                    resetDiscovery();
                  }}
                >
                  返回列表
                </button>
              </div>

              <div className="field-grid">
                <label className="field">
                  <span>名称</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    placeholder="例如：本地 llama.cpp"
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </label>
                <div className="field">
                  <div className="field-head">
                    <span>模型 ID</span>
                    <span className="field-head-actions">
                      {form.purpose === 'embedding' ? (
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={probing || saving}
                          onClick={() => void handleProbeEmbedding()}
                        >
                          {probing ? '探测中…' : '探测嵌入能力'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        disabled={discovering || saving}
                        onClick={() => void handleDiscoverModels()}
                      >
                        {discovering ? '拉取中…' : '拉取模型列表'}
                      </button>
                    </span>
                  </div>
                  <input
                    value={form.model}
                    maxLength={200}
                    placeholder="例如：qwen3-14b"
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                  />
                  {modelNotice ? (
                    <small className={`model-notice model-notice-${modelNotice.tone}`}>
                      {modelNotice.text}
                    </small>
                  ) : null}
                  {probeNotice ? (
                    <small className={`model-notice model-notice-${probeNotice.tone}`}>
                      {probeNotice.text}
                    </small>
                  ) : null}
                  {models.length > 0 ? (
                    <div className="model-options" aria-label="可用模型">
                      {models.map((model) => (
                        <button
                          key={model}
                          type="button"
                          className={`model-option${form.model === model ? ' model-option-active' : ''}`}
                          onClick={() => setForm({ ...form, model })}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <label className="field">
                <span>用途</span>
                {editing ? (
                  <input value={PURPOSE_LABEL[editing.purpose]} disabled readOnly />
                ) : (
                  <select
                    value={form.purpose}
                    onChange={(event) => {
                      setForm({
                        ...form,
                        purpose: event.target.value as ModelProviderPurpose,
                        completionPrice: '',
                      });
                      resetDiscovery();
                    }}
                  >
                    <option value="chat">聊天生成 · 用于 AI 提案</option>
                    <option value="embedding">嵌入检索 · 用于正典索引与搜索</option>
                  </select>
                )}
                <small>创建后用途不可修改。嵌入服务商会收到正典片段与检索查询，请确认端点可信。</small>
              </label>

              <label className="field">
                <span>基础地址</span>
                <input
                  value={form.baseUrl}
                  maxLength={500}
                  placeholder="http://127.0.0.1:8080/v1"
                  spellCheck={false}
                  onChange={(event) => {
                    setForm({ ...form, baseUrl: event.target.value });
                    resetDiscovery();
                  }}
                />
                <small>不要带 /chat/completions；只填到 /v1 这一级。</small>
              </label>

              <div className="field-grid">
                <label className="field">
                  <span>路由优先级</span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    step={1}
                    value={form.priority}
                    onChange={(event) => setForm({ ...form, priority: event.target.value })}
                  />
                  <small>数字越小越先尝试；失败且未输出正文时按顺序切换，最多 3 个候选。</small>
                </label>
                <label className="field">
                  <span>计价币种</span>
                  <select
                    value={form.priceCurrency}
                    onChange={(event) =>
                      setForm({ ...form, priceCurrency: event.target.value as PriceCurrency })
                    }
                  >
                    <option value="CNY">人民币 CNY</option>
                    <option value="USD">美元 USD</option>
                  </select>
                  <small>价表仅用于估算成本，不代表服务商实际账单。</small>
                </label>
              </div>

              <div className="field-grid">
                <label className="field">
                  <span>输入价 · 每百万 token</span>
                  <input
                    type="number"
                    min={0}
                    step="0.0001"
                    value={form.promptPrice}
                    placeholder="留空表示未配置价表"
                    onChange={(event) => setForm({ ...form, promptPrice: event.target.value })}
                  />
                  {form.purpose === 'embedding' ? (
                    <small>嵌入只按输入 token 计费；服务商未返回用量时不估算成本。</small>
                  ) : null}
                </label>
                {form.purpose === 'chat' ? (
                  <label className="field">
                    <span>输出价 · 每百万 token</span>
                    <input
                      type="number"
                      min={0}
                      step="0.0001"
                      value={form.completionPrice}
                      placeholder="留空表示未配置价表"
                      onChange={(event) =>
                        setForm({ ...form, completionPrice: event.target.value })
                      }
                    />
                    <small>输入价与输出价必须同时填写；服务商未返回 token 用量时不计算成本。</small>
                  </label>
                ) : null}
              </div>

              {!editing && providers.some((provider) => provider.hasKey) ? (
                <label className="field">
                  <span>复用已有密钥</span>
                  <select
                    value={form.reuseKeyFromProviderId}
                    onChange={(event) => {
                      setForm({
                        ...form,
                        reuseKeyFromProviderId: event.target.value,
                        apiKey: '',
                      });
                      resetDiscovery();
                    }}
                  >
                    <option value="">不复用（在下方单独填写或留空）</option>
                    {providers
                      .filter((provider) => provider.hasKey)
                      .map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} · {PURPOSE_LABEL[provider.purpose]} ·{' '}
                          {provider.keyHint ?? '已保存'}
                        </option>
                      ))}
                  </select>
                  <small>仅在同一工作区内复制已加密的密钥密文，不把明文交给浏览器。</small>
                </label>
              ) : null}

              <label className="field">
                <span>API Key</span>
                <input
                  type="password"
                  value={form.apiKey}
                  maxLength={600}
                  autoComplete="new-password"
                  disabled={form.clearKey || form.reuseKeyFromProviderId.length > 0}
                  placeholder={
                    form.reuseKeyFromProviderId.length > 0
                      ? '将复用所选服务商的密钥'
                      : editing?.hasKey
                        ? `留空保留现有密钥 ${editing.keyHint ?? ''}`
                        : '无鉴权端点可留空'
                  }
                  onChange={(event) => {
                    setForm({ ...form, apiKey: event.target.value });
                    resetDiscovery();
                  }}
                />
                <small>
                  密钥使用 AES-256-GCM 加密存库，接口只返回尾号，不写入审计与日志。
                </small>
              </label>

              {editing?.hasKey ? (
                <label className="provider-check">
                  <input
                    type="checkbox"
                    checked={form.clearKey}
                    onChange={(event) => {
                      setForm({ ...form, clearKey: event.target.checked, apiKey: '' });
                      resetDiscovery();
                    }}
                  />
                  <span>清除已保存的 API Key</span>
                </label>
              ) : null}

              <label className="provider-check">
                <input
                  type="checkbox"
                  checked={form.isEnabled}
                  onChange={(event) => setForm({ ...form, isEnabled: event.target.checked })}
                />
                <span>启用该服务商（后续模型网关只选择已启用项）</span>
              </label>

              <div className="provider-form-note">
                拉取模型列表与连接测试都会请求 <code>GET 基础地址/models</code>，超时 8 秒；
                嵌入能力探测请求 <code>POST 基础地址/embeddings</code>，发送固定短文本
                「云说嵌入连通性探测。」，超时 10 秒。探测不发送正典、草稿或密钥，也不消耗生成额度。
              </div>

              <div className="provider-form-actions">
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={saving}
                  onClick={() => {
                    setMode('list');
                    setEditing(null);
                    setError(null);
                    resetDiscovery();
                  }}
                >
                  取消
                </button>
                <button type="submit" className="button button-primary" disabled={saving}>
                  {saving ? '保存中…' : '保存服务商'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="provider-list-head">
                <div>
                  <h3>已登记 {providers.length} 个服务商</h3>
                  <p className="muted">
                    {canManage ? '仅所有者可新增、修改与删除。' : '当前身份只读；所有者可修改配置。'}
                  </p>
                </div>
                {canManage ? (
                  <button type="button" className="button button-primary button-small" onClick={startCreate}>
                    新增服务商
                  </button>
                ) : null}
              </div>

              {providers.length === 0 ? (
                <div className="provider-empty">
                  <p>尚未登记模型服务商。</p>
                  <p className="muted">
                    先准备一个 OpenAI 兼容端点（llama.cpp、Ollama、vLLM 或远程 API），
                    再填写基础地址、模型 ID 与 API Key。
                  </p>
                </div>
              ) : (
                <ul className="provider-list">
                  {providers.map((provider) => (
                    <li key={provider.id} className="provider-card">
                      <div className="provider-card-head">
                        <div>
                          <h4>{provider.name}</h4>
                          <p className="provider-endpoint">
                            <code>{provider.baseUrl}</code>
                            <span>·</span>
                            <code>{provider.model}</code>
                          </p>
                        </div>
                        <div className="provider-badges">
                          <Badge tone={provider.purpose === 'embedding' ? 'ink' : 'neutral'}>
                            {PURPOSE_LABEL[provider.purpose]}
                          </Badge>
                          <Badge tone={provider.isEnabled ? 'green' : 'muted'}>
                            {provider.isEnabled ? '已启用' : '已停用'}
                          </Badge>
                          <Badge tone="neutral">优先级 {provider.priority}</Badge>
                          <Badge tone={provider.hasKey ? 'ink' : 'neutral'}>
                            {provider.hasKey ? `密钥 ${provider.keyHint ?? '已保存'}` : '无密钥'}
                          </Badge>
                        </div>
                      </div>

                      <div className="provider-test-line">
                        {provider.lastTest ? (
                          <>
                            <Badge tone={provider.lastTest.status === 'ok' ? 'green' : 'red'}>
                              {provider.lastTest.status === 'ok' ? '连接正常' : '连接失败'}
                            </Badge>
                            <span>{provider.lastTest.message}</span>
                            <span className="muted">
                              {formatDateTime(provider.lastTest.testedAt)}
                              {provider.lastTest.latencyMs !== null
                                ? ` · ${provider.lastTest.latencyMs}ms`
                                : ''}
                            </span>
                          </>
                        ) : (
                          <span className="muted">尚未测试连接。</span>
                        )}
                      </div>

                      <p className="provider-price-line">
                        {provider.purpose === 'embedding' ? (
                          provider.promptPricePer1m !== null ? (
                            <span>
                              嵌入价表：输入 {currencySymbol(provider.priceCurrency)}
                              {formatPrice(provider.promptPricePer1m)} · 每百万 token；
                              会把正典片段发送到该端点。
                            </span>
                          ) : (
                            <span className="muted">
                              未配置嵌入输入价；索引成本将显示为未知。会把正典片段发送到该端点。
                            </span>
                          )
                        ) : provider.promptPricePer1m !== null &&
                          provider.completionPricePer1m !== null ? (
                          <span>
                            价表：输入 {currencySymbol(provider.priceCurrency)}
                            {formatPrice(provider.promptPricePer1m)} / 输出{' '}
                            {currencySymbol(provider.priceCurrency)}
                            {formatPrice(provider.completionPricePer1m)} · 每百万 token
                          </span>
                        ) : (
                          <span className="muted">未配置价表；生成成本将显示为未知。</span>
                        )}
                      </p>

                      <div className="provider-card-actions">
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={testingId === provider.id}
                          onClick={() => void handleTest(provider)}
                        >
                          {testingId === provider.id ? '测试中…' : '测试连接'}
                        </button>
                        {canManage ? (
                          <>
                            <button
                              type="button"
                              className="button button-quiet button-small"
                              onClick={() => startEdit(provider)}
                            >
                              编辑
                            </button>
                            {confirmDeleteId === provider.id ? (
                              <span className="provider-confirm">
                                确认删除？
                                <button
                                  type="button"
                                  className="button button-danger button-small"
                                  disabled={deletingId === provider.id}
                                  onClick={() => void handleDelete(provider)}
                                >
                                  {deletingId === provider.id ? '删除中…' : '确认删除'}
                                </button>
                                <button
                                  type="button"
                                  className="button button-quiet button-small"
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  取消
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="button button-quiet button-small"
                                onClick={() => setConfirmDeleteId(provider.id)}
                              >
                                删除
                              </button>
                            )}
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="provider-encryption-note">
                <p>
                  密钥保护：AES-256-GCM
                  {query.data?.keyEncryption.secretSource === 'session'
                    ? ' · 当前从 SESSION_SECRET 派生加密密钥'
                    : ' · 使用 MODEL_KEY_SECRET'}
                </p>
                {query.data?.keyEncryption.secretSource === 'session' ? (
                  <p className="muted">
                    生产部署请在 .env 设置独立的 MODEL_KEY_SECRET；轮换该密钥后需重新录入 API Key。
                  </p>
                ) : null}
                <p className="muted">
                  连接测试不消耗生成额度。正文生成见写作台 AI 提案；成本按已配置价表与
                  服务商返回的 token 用量估算，价表为空或未返回用量时不显示成本。
                </p>
              </div>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button type="button" className="button button-quiet" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
