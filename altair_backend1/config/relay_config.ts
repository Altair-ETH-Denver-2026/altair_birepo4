export const RELAY_API_URL = (process.env.RELAY_API_URL ?? 'https://api.relay.link').replace(/\/+$/, '');
export const RELAY_TESTNET_API_URL = (process.env.RELAY_TESTNET_API_URL ?? 'https://api.testnets.relay.link').replace(
  /\/+$/,
  ''
);
export const RELAY_API_KEY = process.env.RELAY_API_KEY ?? '';

const RELAY_TESTNET_CHAIN_IDS = new Set([84532, 11155111, 1337, 42431]);

export const resolveRelayApiUrl = (params: { originChainId: number; destinationChainId: number }) => {
  const { originChainId, destinationChainId } = params;
  if (RELAY_TESTNET_CHAIN_IDS.has(originChainId) || RELAY_TESTNET_CHAIN_IDS.has(destinationChainId)) {
    return RELAY_TESTNET_API_URL;
  }
  return RELAY_API_URL;
};

export type RelayQuoteRequest = {
  user: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
  recipient?: string;
  forceSolverExecution?: boolean;
  useDepositAddress?: boolean;
  useReceiver?: boolean;
  strict?: boolean;
  useExternalLiquidity?: boolean;
  useFallbacks?: boolean;
  includeComputeUnitLimit?: boolean;
  maxRouteLength?: number;
  useSharedAccounts?: boolean;
  overridePriceImpact?: boolean;
  disableOriginSwaps?: boolean;
};

export type RelayQuoteResponse = {
  steps: Array<{
    id: string;
    action?: string;
    description?: string;
    kind: 'transaction' | 'signature';
    requestId?: string;
    items: Array<{
      status?: string;
      data?: {
        from?: string;
        to?: string;
        data?: string;
        value?: string;
        chainId?: number;
      };
      check?: {
        endpoint?: string;
        method?: string;
      };
      signatureKind?: string;
      message?: string;
    }>;
  }>;
  details?: Record<string, unknown>;
  fees?: Record<string, unknown>;
  protocol?: Record<string, unknown>;
};
