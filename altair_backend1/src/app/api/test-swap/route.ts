import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ethers } from 'ethers';
import { Connection, PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { BLOCKCHAIN, CHAINS, type ChainKey } from '../../../../config/blockchain_config';
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETH_MAINNET,
  ETH_SEPOLIA,
  SOLANA_MAINNET,
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
import { Swap } from '@/models/Swap';
import { Chat } from '@/models/Chat';
import { generateSwapID } from '@/lib/id';
import { formatAmountFromRaw, parseAmountToRaw } from '@/lib/amounts';
import { MONGODB_JSONS } from '../../../../config/mongodb_config';
import { ZG_JSONS } from '../../../../config/zerog_config';

type TokenInfo = { address: string; decimals: number; symbol?: string };

type JupiterTokenInfo = { address: string; decimals: number; symbol?: string };

const resolveMongoTemplate = (key: 'chat' | 'swap'): Record<string, unknown> => {
  const configValue = MONGODB_JSONS[key];
  if (configValue === 'ZG_JSONS') {
    const source = ZG_JSONS[key];
    return source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  }
  return configValue && typeof configValue === 'object' ? (configValue as Record<string, unknown>) : {};
};

const ZEROX_ETH_PLACEHOLDER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const QUOTE_CACHE_TTL_MS = 15_000;
type QuoteCacheEntry<T> = { expiresAt: number; value: T };
const quoteCache = new Map<string, QuoteCacheEntry<unknown>>();

const CHAIN_LABELS: Record<ChainKey, string> = {
  ETH_MAINNET: 'Ethereum',
  ETH_SEPOLIA: 'Ethereum',
  BASE_MAINNET: 'Base',
  BASE_SEPOLIA: 'Base',
  SOLANA_MAINNET: 'Solana',
};

const resolveBalanceBefore = (params: {
  userBalances: Record<string, unknown> | null | undefined;
  chainKey: ChainKey;
  symbol: string;
}): string | null => {
  const { userBalances, chainKey, symbol } = params;
  if (!userBalances || typeof userBalances !== 'object') return null;
  const chainLabel = CHAIN_LABELS[chainKey];
  const chainBalances = (userBalances as Record<string, unknown>)[chainLabel];
  if (!chainBalances || typeof chainBalances !== 'object') return null;
  const entries = (chainBalances as Record<string, unknown>)[symbol];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const balance = (entries[0] as { balance?: unknown } | undefined)?.balance;
  return typeof balance === 'string' ? balance : null;
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

const resolveBuyTokenAddress = (tokenConfig: Record<string, TokenInfo>, buyToken: string): string => {
  return buyToken === 'ETH' ? ZEROX_ETH_PLACEHOLDER : tokenConfig[buyToken]?.address ?? '';
};


const resolveGasFee = async (params: {
  chainKey: ChainKey;
  txHash: string;
  evmReceipt?: ethers.TransactionReceipt | null;
  solanaTx?: VersionedTransactionResponse | null;
}) => {
  const { chainKey, txHash, evmReceipt, solanaTx } = params;
  if (chainKey === 'SOLANA_MAINNET') {
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
    SOLANA_MAINNET,
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
  const addressOrMint = buyTokenAddressOrMint?.toLowerCase?.() ?? buyTokenAddressOrMint ?? null;
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

  if (chainKey === 'SOLANA_MAINNET') {
    if (normalizedBuy === 'SOL') return tokenConfig.SOL?.decimals ?? 9;
    if (tokenConfig[normalizedBuy]?.decimals !== undefined) return tokenConfig[normalizedBuy].decimals;
    return null;
  }

  if (normalizedBuy === 'ETH') return 18;
  if (tokenConfig[normalizedBuy]?.decimals !== undefined) return tokenConfig[normalizedBuy].decimals;
  return null;
};

const resolveBuyAmount = async (params: {
  chainKey: ChainKey;
  txHash: string;
  buyToken: string;
  recipient: string;
}): Promise<{ amountRaw: string; evmReceipt?: ethers.TransactionReceipt | null; solanaTx?: VersionedTransactionResponse | null }> => {
  const { chainKey, txHash, buyToken, recipient } = params;
  if (chainKey === 'SOLANA_MAINNET') {
    const tokenConfigs: Record<ChainKey, Record<string, TokenInfo>> = {
      BASE_SEPOLIA: buildTokenMap(BaseSepoliaTokens as Record<string, TokenInfo>),
      ETH_SEPOLIA: buildTokenMap(EthSepoliaTokens as Record<string, TokenInfo>),
      ETH_MAINNET: buildTokenMap(EthTokens as Record<string, TokenInfo>),
      BASE_MAINNET: buildTokenMap(BaseTokens as Record<string, TokenInfo>),
      SOLANA_MAINNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
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
    const chainConfig = SOLANA_MAINNET;
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
    SOLANA_MAINNET,
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
  };
  const tokenConfig = applyTokenEnvOverrides(chainKey, tokenConfigs[chainKey]);
  const buyTokenAddress = resolveBuyTokenAddress(tokenConfig, buyToken).toLowerCase();
  if (!buyTokenAddress) {
    throw new Error(`Missing buy token address for ${buyToken}`);
  }

  if (buyToken === 'ETH') {
    let startBalance: bigint | null = null;
    let endBalance: bigint | null = null;
    try {
      startBalance = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'EVM getBalance',
          description: 'pre-swap balance lookup',
        },
        () => provider.getBalance(recipient, receipt.blockNumber - 1)
      );
      endBalance = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'EVM getBalance',
          description: 'post-swap balance lookup',
        },
        () => provider.getBalance(recipient, receipt.blockNumber)
      );
    } catch (err) {
      console.warn('[test-swap] ETH balance delta lookup failed', err);
      try {
        endBalance = await provider.getBalance(recipient);
      } catch (fallbackErr) {
        console.warn('[test-swap] ETH balance fallback failed', fallbackErr);
      }
    }
    const effectiveGasPrice = 'effectiveGasPrice' in receipt && typeof receipt.effectiveGasPrice === 'bigint'
      ? receipt.effectiveGasPrice
      : 0n;
    const gasUsed = typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed : 0n;
    const gasCost = gasUsed * effectiveGasPrice;
    if (startBalance === null || endBalance === null) {
      return { amountRaw: '0', evmReceipt: receipt };
    }
    const delta = endBalance - startBalance + gasCost;
    if (delta <= 0n) {
      return { amountRaw: '0', evmReceipt: receipt };
    }
    return { amountRaw: delta.toString(), evmReceipt: receipt };
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
    const { chain: requestedChain, buyToken, sellToken, amount, recipient, txHash, CID } = (await req
      .json()
      .catch(() => ({
        chain: null,
        buyToken: null,
        sellToken: null,
        amount: null,
        recipient: null,
        txHash: null,
        CID: null,
      }))) as {
      chain?: ChainKey | null;
      buyToken?: string | null;
      sellToken?: string | null;
      amount?: string | null;
      recipient?: string | null;
      txHash?: string | null;
      CID?: string | null;
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
    } as const;

    const chainConfig = chainConfigs[resolvedChainKey];

    const tokenConfigs: Record<ChainKey, Record<string, TokenInfo>> = {
      BASE_SEPOLIA: buildTokenMap(BaseSepoliaTokens as Record<string, TokenInfo>),
      ETH_SEPOLIA: buildTokenMap(EthSepoliaTokens as Record<string, TokenInfo>),
      ETH_MAINNET: buildTokenMap(EthTokens as Record<string, TokenInfo>),
      BASE_MAINNET: buildTokenMap(BaseTokens as Record<string, TokenInfo>),
      SOLANA_MAINNET: buildTokenMap(SolanaTokens as Record<string, TokenInfo>),
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

    const isSolana = resolvedChainKey === 'SOLANA_MAINNET';
    const nativeSymbol = isSolana ? 'SOL' : 'ETH';
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
          })
      );
      const buyAmountRaw = buyAmountResult.amountRaw;
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
                : resolveBuyTokenAddress(tokenConfig, normalizedBuyToken),
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
                : normalizedSellToken === 'ETH'
                  ? ZEROX_ETH_PLACEHOLDER
                  : tokenConfig[normalizedSellToken]?.address ?? null,
            tokenConfig,
          })
      );
      const sellAmountRaw = sellDecimals !== null
        ? parseAmountToRaw(amount, sellDecimals)
        : null;
      const gasFee = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-swap/route.ts',
          target: 'resolveGasFee',
          description: 'derive gas fee from chain data',
        },
        () => resolveGasFee({
          chainKey: resolvedChainKey,
          txHash,
          evmReceipt: buyAmountResult.evmReceipt ?? null,
          solanaTx: buyAmountResult.solanaTx ?? null,
        })
      );
      let sellBalanceBefore: string | null = null;
      let buyBalanceBefore: string | null = null;
      let sellBalanceAfter: string | null = null;
      let buyBalanceAfter: string | null = null;
      try {
        const user = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'syncUserFromAccessToken',
            description: 'Privy + Mongo user sync',
          },
          () => syncUserFromAccessToken(accessToken)
        );
        const userBalances = (user as { balances?: Record<string, unknown> }).balances;
        sellBalanceBefore = resolveBalanceBefore({
          userBalances,
          chainKey: resolvedChainKey,
          symbol: normalizedSellToken,
        });
        buyBalanceBefore = resolveBalanceBefore({
          userBalances,
          chainKey: resolvedChainKey,
          symbol: normalizedBuyToken,
        });
        const gasFeeRaw = gasFee?.amount ? BigInt(gasFee.amount) : 0n;
        const shouldApplyGasToSell = normalizedSellToken === 'ETH' || normalizedSellToken === 'SOL';
        sellBalanceAfter =
          sellBalanceBefore !== null && sellAmountRaw !== null
            ? (BigInt(sellBalanceBefore) - BigInt(sellAmountRaw) - (shouldApplyGasToSell ? gasFeeRaw : 0n)).toString()
            : null;
        buyBalanceAfter =
          buyBalanceBefore !== null
            ? (BigInt(buyBalanceBefore) + BigInt(buyAmountRaw)).toString()
            : null;
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-swap/route.ts',
            target: 'connectToDatabase',
            description: 'MongoDB connection for swap write',
          },
          () => connectToDatabase()
        );
        const sellTokenPayload = {
          amount,
          symbol: normalizedSellToken,
          contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
            ? tokenConfig[normalizedSellToken]?.address ?? null
            : normalizedSellToken === 'ETH'
              ? ZEROX_ETH_PLACEHOLDER
              : tokenConfig[normalizedSellToken]?.address ?? null,
          chain: resolvedChainKey,
          chainId: chainConfig.chainId,
          walletAddress: recipient,
          balanceBefore: sellBalanceBefore,
          balanceAfter: sellBalanceAfter,
          fees: {
            gas: {
              token: gasFee?.token ?? '',
              amount: gasFee?.amount ?? '',
            },
            provider: { token: '', amount: '' },
            altair: { token: '', amount: '' },
          },
        };
        const buyTokenPayload = {
          amount: buyAmount,
          symbol: normalizedBuyToken,
          contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
            ? tokenConfig[normalizedBuyToken]?.address ?? null
            : normalizedBuyToken === 'ETH'
              ? ZEROX_ETH_PLACEHOLDER
              : tokenConfig[normalizedBuyToken]?.address ?? null,
          chain: resolvedChainKey,
          chainId: chainConfig.chainId,
          walletAddress: recipient,
          balanceBefore: buyBalanceBefore,
          balanceAfter: buyBalanceAfter,
          fees: {
            gas: { token: '', amount: '' },
            provider: { token: '', amount: '' },
            altair: { token: '', amount: '' },
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
      } catch (dbErr) {
        console.warn('[test-swap] swap db write failed', dbErr);
      }
        try {
          const sellTokenPayload = {
            amount,
            symbol: normalizedSellToken,
            contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
              ? tokenConfig[normalizedSellToken]?.address ?? null
              : normalizedSellToken === 'ETH'
                ? ZEROX_ETH_PLACEHOLDER
                : tokenConfig[normalizedSellToken]?.address ?? null,
            chain: resolvedChainKey,
            chainId: chainConfig.chainId,
            walletAddress: recipient,
            balanceBefore: sellBalanceBefore,
            balanceAfter: sellBalanceAfter,
            fees: {
              gas: {
                token: gasFee?.token ?? '',
                amount: gasFee?.amount ?? '',
              },
              provider: { token: '', amount: '' },
              altair: { token: '', amount: '' },
            },
          };
          const buyTokenPayload = {
            amount: buyAmount,
            symbol: normalizedBuyToken,
            contractAddress: resolvedChainKey === 'SOLANA_MAINNET'
              ? tokenConfig[normalizedBuyToken]?.address ?? null
              : normalizedBuyToken === 'ETH'
                ? ZEROX_ETH_PLACEHOLDER
                : tokenConfig[normalizedBuyToken]?.address ?? null,
            chain: resolvedChainKey,
            chainId: chainConfig.chainId,
            walletAddress: recipient,
            balanceBefore: buyBalanceBefore,
            balanceAfter: buyBalanceAfter,
            fees: {
              gas: { token: '', amount: '' },
              provider: { token: '', amount: '' },
              altair: { token: '', amount: '' },
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
                intentString: 'SINGLE_CHAIN_SWAP_INTENT',
                sellToken: sellTokenPayload,
                buyToken: buyTokenPayload,
                txHash,
              })
          );
        } catch (zgErr) {
          console.warn('[test-swap] swap 0G write failed', zgErr);
        }
      return NextResponse.json({ ok: true, txHash, buyAmount });
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

    const sellTokenInfo = normalizedSellToken === 'ETH' ? null : tokenConfig[normalizedSellToken];
    const sellDecimals = sellTokenInfo?.decimals ?? 18;
    const amountHuman = Number(amount);
    if (!Number.isFinite(amountHuman) || amountHuman <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    const sellAmountRaw = ethers.parseUnits(amountHuman.toString(), sellDecimals).toString();

    const zeroXApiKey = process.env.ZEROX_API_KEY;
    const zeroXSellToken = normalizedSellToken === 'ETH' ? 'ETH' : tokenConfig[normalizedSellToken].address;
    const zeroXBuyToken = normalizedBuyToken === 'ETH' ? 'ETH' : tokenConfig[normalizedBuyToken].address;
    const v2NativeToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const zeroXV2SellToken = normalizedSellToken === 'ETH' ? v2NativeToken : tokenConfig[normalizedSellToken].address;
    const zeroXV2BuyToken = normalizedBuyToken === 'ETH' ? v2NativeToken : tokenConfig[normalizedBuyToken].address;

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
      sellTokenAddress: normalizedSellToken === 'ETH' ? undefined : tokenConfig[normalizedSellToken].address,
    };
    return NextResponse.json(responseBody);
  } catch (error) {
    console.error('Test swap error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
