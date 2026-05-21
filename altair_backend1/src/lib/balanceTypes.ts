import type { ChainKey } from '../../config/blockchain_config';

export type ApiBalanceSource = 'cache' | 'mongo' | 'blockchain' | 'stale';

export type ApiTokenBalance = {
  symbol: string;
  name?: string;
  address?: string;
  decimals: number;
  balance: string;
  balanceRaw?: string;
  source?: ApiBalanceSource;
  verifiedAt?: number;
  // USD price for this token, looked up from the `tokens` collection at API
  // response time. `null` means we have a row for the token but no price yet;
  // `undefined` means the backend hasn't run the lookup for this entry.
  price?: number | null;
};

export type ApiChainBalances = {
  tokens: Record<string, ApiTokenBalance>;
  address?: string;
  solanaAddress?: string;
  source?: ApiBalanceSource;
  verifiedAt?: number;
  timestamp?: number;
};

export type ApiBalancesResponse = {
  chain: ChainKey;
  tokens: Record<string, ApiTokenBalance>;
  address?: string;
  solanaAddress?: string;
  source: ApiBalanceSource;
  verifiedAt: number;
  timestamp: number;
};

