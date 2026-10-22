import type { EmbeddingProvider } from './embedding-client.js';

export interface EmbeddingCost {
  cost: number;
  currency: string;
}

export function computeEmbeddingCost(
  provider: Pick<EmbeddingProvider, 'promptPricePer1m' | 'priceCurrency'>,
  promptTokens: number | null,
): EmbeddingCost | null {
  if (provider.promptPricePer1m === null || promptTokens === null) return null;
  const value = (promptTokens / 1_000_000) * provider.promptPricePer1m;
  return {
    cost: Math.round(value * 10_000) / 10_000,
    currency: provider.priceCurrency,
  };
}
