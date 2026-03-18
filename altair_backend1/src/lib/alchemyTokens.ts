import { ethers } from 'ethers';
import type { ChainKey } from '../../config/blockchain_config';
import { BASE_MAINNET, BASE_SEPOLIA, ETH_MAINNET, ETH_SEPOLIA, resolveRpcUrls } from '../../config/chain_info';

export type AlchemyDiscoveredToken = {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logo?: string;
  source: 'alchemy';
};

const EVM_CHAIN_CONFIG: Partial<Record<ChainKey, { rpcUrls: string[]; chainId: number }>> = {
  ETH_MAINNET,
  ETH_SEPOLIA,
  BASE_MAINNET,
  BASE_SEPOLIA,
};

export const isEvmAddress = (value: string) => {
  try {
    return ethers.isAddress(value);
  } catch {
    return false;
  }
};

export const normalizeEvmAddress = (value: string) => {
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
};

export const buildEvmTokenCacheKey = (chainId: number, address: string) =>
  `${chainId}:${normalizeEvmAddress(address)}`;

export const getAlchemyTokenMetadataByAddress = async (params: {
  chainKey: ChainKey;
  address: string;
}): Promise<AlchemyDiscoveredToken | null> => {
  const { chainKey, address } = params;
  if (!isEvmAddress(address)) return null;
  const chain = EVM_CHAIN_CONFIG[chainKey];
  if (!chain) return null;

  const rpc = resolveRpcUrls(chain.rpcUrls)[0] ?? chain.rpcUrls[0];
  if (!rpc) return null;

  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'alchemy_getTokenMetadata',
      params: [address],
    }),
  });

  if (!res.ok) return null;
  const body = (await res.json()) as {
    result?: { symbol?: string; name?: string; decimals?: number; logo?: string };
  };
  const result = body?.result;
  if (!result) return null;

  return {
    address: normalizeEvmAddress(address),
    symbol: typeof result.symbol === 'string' ? result.symbol : undefined,
    name: typeof result.name === 'string' ? result.name : undefined,
    decimals: typeof result.decimals === 'number' ? result.decimals : undefined,
    logo: typeof result.logo === 'string' ? result.logo : undefined,
    source: 'alchemy',
  };
};

const normalizeSymbolCandidates = (input: unknown): string[] => {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
};

export const searchAlchemyTokenAddressesBySymbol = async (params: {
  symbol: string;
}): Promise<string[]> => {
  const apiKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  const symbol = params.symbol.trim().toUpperCase();
  if (!apiKey || !symbol) return [];

  // Token API endpoint family; parser is intentionally shape-tolerant.
  const url = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-symbol?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) return [];

  const body = (await res.json()) as Record<string, unknown>;
  const buckets: unknown[] = [];

  if (Array.isArray(body.data)) buckets.push(...body.data);
  if (Array.isArray(body.tokens)) buckets.push(...body.tokens);
  if (Array.isArray(body.results)) buckets.push(...body.results);
  if (body.bySymbol && typeof body.bySymbol === 'object') {
    const bySymbol = body.bySymbol as Record<string, unknown>;
    buckets.push(...normalizeSymbolCandidates(bySymbol[symbol]));
  }

  const out = new Set<string>();

  for (const entry of buckets) {
    if (typeof entry === 'string' && isEvmAddress(entry)) {
      out.add(normalizeEvmAddress(entry));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const maybeAddr =
      (typeof rec.address === 'string' && rec.address) ||
      (typeof rec.contractAddress === 'string' && rec.contractAddress) ||
      (typeof rec.tokenAddress === 'string' && rec.tokenAddress) ||
      null;
    if (maybeAddr && isEvmAddress(maybeAddr)) {
      out.add(normalizeEvmAddress(maybeAddr));
    }
  }

  return Array.from(out);
};

