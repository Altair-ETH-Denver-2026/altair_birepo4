import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ethers } from 'ethers';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
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
import * as BaseTokens from '../../../../config/token_info/base_tokens';
import * as BaseSepoliaTokens from '../../../../config/token_info/base_testnet_sepolia_tokens';
import * as EthTokens from '../../../../config/token_info/eth_tokens';
import * as EthSepoliaTokens from '../../../../config/token_info/eth_sepolia_testnet_tokens';
import * as SolanaTokens from '../../../../config/token_info/solana_tokens';
import { pickBestMatch, searchJupiterTokens } from '@/lib/jupTokens';
import { Token } from '@/models/Token';
import { appendSwapToHistory } from '@/lib/zg-storage';
import { connectToDatabase } from '@/lib/db';
import { syncUserFromAccessToken } from '@/lib/users';
import { withWaitLogger } from '@/lib/waitLogger';
import { type BalanceEntry, updateBalancesInMongoDB } from '@/lib/balanceService';
import { Swap } from '@/models/Swap';
import { Chat } from '@/models/Chat';
import { generateSwapID } from '@/lib/id';
import { formatAmountFromRaw, parseAmountToRaw } from '@/lib/amounts';
import { MONGODB_JSONS } from '../../../../config/mongodb_config';
import { ZG_JSONS } from '../../../../config/zerog_config';
import {
  buildEvmTokenCacheKey,
  getAlchemyTokenMetadataByAddress,
  isEvmAddress,
  normalizeEvmAddress,
  searchAlchemyTokenAddressesBySymbol,
} from '@/lib/alchemyTokens';

type TokenInfo = { address: string; decimals: number; symbol?: string };

type JupiterTokenInfo = { address: string; decimals: number; symbol?: string };

type ResolvedEvmToken = {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  source: 'native' | 'config' | 'mongo-token-cache' | 'alchemy';
};

type ResolveEvmTokenResult =
  | { kind: 'resolved'; token: ResolvedEvmToken }
  | { kind: 'ambiguous'; candidates: ResolvedEvmToken[] }
  | { kind: 'unresolved' };

const resolveMongoTemplate = (key: 'chat' | 'swap'): Record<string, unknown> => {
  const configValue = MONGODB_JSONS[key];
  if (configValue === 'ZG_JSONS') {
    const source = ZG_JSONS[key];
    return source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  }
  return configValue && typeof configValue === 'object' ? (configValue as Record<string, unknown>) : {};
};

const ZEROX_ETH_PLACEHOLDER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ENABLE_EVM_DYNAMIC_TOKEN_RESOLUTION = process.env.ENABLE_EVM_DYNAMIC_TOKEN_RESOLUTION !== 'false';
const QUOTE_CACHE_TTL_MS = 15_000;
type QuoteCacheEntry<T> = { expiresAt: number; value: T };
const quoteCache = new Map<string, QuoteCacheEntry<unknown>>();

const resolveBalanceBefore = (params: {
  userBalances: Record<string, unknown> | null | undefined;
  chainKey: ChainKey;
  symbol: string;
}): string | null => {
  const { userBalances, chainKey, symbol } = params;
  if (!userBalances || typeof userBalances !== 'object') return null;
  if (!(chainKey in CHAINS)) return null;

  const chainBalances = (userBalances as Record<string, unknown>)[chainKey];
  if (!chainBalances || typeof chainBalances !== 'object') return null;

  const normalizedSymbol = symbol.trim().toUpperCase();
  const entryBucket =
    (chainBalances as Record<string, unknown>)[normalizedSymbol]
    ?? (chainBalances as Record<string, unknown>)[symbol];

  if (Array.isArray(entryBucket)) {
    if (entryBucket.length === 0) return null;
    const balance = (entryBucket[0] as { balance?: unknown } | undefined)?.balance;
    return typeof balance === 'string' ? balance : null;
  }

  if (entryBucket && typeof entryBucket === 'object') {
    const balance = (entryBucket as { balance?: unknown }).balance;
    return typeof balance === 'string' ? balance : null;
  }

  return null;
};

const parseRawBalanceSnapshot = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed) >= 0n ? trimmed : null;
  } catch {
    return null;
  }
};

const buildQuoteCacheKey = (parts: Array<string | number | null | undefined>) =>
  parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('|');

const getQuoteCache = <T>(key: string): T | null => {
  const entry = quoteCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    quoteCache.delete(key);
    return null;
  }
  return entry.value as T;
};

const setQuoteCache = <T>(key: string, value: T, ttlMs = QUOTE_CACHE_TTL_MS) => {
  quoteCache.set(key, { expiresAt: Date.now() + ttlMs, value });
};

const resolveRpcUrl = (rpcUrls: string[]) => {
  const resolved = resolveRpcUrls(rpcUrls);
  return resolved[0] ?? rpcUrls[0];
};

const resolveBuyTokenAddress = (params: {
  tokenConfig: Record<string, TokenInfo>;
  buyToken: string;
  resolvedEvmBuyTokenAddress?: string | null;
}): string => {
  const { tokenConfig, buyToken, resolvedEvmBuyTokenAddress } = params;
  return buyToken === 'ETH'
    ? ZEROX_ETH_PLACEHOLDER
    : resolvedEvmBuyTokenAddress ?? tokenConfig[buyToken]?.address ?? '';
};

const EVM_CHAIN_IDS: Partial<Record<ChainKey, number>> = {
  ETH_MAINNET: ETH_MAINNET.chainId,
  ETH_SEPOLIA: ETH_SEPOLIA.chainId,
  BASE_MAINNET: BASE_MAINNET.chainId,
  BASE_SEPOLIA: BASE_SEPOLIA.chainId,
};

const isSolanaChain = (chainKey: ChainKey) => chainKey === 'SOLANA_MAINNET' || chainKey === 'SOLANA_DEVNET';
const isEvmChain = (chainKey: ChainKey): chainKey is Exclude<ChainKey, 'SOLANA_MAINNET' | 'SOLANA_DEVNET'> => !isSolanaChain(chainKey);

const resolveChainLabel = (chainKey: ChainKey) => {
  switch (chainKey) {
    case 'ETH_MAINNET':
    case 'ETH_SEPOLIA':
      return 'Ethereum';
    case 'BASE_MAINNET':
    case 'BASE_SEPOLIA':
      return 'Base';
    case 'SOLANA_MAINNET':
    case 'SOLANA_DEVNET':
      return 'Solana';
    default:
      return chainKey;
  }
};

const toResolvedFromTokenDoc = (params: {
  address: string;
  symbol: string;
  decimals: number;
  source: ResolvedEvmToken['source'];
  name?: string;
}): ResolvedEvmToken => ({
  address: normalizeEvmAddress(params.address),
  symbol: params.symbol.trim().toUpperCase(),
  decimals: params.decimals,
  name: params.name,
  source: params.source,
});

const findEvmTokensInCache = async (params: {
  chainKey: ChainKey;
  symbol?: string;
  address?: string;
}): Promise<ResolvedEvmToken[]> => {
  const { chainKey, symbol, address } = params;
  const chainId = EVM_CHAIN_IDS[chainKey];
  if (!chainId) return [];
  await connectToDatabase();

  const query: Record<string, unknown> = {
    chainId: String(chainId),
  };

  const normalizedAddress = address && isEvmAddress(address) ? normalizeEvmAddress(address) : null;
  if (normalizedAddress) {
    query.$or = [
      { mint: normalizedAddress },
      { mint: buildEvmTokenCacheKey(chainId, normalizedAddress) },
    ];
  } else if (symbol) {
    query.symbol = new RegExp(`^${symbol.trim()}$`, 'i');
  } else {
    return [];
  }

  const docs = await Token.find(query).lean().limit(8);
  return docs
    .map((doc) => {
      const rawMint = typeof doc?.mint === 'string' ? doc.mint : '';
      const inferredAddress = rawMint.includes(':') ? rawMint.split(':')[1] : rawMint;
      const outAddress = normalizeEvmAddress(inferredAddress);
      const outSymbol = typeof doc?.symbol === 'string' && doc.symbol.trim() ? doc.symbol.trim().toUpperCase() : '';
      const outDecimals = typeof doc?.decimals === 'number' ? doc.decimals : null;
      if (!isEvmAddress(outAddress) || !outSymbol || outDecimals === null) return null;
      return toResolvedFromTokenDoc({
        address: outAddress,
        symbol: outSymbol,
        decimals: outDecimals,
        name: typeof doc?.name === 'string' ? doc.name : undefined,
        source: 'mongo-token-cache',
      });
    })
    .filter((entry): entry is ResolvedEvmToken => Boolean(entry));
};

const saveEvmTokenToCache = async (params: {
  chainKey: ChainKey;
  token: ResolvedEvmToken;
}) => {
  const chainId = EVM_CHAIN_IDS[params.chainKey];
  if (!chainId) return;
  await connectToDatabase();
  const cacheKey = buildEvmTokenCacheKey(chainId, params.token.address);
  await Token.updateOne(
    { mint: cacheKey },
    {
      $set: {
        mint: cacheKey,
        chain: resolveChainLabel(params.chainKey),
        chainId: String(chainId),
        symbol: params.token.symbol,
        name: params.token.name ?? null,
        decimals: params.token.decimals,
        source: params.token.source,
        lastFetchedAt: new Date(),
      },
    },
    { upsert: true }
  );
};

const resolveEvmToken = async (params: {
  chainKey: ChainKey;
  symbolOrAddress: string;
  tokenConfig: Record<string, TokenInfo>;
}): Promise<ResolveEvmTokenResult> => {
  const { chainKey, symbolOrAddress, tokenConfig } = params;
  if (!isEvmChain(chainKey)) return { kind: 'unresolved' };
  const normalizedInput = symbolOrAddress.trim();
  const normalizedSymbol = normalizedInput.toUpperCase();

  if (!normalizedInput) return { kind: 'unresolved' };
  if (normalizedSymbol === 'ETH') {
    return {
      kind: 'resolved',
      token: {
        address: ZEROX_ETH_PLACEHOLDER,
        symbol: 'ETH',
        decimals: 18,
        source: 'native',
      },
    };
  }

  const configured = tokenConfig[normalizedSymbol];
  if (configured?.address && typeof configured.decimals === 'number') {
    return {
      kind: 'resolved',
      token: {
        address: normalizeEvmAddress(configured.address),
        symbol: (configured.symbol ?? normalizedSymbol).toUpperCase(),
        decimals: configured.decimals,
        source: 'config',
      },
    };
  }

  if (isEvmAddress(normalizedInput)) {
    const cached = await findEvmTokensInCache({ chainKey, address: normalizedInput });
    if (cached.length > 0) return { kind: 'resolved', token: cached[0] };

    if (!ENABLE_EVM_DYNAMIC_TOKEN_RESOLUTION) return { kind: 'unresolved' };

    const metadata = await getAlchemyTokenMetadataByAddress({ chainKey, address: normalizedInput });
    if (!metadata?.address || typeof metadata.decimals !== 'number') return { kind: 'unresolved' };
    const token = toResolvedFromTokenDoc({
      address: metadata.address,
      symbol: metadata.symbol ?? normalizedInput,
      decimals: metadata.decimals,
      name: metadata.name,
      source: 'alchemy',
    });
    await saveEvmTokenToCache({ chainKey, token });
    return { kind: 'resolved', token };
  }

  const cachedBySymbol = await findEvmTokensInCache({ chainKey, symbol: normalizedSymbol });
  const exactCached = cachedBySymbol.filter((t) => t.symbol === normalizedSymbol);
  if (exactCached.length === 1) return { kind: 'resolved', token: exactCached[0] };
  if (exactCached.length > 1) return { kind: 'ambiguous', candidates: exactCached.slice(0, 5) };

  if (!ENABLE_EVM_DYNAMIC_TOKEN_RESOLUTION) return { kind: 'unresolved' };

  const candidateAddresses = await searchAlchemyTokenAddressesBySymbol({ symbol: normalizedSymbol });
  if (candidateAddresses.length === 0) return { kind: 'unresolved' };

  const discovered: ResolvedEvmToken[] = [];
  for (const address of candidateAddresses.slice(0, 8)) {
    const metadata = await getAlchemyTokenMetadataByAddress({ chainKey, address });
    if (!metadata?.address || typeof metadata.decimals !== 'number') continue;
    discovered.push(
      toResolvedFromTokenDoc({
        address: metadata.address,
        symbol: metadata.symbol ?? normalizedSymbol,
        decimals: metadata.decimals,
        name: metadata.name,
        source: 'alchemy',
      })
    );
  }

  const deduped = Array.from(new Map(discovered.map((t) => [t.address, t])).values());
  const exact = deduped.filter((t) => t.symbol === normalizedSymbol);

  if (exact.length === 1) {
    await saveEvmTokenToCache({ chainKey, token: exact[0] });
    return { kind: 'resolved', token: exact[0] };
  }
  if (exact.length > 1) {
    return { kind: 'ambiguous', candidates: exact.slice(0, 5) };
  }

  if (deduped.length === 1) {
    await saveEvmTokenToCache({ chainKey, token: deduped[0] });
    return { kind: 'resolved', token: deduped[0] };
  }

  if (deduped.length > 1) return { kind: 'ambiguous', candidates: deduped.slice(0, 5) };
  return { kind: 'unresolved' };
};


const resolveGasFee = async (params: {
  chainKey: ChainKey;
  txHash: string;
  evmReceipt?: ethers.TransactionReceipt | null;
  solanaTx?: VersionedTransactionResponse | null;
}) => {
  const { chainKey, txHash, evmReceipt, solanaTx } = params;
  if (isSolanaChain(chainKey)) {
    const tx = solanaTx ?? null;
    if (typeof tx?.meta?.fee === 'number') {
      return { token: 'SOL', amount: tx.meta.fee.toString() };
    }
    return null;
  }

  const chainConfigs = {
    BASE_SEPOLIA,
    ETH_SEPOLIA,
    ETH_MAINNET,
    BASE_MAINNET,
  } as const;
  const chainConfig = chainConfigs[chainKey];
  if (!chainConfig || !('rpcUrls' in chainConfig)) {
    return null;
  }
  const rpcUrl = resolveRpcUrl(chainConfig.rpcUrls);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const receipt = evmReceipt ?? await withWaitLogger(
    {
      file: 'altair_backend1/src/app/api/test-swap/route.ts',
      target: 'EVM getTransactionReceipt (fee)',
      description: 'EVM transaction receipt lookup for fee',
    },
    () => provider.getTransactionReceipt(txHash)
  );
  if (!receipt || receipt.status !== 1) return null;
  let effectiveGasPrice = 'effectiveGasPrice' in receipt && typeof receipt.effectiveGasPrice === 'bigint'
    ? receipt.effectiveGasPrice
    : 0n;
  if (effectiveGasPrice === 0n) {
    const tx = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'EVM getTransaction (fee)',
        description: 'EVM transaction lookup for fee price',
      },
      () => provider.getTransaction(txHash)
    );
    const fallbackPrice =
      (tx && 'gasPrice' in tx && typeof tx.gasPrice === 'bigint' ? tx.gasPrice : null) ??
      (tx && 'maxFeePerGas' in tx && typeof tx.maxFeePerGas === 'bigint' ? tx.maxFeePerGas : null) ??
      0n;
    effectiveGasPrice = fallbackPrice;
  }
  const gasUsed = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : 0n;
  const gasCost = gasUsed * effectiveGasPrice;
  return { token: 'ETH', amount: gasCost.toString() };
};

const resolveTokenDecimals = async (params: {
  chainKey: ChainKey;
  buyToken: string;
  buyTokenAddressOrMint?: string | null;
  tokenConfig: Record<string, TokenInfo>;
}): Promise<number | null> => {
  const { chainKey, buyToken, buyTokenAddressOrMint, tokenConfig } = params;
  const normalizedBuy = buyToken.toUpperCase();
  const addressOrMint = typeof buyTokenAddressOrMint === 'string' ? buyTokenAddressOrMint.trim() : null;
  try {
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for token decimals lookup',
      },
      () => connectToDatabase()
    );
    if (addressOrMint) {
    const tokenDoc = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'Token.findOne',
        description: 'token decimals lookup',
      },
      () => Token.findOne({ mint: addressOrMint }).lean()
    );
      if (typeof tokenDoc?.decimals === 'number') {
        return tokenDoc.decimals;
      }
    }
  } catch (err) {
    console.warn('[test-swap] token decimals lookup failed', err);
  }

  if (isSolanaChain(chainKey)) {
    if (normalizedBuy === 'SOL') return tokenConfig.SOL?.decimals ?? 9;
    if (tokenConfig[normalizedBuy]?.decimals !== undefined) return tokenConfig[normalizedBuy].decimals;
    return null;
  }

  if (normalizedBuy === 'ETH') return 18;
  if (tokenConfig[normalizedBuy]?.decimals !== undefined) return tokenConfig[normalizedBuy].decimals;
  return null;
};

/**
 * Helper to get ETH balance with retry and fallback logic
 */
const getEthBalanceWithRetry = async (
  provider: ethers.JsonRpcProvider,
  address: string,
  blockNumber: number | 'latest' | null,
  label: string
): Promise<bigint | null> => {
  const maxRetries = 2;
  const fallbackBlockNumbers = blockNumber !== null && typeof blockNumber === 'number'
    ? [blockNumber, blockNumber - 1, 'latest']
    : ['latest'];
  
  for (const block of fallbackBlockNumbers) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const balance = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: `EVM getBalance (${label})`,
            description: `ETH balance lookup for ${label} at block ${block}`,
          },
          () => provider.getBalance(address, block === 'latest' ? 'latest' : block)
        );
        console.log(`[test-swap] Successfully retrieved ${label} balance:`, {
          address,
          block,
          balance: balance.toString(),
          attempt: attempt + 1
        });
        return balance;
      } catch (err) {
        console.warn(`[test-swap] ${label} balance lookup failed (attempt ${attempt + 1}, block ${block}):`, err);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); // exponential backoff
        }
      }
    }
  }
  
  console.error(`[test-swap] All attempts failed to get ${label} balance for address ${address}`);
  return null;
};

/**
 * Reads an ERC-20 token balance for `walletAddress` at `blockNumber - 1` (pre-swap state).
 * Falls back to `blockNumber` and then `latest` on failure.
 * Returns the raw balance as a string, or null on failure.
 */
const resolveErc20BalanceAtBlock = async (
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  walletAddress: string,
  blockNumber: number,
  label: string
): Promise<string | null> => {
  const erc20Iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const blocksToTry: Array<number | 'latest'> = [blockNumber - 1, blockNumber, 'latest'];
  for (const block of blocksToTry) {
    try {
      const result = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: `ERC20.balanceOf (${label})`,
          description: `ERC-20 balance lookup for ${label} at block ${block}`,
        },
        () =>
          provider.call({
            to: tokenAddress,
            data: erc20Iface.encodeFunctionData('balanceOf', [walletAddress]),
            blockTag: block === 'latest' ? 'latest' : block,
          })
      );
      const decoded = erc20Iface.decodeFunctionResult('balanceOf', result);
      const balance = decoded[0] as bigint;
      console.log(`[test-swap] ERC-20 balanceOf (${label}) at block ${block}:`, balance.toString());
      return balance.toString();
    } catch (err) {
      console.warn(`[test-swap] ERC-20 balanceOf (${label}) failed at block ${block}:`, err);
    }
  }
  return null;
};

const resolveBuyAmount = async (params: {
  chainKey: ChainKey;
  txHash: string;
  buyToken: string;
  recipient: string;
  buyTokenAddressOrMint?: string | null;
  balanceBefore?: string | null;
  /** Pre-computed gas cost in raw wei (string). When provided, used directly instead of
   *  re-deriving from the receipt (which may lack effectiveGasPrice in ethers v6). */
  gasCostRaw?: string | null;
}): Promise<{ amountRaw: string; evmReceipt?: ethers.TransactionReceipt | null; solanaTx?: VersionedTransactionResponse | null; ethEndBalance?: string | null }> => {
  const { chainKey, txHash, buyToken, recipient, buyTokenAddressOrMint, balanceBefore, gasCostRaw } = params;
  if (isSolanaChain(chainKey)) {
    const tokenConfigs: Record<ChainKey, Record<string, TokenInfo>> = {
      BASE_SEPOLIA: buildTokenMap(BaseSepoliaTokens as Record<string, TokenInfo>),
      ETH_SEPOLIA: buildTokenMap(EthSepoliaTokens as Record<string, TokenInfo>),
      ETH_MAINNET: buildTokenMap(EthTokens as Record<string, TokenInfo>),
      BASE_MAINNET: buildTokenMap(BaseTokens as Record<string, TokenInfo>),
      SOLANA_MAINNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
      SOLANA_DEVNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
    };
    const tokenConfig = applyTokenEnvOverrides(chainKey, tokenConfigs[chainKey]);
    const normalizedBuy = buyToken.toUpperCase();
    let buyTokenInfo = normalizedBuy === 'SOL'
      ? { mint: tokenConfig.SOL.address, decimals: tokenConfig.SOL.decimals }
      : tokenConfig[normalizedBuy]
        ? { mint: tokenConfig[normalizedBuy].address, decimals: tokenConfig[normalizedBuy].decimals }
        : isSolanaMint(normalizedBuy)
          ? { mint: normalizedBuy, decimals: 9 }
          : null;
    if (!buyTokenInfo?.mint) {
      const jupiterToken = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'findJupiterToken',
          description: 'resolve Solana buy token mint',
        },
        () => findJupiterToken(normalizedBuy)
      );
      if (jupiterToken?.address) {
        buyTokenInfo = { mint: jupiterToken.address, decimals: jupiterToken.decimals ?? 9 };
      }
    }
    if (!buyTokenInfo?.mint) {
      throw new Error(`Unable to resolve Solana mint for ${buyToken}`);
    }
    const chainConfig = chainKey === 'SOLANA_MAINNET' ? SOLANA_MAINNET : SOLANA_DEVNET;
    const rpcUrl = resolveRpcUrl(chainConfig.rpcUrls);
    const connection = new Connection(rpcUrl, 'confirmed');
    const tx = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'Solana getTransaction',
        description: 'Solana transaction lookup for buy amount',
      },
      () => connection.getTransaction(txHash, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    );
    if (!tx?.meta) {
      throw new Error(`Solana transaction not found for ${txHash}`);
    }
    const recipientKey = recipient;
    if (normalizedBuy === 'SOL') {
      const lookupKeys = tx.meta?.loadedAddresses
        ? {
            writable: tx.meta.loadedAddresses.writable.map((key) => key),
            readonly: tx.meta.loadedAddresses.readonly.map((key) => key),
          }
        : undefined;
      const accountKeys = tx.transaction.message
        .getAccountKeys(lookupKeys ? { accountKeysFromLookups: lookupKeys } : undefined)
        .staticAccountKeys.map((key) => key.toBase58());
      const idx = accountKeys.findIndex((key) => key === recipientKey);
      if (idx < 0) {
        throw new Error('Recipient account not found in Solana transaction');
      }
      const pre = BigInt(tx.meta.preBalances[idx] ?? 0);
      const post = BigInt(tx.meta.postBalances[idx] ?? 0);
      const delta = post - pre;
      if (delta <= 0n) {
        throw new Error('Unable to resolve SOL buy amount from transaction balances.');
      }
      return { amountRaw: delta.toString(), solanaTx: tx };
    }
    const preTokens = tx.meta.preTokenBalances ?? [];
    const postTokens = tx.meta.postTokenBalances ?? [];
    const owner = recipientKey;
    const mint = buyTokenInfo.mint;
    const preEntry = preTokens.find((b) => b.owner === owner && b.mint === mint);
    const postEntry = postTokens.find((b) => b.owner === owner && b.mint === mint);
    const preAmount = BigInt(preEntry?.uiTokenAmount?.amount ?? '0');
    const postAmount = BigInt(postEntry?.uiTokenAmount?.amount ?? '0');
    const delta = postAmount - preAmount;
    if (delta <= 0n) {
      throw new Error('Unable to resolve SPL buy amount from transaction balances.');
    }
    return { amountRaw: delta.toString(), solanaTx: tx };
  }

  const chainConfigs = {
    BASE_SEPOLIA,
    ETH_SEPOLIA,
    ETH_MAINNET,
    BASE_MAINNET,
  } as const;
  const chainConfig = chainConfigs[chainKey];
  if (!chainConfig || !('rpcUrls' in chainConfig)) {
    throw new Error('Unsupported chain for buyAmount resolution.');
  }
  const rpcUrl = resolveRpcUrl(chainConfig.rpcUrls);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const receipt = await withWaitLogger(
    {
      file: 'altair_backend1/src/app/api/test-swap/route.ts',
      target: 'EVM getTransactionReceipt',
      description: 'EVM transaction receipt lookup',
    },
    () => provider.getTransactionReceipt(txHash)
  );
  if (!receipt) {
    throw new Error(`Transaction receipt not found for ${txHash}`);
  }
  if (receipt.status !== 1) {
    throw new Error(`Transaction failed for ${txHash}`);
  }

  const tokenConfigs: Record<ChainKey, Record<string, TokenInfo>> = {
    BASE_SEPOLIA: buildTokenMap(BaseSepoliaTokens as Record<string, TokenInfo>),
    ETH_SEPOLIA: buildTokenMap(EthSepoliaTokens as Record<string, TokenInfo>),
    ETH_MAINNET: buildTokenMap(EthTokens as Record<string, TokenInfo>),
    BASE_MAINNET: buildTokenMap(BaseTokens as Record<string, TokenInfo>),
    SOLANA_MAINNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
    SOLANA_DEVNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
  };
  const tokenConfig = applyTokenEnvOverrides(chainKey, tokenConfigs[chainKey]);
  const buyTokenAddress = resolveBuyTokenAddress({
    tokenConfig,
    buyToken,
    resolvedEvmBuyTokenAddress: buyTokenAddressOrMint,
  }).toLowerCase();
  if (!buyTokenAddress) {
    throw new Error(`Missing buy token address for ${buyToken}`);
  }

  if (buyToken === 'ETH') {
    let startBalance: bigint | null = null;
    let endBalance: bigint | null = null;
    
    // Use provided balanceBefore if available
    if (balanceBefore !== null && balanceBefore !== undefined && balanceBefore.trim().length > 0) {
      try {
        startBalance = BigInt(balanceBefore);
        console.log('[test-swap] Using provided balanceBefore for ETH:', balanceBefore);
      } catch (err) {
        console.warn('[test-swap] Failed to parse provided balanceBefore:', balanceBefore, err);
      }
    }
    
    // If startBalance not provided or parsing failed, try blockchain lookup with retry
    if (startBalance === null) {
      startBalance = await getEthBalanceWithRetry(provider, recipient, receipt.blockNumber - 1, 'startBalance');
    }
    
    // Get endBalance with retry
    endBalance = await getEthBalanceWithRetry(provider, recipient, receipt.blockNumber, 'endBalance');
    
    // Prefer the pre-computed gasCostRaw (passed in from resolveGasFee which has a
    // tx.gasPrice fallback).  Fall back to deriving from the receipt only when not provided.
    let gasCost: bigint;
    if (gasCostRaw !== null && gasCostRaw !== undefined && gasCostRaw.trim().length > 0) {
      try {
        gasCost = BigInt(gasCostRaw);
        console.log('[test-swap] resolveBuyAmount: using provided gasCostRaw:', gasCostRaw);
      } catch {
        console.warn('[test-swap] resolveBuyAmount: failed to parse gasCostRaw, falling back to receipt derivation:', gasCostRaw);
        const effectiveGasPrice = 'effectiveGasPrice' in receipt && typeof receipt.effectiveGasPrice === 'bigint'
          ? receipt.effectiveGasPrice
          : 0n;
        const gasUsed = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : 0n;
        gasCost = gasUsed * effectiveGasPrice;
      }
    } else {
      const effectiveGasPrice = 'effectiveGasPrice' in receipt && typeof receipt.effectiveGasPrice === 'bigint'
        ? receipt.effectiveGasPrice
        : 0n;
      const gasUsed = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : 0n;
      gasCost = gasUsed * effectiveGasPrice;
    }
    
    if (startBalance === null || endBalance === null) {
      throw new Error(`Cannot resolve ETH buy amount: missing startBalance or endBalance. startBalance=${startBalance?.toString() ?? 'null'}, endBalance=${endBalance?.toString() ?? 'null'}, balanceBeforeProvided=${balanceBefore ?? 'null'}, txHash=${txHash}, recipient=${recipient}`);
    }
    
    const delta = endBalance - startBalance + gasCost;
    if (delta <= 0n) {
      throw new Error(`ETH buy amount delta is non-positive: startBalance=${startBalance.toString()}, endBalance=${endBalance.toString()}, gasCost=${gasCost.toString()}, delta=${delta.toString()}. Possible causes: 1) No ETH was received in swap, 2) Gas cost exceeds received amount, 3) Balance lookup incorrect.`);
    }
    
    console.log('[test-swap] Resolved ETH buy amount:', {
      startBalance: startBalance.toString(),
      endBalance: endBalance.toString(),
      gasCost: gasCost.toString(),
      delta: delta.toString(),
      amountRaw: delta.toString(),
    });
    // Return ethEndBalance so the call site can use it directly as buyBalanceAfter
    // without arithmetic from potentially-stale buyBalanceBefore.
    return { amountRaw: delta.toString(), evmReceipt: receipt, ethEndBalance: endBalance.toString() };
  }

  const erc20Iface = new ethers.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  let total = 0n;
  const recipientLower = recipient.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== buyTokenAddress) continue;
    try {
      const parsed = erc20Iface.parseLog(log);
      if (parsed?.name !== 'Transfer') continue;
      const to = (parsed.args?.to as string | undefined)?.toLowerCase?.();
      if (to !== recipientLower) continue;
      const value = parsed.args?.value as bigint | undefined;
      if (typeof value === 'bigint') {
        total += value;
      }
    } catch {
      // ignore non-matching logs
    }
  }
  if (total <= 0n) {
    throw new Error('Unable to resolve buy token amount from receipt logs.');
  }
  return { amountRaw: total.toString(), evmReceipt: receipt };
};

const isSolanaMint = (value: string) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
};

const saveJupiterToken = async (token: {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  icon?: string;
  tags?: string[];
  isVerified?: boolean;
  tokenProgram?: string;
  updatedAt?: string;
}) => {
  if (!token?.id) return;
  try {
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for Jupiter token save',
      },
      () => connectToDatabase()
    );
    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-swap/route.ts',
        target: 'Token.updateOne',
        description: 'save Jupiter token metadata',
      },
      () =>
        Token.updateOne(
          { mint: token.id },
          {
            $set: {
              mint: token.id,
              chain: 'Solana',
              chainId: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
              symbol: token.symbol ?? null,
              name: token.name ?? null,
              decimals: token.decimals ?? null,
              icon: token.icon ?? null,
              tags: token.tags ?? [],
              isVerified: token.isVerified ?? null,
              tokenProgram: token.tokenProgram ?? null,
              jupUpdatedAt: token.updatedAt ?? null,
              source: 'jupiter',
              lastFetchedAt: new Date(),
            },
          },
          { upsert: true }
        )
    );
    console.log('[test-swap] saved token from Jupiter', {
      mint: token.id,
      chain: 'Solana',
      chainId: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      isVerified: token.isVerified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[test-swap] failed to save token from Jupiter', {
      mint: token.id,
      symbol: token.symbol,
      error: message,
    });
  }
};

async function findJupiterToken(input: string): Promise<JupiterTokenInfo | null> {
  const normalized = input.trim();
  console.log('[test-swap] findJupiterToken: start', {
    input,
    normalized,
    hasApiKey: Boolean(process.env.JUPITER_API_KEY),
  });
  if (!normalized) return null;
  const tokens = await withWaitLogger(
    {
      file: 'altair_backend1/src/app/api/test-swap/route.ts',
      target: 'Jupiter token search',
      description: 'search token list',
    },
    () =>
      searchJupiterTokens(normalized, {
        apiKey: process.env.JUPITER_API_KEY,
        maxResults: 8,
      })
  );
  console.log('[test-swap] findJupiterToken: search results', {
    query: normalized,
    count: tokens.length,
    candidates: tokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      isVerified: token.isVerified,
      tags: token.tags,
    })),
  });
  const best = pickBestMatch(tokens, normalized);
  console.log('[test-swap] findJupiterToken: best match', {
    query: normalized,
    best: best
      ? {
          id: best.id,
          symbol: best.symbol,
          name: best.name,
          decimals: best.decimals,
          isVerified: best.isVerified,
          tags: best.tags,
        }
      : null,
  });
  if (!best) return null;
  await saveJupiterToken(best);
  return {
    address: best.id,
    decimals: best.decimals,
    symbol: best.symbol,
  };
}

const buildTokenMap = (tokensModule: Record<string, TokenInfo>): Record<string, TokenInfo> => {
  const map: Record<string, TokenInfo> = {};
  Object.entries(tokensModule).forEach(([key, token]) => {
    if (!token || typeof token !== 'object') return;
    const address = typeof token.address === 'string' ? token.address : '';
    const decimals = typeof token.decimals === 'number' ? token.decimals : undefined;
    if (!address || address.length < 4 || decimals === undefined) return;
    const symbol = typeof token.symbol === 'string' && token.symbol.length > 0 ? token.symbol : key;
    map[symbol.toUpperCase()] = { ...token, symbol };
  });
  return map;
};

const applyTokenEnvOverrides = (chainKey: ChainKey, tokens: Record<string, TokenInfo>): Record<string, TokenInfo> => {
  const out = { ...tokens };
  for (const symbol of Object.keys(out)) {
    const envKey = `${chainKey}_${symbol}_ADDRESS`;
    const addr = process.env[envKey];
    if (addr) out[symbol] = { ...out[symbol], address: addr };
  }
  return out;
};

export async function POST(req: Request) {
  try {
    const { chain: requestedChain, buyToken, sellToken, amount, recipient, txHash, CID, provider: providerFromBody, balanceSnapshots } = (await req
      .json()
      .catch(() => ({
        chain: null,
        buyToken: null,
        sellToken: null,
        amount: null,
        recipient: null,
        txHash: null,
        CID: null,
        provider: null,
        balanceSnapshots: null,
      }))) as {
      chain?: ChainKey | null;
      buyToken?: string | null;
      sellToken?: string | null;
      amount?: string | null;
      recipient?: string | null;
      txHash?: string | null;
      CID?: string | null;
      provider?: string | null;
      balanceSnapshots?: {
        sellTokenBeforeRaw?: string | null;
        buyTokenBeforeRaw?: string | null;
        gasTokenBeforeRaw?: string | null;
        gasTokenSymbol?: string | null;
        gasTokenDecimals?: number | null;
      } | null;
    };

    const resolvedChainKey: ChainKey =
      requestedChain && requestedChain in CHAINS ? requestedChain : (BLOCKCHAIN as ChainKey);
    console.log('[test-swap] Blockchain: resolvedChainKey', resolvedChainKey);
    
    const chainConfigs = {
      BASE_SEPOLIA,
      ETH_SEPOLIA,
      ETH_MAINNET,
      BASE_MAINNET,
      SOLANA_MAINNET,
      SOLANA_DEVNET,
    } as const;

    const chainConfig = chainConfigs[resolvedChainKey];

    const tokenConfigs: Record<ChainKey, Record<string, TokenInfo>> = {
      BASE_SEPOLIA: buildTokenMap(BaseSepoliaTokens as Record<string, TokenInfo>),
      ETH_SEPOLIA: buildTokenMap(EthSepoliaTokens as Record<string, TokenInfo>),
      ETH_MAINNET: buildTokenMap(EthTokens as Record<string, TokenInfo>),
      BASE_MAINNET: buildTokenMap(BaseTokens as Record<string, TokenInfo>),
      SOLANA_MAINNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
      SOLANA_DEVNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
    };

    const tokenConfig = applyTokenEnvOverrides(resolvedChainKey, tokenConfigs[resolvedChainKey]);
    if (!chainConfig) {
      return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
    }

    if (!amount || !recipient) {
      return NextResponse.json({ error: 'Missing amount or recipient' }, { status: 400 });
    }

    const normalizedBuyToken = buyToken?.toUpperCase();
    const normalizedSellToken = sellToken?.toUpperCase();
    console.log('[test-swap] normalizedBuyToken', normalizedBuyToken);
    console.log('[test-swap] normalizedSellToken', normalizedSellToken);
    
    if (!normalizedBuyToken || !normalizedSellToken) {
      return NextResponse.json({ error: 'Missing buy or sell token' }, { status: 400 });
    }

    const isSolana = isSolanaChain(resolvedChainKey);
    const provider = typeof providerFromBody === 'string' && providerFromBody.trim().length > 0
      ? providerFromBody.trim()
      : isSolana
        ? 'Jupiter'
        : '0x';
    const nativeSymbol = isSolana ? 'SOL' : 'ETH';

    let resolvedEvmSellToken: ResolvedEvmToken | null = null;
    let resolvedEvmBuyToken: ResolvedEvmToken | null = null;
    if (!isSolana && isEvmChain(resolvedChainKey)) {
      const sellResolution = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveEvmToken (sell)',
          description: 'resolve EVM sell token from config/cache/alchemy',
        },
        () => resolveEvmToken({
          chainKey: resolvedChainKey,
          symbolOrAddress: normalizedSellToken,
          tokenConfig,
        })
      );

      if (sellResolution.kind === 'ambiguous') {
        return NextResponse.json(
          {
            error: `Ambiguous sell token symbol: ${normalizedSellToken}`,
            code: 'AMBIGUOUS_SELL_TOKEN',
            chain: resolvedChainKey,
            candidates: sellResolution.candidates,
          },
          { status: 400 }
        );
      }
      if (sellResolution.kind === 'unresolved') {
        return NextResponse.json(
          {
            error: `Unable to resolve sell token: ${normalizedSellToken}`,
            code: 'UNRESOLVED_SELL_TOKEN',
            chain: resolvedChainKey,
          },
          { status: 400 }
        );
      }
      resolvedEvmSellToken = sellResolution.token;

      const buyResolution = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveEvmToken (buy)',
          description: 'resolve EVM buy token from config/cache/alchemy',
        },
        () => resolveEvmToken({
          chainKey: resolvedChainKey,
          symbolOrAddress: normalizedBuyToken,
          tokenConfig,
        })
      );

      if (buyResolution.kind === 'ambiguous') {
        return NextResponse.json(
          {
            error: `Ambiguous buy token symbol: ${normalizedBuyToken}`,
            code: 'AMBIGUOUS_BUY_TOKEN',
            chain: resolvedChainKey,
            candidates: buyResolution.candidates,
          },
          { status: 400 }
        );
      }
      if (buyResolution.kind === 'unresolved') {
        return NextResponse.json(
          {
            error: `Unable to resolve buy token: ${normalizedBuyToken}`,
            code: 'UNRESOLVED_BUY_TOKEN',
            chain: resolvedChainKey,
          },
          { status: 400 }
        );
      }
      resolvedEvmBuyToken = buyResolution.token;
    }
    // const supportedSell = normalizedSellToken === nativeSymbol || !!tokenConfig[normalizedSellToken];
    // const supportedBuy = normalizedBuyToken === nativeSymbol || !!tokenConfig[normalizedBuyToken];
    // if (!isSolana && (!supportedBuy || !supportedSell)) {
    //   return NextResponse.json(
    //     {
    //       error: `Unsupported token pair. Sell must be ${nativeSymbol} or one of: ${Object.keys(tokenConfig).join(', ')}. Buy must be ${nativeSymbol} or one of: ${Object.keys(tokenConfig).join(', ')}.`,
    //     },
    //     { status: 400 }
    //   );
    // }

    if (txHash && normalizedBuyToken && normalizedSellToken && amount) {
      if (!CID) {
        return NextResponse.json({ error: 'Missing CID for swap writeback.' }, { status: 400 });
      }
      const authHeader = req.headers.get('authorization');
      const accessTokenHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const cookieStore = await cookies();
      const cookieToken = cookieStore.get('privy-token')?.value ?? null;
      const accessToken = accessTokenHeader ?? cookieToken;
      if (!accessToken) {
        return NextResponse.json({ error: 'Missing Privy access token for swap writeback.' }, { status: 401 });
      }
      
      // Extract balance before values from balanceSnapshots for use in resolveBuyAmount
      let buyBalanceBefore: string | null = parseRawBalanceSnapshot(balanceSnapshots?.buyTokenBeforeRaw);

      // Resolve gas fee FIRST so we can pass gasCostRaw into resolveBuyAmount.
      // resolveGasFee fetches its own receipt when evmReceipt is null, so no dependency on
      // buyAmountResult here.  For Solana the gas fee is derived from solanaTx.meta.fee, but
      // solanaTx is only available after resolveBuyAmount — so we pass solanaTx: null here and
      // re-resolve below (after resolveBuyAmount) for Solana.  EVM swaps are unaffected.
      let gasFee = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveGasFee',
          description: 'derive gas fee from chain data',
        },
        () => resolveGasFee({
          chainKey: resolvedChainKey,
          txHash,
          evmReceipt: null,
          solanaTx: null,
        })
      );

      const buyAmountResult = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveBuyAmount',
          description: 'derive buy amount from chain data',
        },
        () =>
          resolveBuyAmount({
            chainKey: resolvedChainKey,
            txHash,
            buyToken: normalizedBuyToken,
            recipient,
            buyTokenAddressOrMint:
              resolvedChainKey === 'SOLANA_MAINNET'
                ? tokenConfig[normalizedBuyToken]?.address ?? null
                : resolvedEvmBuyToken?.address ?? null,
            balanceBefore: buyBalanceBefore,
            // Pass the pre-computed gas cost so resolveBuyAmount can correctly add it back
            // when computing the ETH delta (endBalance - startBalance + gasCost).
            gasCostRaw: gasFee?.amount ?? null,
          })
      );
      let buyAmountRaw = buyAmountResult.amountRaw;
      const buyDecimals = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveTokenDecimals',
          description: 'lookup buy token decimals',
        },
        () =>
          resolveTokenDecimals({
            chainKey: resolvedChainKey,
            buyToken: normalizedBuyToken,
            buyTokenAddressOrMint:
              resolvedChainKey === 'SOLANA_MAINNET'
                ? tokenConfig[normalizedBuyToken]?.address ?? null
                : resolveBuyTokenAddress({
                    tokenConfig,
                    buyToken: normalizedBuyToken,
                    resolvedEvmBuyTokenAddress: resolvedEvmBuyToken?.address ?? null,
                  }),
            tokenConfig,
          })
      );
      const buyAmount = buyDecimals !== null
        ? formatAmountFromRaw(buyAmountRaw, buyDecimals)
        : buyAmountRaw;
      const sellDecimals = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveTokenDecimals (sell)',
          description: 'lookup sell token decimals',
        },
        () =>
          resolveTokenDecimals({
            chainKey: resolvedChainKey,
            buyToken: normalizedSellToken,
            buyTokenAddressOrMint:
              resolvedChainKey === 'SOLANA_MAINNET'
                ? tokenConfig[normalizedSellToken]?.address ?? null
                : resolvedEvmSellToken?.address ?? null,
            tokenConfig,
          })
      );
      const sellAmountRaw = sellDecimals !== null
        ? parseAmountToRaw(amount, sellDecimals)
        : null;
      console.log('[test-swap] Received balanceSnapshots:', JSON.stringify(balanceSnapshots, null, 2));
      
      let sellBalanceBefore: string | null = parseRawBalanceSnapshot(balanceSnapshots?.sellTokenBeforeRaw);
      
      console.log('[test-swap] sellBalanceBefore parsed:', sellBalanceBefore, 'for token:', normalizedSellToken);
      
      // buyBalanceBefore already extracted earlier for resolveBuyAmount
      const gasTokenSymbol =
        typeof balanceSnapshots?.gasTokenSymbol === 'string' && balanceSnapshots.gasTokenSymbol.trim().length > 0
          ? balanceSnapshots.gasTokenSymbol.trim().toUpperCase()
          : (GAS_TOKENS[resolvedChainKey] ?? (isSolana ? 'SOL' : 'ETH')).toUpperCase();
      let gasTokenBefore = parseRawBalanceSnapshot(balanceSnapshots?.gasTokenBeforeRaw);
      const gasTokenDecimals =
        typeof balanceSnapshots?.gasTokenDecimals === 'number' && Number.isFinite(balanceSnapshots.gasTokenDecimals)
          ? balanceSnapshots.gasTokenDecimals
          : (gasTokenSymbol === 'SOL' ? 9 : 18);
      let sellBalanceAfter: string | null = null;
      let buyBalanceAfter: string | null = null;
      let gasBalanceAfter: string | null = null;
      try {
        const user = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'syncUserFromAccessToken',
            description: 'Privy + Mongo user sync',
          },
          () => syncUserFromAccessToken(accessToken, { mode: 'runtime' })
        );
        const userBalances = ((user as { balances?: unknown }).balances ?? null) as Record<string, unknown> | null;

        const mongoSellBalanceBefore = parseRawBalanceSnapshot(
          resolveBalanceBefore({
            userBalances,
            chainKey: resolvedChainKey,
            symbol: normalizedSellToken,
          })
        );
        const mongoBuyBalanceBefore = parseRawBalanceSnapshot(
          resolveBalanceBefore({
            userBalances,
            chainKey: resolvedChainKey,
            symbol: normalizedBuyToken,
          })
        );
        const mongoGasBalanceBefore = parseRawBalanceSnapshot(
          resolveBalanceBefore({
            userBalances,
            chainKey: resolvedChainKey,
            symbol: gasTokenSymbol,
          })
        );

        // Prefer client snapshot only when valid; otherwise use Mongo snapshot.
        buyBalanceBefore = buyBalanceBefore ?? mongoBuyBalanceBefore;
        sellBalanceBefore = sellBalanceBefore ?? mongoSellBalanceBefore;
        gasTokenBefore = gasTokenBefore ?? mongoGasBalanceBefore;

        // Guard against corrupted pre-swap sell snapshot (e.g. stale cache or accidental "0").
        if (sellBalanceBefore !== null && sellAmountRaw !== null) {
          try {
            if (BigInt(sellBalanceBefore) < BigInt(sellAmountRaw)) {
              sellBalanceBefore = mongoSellBalanceBefore;
            }
          } catch {
            sellBalanceBefore = mongoSellBalanceBefore;
          }
        }

        // --- Blockchain fallback for balanceBefore values ---
        // When both client snapshot and MongoDB are null, read the pre-swap balance
        // directly from the chain at blockNumber - 1 (the block before the swap tx).
        // This ensures balanceBefore/balanceAfter are always populated for EVM swaps.
        const evmReceipt = buyAmountResult.evmReceipt ?? null;
        const receiptBlockNumber = typeof evmReceipt?.blockNumber === 'number' ? evmReceipt.blockNumber : null;
        // When sellToken is ETH, we read the on-chain balance at blockNumber directly
        // (endBalance after swap + gas) instead of computing sellBefore - sellAmt - gas.
        // sellAmountRaw comes from the user-typed input and may not exactly match what the
        // router consumed, causing a small but real discrepancy.
        let ethSellEndBalance: string | null = null;
        if (!isSolana && receiptBlockNumber !== null && isEvmChain(resolvedChainKey)) {
          const chainConfigs2 = { BASE_SEPOLIA, ETH_SEPOLIA, ETH_MAINNET, BASE_MAINNET } as const;
          const evmChainConfig = chainConfigs2[resolvedChainKey as keyof typeof chainConfigs2];
          if (evmChainConfig && 'rpcUrls' in evmChainConfig) {
            const rpcUrl2 = resolveRpcUrl(evmChainConfig.rpcUrls);
            const evmProvider = new ethers.JsonRpcProvider(rpcUrl2);

            // When ETH is the sell token, read the post-swap on-chain balance directly.
            // This is exact — no arithmetic from user-typed sellAmountRaw needed.
            if (normalizedSellToken === 'ETH') {
              try {
                const bal = await getEthBalanceWithRetry(evmProvider, recipient, receiptBlockNumber, 'ethSellEndBalance');
                if (bal !== null) {
                  ethSellEndBalance = bal.toString();
                  console.log('[test-swap] ETH sell endBalance at blockNumber:', ethSellEndBalance);
                }
              } catch (err) {
                console.warn('[test-swap] Failed to fetch ETH sell endBalance:', err);
              }
            }

            // Sell token balanceBefore fallback
            if (sellBalanceBefore === null) {
              try {
                if (normalizedSellToken === 'ETH') {
                  const bal = await getEthBalanceWithRetry(evmProvider, recipient, receiptBlockNumber - 1, 'sellBalanceBefore');
                  if (bal !== null) {
                    sellBalanceBefore = bal.toString();
                    console.log('[test-swap] Blockchain fallback sellBalanceBefore (ETH):', sellBalanceBefore);
                  }
                } else {
                  const sellAddr = resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? null;
                  if (sellAddr) {
                    const bal = await resolveErc20BalanceAtBlock(evmProvider, sellAddr, recipient, receiptBlockNumber, 'sellBalanceBefore');
                    if (bal !== null) {
                      sellBalanceBefore = bal;
                      console.log('[test-swap] Blockchain fallback sellBalanceBefore (ERC-20):', sellBalanceBefore);
                    }
                  }
                }
              } catch (err) {
                console.warn('[test-swap] Blockchain fallback for sellBalanceBefore failed:', err);
              }
            }

            // Buy token fallback
            if (buyBalanceBefore === null) {
              try {
                if (normalizedBuyToken === 'ETH') {
                  const bal = await getEthBalanceWithRetry(evmProvider, recipient, receiptBlockNumber - 1, 'buyBalanceBefore');
                  if (bal !== null) {
                    buyBalanceBefore = bal.toString();
                    console.log('[test-swap] Blockchain fallback buyBalanceBefore (ETH):', buyBalanceBefore);
                  }
                } else {
                  const buyAddr = resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? null;
                  if (buyAddr) {
                    const bal = await resolveErc20BalanceAtBlock(evmProvider, buyAddr, recipient, receiptBlockNumber, 'buyBalanceBefore');
                    if (bal !== null) {
                      buyBalanceBefore = bal;
                      console.log('[test-swap] Blockchain fallback buyBalanceBefore (ERC-20):', buyBalanceBefore);
                    }
                  }
                }
              } catch (err) {
                console.warn('[test-swap] Blockchain fallback for buyBalanceBefore failed:', err);
              }
            }

            // Gas token fallback (only when gas token ≠ sell and ≠ buy)
            if (gasTokenBefore === null && gasTokenSymbol !== normalizedSellToken && gasTokenSymbol !== normalizedBuyToken) {
              try {
                const bal = await getEthBalanceWithRetry(evmProvider, recipient, receiptBlockNumber - 1, 'gasTokenBefore');
                if (bal !== null) {
                  gasTokenBefore = bal.toString();
                  console.log('[test-swap] Blockchain fallback gasTokenBefore (ETH):', gasTokenBefore);
                }
              } catch (err) {
                console.warn('[test-swap] Blockchain fallback for gasTokenBefore failed:', err);
              }
            }
          }
        }

        // --- Solana fallback: read pre/post balances directly from solanaTx ---
        // solanaTx already contains preBalances, postBalances, preTokenBalances, postTokenBalances.
        // This is zero extra RPC calls — the tx was already fetched by resolveBuyAmount.
        if (isSolana) {
          const solanaTx = buyAmountResult.solanaTx ?? null;
          if (solanaTx?.meta) {
            const meta = solanaTx.meta;
            const lookupKeys = meta.loadedAddresses
              ? {
                  writable: meta.loadedAddresses.writable.map((k) => k),
                  readonly: meta.loadedAddresses.readonly.map((k) => k),
                }
              : undefined;
            const accountKeys = solanaTx.transaction.message
              .getAccountKeys(lookupKeys ? { accountKeysFromLookups: lookupKeys } : undefined)
              .staticAccountKeys.map((k) => k.toBase58());
            const recipientIdx = accountKeys.findIndex((k) => k === recipient);

            const preTokens = meta.preTokenBalances ?? [];
            const postTokens = meta.postTokenBalances ?? [];

            // Helper: get SOL lamport balance for recipient
            const getSolBalance = (balances: number[]): string | null => {
              if (recipientIdx < 0 || recipientIdx >= balances.length) return null;
              return String(balances[recipientIdx] ?? 0);
            };

            // Helper: get SPL token balance for recipient by mint
            const getSplBalance = (
              entries: Array<{ owner?: string | null; mint?: string | null; uiTokenAmount?: { amount?: string } | null }>,
              mint: string
            ): string | null => {
              const entry = entries.find((b) => b.owner === recipient && b.mint === mint);
              return entry?.uiTokenAmount?.amount ?? null;
            };

            // Resolve mints for sell and buy tokens
            const sellMint = normalizedSellToken === 'SOL' ? null : (tokenConfig[normalizedSellToken]?.address ?? null);
            const buyMint = normalizedBuyToken === 'SOL' ? null : (tokenConfig[normalizedBuyToken]?.address ?? null);

            // sellBalanceBefore
            if (sellBalanceBefore === null) {
              if (normalizedSellToken === 'SOL') {
                sellBalanceBefore = getSolBalance(meta.preBalances);
              } else if (sellMint) {
                sellBalanceBefore = getSplBalance(preTokens, sellMint);
              }
              if (sellBalanceBefore !== null) {
                console.log('[test-swap] Solana fallback sellBalanceBefore:', sellBalanceBefore);
              }
            }

            // buyBalanceBefore
            if (buyBalanceBefore === null) {
              if (normalizedBuyToken === 'SOL') {
                buyBalanceBefore = getSolBalance(meta.preBalances);
              } else if (buyMint) {
                buyBalanceBefore = getSplBalance(preTokens, buyMint);
              }
              if (buyBalanceBefore !== null) {
                console.log('[test-swap] Solana fallback buyBalanceBefore:', buyBalanceBefore);
              }
            }

            // sellBalanceAfter — read directly from postBalances/postTokenBalances (exact, no arithmetic)
            if (normalizedSellToken === 'SOL') {
              const bal = getSolBalance(meta.postBalances);
              if (bal !== null) {
                sellBalanceAfter = bal;
                console.log('[test-swap] Solana sellBalanceAfter (SOL, postBalances):', sellBalanceAfter);
              }
            } else if (sellMint) {
              const bal = getSplBalance(postTokens, sellMint);
              if (bal !== null) {
                sellBalanceAfter = bal;
                console.log('[test-swap] Solana sellBalanceAfter (SPL, postTokenBalances):', sellBalanceAfter);
              }
            }

            // buyBalanceAfter — read directly from postBalances/postTokenBalances (exact, no arithmetic)
            if (normalizedBuyToken === 'SOL') {
              const bal = getSolBalance(meta.postBalances);
              if (bal !== null) {
                buyBalanceAfter = bal;
                console.log('[test-swap] Solana buyBalanceAfter (SOL, postBalances):', buyBalanceAfter);
              }
            } else if (buyMint) {
              const bal = getSplBalance(postTokens, buyMint);
              if (bal !== null) {
                buyBalanceAfter = bal;
                console.log('[test-swap] Solana buyBalanceAfter (SPL, postTokenBalances):', buyBalanceAfter);
              }
            }

            // gasTokenBefore (SOL) — only when gas token ≠ sell and ≠ buy
            if (gasTokenBefore === null && gasTokenSymbol === 'SOL' && gasTokenSymbol !== normalizedSellToken && gasTokenSymbol !== normalizedBuyToken) {
              gasTokenBefore = getSolBalance(meta.preBalances);
              if (gasTokenBefore !== null) {
                console.log('[test-swap] Solana fallback gasTokenBefore:', gasTokenBefore);
              }
            }
          }
        }

        // Re-resolve gasFee for Solana now that we have solanaTx from resolveBuyAmount.
        // The initial resolveGasFee call passed solanaTx: null (solanaTx wasn't available yet),
        // so it returned null for Solana.  We now have the tx and can read meta.fee directly.
        if (isSolana && gasFee === null && buyAmountResult.solanaTx) {
          gasFee = await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/test-swap/route.ts',
              target: 'resolveGasFee (Solana re-resolve)',
              description: 'derive SOL gas fee from solanaTx.meta.fee',
            },
            () => resolveGasFee({
              chainKey: resolvedChainKey,
              txHash,
              evmReceipt: null,
              solanaTx: buyAmountResult.solanaTx,
            })
          );
          if (gasFee !== null) {
            console.log('[test-swap] Solana gasFee re-resolved:', gasFee);
          }
        }

        const gasFeeRaw = gasFee?.amount ? BigInt(gasFee.amount) : 0n;
        const shouldApplyGasToSell = normalizedSellToken === gasTokenSymbol;
        const shouldApplyGasToBuy = normalizedBuyToken === gasTokenSymbol;

        // When buyToken === ETH, recompute buyAmountRaw using the finalized buyBalanceBefore
        // (which may have been updated by the blockchain fallback above) and ethEndBalance.
        // Formula: buyAmountRaw = ethEndBalance - buyBalanceBefore + gasCost
        // This is the pure ETH received from the swap router (gas-neutral).
        // The original buyAmountRaw from resolveBuyAmount used the client-snapshot startBalance
        // which may be stale; the blockchain-fallback buyBalanceBefore is always accurate.
        const ethBuyEndBalanceForAmount = buyAmountResult.ethEndBalance ?? null;
        if (normalizedBuyToken === 'ETH' && ethBuyEndBalanceForAmount !== null && buyBalanceBefore !== null) {
          try {
            const endBal = BigInt(ethBuyEndBalanceForAmount);
            const startBal = BigInt(buyBalanceBefore);
            const recomputedDelta = endBal - startBal + gasFeeRaw;
            if (recomputedDelta > 0n) {
              buyAmountRaw = recomputedDelta.toString();
              console.log('[test-swap] buyAmountRaw recomputed for ETH:', {
                ethEndBalance: ethBuyEndBalanceForAmount,
                buyBalanceBefore,
                gasFeeRaw: gasFeeRaw.toString(),
                recomputedDelta: buyAmountRaw,
              });
            }
          } catch (err) {
            console.warn('[test-swap] Failed to recompute buyAmountRaw for ETH:', err);
          }
        }
        console.log('[test-swap] balance-after inputs:', {
          sellToken: normalizedSellToken,
          buyToken: normalizedBuyToken,
          gasTokenSymbol,
          shouldApplyGasToSell,
          shouldApplyGasToBuy,
          sellBalanceBefore,
          buyBalanceBefore,
          gasTokenBefore,
          sellAmountRaw,
          buyAmountRaw,
          gasFeeRaw: gasFeeRaw.toString(),
        });

        // For ETH sell token: use the on-chain endBalance at blockNumber directly.
        // This is exact — no arithmetic from user-typed sellAmountRaw which may differ
        // from what the router actually consumed (slippage / exact-output semantics).
        // For non-ETH EVM sell tokens: use arithmetic (ERC-20 Transfer logs give exact amounts).
        // For Solana: already set from postBalances/postTokenBalances above — skip arithmetic.
        if (normalizedSellToken === 'ETH' && ethSellEndBalance !== null) {
          sellBalanceAfter = ethSellEndBalance;
          console.log('[test-swap] sellBalanceAfter (ETH, on-chain endBalance):', sellBalanceAfter);
        } else if (!isSolana) {
          sellBalanceAfter =
            sellBalanceBefore !== null && sellAmountRaw !== null
              ? (() => {
                  const sellBefore = BigInt(sellBalanceBefore);
                  const sellAmt = BigInt(sellAmountRaw);
                  const gasDeduction = shouldApplyGasToSell ? gasFeeRaw : 0n;
                  const next = sellBefore - sellAmt - gasDeduction;
                  const result = (next < 0n ? 0n : next).toString();
                  console.log('[test-swap] sellBalanceAfter math:', {
                    sellBefore: sellBefore.toString(),
                    sellAmt: sellAmt.toString(),
                    gasDeduction: gasDeduction.toString(),
                    next: next.toString(),
                    result,
                  });
                  return result;
                })()
              : null;
        }
        // For ETH buy token: use the on-chain endBalance at blockNumber directly.
        // buyAmountRaw is derived from endBalance - startBalance + gasCost, but if
        // startBalance (buyBalanceBefore) is stale the arithmetic produces a wrong delta.
        // endBalance itself is always exact — it IS the correct buyBalanceAfter.
        // For non-ETH EVM buy tokens: use arithmetic (ERC-20 Transfer logs give exact amounts).
        // For Solana: already set from postBalances/postTokenBalances above — skip arithmetic.
        const ethBuyEndBalance = buyAmountResult.ethEndBalance ?? null;
        if (normalizedBuyToken === 'ETH' && ethBuyEndBalance !== null) {
          buyBalanceAfter = ethBuyEndBalance;
          console.log('[test-swap] buyBalanceAfter (ETH, on-chain endBalance):', buyBalanceAfter);
        } else if (!isSolana) {
          buyBalanceAfter =
            buyBalanceBefore !== null
              ? (() => {
                  const buyBefore = BigInt(buyBalanceBefore);
                  const buyAmt = BigInt(buyAmountRaw);
                  const gross = buyBefore + buyAmt;
                  const gasDeduction = shouldApplyGasToBuy ? gasFeeRaw : 0n;
                  const net = gross - gasDeduction;
                  const result = (net < 0n ? 0n : net).toString();
                  console.log('[test-swap] buyBalanceAfter math:', {
                    buyBefore: buyBefore.toString(),
                    buyAmt: buyAmt.toString(),
                    gross: gross.toString(),
                    gasDeduction: gasDeduction.toString(),
                    net: net.toString(),
                    result,
                  });
                  return result;
                })()
              : null;
        }
        gasBalanceAfter =
          gasTokenBefore !== null
            ? (shouldApplyGasToSell && sellBalanceAfter !== null
              ? sellBalanceAfter
              : (shouldApplyGasToBuy && buyBalanceAfter !== null
                ? buyBalanceAfter
              : (() => {
                  const gasBefore = BigInt(gasTokenBefore);
                  const next = gasBefore - gasFeeRaw;
                  const result = (next < 0n ? 0n : next).toString();
                  console.log('[test-swap] gasBalanceAfter math (standalone):', {
                    gasBefore: gasBefore.toString(),
                    gasFeeRaw: gasFeeRaw.toString(),
                    next: next.toString(),
                    result,
                  });
                  return result;
                })()))
            : null;

        console.log('[test-swap] balance-after results:', {
          sellBalanceAfter,
          buyBalanceAfter,
          gasBalanceAfter,
        });
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'connectToDatabase',
            description: 'MongoDB connection for swap write',
          },
          () => connectToDatabase()
        );
        const sellTokenPayload = {
          amount: sellAmountRaw ?? amount,
          decimals: sellDecimals,
          symbol: normalizedSellToken,
          contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
            ? tokenConfig[normalizedSellToken]?.address ?? null
            : normalizedSellToken === 'ETH'
              ? ZEROX_ETH_PLACEHOLDER
              : resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? null,
          chain: resolvedChainKey,
          chainId: chainConfig.chainId,
          walletAddress: recipient,
          balanceBefore: sellBalanceBefore,
          balanceAfter: sellBalanceAfter,
          fees: {
            gas: {
              token: gasFee?.token ?? '',
              amount: gasFee?.amount ?? '',
              decimals: gasFee?.token === 'SOL' ? 9 : gasFee?.token === 'ETH' ? 18 : null,
            },
            provider: { token: '', amount: '', decimals: null },
            altair: { token: '', amount: '', decimals: null },
          },
        };
        const buyTokenPayload = {
          amount: buyAmountRaw,
          decimals: buyDecimals,
          symbol: normalizedBuyToken,
          contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
            ? tokenConfig[normalizedBuyToken]?.address ?? null
            : resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? null,
          chain: resolvedChainKey,
          chainId: chainConfig.chainId,
          walletAddress: recipient,
          balanceBefore: buyBalanceBefore,
          balanceAfter: buyBalanceAfter,
          fees: {
            gas: { token: '', amount: '', decimals: null },
            provider: { token: '', amount: '', decimals: null },
            altair: { token: '', amount: '', decimals: null },
          },
        };
        const SID = await generateSwapID();
        console.log('[test-swap] MongoDB swap data:')
        console.log({
          SID,
          UID: user.UID,
          CID,
          intentString: 'SINGLE_CHAIN_SWAP_INTENT',
          sellToken: sellTokenPayload,
          buyToken: buyTokenPayload,
          txHash,
          timestamp: new Date().toISOString(),
        });
        const swapTemplate = resolveMongoTemplate('swap');
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'Swap.create',
            description: 'Mongo swap write',
          },
          async () =>
            Swap.create({
              ...swapTemplate,
              SID,
              UID: user.UID,
              CID,
              provider,
              intentString: 'SINGLE_CHAIN_SWAP_INTENT',
              sellToken: sellTokenPayload,
              buyToken: buyTokenPayload,
              txHash,
              timestamp: new Date().toISOString(),
            })
        );
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'Chat.updateOne',
            description: 'mark chat intent as executed (swap writeback)',
          },
          () =>
            Chat.updateOne(
              { CID, UID: user.UID },
              {
                $set: {
                  SID,
                  intentString: 'SINGLE_CHAIN_SWAP_INTENT',
                  intentExecuted: true,
                },
              }
            )
        );

        const sellEntryAddress = resolvedChainKey === 'SOLANA_MAINNET'
          ? tokenConfig[normalizedSellToken]?.address ?? ''
          : normalizedSellToken === 'ETH'
            ? ''
            : resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? '';
        const buyEntryAddress = resolvedChainKey === 'SOLANA_MAINNET'
          ? tokenConfig[normalizedBuyToken]?.address ?? ''
          : resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? '';
        const gasEntryAddress = gasTokenSymbol === 'SOL'
          ? tokenConfig.SOL?.address ?? ''
          : '';

        const mongoBalanceUpdates: Record<string, BalanceEntry> = {};
        if (sellBalanceAfter !== null) {
          mongoBalanceUpdates[normalizedSellToken] = {
            symbol: normalizedSellToken,
            balance: sellBalanceAfter,
            decimals: typeof sellDecimals === 'number' ? sellDecimals : (isSolana ? 9 : 18),
            name: normalizedSellToken,
            address: sellEntryAddress,
            source: 'blockchain',
            verifiedAt: Date.now(),
          };
        }
        if (buyBalanceAfter !== null) {
          mongoBalanceUpdates[normalizedBuyToken] = {
            symbol: normalizedBuyToken,
            balance: buyBalanceAfter,
            decimals: typeof buyDecimals === 'number' ? buyDecimals : (isSolana ? 9 : 18),
            name: normalizedBuyToken,
            address: buyEntryAddress,
            source: 'blockchain',
            verifiedAt: Date.now(),
          };
        }
        if (gasBalanceAfter !== null && !(gasTokenSymbol in mongoBalanceUpdates)) {
          mongoBalanceUpdates[gasTokenSymbol] = {
            symbol: gasTokenSymbol,
            balance: gasBalanceAfter,
            decimals: gasTokenDecimals,
            name: gasTokenSymbol,
            address: gasEntryAddress,
            source: 'blockchain',
            verifiedAt: Date.now(),
          };
        }

        if (Object.keys(mongoBalanceUpdates).length > 0) {
          await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/test-swap/route.ts',
              target: 'updateBalancesInMongoDB',
              description: 'durable sell/buy/gas balance persistence',
            },
            () => updateBalancesInMongoDB(user.UID, resolvedChainKey, mongoBalanceUpdates, 'blockchain')
          );
        }
      } catch (dbErr) {
        console.warn('[test-swap] swap db write failed', dbErr);
      }
        try {
          const sellTokenPayload = {
            amount: sellAmountRaw ?? amount,
            decimals: sellDecimals,
            symbol: normalizedSellToken,
            contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
              ? tokenConfig[normalizedSellToken]?.address ?? null
              : normalizedSellToken === 'ETH'
                ? ZEROX_ETH_PLACEHOLDER
                : resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? null,
            chain: resolvedChainKey,
            chainId: chainConfig.chainId,
            walletAddress: recipient,
            balanceBefore: sellBalanceBefore,
            balanceAfter: sellBalanceAfter,
            fees: {
              gas: {
                token: gasFee?.token ?? '',
                amount: gasFee?.amount ?? '',
                decimals: gasFee?.token === 'SOL' ? 9 : gasFee?.token === 'ETH' ? 18 : null,
              },
              provider: { token: '', amount: '', decimals: null },
              altair: { token: '', amount: '', decimals: null },
            },
          };
          const buyTokenPayload = {
            amount: buyAmountRaw,
            decimals: buyDecimals,
            symbol: normalizedBuyToken,
            contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
              ? tokenConfig[normalizedBuyToken]?.address ?? null
              : resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? null,
            chain: resolvedChainKey,
            chainId: chainConfig.chainId,
            walletAddress: recipient,
            balanceBefore: buyBalanceBefore,
            balanceAfter: buyBalanceAfter,
            fees: {
              gas: { token: '', amount: '', decimals: null },
              provider: { token: '', amount: '', decimals: null },
              altair: { token: '', amount: '', decimals: null },
            },
          };
          await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/test-swap/route.ts',
              target: 'appendSwapToHistory',
              description: '0G swap history write',
            },
            () =>
              appendSwapToHistory({
                accessToken,
                CID,
                provider,
                intentString: 'SINGLE_CHAIN_SWAP_INTENT',
                sellToken: sellTokenPayload,
                buyToken: buyTokenPayload,
                txHash,
              })
          );
        } catch (zgErr) {
          console.warn('[test-swap] swap 0G write failed', zgErr);
        }
      const shouldEmitGasUpdate =
        gasBalanceAfter !== null &&
        gasTokenSymbol !== normalizedSellToken &&
        gasTokenSymbol !== normalizedBuyToken;

      const balanceUpdates = [
        sellBalanceAfter !== null
          ? {
              chain: resolvedChainKey,
              symbol: normalizedSellToken,
              balanceAfterRaw: sellBalanceAfter,
              decimals: sellDecimals,
            }
          : null,
        buyBalanceAfter !== null
          ? {
              chain: resolvedChainKey,
              symbol: normalizedBuyToken,
              balanceAfterRaw: buyBalanceAfter,
              decimals: buyDecimals,
            }
          : null,
        shouldEmitGasUpdate
          ? {
              chain: resolvedChainKey,
              symbol: gasTokenSymbol,
              balanceAfterRaw: gasBalanceAfter,
              decimals: gasTokenDecimals,
            }
          : null,
      ].filter((entry): entry is { chain: ChainKey; symbol: string; balanceAfterRaw: string; decimals: number } => Boolean(entry));

      return NextResponse.json({ ok: true, txHash, buyAmount, balanceUpdates });
    }

    if (isSolana) {
      const resolveSolanaToken = async (symbolOrMint: string) => {
        const chainContext = undefined;
        console.log('[test-swap] resolveSolanaToken: start', {
          input: symbolOrMint,
          normalized: symbolOrMint?.toUpperCase?.() ?? symbolOrMint,
          isMint: isSolanaMint(symbolOrMint),
        });
        if (symbolOrMint === 'SOL') {
          console.log('[test-swap] resolveSolanaToken: using native SOL config', {
            mint: tokenConfig.SOL.address,
            decimals: tokenConfig.SOL.decimals,
          });
          return { mint: tokenConfig.SOL.address, decimals: tokenConfig.SOL.decimals, symbol: 'SOL' };
        }
        const configuredToken = tokenConfig[symbolOrMint];
        if (configuredToken) {
          console.log('[test-swap] resolveSolanaToken: using configured token', {
            symbol: symbolOrMint,
            mint: configuredToken.address,
            decimals: configuredToken.decimals,
          });
          return {
            mint: configuredToken.address,
            decimals: configuredToken.decimals,
            symbol: configuredToken.symbol ?? symbolOrMint,
          };
        }
        if (isSolanaMint(symbolOrMint)) {
          const jupiterToken = await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/test-swap/route.ts',
              target: 'findJupiterToken',
              description: 'resolve Solana token by mint',
            },
            () => findJupiterToken(symbolOrMint)
          );
          console.log('[test-swap] resolveSolanaToken: mint lookup', {
            input: symbolOrMint,
            found: Boolean(jupiterToken),
            token: jupiterToken ?? null,
          });
          return {
            mint: symbolOrMint,
            decimals: jupiterToken?.decimals ?? 9,
            symbol: jupiterToken?.symbol ?? symbolOrMint,
          };
        }
        const jupiterToken = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'findJupiterToken',
            description: 'resolve Solana token by symbol',
          },
          () => findJupiterToken(symbolOrMint)
        );
        console.log('[test-swap] resolveSolanaToken: symbol lookup', {
          input: symbolOrMint,
          found: Boolean(jupiterToken),
          token: jupiterToken ?? null,
        });
        if (jupiterToken) {
          return {
            mint: jupiterToken.address,
            decimals: jupiterToken.decimals,
            symbol: jupiterToken.symbol ?? symbolOrMint,
          };
        }
        const searchResults = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'Jupiter token search',
            description: 'search Solana token list',
          },
          () =>
            searchJupiterTokens(symbolOrMint, {
              apiKey: process.env.JUPITER_API_KEY,
              maxResults: 8,
            })
        );
        console.log('[test-swap] Jupiter token search results', {
          query: symbolOrMint,
          count: searchResults.length,
          top: searchResults.slice(0, 5).map((token) => ({
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            isVerified: token.isVerified,
            tags: token.tags,
          })),
        });
        const best = pickBestMatch(searchResults, symbolOrMint);
        console.log('[test-swap] Jupiter token best match', {
          query: symbolOrMint,
          best: best
            ? {
                id: best.id,
                symbol: best.symbol,
                name: best.name,
                decimals: best.decimals,
                isVerified: best.isVerified,
                tags: best.tags,
              }
            : null,
        });
        if (!best) return null;
        await saveJupiterToken(best);
        return {
          mint: best.id,
          decimals: best.decimals ?? 9,
          symbol: best.symbol ?? symbolOrMint,
        };
      };

      const sellTokenInfo = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveSolanaToken',
          description: 'resolve Solana sell token',
        },
        () => resolveSolanaToken(normalizedSellToken)
      );
      const buyTokenInfo = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveSolanaToken',
          description: 'resolve Solana buy token',
        },
        () => resolveSolanaToken(normalizedBuyToken)
      );
      if (!sellTokenInfo || !buyTokenInfo) {
        return NextResponse.json(
          {
            error:
              'Unsupported Solana token. Provide a known symbol (from config or Jupiter list) or a valid mint address.',
          },
          { status: 400 }
        );
      }

      const tokenInMint = sellTokenInfo.mint;
      const tokenOutMint = buyTokenInfo.mint;
      const decimals = sellTokenInfo.decimals ?? 9;
      const amountHuman = Number(amount);
      if (!Number.isFinite(amountHuman) || amountHuman <= 0) {
        return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
      }
      const amountInRaw = Math.floor(amountHuman * 10 ** decimals).toString();
      const jupiterApiKey = process.env.JUPITER_API_KEY;
      if (!jupiterApiKey) {
        return NextResponse.json(
          { error: 'JUPITER_API_KEY is required for Solana swaps. Get an Ultra Swap API key at https://portal.jup.ag/api-keys' },
          { status: 500 }
        );
      }
      const orderUrl = `https://api.jup.ag/ultra/v1/order?inputMint=${encodeURIComponent(tokenInMint)}&outputMint=${encodeURIComponent(tokenOutMint)}&amount=${amountInRaw}&taker=${encodeURIComponent(recipient)}`;
      const jupiterCacheKey = buildQuoteCacheKey([
        'jupiter',
        'SOLANA_MAINNET',
        tokenInMint,
        tokenOutMint,
        amountInRaw,
        recipient,
      ]);
      let orderPayload = getQuoteCache<{ transaction?: string; requestId?: string; outAmount?: string }>(jupiterCacheKey);
      if (!orderPayload) {
        const orderRes = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'Jupiter Ultra order',
            description: 'swap route response',
          },
          () =>
            fetch(orderUrl, {
              headers: { Accept: 'application/json', 'x-api-key': jupiterApiKey },
              cache: 'no-store',
            })
        );
        if (!orderRes.ok) {
          const errText = await orderRes.text();
          const isUnauthorized = orderRes.status === 401;
          const isRateLimited = orderRes.status === 429;
          const userMessage = isUnauthorized
            ? 'Invalid or missing JUPITER_API_KEY. Use an Ultra Swap API key from https://portal.jup.ag/api-keys'
            : isRateLimited
              ? 'Jupiter rate limit exceeded. Please retry shortly.'
              : `Jupiter Ultra order failed: ${errText}`;
          return NextResponse.json({ error: userMessage, status: orderRes.status, provider: 'jupiter' }, { status: 500 });
        }
        orderPayload = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'Jupiter orderRes.json',
            description: 'parse Jupiter order response',
          },
          async () => (await orderRes.json()) as { transaction?: string; requestId?: string; outAmount?: string }
        );
        if (orderPayload?.transaction) {
          setQuoteCache(jupiterCacheKey, orderPayload);
        }
      }
      if (!orderPayload?.transaction) {
        return NextResponse.json(
          { error: 'Jupiter Ultra returned no transaction for this pair/amount.' },
          { status: 500 }
        );
      }
      const rpcUrlCandidates = resolveRpcUrls(chainConfig.rpcUrls);
      const rpcUrl = rpcUrlCandidates[0] ?? chainConfig.rpcUrls[0];

      const responseBody = {
        source: 'jupiter',
        chain: 'SOLANA_MAINNET',
        solana: {
          swapTransaction: orderPayload.transaction,
          rpcUrl,
          rpcUrlCandidates,
          amountOut: orderPayload.outAmount,
        },
        sellTokenAddress: tokenInMint,
        buyTokenAddress: tokenOutMint,
      };
      return NextResponse.json(responseBody);
    }

    if (!('chainId' in chainConfig)) {
      return NextResponse.json({ error: 'Unsupported EVM chain configuration' }, { status: 400 });
    }

    const sellDecimals = resolvedEvmSellToken?.decimals ?? (normalizedSellToken === 'ETH' ? 18 : tokenConfig[normalizedSellToken]?.decimals ?? 18);
    const amountHuman = Number(amount);
    if (!Number.isFinite(amountHuman) || amountHuman <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    const sellAmountRaw = ethers.parseUnits(amountHuman.toString(), sellDecimals).toString();

    const zeroXApiKey = process.env.ZEROX_API_KEY;
    const zeroXSellToken = normalizedSellToken === 'ETH' ? 'ETH' : (resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? '');
    const zeroXBuyToken = normalizedBuyToken === 'ETH' ? 'ETH' : (resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? '');
    const v2NativeToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const zeroXV2SellToken = normalizedSellToken === 'ETH' ? v2NativeToken : (resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address ?? '');
    const zeroXV2BuyToken = normalizedBuyToken === 'ETH' ? v2NativeToken : (resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address ?? '');

    if (!zeroXSellToken || !zeroXBuyToken || !zeroXV2SellToken || !zeroXV2BuyToken) {
      return NextResponse.json(
        {
          error: `Unable to resolve token addresses for ${normalizedSellToken}/${normalizedBuyToken} on ${resolvedChainKey}.`,
          code: 'UNRESOLVED_EVM_TOKEN_ADDRESS',
        },
        { status: 400 }
      );
    }

    const v1TestnetEndpoints: Partial<Record<ChainKey, string>> = {
      ETH_SEPOLIA: 'https://sepolia.api.0x.org/swap/v1/quote',
      BASE_SEPOLIA: 'https://base-sepolia.api.0x.org/swap/v1/quote',
    };

    const v1Endpoint = v1TestnetEndpoints[resolvedChainKey];
    let methodParameters: { to: string; calldata: string; value: string };

    if (v1Endpoint) {
      const v1Url = new URL(v1Endpoint);
      v1Url.searchParams.set('sellToken', zeroXSellToken);
      v1Url.searchParams.set('buyToken', zeroXBuyToken);
      v1Url.searchParams.set('sellAmount', sellAmountRaw);
      v1Url.searchParams.set('takerAddress', recipient);
      v1Url.searchParams.set('slippagePercentage', '0.005');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (zeroXApiKey) headers['0x-api-key'] = zeroXApiKey;

      const v1CacheKey = buildQuoteCacheKey([
        '0x',
        'v1',
        resolvedChainKey,
        zeroXSellToken,
        zeroXBuyToken,
        sellAmountRaw,
        recipient,
      ]);
      const cachedV1Method = getQuoteCache<{ to: string; calldata: string; value: string }>(v1CacheKey);
      if (cachedV1Method) {
        methodParameters = cachedV1Method;
      } else {

      console.log('[test-swap] 0x v1 request context', {
        resolvedChainKey,
        chainConfig,
        tokenConfig,
        normalizedSellToken,
        normalizedBuyToken,
        zeroXSellToken,
        zeroXBuyToken,
        sellAmountRaw,
        recipient,
        zeroXUrl: v1Url.toString(),
      });

        const v1Res = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: '0x v1 quote',
            description: 'swap quote response',
          },
          () => fetch(v1Url.toString(), { headers, method: 'GET' })
        );
        if (!v1Res.ok) {
          const errText = await v1Res.text();
          let msg = errText;
          try {
            const errJson = JSON.parse(errText) as { message?: string };
            if (errJson?.message?.toLowerCase().includes('no route')) {
              msg = `No swap route on ${resolvedChainKey} (0x may have limited testnet liquidity). Try a different amount or chain.`;
            }
          } catch {
            // keep msg
          }
          return NextResponse.json({ error: `0x ${resolvedChainKey} quote failed: ${msg}` }, { status: 500 });
        }

        const v1Payload = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: '0x v1 response.json',
            description: 'parse 0x v1 response',
          },
          async () => (await v1Res.json()) as { to?: string; data?: string; value?: string }
        );
        if (!v1Payload?.to || !v1Payload?.data || v1Payload?.value === undefined) {
          return NextResponse.json({ error: `0x ${resolvedChainKey} response missing to/data/value` }, { status: 500 });
        }
        methodParameters = { to: v1Payload.to, calldata: v1Payload.data, value: v1Payload.value };
        setQuoteCache(v1CacheKey, methodParameters);
      }
    } else {
      if (!zeroXApiKey) {
        return NextResponse.json(
          { error: 'ZEROX_API_KEY is required for 0x Swap API v2 (mainnet). Set it in .env and restart the server.' },
          { status: 500 }
        );
      }

      const v2Url = new URL('https://api.0x.org/swap/allowance-holder/quote');
      v2Url.searchParams.set('chainId', String(chainConfig.chainId));
      v2Url.searchParams.set('sellToken', zeroXV2SellToken);
      v2Url.searchParams.set('buyToken', zeroXV2BuyToken);
      v2Url.searchParams.set('sellAmount', sellAmountRaw);
      v2Url.searchParams.set('taker', recipient);
      v2Url.searchParams.set('slippageBps', '50');

      const v2CacheKey = buildQuoteCacheKey([
        '0x',
        'v2',
        resolvedChainKey,
        zeroXV2SellToken,
        zeroXV2BuyToken,
        sellAmountRaw,
        recipient,
      ]);
      const cachedV2Method = getQuoteCache<{ to: string; calldata: string; value: string }>(v2CacheKey);
      if (cachedV2Method) {
        methodParameters = cachedV2Method;
      } else {

      console.log('[test-swap] 0x v2 request context', {
        resolvedChainKey,
        chainConfig,
        tokenConfig,
        normalizedSellToken,
        normalizedBuyToken,
        zeroXSellToken: zeroXV2SellToken,
        zeroXBuyToken: zeroXV2BuyToken,
        sellAmountRaw,
        recipient,
        zeroXUrl: v2Url.toString(),
      });

        const v2Res = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: '0x v2 quote',
            description: 'swap quote response',
          },
          () =>
            fetch(v2Url.toString(), {
              headers: {
                Accept: 'application/json',
                '0x-api-key': zeroXApiKey,
                '0x-version': 'v2',
              },
              method: 'GET',
            })
        );

        if (!v2Res.ok) {
          const errText = await v2Res.text();
          let userMessage = `0x quote failed: ${errText}`;
          try {
            const errJson = JSON.parse(errText) as { message?: string };
            if (errJson?.message?.toLowerCase().includes('no route')) {
              userMessage = `No swap route for ${normalizedSellToken}/${normalizedBuyToken} on ${resolvedChainKey}. Check chain and token addresses or increase amount.`;
            }
          } catch {
            // keep userMessage
          }
          return NextResponse.json({ error: userMessage }, { status: 500 });
        }

        const v2Payload = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: '0x v2 response.json',
            description: 'parse 0x v2 response',
          },
          async () =>
            (await v2Res.json()) as {
              liquidityAvailable?: boolean;
              transaction?: { to: string; data: string; value: string; gas?: string };
            }
        );
        if (v2Payload.liquidityAvailable === false || !v2Payload.transaction) {
          return NextResponse.json(
            { error: `No liquidity for ${normalizedSellToken}/${normalizedBuyToken} on chain ${chainConfig.chainId}.` },
            { status: 500 }
          );
        }
        const tx = v2Payload.transaction;
        if (!tx.to || !tx.data || tx.value === undefined) {
          return NextResponse.json({ error: '0x quote response missing transaction fields' }, { status: 500 });
        }
        methodParameters = { to: tx.to, calldata: tx.data, value: tx.value };
        setQuoteCache(v2CacheKey, methodParameters);
      }
    }

    const responseBody = {
      methodParameters,
      source: '0x',
      chainRpcCandidates: resolveRpcUrls(chainConfig.rpcUrls),
      sellTokenAddress: normalizedSellToken === 'ETH' ? undefined : (resolvedEvmSellToken?.address ?? tokenConfig[normalizedSellToken]?.address),
      buyTokenAddress: normalizedBuyToken === 'ETH' ? ZEROX_ETH_PLACEHOLDER : (resolvedEvmBuyToken?.address ?? tokenConfig[normalizedBuyToken]?.address),
    };
    return NextResponse.json(responseBody);
  } catch (error) {
    console.error('Test swap error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
