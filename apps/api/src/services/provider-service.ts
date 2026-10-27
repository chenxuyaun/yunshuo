import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { sql, jsonValue } from '@yunshuo/db';
import type {
  EmbeddingProbeResponse,
  ModelDiscoveryResponse,
  ModelProviderListResponse,
  ModelProviderPurpose,
  ModelProviderTestResponse,
  ModelProviderView,
  PriceCurrency,
} from '@yunshuo/contracts';
import type { Role } from '@yunshuo/domain';
import {
  EMBEDDING_PROBE_TEXT,
  EmbeddingError,
  decryptApiKey,
  embedBatch,
  encryptApiKey,
} from '@yunshuo/model-gateway';
import { env } from '../env.js';
import type { AuthContext } from '../auth.js';
import { badGateway, badRequest, conflict, forbidden, notFound } from '../errors.js';

type Executor = Sql<any> | TransactionSql<any>;

export const MAX_ROUTING_PROVIDERS = 3;

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  purpose: ModelProviderPurpose;
  is_enabled: boolean;
  priority: number;
  prompt_price_per_1m: string | number | null;
  completion_price_per_1m: string | number | null;
  price_currency: string;
  api_key_ciphertext: string | null;
  api_key_hint: string | null;
  last_test_status: 'ok' | 'failed' | null;
  last_test_message: string | null;
  last_test_latency_ms: number | null;
  last_tested_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  model: string;
  purpose: ModelProviderPurpose;
  apiKey?: string;
  reuseKeyFromProviderId?: string;
  isEnabled: boolean;
  priority: number;
  promptPricePer1m?: number | null;
  completionPricePer1m?: number | null;
  priceCurrency: PriceCurrency;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  isEnabled?: boolean;
  priority?: number;
  promptPricePer1m?: number | null;
  completionPricePer1m?: number | null;
  priceCurrency?: PriceCurrency;
}

export interface DiscoverModelsInput {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}

export interface ProbeEmbeddingInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  providerId?: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

// 服务端会按这个地址主动出网，所以先把目标钉死：只允许 http/https、不内嵌凭据、
// 不指向云元数据/链路本地地址。环回与私网故意放行——本机或内网自建推理端点
// （Ollama、LM Studio）是受支持的用法，L0 探针本身就要打本机 Ollama。
// 返回结构化 URL，拼接请求路径交给 URL 解析器，不再手工拼字符串。
function assertModelEndpointUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('VALIDATION', '模型端点不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('VALIDATION', '模型端点只支持 http/https');
  }
  if (url.username !== '' || url.password !== '') {
    throw badRequest('VALIDATION', '模型端点地址不能内嵌凭据');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host.startsWith('169.254.')) {
    throw badRequest('VALIDATION', '模型端点不能指向云元数据地址');
  }
  return url;
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceCurrency(value: string): PriceCurrency {
  return value === 'USD' ? 'USD' : 'CNY';
}

function assertPricing(
  purpose: ModelProviderPurpose,
  prompt: number | null,
  completion: number | null,
): void {
  if (purpose === 'embedding') {
    if (completion !== null) {
      throw badRequest('PROVIDER_PRICING_UNSUPPORTED', '嵌入服务商只支持输入价，输出价必须留空');
    }
    return;
  }
  if ((prompt === null) !== (completion === null)) {
    throw badRequest('PROVIDER_PRICING_INCOMPLETE', '输入价与输出价必须同时填写或同时留空');
  }
}

export function mapProvider(row: ProviderRow): ModelProviderView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    purpose: row.purpose,
    isEnabled: row.is_enabled,
    priority: row.priority,
    promptPricePer1m: nullableNumber(row.prompt_price_per_1m),
    completionPricePer1m: nullableNumber(row.completion_price_per_1m),
    priceCurrency: priceCurrency(row.price_currency),
    hasKey: Boolean(row.api_key_ciphertext),
    keyHint: row.api_key_hint,
    lastTest:
      row.last_test_status && row.last_tested_at
        ? {
            status: row.last_test_status,
            message: row.last_test_message ?? '',
            latencyMs: row.last_test_latency_ms,
            testedAt: iso(row.last_tested_at),
          }
        : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function assertCanView(role: Role): void {
  if (role !== 'owner' && role !== 'lead') {
    throw forbidden('仅所有者与主笔可以查看模型服务商配置');
  }
}

function assertCanManage(role: Role): void {
  if (role !== 'owner') {
    throw forbidden('仅所有者可以新增、修改或删除模型服务商');
  }
}

// 拉清单会让服务端按请求里的地址主动出网，属于"替调用者发起一次外部请求"，
// 所以口径跟写服务商一致收到所有者，而不是跟"查看配置"一样放开给主笔。
function assertCanDiscoverModels(role: Role): void {
  if (role !== 'owner') {
    throw forbidden('仅所有者可以拉取模型清单');
  }
}

async function loadProvider(
  exec: Executor,
  workspaceId: string,
  providerId: string,
  lock = false,
): Promise<ProviderRow | null> {
  const rows = lock
    ? await exec<ProviderRow[]>`
        SELECT * FROM model_providers
        WHERE id = ${providerId} AND workspace_id = ${workspaceId}
        FOR UPDATE
      `
    : await exec<ProviderRow[]>`
        SELECT * FROM model_providers
        WHERE id = ${providerId} AND workspace_id = ${workspaceId}
      `;
  return rows[0] ?? null;
}

async function writeAudit(
  exec: Executor,
  auth: AuthContext,
  action: string,
  providerId: string,
  result: 'success' | 'failure',
  metadata: Record<string, unknown>,
): Promise<void> {
  await exec`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role}, ${action},
      'model_provider', ${providerId}, ${result},
      ${exec.json(jsonValue(metadata))}
    )
  `;
}

async function writeProbeAudit(
  auth: AuthContext,
  providerId: string | null,
  result: 'success' | 'failure',
  metadata: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO audit_log (
      workspace_id, actor_id, actor_type, role, action, object_type, object_id, result, metadata
    )
    VALUES (
      ${auth.workspace.id}, ${auth.user.id}, 'human', ${auth.role},
      'model_provider.probe_embedding', 'model_provider', ${providerId}, ${result},
      ${sql.json(jsonValue(metadata))}
    )
  `;
}

export async function listProviders(auth: AuthContext): Promise<ModelProviderListResponse> {
  assertCanView(auth.role);
  const rows = await sql<ProviderRow[]>`
    SELECT * FROM model_providers
    WHERE workspace_id = ${auth.workspace.id}
    ORDER BY priority ASC, created_at ASC
  `;
  return {
    providers: rows.map(mapProvider),
    keyEncryption: {
      algorithm: 'aes-256-gcm',
      secretSource: env.modelKeySecretIsDedicated ? 'dedicated' : 'session',
    },
  };
}

export async function createProvider(
  auth: AuthContext,
  input: CreateProviderInput,
): Promise<ModelProviderView> {
  assertCanManage(auth.role);
  const id = randomUUID();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const promptPrice = input.promptPricePer1m ?? null;
  const completionPrice = input.completionPricePer1m ?? null;
  assertPricing(input.purpose, promptPrice, completionPrice);

  const row = await sql.begin(async (tx) => {
    let key: { ciphertext: string; hint: string | null } | null = null;
    let reusedKey = false;
    if (input.reuseKeyFromProviderId) {
      const source = await loadProvider(tx, auth.workspace.id, input.reuseKeyFromProviderId);
      if (!source) throw notFound('PROVIDER_NOT_FOUND', '要复用密钥的服务商不存在');
      if (!source.api_key_ciphertext) {
        throw badRequest('PROVIDER_KEY_MISSING', '所选服务商没有可复用的密钥');
      }
      key = { ciphertext: source.api_key_ciphertext, hint: source.api_key_hint };
      reusedKey = true;
    } else if (input.apiKey && input.apiKey.length > 0) {
      const encrypted = encryptApiKey(input.apiKey, env.modelKeySecret);
      key = { ciphertext: encrypted.ciphertext, hint: encrypted.hint };
    }

    const rows = await tx<ProviderRow[]>`
      INSERT INTO model_providers (
        id, workspace_id, name, base_url, model, purpose, is_enabled, priority,
        prompt_price_per_1m, completion_price_per_1m, price_currency,
        api_key_ciphertext, api_key_hint
      )
      VALUES (
        ${id}, ${auth.workspace.id}, ${input.name}, ${baseUrl}, ${input.model},
        ${input.purpose}, ${input.isEnabled}, ${input.priority}, ${promptPrice},
        ${completionPrice}, ${input.priceCurrency}, ${key?.ciphertext ?? null},
        ${key?.hint ?? null}
      )
      RETURNING *
    `;
    const inserted = rows[0];
    if (!inserted) throw new Error('模型服务商写入失败');
    await writeAudit(tx, auth, 'model_provider.create', id, 'success', {
      name: input.name,
      baseUrl,
      model: input.model,
      purpose: input.purpose,
      priority: input.priority,
      hasPricing: promptPrice !== null,
      priceCurrency: input.priceCurrency,
      hasKey: Boolean(key),
      reusedKey,
    });
    return inserted;
  });

  return mapProvider(row);
}

export async function updateProvider(
  auth: AuthContext,
  providerId: string,
  input: UpdateProviderInput,
): Promise<ModelProviderView> {
  assertCanManage(auth.role);

  const row = await sql.begin(async (tx) => {
    const current = await loadProvider(tx, auth.workspace.id, providerId, true);
    if (!current) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在');

    const nextBaseUrl = input.baseUrl === undefined ? current.base_url : normalizeBaseUrl(input.baseUrl);
    const nextModel = input.model ?? current.model;
    const nextPriority = input.priority ?? current.priority;
    const nextPromptPrice =
      input.promptPricePer1m === undefined
        ? nullableNumber(current.prompt_price_per_1m)
        : input.promptPricePer1m;
    const nextCompletionPrice =
      input.completionPricePer1m === undefined
        ? nullableNumber(current.completion_price_per_1m)
        : input.completionPricePer1m;
    assertPricing(current.purpose, nextPromptPrice, nextCompletionPrice);
    const nextPriceCurrency = input.priceCurrency ?? priceCurrency(current.price_currency);
    let nextCiphertext = current.api_key_ciphertext;
    let nextHint = current.api_key_hint;
    let keyChanged = false;

    if (input.apiKey !== undefined) {
      if (input.apiKey.length === 0) {
        nextCiphertext = null;
        nextHint = null;
        keyChanged = true;
      } else {
        const key = encryptApiKey(input.apiKey, env.modelKeySecret);
        nextCiphertext = key.ciphertext;
        nextHint = key.hint;
        keyChanged = true;
      }
    }

    const connectionChanged =
      nextBaseUrl !== current.base_url || nextModel !== current.model || keyChanged;

    const rows = await tx<ProviderRow[]>`
      UPDATE model_providers SET
        name = ${input.name ?? current.name},
        base_url = ${nextBaseUrl},
        model = ${nextModel},
        is_enabled = ${input.isEnabled ?? current.is_enabled},
        priority = ${nextPriority},
        prompt_price_per_1m = ${nextPromptPrice},
        completion_price_per_1m = ${nextCompletionPrice},
        price_currency = ${nextPriceCurrency},
        api_key_ciphertext = ${nextCiphertext},
        api_key_hint = ${nextHint},
        last_test_status = ${connectionChanged ? null : current.last_test_status},
        last_test_message = ${connectionChanged ? null : current.last_test_message},
        last_test_latency_ms = ${connectionChanged ? null : current.last_test_latency_ms},
        last_tested_at = ${connectionChanged ? null : current.last_tested_at},
        updated_at = now()
      WHERE id = ${providerId} AND workspace_id = ${auth.workspace.id}
      RETURNING *
    `;
    const updated = rows[0];
    if (!updated) throw new Error('模型服务商更新失败');
    await writeAudit(tx, auth, 'model_provider.update', providerId, 'success', {
      name: updated.name,
      baseUrl: updated.base_url,
      model: updated.model,
      purpose: updated.purpose,
      priority: updated.priority,
      hasPricing: updated.prompt_price_per_1m !== null,
      priceCurrency: updated.price_currency,
      hasKey: Boolean(updated.api_key_ciphertext),
      clearedTest: connectionChanged,
    });
    return updated;
  });

  return mapProvider(row);
}

export async function deleteProvider(auth: AuthContext, providerId: string): Promise<void> {
  assertCanManage(auth.role);

  await sql.begin(async (tx) => {
    const current = await loadProvider(tx, auth.workspace.id, providerId, true);
    if (!current) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在');

    const used = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_calls WHERE provider_id = ${providerId}
    `;
    if ((used[0]?.count ?? 0) > 0) {
      throw conflict('PROVIDER_IN_USE', '该服务商已有调用记录，不能删除；请改为停用');
    }

    await tx`DELETE FROM model_providers WHERE id = ${providerId}`;
    await writeAudit(tx, auth, 'model_provider.delete', providerId, 'success', {
      name: current.name,
      baseUrl: current.base_url,
      model: current.model,
    });
  });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function connectionFailureDetail(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: { code?: unknown; message?: unknown } }).cause : null;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (cause && typeof cause.message === 'string') return truncate(cause.message, 200);
  if (error instanceof Error) return truncate(error.message, 200);
  return truncate(String(error), 200);
}

function extractModelIds(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((item) =>
      item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id.trim()
        : '',
    )
    .filter((id) => id.length > 0);
  return [...new Set(ids)];
}

type ModelListFetch =
  | { kind: 'ok'; models: string[] | null }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; detail: string }
  | { kind: 'timeout' };

export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('••••');
}

async function requestModelList(endpoint: URL, apiKey: string | null): Promise<ModelListFetch> {
  try {
    const target = new URL('models', `${endpoint.href.replace(/\/+$/, '')}/`);
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { kind: 'http_error', status: response.status, body: redactSecret(text, apiKey) };
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
    return { kind: 'ok', models: extractModelIds(payload) };
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
        ? (error as { name: string }).name
        : '';
    if (errorName === 'TimeoutError') return { kind: 'timeout' };
    return { kind: 'network_error', detail: connectionFailureDetail(error) };
  }
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

export interface GenerationProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  priority: number;
  promptPricePer1m: number | null;
  completionPricePer1m: number | null;
  priceCurrency: PriceCurrency;
  lastTestStatus: 'ok' | 'failed' | null;
}

export interface ProviderRouting {
  providers: GenerationProvider[];
  skipped: Array<{ name: string; reason: string }>;
}

export async function loadGenerationProviders(workspaceId: string): Promise<ProviderRouting> {
  const rows = await sql<ProviderRow[]>`
    SELECT * FROM model_providers
    WHERE workspace_id = ${workspaceId} AND is_enabled = true AND purpose = 'chat'
    ORDER BY priority ASC, created_at ASC
  `;
  if (rows.length === 0) {
    throw conflict(
      'NO_MODEL_PROVIDER',
      '当前工作区没有已启用的模型服务商，无法生成；请先在页头配置并启用一个 OpenAI 兼容端点。',
    );
  }

  const providers: GenerationProvider[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const provider of rows) {
    let apiKey: string | null = null;
    if (provider.api_key_ciphertext) {
      try {
        apiKey = decryptApiKey(provider.api_key_ciphertext, env.modelKeySecret);
      } catch {
        skipped.push({ name: provider.name, reason: '已保存的 API Key 无法解密' });
        continue;
      }
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.base_url,
      model: provider.model,
      apiKey,
      priority: provider.priority,
      promptPricePer1m: nullableNumber(provider.prompt_price_per_1m),
      completionPricePer1m: nullableNumber(provider.completion_price_per_1m),
      priceCurrency: priceCurrency(provider.price_currency),
      lastTestStatus: provider.last_test_status,
    });
  }

  if (providers.length === 0) {
    throw conflict(
      'PROVIDER_KEY_UNREADABLE',
      '已启用的模型服务商密钥都无法解密，请所有者重新录入后再生成',
    );
  }

  return {
    providers: providers.slice(0, MAX_ROUTING_PROVIDERS),
    skipped,
  };
}

const DISCOVERY_LIMIT = 200;

export async function discoverModels(
  auth: AuthContext,
  input: DiscoverModelsInput,
): Promise<ModelDiscoveryResponse> {
  assertCanDiscoverModels(auth.role);
  const endpoint = assertModelEndpointUrl(input.baseUrl);
  let apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : null;

  if (!apiKey && input.providerId) {
    const provider = await loadProvider(sql, auth.workspace.id, input.providerId);
    if (!provider) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在');
    if (provider.api_key_ciphertext) {
      try {
        apiKey = decryptApiKey(provider.api_key_ciphertext, env.modelKeySecret);
      } catch {
        throw badRequest('PROVIDER_KEY_UNREADABLE', '已保存的 API Key 无法解密，请重新录入后再拉取');
      }
    }
  }

  const startedAt = Date.now();
  const fetched = await requestModelList(endpoint, apiKey);
  const latencyMs = Date.now() - startedAt;

  if (fetched.kind === 'timeout') {
    throw badGateway('MODEL_DISCOVERY_TIMEOUT', '连接超时（8 秒），请检查端点是否可达。');
  }
  if (fetched.kind === 'network_error') {
    throw badGateway('MODEL_DISCOVERY_FAILED', `无法连接：${fetched.detail}`);
  }
  if (fetched.kind === 'http_error') {
    throw badGateway(
      'MODEL_DISCOVERY_FAILED',
      `连接失败：HTTP ${fetched.status}${fetched.body ? ` · ${truncate(fetched.body, 160)}` : ''}`,
    );
  }
  if (!fetched.models) {
    return {
      models: [],
      latencyMs,
      message: '连接成功（HTTP 200），但响应未包含模型清单。',
    };
  }

  const models = fetched.models.slice(0, DISCOVERY_LIMIT);
  return {
    models,
    latencyMs,
    message:
      fetched.models.length === 0
        ? '端点返回了空模型清单。'
        : `读取到 ${fetched.models.length} 个模型${
            fetched.models.length > DISCOVERY_LIMIT ? `，仅显示前 ${DISCOVERY_LIMIT} 个` : ''
          }。`,
  };
}

export async function probeEmbedding(
  auth: AuthContext,
  input: ProbeEmbeddingInput,
): Promise<EmbeddingProbeResponse> {
  assertCanManage(auth.role);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  let apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : null;
  let keyError: string | null = null;

  if (!apiKey && input.providerId) {
    const provider = await loadProvider(sql, auth.workspace.id, input.providerId);
    if (!provider) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在');
    if (provider.api_key_ciphertext) {
      try {
        apiKey = decryptApiKey(provider.api_key_ciphertext, env.modelKeySecret);
      } catch {
        keyError = '已保存的 API Key 无法解密，请重新录入后再探测';
      }
    }
  }

  const startedAt = Date.now();
  let response: EmbeddingProbeResponse;
  let errorKind: string | null = null;
  let errorCode: string | null = null;

  try {
    if (keyError) {
      throw new EmbeddingError('auth', 'EMBEDDING_KEY_UNREADABLE', keyError, {
        retryable: false,
      });
    }
    const result = await embedBatch(
      {
        id: input.providerId ?? 'embedding-probe',
        name: 'embedding-probe',
        baseUrl,
        model: input.model,
        apiKey,
        priority: 0,
        promptPricePer1m: null,
        priceCurrency: 'CNY',
      },
      [EMBEDDING_PROBE_TEXT],
      { timeoutMs: 10_000 },
    );
    response = {
      supported: true,
      model: input.model,
      dimensions: result.dimensions,
      latencyMs: result.latencyMs,
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: null,
      },
      message: `嵌入端点可用，返回 ${result.dimensions} 维向量。`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error instanceof EmbeddingError) {
      errorKind = error.kind;
      errorCode = error.code;
    }
    const detail = error instanceof Error ? error.message : String(error);
    response = {
      supported: false,
      model: input.model,
      dimensions: null,
      latencyMs,
      usage: null,
      message: errorKind === 'auth' ? `${detail}，请检查 API Key。` : detail,
    };
  }

  try {
    await writeProbeAudit(auth, input.providerId ?? null, response.supported ? 'success' : 'failure', {
      baseUrl,
      model: input.model,
      dimensions: response.dimensions,
      latencyMs: response.latencyMs,
      promptTokens: response.usage?.promptTokens ?? null,
      errorKind,
      errorCode,
    });
  } catch (auditError) {
    console.error('嵌入探测审计写入失败', auditError);
  }

  return response;
}

export async function testProvider(
  auth: AuthContext,
  providerId: string,
): Promise<ModelProviderTestResponse> {  assertCanView(auth.role);
  const provider = await loadProvider(sql, auth.workspace.id, providerId);
  if (!provider) throw notFound('PROVIDER_NOT_FOUND', '模型服务商不存在');

  let apiKey: string | null = null;
  let keyError: string | null = null;
  if (provider.api_key_ciphertext) {
    try {
      apiKey = decryptApiKey(provider.api_key_ciphertext, env.modelKeySecret);
    } catch {
      keyError = '已保存的 API Key 无法解密，请重新录入后再测试';
    }
  }

  const startedAt = Date.now();
  let status: 'ok' | 'failed' = 'failed';
  let message = '';
  let modelCount: number | null = null;
  let configuredModelAvailable: boolean | null = null;

  if (keyError) {
    message = keyError;
  } else {
    const fetched = await requestModelList(assertModelEndpointUrl(provider.base_url), apiKey);
    if (fetched.kind === 'timeout') {
      message = '连接超时（8 秒），请检查端点是否可达。';
    } else if (fetched.kind === 'network_error') {
      message = `无法连接：${fetched.detail}`;
    } else if (fetched.kind === 'http_error') {
      message = `连接失败：HTTP ${fetched.status}${fetched.body ? ` · ${truncate(fetched.body, 160)}` : ''}`;
    } else {
      const list = fetched.models;
      modelCount = list?.length ?? null;
      configuredModelAvailable = list ? list.includes(provider.model) : null;
      status = 'ok';
      message = list
        ? configuredModelAvailable
          ? `连接成功，返回 ${list.length} 个模型，已找到 ${provider.model}。`
          : `连接成功，返回 ${list.length} 个模型，但未找到 ${provider.model}。`
        : '连接成功（HTTP 200），但响应未包含模型清单。';
    }
  }

  const latencyMs = Date.now() - startedAt;
  const testedAt = new Date();
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<ProviderRow[]>`
      UPDATE model_providers SET
        last_test_status = ${status},
        last_test_message = ${truncate(message, 500)},
        last_test_latency_ms = ${latencyMs},
        last_tested_at = ${testedAt},
        updated_at = now()
      WHERE id = ${providerId} AND workspace_id = ${auth.workspace.id}
      RETURNING *
    `;
    const saved = updated[0];
    if (!saved) throw new Error('模型服务商测试状态写入失败');
    await writeAudit(tx, auth, 'model_provider.test', providerId, status === 'ok' ? 'success' : 'failure', {
      baseUrl: provider.base_url,
      model: provider.model,
      latencyMs,
      modelCount,
      configuredModelAvailable,
    });
    return saved;
  });

  return {
    result: {
      status,
      message,
      latencyMs,
      modelCount,
      configuredModelAvailable,
      testedAt: testedAt.toISOString(),
    },
    provider: mapProvider(rows),
  };
}
