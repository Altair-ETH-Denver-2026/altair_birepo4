import { type ChainKey } from './blockchain_config';

// Asset-platform IDs CoinGecko uses for our chains.
// Source: GET /api/v3/asset_platforms.
// Testnets are intentionally omitted; CoinGecko does not price testnet tokens.
export const COINGECKO_ASSET_PLATFORMS: Partial<Record<ChainKey, string>> = {
  ETH_MAINNET: 'ethereum',
  BASE_MAINNET: 'base',
  SOLANA_MAINNET: 'solana',
};

// CoinGecko `coins/{id}` IDs for native tokens. Not used in the current
// price job — native ETH/SOL are priced via their WETH/WSOL contract rows —
// but kept here so a future `/simple/price?ids=` fallback has the mapping ready.
export const COINGECKO_NATIVE_COIN_IDS: Partial<Record<ChainKey, string>> = {
  ETH_MAINNET: 'ethereum',
  BASE_MAINNET: 'ethereum',
  SOLANA_MAINNET: 'solana',
};

export type CoinGeckoTier = 'demo' | 'pro';

// CoinGecko ships two split tiers. Demo (free) and Pro (paid) have different
// base URLs and different auth header names; mixing them yields a 400.
const TIER_ENDPOINTS: Record<CoinGeckoTier, { baseUrl: string; apiKeyHeader: string }> = {
  demo: {
    baseUrl: 'https://api.coingecko.com/api/v3',
    apiKeyHeader: 'x-cg-demo-api-key',
  },
  pro: {
    baseUrl: 'https://pro-api.coingecko.com/api/v3',
    apiKeyHeader: 'x-cg-pro-api-key',
  },
};

/**
 * Resolves which CoinGecko tier to use. Override with `COINGECKO_TIER=pro`
 * once on a paid plan. Defaults to `demo` — matches a free CoinGecko API key.
 */
export function resolveCoinGeckoTier(): CoinGeckoTier {
  const raw = process.env.COINGECKO_TIER?.trim().toLowerCase();
  return raw === 'pro' ? 'pro' : 'demo';
}

export function resolveCoinGeckoEndpoint(): { baseUrl: string; apiKeyHeader: string; tier: CoinGeckoTier } {
  const tier = resolveCoinGeckoTier();
  return { ...TIER_ENDPOINTS[tier], tier };
}

export const COINGECKO_API = {
  // Comma-separated contract_addresses cap per request. CoinGecko docs don't
  // publish a hard limit; 50 is a safe ceiling that keeps URL length sane.
  contractBatchSize: 50,
  requestTimeoutMs: 10_000,
  // Soft inter-batch delay so we don't fan out 100 contracts in one tick.
  interBatchDelayMs: 250,
};
