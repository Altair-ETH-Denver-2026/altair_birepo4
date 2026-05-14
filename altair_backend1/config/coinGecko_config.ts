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

export const COINGECKO_API = {
  baseUrl: 'https://pro-api.coingecko.com/api/v3',
  // Comma-separated contract_addresses cap per request. CoinGecko docs don't
  // publish a hard limit; 50 is a safe ceiling that keeps URL length sane.
  contractBatchSize: 50,
  requestTimeoutMs: 10_000,
  // Soft inter-batch delay so we don't fan out 100 contracts in one tick.
  interBatchDelayMs: 250,
};
