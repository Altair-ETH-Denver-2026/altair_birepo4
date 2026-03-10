import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectToDatabase } from '@/lib/db';
import { Swap } from '@/models/Swap';
import { generateSwapID } from '@/lib/id';
import { appendSwapToHistory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';
import { syncUserFromAccessToken } from '@/lib/users';
import { buildCorsHeaders } from '@/lib/appUrls';

const corsHeaders = buildCorsHeaders(null);

type RelayWritebackToken = {
  amount?: string | null;
  symbol?: string | null;
  contractAddress?: string | null;
  chain?: string | null;
  chainId?: string | number | null;
  walletAddress?: string | null;
  balanceBefore?: string | null;
  balanceAfter?: string | null;
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
      () => syncUserFromAccessToken(accessToken)
    );

    await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for relay writeback',
      },
      () => connectToDatabase()
    );

    const sellToken = {
      amount: payload.sellToken.amount ?? '',
      symbol: payload.sellToken.symbol ?? '',
      contractAddress: payload.sellToken.contractAddress ?? null,
      chain: payload.sellToken.chain ?? '',
      chainId: payload.sellToken.chainId ?? null,
      walletAddress: payload.sellToken.walletAddress ?? null,
      balanceBefore: payload.sellToken.balanceBefore ?? null,
      balanceAfter: payload.sellToken.balanceAfter ?? null,
    };
    const buyToken = {
      amount: payload.buyToken.amount ?? '',
      symbol: payload.buyToken.symbol ?? '',
      contractAddress: payload.buyToken.contractAddress ?? null,
      chain: payload.buyToken.chain ?? '',
      chainId: payload.buyToken.chainId ?? null,
      walletAddress: payload.buyToken.walletAddress ?? null,
      balanceBefore: payload.buyToken.balanceBefore ?? null,
      balanceAfter: payload.buyToken.balanceAfter ?? null,
    };

    const swapDoc = {
      SID: await generateSwapID(),
      UID: user.UID,
      CID: payload.cid ?? null,
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
