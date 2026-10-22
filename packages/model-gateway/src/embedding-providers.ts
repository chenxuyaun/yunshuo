import type { Sql, TransactionSql } from 'postgres';
import { decryptApiKey } from './secret.js';
import type { EmbeddingProvider, GatewayPriceCurrency } from './embedding-client.js';

type Executor = Sql<any> | TransactionSql<any>;

export const MAX_EMBEDDING_PROVIDERS = 3;

interface EmbeddingProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  priority: number;
  prompt_price_per_1m: string | number | null;
  price_currency: string;
  api_key_ciphertext: string | null;
}

export interface EmbeddingRouting {
  providers: EmbeddingProvider[];
  skipped: Array<{ name: string; reason: string }>;
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function currency(value: string): GatewayPriceCurrency {
  return value === 'USD' ? 'USD' : 'CNY';
}

export async function loadEmbeddingProviders(
  exec: Executor,
  workspaceId: string,
  secret: string,
): Promise<EmbeddingRouting> {
  const rows = await exec<EmbeddingProviderRow[]>`
    SELECT id, name, base_url, model, priority, prompt_price_per_1m, price_currency,
           api_key_ciphertext
    FROM model_providers
    WHERE workspace_id = ${workspaceId} AND is_enabled = true AND purpose = 'embedding'
    ORDER BY priority ASC, created_at ASC
  `;

  const providers: EmbeddingProvider[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const row of rows) {
    let apiKey: string | null = null;
    if (row.api_key_ciphertext) {
      try {
        apiKey = decryptApiKey(row.api_key_ciphertext, secret);
      } catch {
        skipped.push({ name: row.name, reason: '已保存的 API Key 无法解密' });
        continue;
      }
    }
    providers.push({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      apiKey,
      priority: row.priority,
      promptPricePer1m: nullableNumber(row.prompt_price_per_1m),
      priceCurrency: currency(row.price_currency),
    });
  }

  return {
    providers: providers.slice(0, MAX_EMBEDDING_PROVIDERS),
    skipped,
  };
}
