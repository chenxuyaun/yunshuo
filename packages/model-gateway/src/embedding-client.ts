export const EMBEDDING_PROBE_TEXT = '云说嵌入连通性探测。';

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_BODY_LIMIT = 300;

export type GatewayPriceCurrency = 'CNY' | 'USD';

export interface EmbeddingProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  priority: number;
  promptPricePer1m: number | null;
  priceCurrency: GatewayPriceCurrency;
}

export type EmbeddingErrorKind =
  | 'auth'
  | 'http'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'dimension_mismatch';

export interface EmbeddingErrorOptions {
  retryable: boolean;
  status?: number | null;
}

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    kind: EmbeddingErrorKind,
    code: string,
    message: string,
    options: EmbeddingErrorOptions,
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

export interface EmbeddingBatchResult {
  vectors: number[][];
  dimensions: number;
  promptTokens: number | null;
  latencyMs: number;
}

export interface EmbeddingRequestOptions {
  timeoutMs?: number;
}

function redact(text: string, apiKey: string | null): string {
  if (!apiKey || apiKey.length < 4) return text;
  return text.split(apiKey).join('••••');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function extractVectors(payload: unknown, expected: number): number[][] {
  if (!payload || typeof payload !== 'object') {
    throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入服务返回的不是 JSON 对象', {
      retryable: false,
    });
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入服务响应缺少 data 数组', {
      retryable: false,
    });
  }
  const items = data.map((item, position) => {
    if (!item || typeof item !== 'object') {
      throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入服务返回了无效的向量项', {
        retryable: false,
      });
    }
    const record = item as { embedding?: unknown; index?: unknown };
    const index =
      typeof record.index === 'number' && Number.isInteger(record.index) ? record.index : position;
    if (!Array.isArray(record.embedding) || record.embedding.length === 0) {
      throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入服务返回了空向量', {
        retryable: false,
      });
    }
    const vector = record.embedding.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入向量包含非数值', {
          retryable: false,
        });
      }
      return value;
    });
    return { index, vector };
  });
  if (items.length !== expected) {
    throw new EmbeddingError(
      'bad_response',
      'EMBEDDING_COUNT_MISMATCH',
      `嵌入服务返回 ${items.length} 条向量，期望 ${expected} 条`,
      { retryable: false },
    );
  }
  items.sort((a, b) => a.index - b.index);
  return items.map((item) => item.vector);
}

function promptTokens(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const value = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function embedBatch(
  provider: EmbeddingProvider,
  inputs: string[],
  options: EmbeddingRequestOptions = {},
): Promise<EmbeddingBatchResult> {
  if (inputs.length === 0) {
    throw new EmbeddingError('bad_response', 'EMBEDDING_EMPTY_INPUT', '没有可嵌入的文本', {
      retryable: false,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

    const response = await fetch(`${provider.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, input: inputs }),
      redirect: 'error',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      let detail = '';
      try {
        detail = truncate(redact(await response.text(), provider.apiKey), ERROR_BODY_LIMIT);
      } catch {
        detail = '';
      }
      const kind = response.status === 401 || response.status === 403 ? 'auth' : 'http';
      throw new EmbeddingError(
        kind,
        kind === 'auth' ? 'EMBEDDING_AUTH' : 'EMBEDDING_HTTP_ERROR',
        `嵌入服务返回 HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
        { retryable: kind === 'http' && retryableStatus(response.status), status: response.status },
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new EmbeddingError('bad_response', 'EMBEDDING_BAD_RESPONSE', '嵌入服务返回的不是有效 JSON', {
        retryable: false,
        status: response.status,
      });
    }

    const vectors = extractVectors(payload, inputs.length);
    const dimensions = vectors[0]!.length;
    for (const vector of vectors) {
      if (vector.length !== dimensions) {
        throw new EmbeddingError(
          'dimension_mismatch',
          'EMBEDDING_DIMENSION_MISMATCH',
          `同一批次向量维度不一致：${dimensions} 与 ${vector.length}`,
          { retryable: false, status: response.status },
        );
      }
    }

    return {
      vectors,
      dimensions,
      promptTokens: promptTokens(payload),
      latencyMs,
    };
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    const latencyMs = Date.now() - startedAt;
    void latencyMs;
    if (timedOut) {
      throw new EmbeddingError(
        'timeout',
        'EMBEDDING_TIMEOUT',
        `嵌入请求超时（${Math.round(timeoutMs / 1000)} 秒）`,
        { retryable: true },
      );
    }
    const name =
      error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
        ? (error as { name: string }).name
        : '';
    if (name === 'TimeoutError') {
      throw new EmbeddingError(
        'timeout',
        'EMBEDDING_TIMEOUT',
        `嵌入请求超时（${Math.round(timeoutMs / 1000)} 秒）`,
        { retryable: true },
      );
    }
    throw new EmbeddingError(
      'network',
      'EMBEDDING_NETWORK_ERROR',
      `无法连接嵌入服务：${truncate(redact(String(error), provider.apiKey), ERROR_BODY_LIMIT)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}
