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
  resolveRpcUrls,
} from '../../../../config/chain_info';
import type { ApiBalancesResponse, ApiTokenBalance } from '../../../../config/balance_types';
import { getPrivyEvmWalletAddress, getPrivySolanaWalletAddress } from '@/lib/privy';
import {
  getBalancesFromMongoDB,
  updateBalancesInMongoDB,
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
    ...(params.chain === 'SOLANA_MAINNET' ? { solanaAddress: params.address } : { address: params.address }),
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
} as const;

async function fetchBlockchainBalancesDynamic(params: {
  chainKey: ChainKey;
  walletAddress: string;
  seedBalances: Record<string, BalanceEntry>;
}): Promise<Record<string, BalanceEntry>> {
  const { chainKey, walletAddress, seedBalances } = params;
  const symbolSeed = Object.keys(seedBalances);
  const nativeSymbol = GAS_TOKENS[chainKey]?.toUpperCase() ?? (chainKey === 'SOLANA_MAINNET' ? 'SOL' : 'ETH');
  const tokenSymbols = Array.from(new Set([nativeSymbol, ...symbolSeed.map((s) => s.toUpperCase())]));
  const output: Record<string, BalanceEntry> = {};

  if (chainKey === 'SOLANA_MAINNET') {
    const connection = new Connection(SOLANA_MAINNET.rpcUrls[0], 'confirmed');
    const owner = new PublicKey(walletAddress);

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

      let raw = '0';
      let decimals = seedDecimals ?? 0;
      try {
        const mint = new PublicKey(seedAddress);
        const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
        const total = accounts.value.reduce((acc, tokenAccount) => {
          const parsed = tokenAccount.account.data;
          if (!('parsed' in parsed)) return acc;
          const amount = parsed.parsed?.info?.tokenAmount?.amount ?? '0';
          const next = BigInt(amount);
          const parsedDecimals = parsed.parsed?.info?.tokenAmount?.decimals;
          if (typeof parsedDecimals === 'number') decimals = parsedDecimals;
          return acc + next;
        }, 0n);
        raw = total.toString();
      } catch {
        raw = '0';
      }

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
    ...(params.chain === 'SOLANA_MAINNET' ? { solanaAddress: params.address } : { address: params.address }),
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
    } = (await req.json().catch(() => ({}))) as {
      walletAddress?: string;
      chain?: ChainKey;
      accessToken?: string;
      forceRefresh?: boolean;
    };

    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value;
    const tokenToVerify = bodyToken ?? cookieToken ?? null;

    const resolvedChainKey: ChainKey = chain && chain in CHAINS ? chain : (BLOCKCHAIN as ChainKey);

    const walletAddress = overrideAddress
      ?? (resolvedChainKey === 'SOLANA_MAINNET'
        ? (tokenToVerify ? await getPrivySolanaWalletAddress(tokenToVerify) : null)
        : (tokenToVerify ? await getPrivyEvmWalletAddress(tokenToVerify) : null));

    if (!walletAddress) {
      return NextResponse.json({ error: 'Unable to resolve wallet address' }, withCors({ status: 401 }));
    }

    const uid = tokenToVerify
      ? await getUserUIDFromAccessTokenByMode(tokenToVerify, 'login').catch(() => null)
      : null;
    const mongoBalances = uid
      ? await getBalancesFromMongoDB(uid, resolvedChainKey)
      : null;

    const shouldForceRefresh = Boolean(forceRefresh);

    if (mongoBalances && !shouldForceRefresh) {
      const immediatePayload = fromMongoToPayload({
        chain: resolvedChainKey,
        address: walletAddress,
        mongoBalances,
      });

      if (uid) {
        void (async () => {
          try {
            const verifiedBalances = await fetchBlockchainBalancesDynamic({
              chainKey: resolvedChainKey,
              walletAddress,
              seedBalances: mongoBalances,
            });
            await updateBalancesInMongoDB(uid, resolvedChainKey, verifiedBalances, 'blockchain');
          } catch (err) {
            console.warn('[balances] async verification failed', err);
          }
        })();
      }

      return NextResponse.json(immediatePayload, withCors());
    }

    const seed = mongoBalances ?? {};
    const blockchainBalances = await fetchBlockchainBalancesDynamic({
      chainKey: resolvedChainKey,
      walletAddress,
      seedBalances: seed,
    });

    if (uid) {
      void updateBalancesInMongoDB(uid, resolvedChainKey, blockchainBalances, 'blockchain');
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

