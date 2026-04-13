import { NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Connection, PublicKey } from '@solana/web3.js';
import { cookies } from 'next/headers';
import { BLOCKCHAIN, CHAINS, GAS_TOKENS, type ChainKey } from '../../../../config/blockchain_config';
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETH_MAINNET,
  ETH_SEPOLIA,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  resolveRpcUrls,
} from '../../../../config/chain_info';
import type { ApiBalancesResponse, ApiTokenBalance } from '@/lib/balanceTypes';
import { getPrivyEvmWalletAddress, getPrivySolanaWalletAddress } from '@/lib/privy';
import {
  getAllUserTokens,
  getUIDFromAccessToken,
  updateBalancesSnapshotInMongoDB,
  type BalanceEntry,
} from '@/lib/balanceService';
import { getUserUIDFromAccessTokenByMode } from '@/lib/users';
import { formatAmountFromRaw } from '@/lib/amounts';
import { buildCorsHeaders } from '@/lib/appUrls';

const ERC20_BALANCE_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const NATIVE_EVM_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const toApiTokenBalance = (entry: BalanceEntry): ApiTokenBalance => ({
  symbol: entry.symbol,
  name: entry.name,
  address: entry.address,
  decimals: entry.decimals,
  balanceRaw: entry.balance,
  balance: formatAmountFromRaw(entry.balance, entry.decimals),
  source: entry.source,
  verifiedAt: entry.verifiedAt,
});

export const fromMongoToPayload = (params: {
  chain: ChainKey;
  address: string;
  mongoBalances: Record<string, BalanceEntry>;
}): ApiBalancesResponse => {
  const tokens: Record<string, ApiTokenBalance> = {};
  Object.entries(params.mongoBalances).forEach(([symbol, entry]) => {
    if (!entry || typeof entry !== 'object') return;
    tokens[symbol.toUpperCase()] = toApiTokenBalance({
      ...entry,
      symbol: entry.symbol ?? symbol,
      source: entry.source ?? 'mongo',
    });
  });

  const now = Date.now();
  return {
    chain: params.chain,
    tokens,
    ...((params.chain === 'SOLANA_MAINNET' || params.chain === 'SOLANA_DEVNET')
      ? { solanaAddress: params.address }
      : { address: params.address }),
    source: 'mongo',
    verifiedAt: now,
    timestamp: now,
  };
};

const chainInfoByKey = {
  BASE_SEPOLIA,
  ETH_SEPOLIA,
  ETH_MAINNET,
  BASE_MAINNET,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
} as const;

const isSolanaChain = (chainKey: ChainKey) =>
  chainKey === 'SOLANA_MAINNET' || chainKey === 'SOLANA_DEVNET';
const isLikelyEvmAddress = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
const isLikelySolanaAddress = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length >= 32 && !value.trim().startsWith('0x');

const INCLUDE_ALL_CHAINS_CACHE_TTL_MS = 1_500;
type IncludeAllChainsResponse = ApiBalancesResponse & { allChains: Record<ChainKey, ApiBalancesResponse> };
const includeAllChainsInFlight = new Map<string, Promise<IncludeAllChainsResponse>>();
const includeAllChainsCache = new Map<string, { expiresAt: number; payload: IncludeAllChainsResponse }>();

const ALCHEMY_PORTFOLIO_NETWORK_BY_CHAIN: Partial<Record<ChainKey, string>> = {
  ETH_MAINNET: 'eth-mainnet',
  ETH_SEPOLIA: 'eth-sepolia',
  BASE_MAINNET: 'base-mainnet',
  BASE_SEPOLIA: 'base-sepolia',
};

const CHAIN_BY_ALCHEMY_PORTFOLIO_NETWORK: Record<string, ChainKey> = {
  'eth-mainnet': 'ETH_MAINNET',
  'eth-sepolia': 'ETH_SEPOLIA',
  'base-mainnet': 'BASE_MAINNET',
  'base-sepolia': 'BASE_SEPOLIA',
};

const normalizeRawBalance = (value: unknown): string => {
  if (typeof value !== 'string') return '0';
  const raw = value.trim();
  if (!raw) return '0';
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    try {
      return BigInt(raw).toString();
    } catch {
      return '0';
    }
  }
  return raw;
};

const cloneSeedEntry = (symbol: string, seed?: BalanceEntry): BalanceEntry => ({
  symbol,
  name: seed?.name ?? symbol,
  address: seed?.address ?? '',
  decimals: typeof seed?.decimals === 'number' ? seed.decimals : 18,
  balance: seed?.balance ?? '0',
  source: 'blockchain',
  verifiedAt: Date.now(),
});

const fetchEvmBalancesViaAlchemyPortfolio = async (params: {
  walletAddress: string;
  chainKeys: ChainKey[];
  seedByChain: Partial<Record<ChainKey, Record<string, BalanceEntry>>>;
}): Promise<Record<ChainKey, Record<string, BalanceEntry>>> => {
  const apiKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_ALCHEMY_API_KEY is required for Alchemy Portfolio token balances');
  }

  const requestedNetworks = params.chainKeys
    .map((chainKey) => ALCHEMY_PORTFOLIO_NETWORK_BY_CHAIN[chainKey])
    .filter((network): network is string => typeof network === 'string' && network.length > 0);

  if (requestedNetworks.length === 0) {
    return {} as Record<ChainKey, Record<string, BalanceEntry>>;
  }

  const out: Record<ChainKey, Record<string, BalanceEntry>> = {} as Record<ChainKey, Record<string, BalanceEntry>>;
  const trackedSymbolsByChain: Partial<Record<ChainKey, Set<string>>> = {};
  const trackedAddressToSymbolByChain: Partial<Record<ChainKey, Map<string, string>>> = {};
  const updatedCountByChain: Partial<Record<ChainKey, number>> = {};
  const updatedSymbolsByChain: Partial<Record<ChainKey, Set<string>>> = {};

  for (const chainKey of params.chainKeys) {
    const seed = params.seedByChain[chainKey] ?? {};
    const seeded: Record<string, BalanceEntry> = {};
    const tracked = new Set<string>();
    const trackedAddressToSymbol = new Map<string, string>();

    Object.entries(seed).forEach(([symbol, entry]) => {
      const normalized = symbol.toUpperCase();
      seeded[normalized] = cloneSeedEntry(normalized, { ...entry, symbol: entry.symbol ?? normalized });
      tracked.add(normalized);
      const addressRaw = typeof entry?.address === 'string' ? entry.address.trim().toLowerCase() : '';
      if (addressRaw && addressRaw !== NATIVE_EVM_ADDRESS.toLowerCase()) {
        trackedAddressToSymbol.set(addressRaw, normalized);
      }
    });

    out[chainKey] = seeded;
    trackedSymbolsByChain[chainKey] = tracked;
    trackedAddressToSymbolByChain[chainKey] = trackedAddressToSymbol;
    updatedCountByChain[chainKey] = 0;
    updatedSymbolsByChain[chainKey] = new Set<string>();
  }

  const endpoint = `https://api.g.alchemy.com/data/v1/${apiKey}/assets/tokens/by-address`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      addresses: [
        {
          address: params.walletAddress,
          networks: requestedNetworks,
        },
      ],
      withMetadata: true,
      includeNativeTokens: true,
      includeErc20Tokens: true,
      withPrices: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Alchemy Portfolio token fetch failed (${response.status}): ${errText}`);
  }

  const payload = (await response.json()) as {
    data?: {
      tokens?: Array<{
        network?: string;
        tokenAddress?: string;
        tokenBalance?: string;
        tokenMetadata?: {
          symbol?: string;
          name?: string;
          decimals?: number;
        };
      }>;
    };
  };

  const now = Date.now();
  const tokens = Array.isArray(payload?.data?.tokens) ? payload.data.tokens : [];

  for (const token of tokens) {
    const networkRaw = typeof token?.network === 'string' ? token.network.toLowerCase() : '';
    const chainKey = CHAIN_BY_ALCHEMY_PORTFOLIO_NETWORK[networkRaw];
    if (!chainKey || !out[chainKey]) continue;

    const symbolRaw = typeof token?.tokenMetadata?.symbol === 'string' && token.tokenMetadata.symbol.length > 0
      ? token.tokenMetadata.symbol
      : (GAS_TOKENS[chainKey] ?? 'TOKEN');
    const symbol = symbolRaw.toUpperCase();
    const tokenAddressNormalized = typeof token?.tokenAddress === 'string'
      ? token.tokenAddress.trim().toLowerCase()
      : '';
    const trackedSymbols = trackedSymbolsByChain[chainKey] ?? new Set<string>();
    const trackedAddressMap = trackedAddressToSymbolByChain[chainKey] ?? new Map<string, string>();
    const matchedByAddress = tokenAddressNormalized ? trackedAddressMap.get(tokenAddressNormalized) : undefined;
    const targetSymbol = matchedByAddress ?? (trackedSymbols.has(symbol) ? symbol : null);

    if (!targetSymbol) {
      console.log('[balances] EVM token skipped (not in tracked seed set)', {
        chainKey,
        network: networkRaw,
        symbol,
        tokenAddress: token?.tokenAddress,
      });
      continue;
    } else {
      console.log('[balances] EVM token to update', {
        chainKey,
        network: networkRaw,
        symbol,
        tokenAddress: token?.tokenAddress,
      });
    }
    const seed = out[chainKey][targetSymbol];
    const isLikelyNative =
      !token?.tokenAddress ||
      token.tokenAddress === 'NATIVE_TOKEN' ||
      token.tokenAddress === '0x0000000000000000000000000000000000000000';

    const nativeSymbol = GAS_TOKENS[chainKey]?.toUpperCase() ?? 'ETH';
    const existing = out[chainKey][targetSymbol];
    const existingIsNative =
      typeof existing?.address === 'string' &&
      existing.address.toLowerCase() === NATIVE_EVM_ADDRESS.toLowerCase();

    // Never allow a non-native token with the same symbol (e.g., "ETH")
    // to overwrite the native gas token entry.
    if (!isLikelyNative && targetSymbol === nativeSymbol && existingIsNative) {
      continue;
    }

    out[chainKey][targetSymbol] = {
      symbol: targetSymbol,
      name: typeof token?.tokenMetadata?.name === 'string' && token.tokenMetadata.name.length > 0
        ? token.tokenMetadata.name
        : (seed?.name ?? targetSymbol),
      address: isLikelyNative
        ? NATIVE_EVM_ADDRESS
        : (typeof token?.tokenAddress === 'string' ? token.tokenAddress : (seed?.address ?? '')),
      decimals: typeof token?.tokenMetadata?.decimals === 'number'
        ? token.tokenMetadata.decimals
        : (seed?.decimals ?? 18),
      balance: normalizeRawBalance(token?.tokenBalance),
      source: 'blockchain',
      verifiedAt: now,
    };
    updatedCountByChain[chainKey] = (updatedCountByChain[chainKey] ?? 0) + 1;
    updatedSymbolsByChain[chainKey]?.add(targetSymbol);
  }

  // Alchemy Portfolio may omit tracked tokens for a chain in the response payload.
  // For strict seed reconciliation, backfill any tracked symbols not returned by Alchemy
  // using direct on-chain reads (native getBalance / ERC-20 balanceOf).
  for (const chainKey of params.chainKeys) {
    const trackedSymbols = trackedSymbolsByChain[chainKey] ?? new Set<string>();
    const updatedSymbols = updatedSymbolsByChain[chainKey] ?? new Set<string>();
    const missingSymbols = Array.from(trackedSymbols).filter((symbol) => !updatedSymbols.has(symbol));
    if (missingSymbols.length === 0) continue;

    const chainConfig = chainInfoByKey[chainKey];
    if (!('chainId' in chainConfig)) continue;
    const rpcUrls = resolveRpcUrls(chainConfig.rpcUrls);
    const rpcUrl = rpcUrls[0] ?? chainConfig.rpcUrls[0];
    if (!rpcUrl) continue;

    const client = createPublicClient({
      chain: {
        ...baseSepolia,
        id: chainConfig.chainId,
        rpcUrls: { default: { http: rpcUrls }, public: { http: rpcUrls } },
      },
      transport: http(rpcUrl),
    });

    const account = params.walletAddress as `0x${string}`;
    const nativeSymbol = GAS_TOKENS[chainKey]?.toUpperCase() ?? 'ETH';

    for (const symbol of missingSymbols) {
      const seed = out[chainKey][symbol] ?? cloneSeedEntry(symbol);
      const seedAddress = typeof seed.address === 'string' ? seed.address.trim() : '';
      const isNativeBySymbol = symbol === nativeSymbol;
      const isNativeByAddress = seedAddress.toLowerCase() === NATIVE_EVM_ADDRESS.toLowerCase();

      try {
        if (isNativeBySymbol || isNativeByAddress || !seedAddress) {
          const nativeBalance = await client.getBalance({ address: account });
          out[chainKey][symbol] = {
            ...seed,
            symbol,
            address: NATIVE_EVM_ADDRESS,
            decimals: typeof seed.decimals === 'number' ? seed.decimals : 18,
            balance: nativeBalance.toString(),
            source: 'blockchain',
            verifiedAt: Date.now(),
          };
          updatedSymbolsByChain[chainKey]?.add(symbol);
          updatedCountByChain[chainKey] = (updatedCountByChain[chainKey] ?? 0) + 1;
          console.log('[balances] EVM fallback token updated', { chainKey, symbol, via: 'native-getBalance' });
          continue;
        }

        const [decimalsRaw, balanceRaw] = await Promise.all([
          client.readContract({
            address: seedAddress as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: 'decimals',
          }),
          client.readContract({
            address: seedAddress as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [account],
          }),
        ]);

        out[chainKey][symbol] = {
          ...seed,
          symbol,
          address: seedAddress,
          decimals: Number(decimalsRaw),
          balance: balanceRaw.toString(),
          source: 'blockchain',
          verifiedAt: Date.now(),
        };
        updatedSymbolsByChain[chainKey]?.add(symbol);
        updatedCountByChain[chainKey] = (updatedCountByChain[chainKey] ?? 0) + 1;
        console.log('[balances] EVM fallback token updated', { chainKey, symbol, via: 'erc20-balanceOf' });
      } catch (err) {
        console.warn('[balances] EVM fallback token read failed', {
          chainKey,
          symbol,
          tokenAddress: seedAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  console.log('[balances] EVM verification update counts', updatedCountByChain);

  return out;
};

async function fetchBlockchainBalancesDynamic(params: {
  chainKey: ChainKey;
  walletAddress: string;
  seedBalances: Record<string, BalanceEntry>;
}): Promise<Record<string, BalanceEntry>> {
  const { chainKey, walletAddress, seedBalances } = params;
  const symbolSeed = Object.keys(seedBalances);
  const nativeSymbol = GAS_TOKENS[chainKey]?.toUpperCase() ?? (isSolanaChain(chainKey) ? 'SOL' : 'ETH');
  const tokenSymbols = Array.from(new Set(symbolSeed.map((s) => s.toUpperCase())));
  const output: Record<string, BalanceEntry> = {};

  if (isSolanaChain(chainKey)) {
    const solanaConfig = chainKey === 'SOLANA_MAINNET' ? SOLANA_MAINNET : SOLANA_DEVNET;
    const solanaRpcUrls = resolveRpcUrls(solanaConfig.rpcUrls);
    const solanaRpcUrl = solanaRpcUrls[0] ?? solanaConfig.rpcUrls[0];
    const connection = new Connection(solanaRpcUrl, 'confirmed');
    const owner = new PublicKey(walletAddress);
    const balancesByMint = new Map<string, { amount: bigint; decimals: number }>();

    const tokenProgramIds = [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ];

    for (const programId of tokenProgramIds) {
      try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) });
        tokenAccounts.value.forEach((tokenAccount) => {
          const parsed = tokenAccount.account.data;
          if (!('parsed' in parsed)) return;
          const mint = parsed.parsed?.info?.mint;
          const amount = parsed.parsed?.info?.tokenAmount?.amount;
          const decimals = parsed.parsed?.info?.tokenAmount?.decimals;
          if (typeof mint !== 'string' || typeof amount !== 'string') return;
          const current = balancesByMint.get(mint);
          const nextAmount = BigInt(amount);
          const nextDecimals = typeof decimals === 'number' ? decimals : (current?.decimals ?? 0);
          balancesByMint.set(mint, {
            amount: (current?.amount ?? 0n) + nextAmount,
            decimals: nextDecimals,
          });
        });
      } catch {
        // Ignore token-program specific failures and continue with whatever data is available.
      }
    }

    for (const symbol of tokenSymbols) {
      const seed = seedBalances[symbol] ?? seedBalances[symbol.toUpperCase()];
      const seedDecimals = typeof seed?.decimals === 'number' ? seed.decimals : undefined;
      const seedAddress = typeof seed?.address === 'string' ? seed.address : '';
      const isNative = symbol === nativeSymbol;

      if (isNative) {
        const lamports = await connection.getBalance(owner);
        output[symbol] = {
          symbol,
          name: seed?.name ?? symbol,
          address: seedAddress,
          decimals: seedDecimals ?? 9,
          balance: lamports.toString(),
          source: 'blockchain',
          verifiedAt: Date.now(),
        };
        continue;
      }

      if (!seedAddress) {
        output[symbol] = {
          symbol,
          name: seed?.name ?? symbol,
          address: '',
          decimals: seedDecimals ?? 0,
          balance: '0',
          source: 'blockchain',
          verifiedAt: Date.now(),
        };
        continue;
      }

      const mintAggregate = balancesByMint.get(seedAddress);
      const raw = (mintAggregate?.amount ?? 0n).toString();
      const decimals = mintAggregate?.decimals ?? seedDecimals ?? 0;

      output[symbol] = {
        symbol,
        name: seed?.name ?? symbol,
        address: seedAddress,
        decimals,
        balance: raw,
        source: 'blockchain',
        verifiedAt: Date.now(),
      };
    }

    return output;
  }

  const chainConfig = chainInfoByKey[chainKey];
  if (!('chainId' in chainConfig)) {
    return output;
  }
  const rpcUrls = resolveRpcUrls(chainConfig.rpcUrls);
  const client = createPublicClient({
    chain: {
      ...baseSepolia,
      id: chainConfig.chainId,
      rpcUrls: { default: { http: rpcUrls }, public: { http: rpcUrls } },
    },
    transport: http(rpcUrls[0]),
  });

  const account = walletAddress as `0x${string}`;

  for (const symbol of tokenSymbols) {
    const seed = seedBalances[symbol] ?? seedBalances[symbol.toUpperCase()];
    const isNative = symbol === nativeSymbol;
    const seedAddress = typeof seed?.address === 'string' ? seed.address : '';
    const tokenAddress = isNative ? NATIVE_EVM_ADDRESS : seedAddress;
    const seedDecimals = typeof seed?.decimals === 'number' ? seed.decimals : undefined;

    if (isNative) {
      const nativeBalance = await client.getBalance({ address: account });
      output[symbol] = {
        symbol,
        name: seed?.name ?? symbol,
        address: tokenAddress,
        decimals: seedDecimals ?? 18,
        balance: nativeBalance.toString(),
        source: 'blockchain',
        verifiedAt: Date.now(),
      };
      continue;
    }

    if (!tokenAddress || tokenAddress === NATIVE_EVM_ADDRESS) {
      output[symbol] = {
        symbol,
        name: seed?.name ?? symbol,
        address: tokenAddress,
        decimals: seedDecimals ?? 18,
        balance: '0',
        source: 'blockchain',
        verifiedAt: Date.now(),
      };
      continue;
    }

    try {
      const [decimalsRaw, balanceRaw] = await Promise.all([
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'decimals',
        }),
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [account],
        }),
      ]);

      output[symbol] = {
        symbol,
        name: seed?.name ?? symbol,
        address: tokenAddress,
        decimals: Number(decimalsRaw),
        balance: balanceRaw.toString(),
        source: 'blockchain',
        verifiedAt: Date.now(),
      };
    } catch {
      output[symbol] = {
        symbol,
        name: seed?.name ?? symbol,
        address: tokenAddress,
        decimals: seedDecimals ?? 18,
        balance: '0',
        source: 'blockchain',
        verifiedAt: Date.now(),
      };
    }
  }

  return output;
}

const toResponseFromBlockchain = (params: {
  chain: ChainKey;
  address: string;
  balances: Record<string, BalanceEntry>;
}): ApiBalancesResponse => {
  const now = Date.now();
  const tokens: Record<string, ApiTokenBalance> = {};
  Object.entries(params.balances).forEach(([symbol, entry]) => {
    tokens[symbol.toUpperCase()] = toApiTokenBalance(entry);
  });

  return {
    chain: params.chain,
    tokens,
    ...((params.chain === 'SOLANA_MAINNET' || params.chain === 'SOLANA_DEVNET')
      ? { solanaAddress: params.address }
      : { address: params.address }),
    source: 'blockchain',
    verifiedAt: now,
    timestamp: now,
  };
};

export async function POST(req: Request) {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  const withCors = (init?: ResponseInit): ResponseInit => ({
    ...(init ?? {}),
    headers: {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
      ...corsHeaders,
    },
  });

  try {
    const {
      walletAddress: overrideAddress,
      chain,
      accessToken: bodyToken,
      forceRefresh,
      skipAsyncVerification,
      includeAllChains,
      refreshSelectedChain,
    } = (await req.json().catch(() => ({}))) as {
      walletAddress?: string;
      chain?: ChainKey;
      accessToken?: string;
      forceRefresh?: boolean;
      skipAsyncVerification?: boolean;
      includeAllChains?: boolean;
      refreshSelectedChain?: boolean;
    };

    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value;
    const tokenToVerify = bodyToken ?? cookieToken ?? null;

    const resolvedChainKey: ChainKey = chain && chain in CHAINS ? chain : (BLOCKCHAIN as ChainKey);

    const walletAddress = overrideAddress
      ?? ((resolvedChainKey === 'SOLANA_MAINNET' || resolvedChainKey === 'SOLANA_DEVNET')
        ? (tokenToVerify ? await getPrivySolanaWalletAddress(tokenToVerify) : null)
        : (tokenToVerify ? await getPrivyEvmWalletAddress(tokenToVerify) : null));

    if (!walletAddress) {
      return NextResponse.json({ error: 'Unable to resolve wallet address' }, withCors({ status: 401 }));
    }

    const uidFromToken = tokenToVerify
      ? await getUserUIDFromAccessTokenByMode(tokenToVerify, 'login').catch(() => null)
      : null;
    const uid = uidFromToken
      ?? await getUIDFromAccessToken(walletAddress).catch(() => null);
    const shouldForceRefresh = Boolean(forceRefresh);
    const shouldSkipAsyncVerification = Boolean(skipAsyncVerification);
    const shouldIncludeAllChains = Boolean(includeAllChains);
    const shouldRefreshSelectedChain = Boolean(refreshSelectedChain);
    const useEvmPortfolioPath = !isSolanaChain(resolvedChainKey);
    const configuredChainKeys = Object.keys(CHAINS) as ChainKey[];
    const evmChainKeys = configuredChainKeys.filter((chainKey) => !isSolanaChain(chainKey));
    const mongoByChain: Partial<Record<ChainKey, Record<string, BalanceEntry>>> = uid
      ? await getAllUserTokens(uid)
      : {};
    const mongoBalances = uid ? (mongoByChain[resolvedChainKey] ?? null) : null;

    if (uid && shouldIncludeAllChains && !shouldForceRefresh) {
      const includeAllChainsKey = [
        uid,
        resolvedChainKey,
        walletAddress,
        shouldSkipAsyncVerification ? 'skip-verify' : 'verify',
        shouldRefreshSelectedChain ? 'refresh-selected' : 'mongo-only',
      ].join('|');

      const allowIncludeAllCache = !shouldRefreshSelectedChain;

      if (allowIncludeAllCache) {
        const cached = includeAllChainsCache.get(includeAllChainsKey);
        if (cached && cached.expiresAt > Date.now()) {
          return NextResponse.json(cached.payload, withCors());
        }
        if (cached && cached.expiresAt <= Date.now()) {
          includeAllChainsCache.delete(includeAllChainsKey);
        }
      }

      const existingInFlight = includeAllChainsInFlight.get(includeAllChainsKey);
      if (existingInFlight) {
        const payload = await existingInFlight;
        return NextResponse.json(payload, withCors());
      }

      const work = (async (): Promise<IncludeAllChainsResponse> => {
        const evmAddressForAllChains = tokenToVerify
          ? await getPrivyEvmWalletAddress(tokenToVerify).catch(() => null)
          : null;
        const solanaAddressForAllChains = tokenToVerify
          ? await getPrivySolanaWalletAddress(tokenToVerify).catch(() => null)
          : null;
        const evmWalletForAllChains = isLikelyEvmAddress(evmAddressForAllChains)
          ? evmAddressForAllChains
          : (isLikelyEvmAddress(walletAddress) ? walletAddress : null);
        const solWalletForAllChains = isLikelySolanaAddress(solanaAddressForAllChains)
          ? solanaAddressForAllChains
          : (isLikelySolanaAddress(walletAddress) ? walletAddress : null);

        const allChainsPayload = Object.fromEntries(
          (Object.keys(CHAINS) as ChainKey[]).map((chainKey) => {
            const chainMongoBalances = mongoByChain[chainKey] ?? {};
            const addressForChain = isSolanaChain(chainKey)
              ? (solWalletForAllChains ?? walletAddress)
              : (evmWalletForAllChains ?? walletAddress);
            return [
              chainKey,
              fromMongoToPayload({
                chain: chainKey,
                address: addressForChain,
                mongoBalances: chainMongoBalances,
              }),
            ] as const;
          })
        ) as Record<ChainKey, ApiBalancesResponse>;

        if (shouldRefreshSelectedChain) {
          try {
            const snapshotUpdates: Partial<Record<ChainKey, Record<string, BalanceEntry>>> = {};

            if (evmWalletForAllChains) {
              const evmSeedByChain: Partial<Record<ChainKey, Record<string, BalanceEntry>>> =
                Object.fromEntries(
                  evmChainKeys.map((chainKey) => [chainKey, mongoByChain[chainKey] ?? {}] as const)
                ) as Partial<Record<ChainKey, Record<string, BalanceEntry>>>;

              const verifiedEvmByChain = await fetchEvmBalancesViaAlchemyPortfolio({
                walletAddress: evmWalletForAllChains,
                chainKeys: evmChainKeys,
                seedByChain: evmSeedByChain,
              });
              Object.assign(snapshotUpdates, verifiedEvmByChain);
            }

            const solChainKeys = configuredChainKeys.filter((chainKey) => isSolanaChain(chainKey));
            if (solWalletForAllChains) {
              await Promise.all(
                solChainKeys.map(async (chainKey) => {
                  const verifiedSolana = await fetchBlockchainBalancesDynamic({
                    chainKey,
                    walletAddress: solWalletForAllChains,
                    seedBalances: mongoByChain[chainKey] ?? {},
                  });
                  snapshotUpdates[chainKey] = verifiedSolana;
                })
              );
            }

            await updateBalancesSnapshotInMongoDB(uid, snapshotUpdates, 'blockchain');

            (Object.entries(snapshotUpdates) as Array<[ChainKey, Record<string, BalanceEntry>]>).forEach(
              ([chainKey, balances]) => {
                const addressForChain = isSolanaChain(chainKey)
                  ? (solWalletForAllChains ?? walletAddress)
                  : (evmWalletForAllChains ?? walletAddress);
                allChainsPayload[chainKey] = toResponseFromBlockchain({
                  chain: chainKey,
                  address: addressForChain,
                  balances,
                });
              }
            );
          } catch (err) {
            console.warn('[balances] includeAllChains all-chain refresh failed', err);
          }
        }

        if (!shouldSkipAsyncVerification && !shouldRefreshSelectedChain) {
          void (async () => {
            try {
              const snapshotUpdates: Partial<Record<ChainKey, Record<string, BalanceEntry>>> = {};

              if (evmWalletForAllChains) {
                const evmSeedByChain: Partial<Record<ChainKey, Record<string, BalanceEntry>>> =
                  Object.fromEntries(
                    evmChainKeys.map((chainKey) => [chainKey, mongoByChain[chainKey] ?? {}] as const)
                  ) as Partial<Record<ChainKey, Record<string, BalanceEntry>>>;

                const verifiedEvmByChain = await fetchEvmBalancesViaAlchemyPortfolio({
                  walletAddress: evmWalletForAllChains,
                  chainKeys: evmChainKeys,
                  seedByChain: evmSeedByChain,
                });
                Object.assign(snapshotUpdates, verifiedEvmByChain);
              }

              const solChainKeys = configuredChainKeys.filter((chainKey) => isSolanaChain(chainKey));
              if (solWalletForAllChains) {
                await Promise.all(
                  solChainKeys.map(async (chainKey) => {
                    const verifiedSolana = await fetchBlockchainBalancesDynamic({
                      chainKey,
                      walletAddress: solWalletForAllChains,
                      seedBalances: mongoByChain[chainKey] ?? {},
                    });
                    snapshotUpdates[chainKey] = verifiedSolana;
                  })
                );
              }

              await updateBalancesSnapshotInMongoDB(uid, snapshotUpdates, 'blockchain');
            } catch (err) {
              console.warn('[balances] async all-chain verification failed', err);
            }
          })();
        }

        const selectedPayload = allChainsPayload[resolvedChainKey]
          ?? fromMongoToPayload({
            chain: resolvedChainKey,
            address: walletAddress,
            mongoBalances: {},
          });

        return {
          ...selectedPayload,
          allChains: allChainsPayload,
        };
      })();

      includeAllChainsInFlight.set(includeAllChainsKey, work);
      try {
        const payload = await work;
        if (allowIncludeAllCache) {
          includeAllChainsCache.set(includeAllChainsKey, {
            expiresAt: Date.now() + INCLUDE_ALL_CHAINS_CACHE_TTL_MS,
            payload,
          });
        }
        return NextResponse.json(payload, withCors());
      } finally {
        includeAllChainsInFlight.delete(includeAllChainsKey);
      }
    }

    if (mongoBalances && !shouldForceRefresh) {
      const immediatePayload = fromMongoToPayload({
        chain: resolvedChainKey,
        address: walletAddress,
        mongoBalances,
      });

      if (uid && !shouldSkipAsyncVerification) {
        void (async () => {
          try {
            if (useEvmPortfolioPath) {
              const verifiedByChain = await fetchEvmBalancesViaAlchemyPortfolio({
                walletAddress,
                chainKeys: evmChainKeys,
                seedByChain: mongoByChain,
              });
              await updateBalancesSnapshotInMongoDB(uid, verifiedByChain, 'blockchain');
            } else {
              const verifiedBalances = await fetchBlockchainBalancesDynamic({
                chainKey: resolvedChainKey,
                walletAddress,
                seedBalances: mongoBalances,
              });
              await updateBalancesSnapshotInMongoDB(uid, { [resolvedChainKey]: verifiedBalances }, 'blockchain');
            }
          } catch (err) {
            console.warn('[balances] async verification failed', err);
          }
        })();
      }

      return NextResponse.json(immediatePayload, withCors());
    }

    const seed = mongoBalances ?? {};
    const blockchainBalances = await (useEvmPortfolioPath
      ? (() => {
        const chainSeedByKey: Partial<Record<ChainKey, Record<string, BalanceEntry>>> = {
            ...mongoByChain,
            [resolvedChainKey]: seed,
          };
          return fetchEvmBalancesViaAlchemyPortfolio({
            walletAddress,
            chainKeys: evmChainKeys,
            seedByChain: chainSeedByKey,
          }).then((all) => all[resolvedChainKey] ?? {});
        })()
      : fetchBlockchainBalancesDynamic({
          chainKey: resolvedChainKey,
          walletAddress,
          seedBalances: seed,
        }));

    if (uid) {
      if (useEvmPortfolioPath && !shouldSkipAsyncVerification) {
        void (async () => {
          try {
            const verifiedByChain = await fetchEvmBalancesViaAlchemyPortfolio({
              walletAddress,
              chainKeys: evmChainKeys,
              seedByChain: {
                ...mongoByChain,
                [resolvedChainKey]: blockchainBalances,
              },
            });
            await updateBalancesSnapshotInMongoDB(uid, verifiedByChain, 'blockchain');
          } catch (err) {
            console.warn('[balances] EVM multi-chain Mongo update failed', err);
            await updateBalancesSnapshotInMongoDB(uid, { [resolvedChainKey]: blockchainBalances }, 'blockchain');
          }
        })();
      } else if (!shouldSkipAsyncVerification) {
        void updateBalancesSnapshotInMongoDB(uid, { [resolvedChainKey]: blockchainBalances }, 'blockchain');
      }
    }

    const payload = toResponseFromBlockchain({
      chain: resolvedChainKey,
      address: walletAddress,
      balances: blockchainBalances,
    });

    return NextResponse.json(payload, withCors());
  } catch (error) {
    console.error('[balances] error', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500, headers: buildCorsHeaders(req.headers.get('origin')) });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}

