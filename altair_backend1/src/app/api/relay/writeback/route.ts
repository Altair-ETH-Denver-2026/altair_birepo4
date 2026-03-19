import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectToDatabase } from '@/lib/db';
import { Swap } from '@/models/Swap';
import { Chat } from '@/models/Chat';
import { generateSwapID } from '@/lib/id';
import { appendSwapToHistory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';
import { syncUserFromAccessToken } from '@/lib/users';
import { buildCorsHeaders } from '@/lib/appUrls';

const corsHeaders = buildCorsHeaders(null);

type RelayWritebackToken = {
  amount?: string | null;
  decimals?: number | null;
  symbol?: string | null;
  contractAddress?: string | null;
  chain?: string | null;
  chainId?: string | number | null;
  walletAddress?: string | null;
  balanceBefore?: string | null;
  balanceAfter?: string | null;
  fees?: {
    gas?: { token?: string | null; amount?: string | null; decimals?: number | null } | null;
    provider?: { token?: string | null; amount?: string | null; decimals?: number | null } | null;
    altair?: { token?: string | null; amount?: string | null; decimals?: number | null } | null;
  } | null;
};

const parseRawAmount = (value: string | null | undefined): bigint | null => {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
};

const isNativeGasTokenForChain = (symbol: string | null, chain: string | null) => {
  const normalizedSymbol = symbol?.trim().toUpperCase() ?? '';
  const normalizedChain = chain?.trim().toUpperCase() ?? '';
  if (!normalizedSymbol || !normalizedChain) return false;
  if (normalizedSymbol === 'SOL') return normalizedChain === 'SOLANA_MAINNET';
  if (normalizedSymbol === 'ETH') return normalizedChain !== 'SOLANA_MAINNET';
  return false;
};

const resolveBridgeProviderFee = (params: {
  intentString: string | null;
  sellToken: RelayWritebackToken;
  buyToken: RelayWritebackToken;
}): { token: string; amount: string; decimals: number | null } | null => {
  const intent = params.intentString?.trim().toUpperCase() ?? '';
  if (intent !== 'BRIDGE_INTENT' && intent !== 'CROSS_CHAIN_SWAP_INTENT') return null;

  const sellSymbol = params.sellToken.symbol?.trim().toUpperCase() ?? '';
  const buySymbol = params.buyToken.symbol?.trim().toUpperCase() ?? '';
  if (!sellSymbol || !buySymbol || sellSymbol !== buySymbol) return null;

  const sellBefore = parseRawAmount(params.sellToken.balanceBefore);
  const buyBefore = parseRawAmount(params.buyToken.balanceBefore);
  const sellAfter = parseRawAmount(params.sellToken.balanceAfter);
  const buyAfter = parseRawAmount(params.buyToken.balanceAfter);
  if (sellBefore === null || buyBefore === null || sellAfter === null || buyAfter === null) return null;

  const beforeTotal = sellBefore + buyBefore;
  const afterTotal = sellAfter + buyAfter;
  let providerFee = beforeTotal - afterTotal;

  if (isNativeGasTokenForChain(sellSymbol, params.sellToken.chain ?? null)) {
    const gasRaw = parseRawAmount(params.sellToken.fees?.gas?.amount ?? null) ?? 0n;
    providerFee += gasRaw;
  }

  if (providerFee < 0n) providerFee = 0n;
  return {
    token: sellSymbol,
    amount: providerFee.toString(),
    decimals:
      typeof params.sellToken.decimals === 'number'
        ? params.sellToken.decimals
        : typeof params.buyToken.decimals === 'number'
          ? params.buyToken.decimals
          : null,
  };
};

export async function POST(req: Request) {
  try {
    const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
    const payload = (await req.json()) as {
      cid?: string | null;
      intentString?: string | null;
      sellToken?: RelayWritebackToken | null;
      buyToken?: RelayWritebackToken | null;
      txHash?: string | null;
      requestId?: string | null;
    };

    const authHeader = req.headers.get('authorization');
    const accessTokenHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = accessTokenHeader ?? cookieToken;
    if (!accessToken) {
      return NextResponse.json({ error: 'Missing Privy access token for relay writeback.' }, { status: 401, headers: corsHeaders });
    }

    if (!payload?.sellToken || !payload?.buyToken) {
      return NextResponse.json({ error: 'Missing sellToken or buyToken payload.' }, { status: 400, headers: corsHeaders });
    }

    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
        target: 'syncUserFromAccessToken',
        description: 'Privy + Mongo user sync',
      },
      () => syncUserFromAccessToken(accessToken, { mode: 'runtime' })
    );

    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for relay writeback',
      },
      () => connectToDatabase()
    );

    const resolvedProviderFee = resolveBridgeProviderFee({
      intentString: payload.intentString ?? null,
      sellToken: payload.sellToken,
      buyToken: payload.buyToken,
    });

    const sellToken = {
      amount: payload.sellToken.amount ?? '',
      decimals: typeof payload.sellToken.decimals === 'number' ? payload.sellToken.decimals : null,
      symbol: payload.sellToken.symbol ?? '',
      contractAddress: payload.sellToken.contractAddress ?? null,
      chain: payload.sellToken.chain ?? '',
      chainId: payload.sellToken.chainId ?? null,
      walletAddress: payload.sellToken.walletAddress ?? null,
      balanceBefore: payload.sellToken.balanceBefore ?? null,
      balanceAfter: payload.sellToken.balanceAfter ?? null,
      fees: {
        gas: {
          token: payload.sellToken.fees?.gas?.token ?? '',
          amount: payload.sellToken.fees?.gas?.amount ?? '',
          decimals: typeof payload.sellToken.fees?.gas?.decimals === 'number' ? payload.sellToken.fees.gas.decimals : null,
        },
        provider: {
          token: resolvedProviderFee?.token ?? payload.sellToken.fees?.provider?.token ?? '',
          amount: resolvedProviderFee?.amount ?? payload.sellToken.fees?.provider?.amount ?? '',
          decimals:
            resolvedProviderFee?.decimals ??
            (typeof payload.sellToken.fees?.provider?.decimals === 'number' ? payload.sellToken.fees.provider.decimals : null),
        },
        altair: {
          token: payload.sellToken.fees?.altair?.token ?? '',
          amount: payload.sellToken.fees?.altair?.amount ?? '',
          decimals: typeof payload.sellToken.fees?.altair?.decimals === 'number' ? payload.sellToken.fees.altair.decimals : null,
        },
      },
    };
    const buyToken = {
      amount: payload.buyToken.amount ?? '',
      decimals: typeof payload.buyToken.decimals === 'number' ? payload.buyToken.decimals : null,
      symbol: payload.buyToken.symbol ?? '',
      contractAddress: payload.buyToken.contractAddress ?? null,
      chain: payload.buyToken.chain ?? '',
      chainId: payload.buyToken.chainId ?? null,
      walletAddress: payload.buyToken.walletAddress ?? null,
      balanceBefore: payload.buyToken.balanceBefore ?? null,
      balanceAfter: payload.buyToken.balanceAfter ?? null,
      fees: {
        gas: {
          token: payload.buyToken.fees?.gas?.token ?? '',
          amount: payload.buyToken.fees?.gas?.amount ?? '',
          decimals: typeof payload.buyToken.fees?.gas?.decimals === 'number' ? payload.buyToken.fees.gas.decimals : null,
        },
        provider: {
          token: payload.buyToken.fees?.provider?.token ?? '',
          amount: payload.buyToken.fees?.provider?.amount ?? '',
          decimals: typeof payload.buyToken.fees?.provider?.decimals === 'number' ? payload.buyToken.fees.provider.decimals : null,
        },
        altair: {
          token: payload.buyToken.fees?.altair?.token ?? '',
          amount: payload.buyToken.fees?.altair?.amount ?? '',
          decimals: typeof payload.buyToken.fees?.altair?.decimals === 'number' ? payload.buyToken.fees.altair.decimals : null,
        },
      },
    };

    const SID = await generateSwapID();

    const swapDoc = {
      SID,
      UID: user.UID,
      CID: payload.cid ?? null,
      provider: 'Relay',
      intentString: payload.intentString ?? null,
      sellToken,
      buyToken,
      txHash: payload.txHash ?? payload.requestId ?? null,
      timestamp: new Date().toISOString(),
    };

    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
        target: 'Swap.create',
        description: 'Mongo relay swap write',
      },
      () => Swap.create(swapDoc)
    );

    if (payload.cid) {
      await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
          target: 'Chat.updateOne',
          description: 'mark chat intent as executed (relay writeback)',
        },
        () =>
          Chat.updateOne(
            { CID: payload.cid, UID: user.UID },
            {
              $set: {
                SID,
                intentString: payload.intentString ?? null,
                intentExecuted: true,
              },
            }
          )
      );
    }

    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
        target: 'appendSwapToHistory',
        description: '0G relay swap history write',
      },
      () =>
        appendSwapToHistory({
          accessToken,
          CID: payload.cid ?? null,
          provider: 'Relay',
          intentString: payload.intentString ?? null,
          sellToken,
          buyToken,
          txHash: payload.txHash ?? payload.requestId ?? 'pending',
        })
    );

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
