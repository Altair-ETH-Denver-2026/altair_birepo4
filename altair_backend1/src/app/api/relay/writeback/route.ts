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
import { type BalanceEntry, updateBalancesInMongoDB } from '@/lib/balanceService';
import { CHAINS, type ChainKey } from '../../../../../config/blockchain_config';
import { computeFeeAmount } from '@/lib/feeResolver';

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
    gas?: {
      token?: string | null;
      amount?: string | null;
      decimals?: number | null;
      balanceBefore?: string | null;
      balanceAfter?: string | null;
    } | null;
    provider?: { token?: string | null; amount?: string | null; decimals?: number | null } | null;
    altair?: { token?: string | null; amount?: string | null; decimals?: number | null; bps?: number | null } | null;
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

const normalizeChainKey = (value: string | null | undefined): ChainKey | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase();
  if (!key) return null;
  return key in CHAINS ? (key as ChainKey) : null;
};

/**
 * Polls GET /intents/status/v3 until the Relay request reaches a terminal state,
 * then fetches GET /requests/v2?id=<requestId> to read the actual delivered amount
 * from outTxs[0].data.value.
 *
 * Returns the confirmed raw buy amount string, or null if unavailable / timed-out.
 */
const pollRelayForConfirmedBuyAmount = async (requestId: string): Promise<string | null> => {
  const POLL_INTERVAL_MS = 2_000;
  const MAX_POLL_MS = 60_000;
  const TERMINAL_STATUSES = new Set(['success', 'failure', 'refunded']);

  const deadline = Date.now() + MAX_POLL_MS;

  // Poll status until terminal or timeout
  let finalStatus: string | null = null;
  while (Date.now() < deadline) {
    try {
      const statusRes = await fetch(
        `https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(requestId)}`,
        { headers: { 'Content-Type': 'application/json' } }
      );
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as { status?: string };
        const status = statusData?.status ?? '';
        console.log('[relay/writeback] Relay status poll', { requestId, status });
        if (TERMINAL_STATUSES.has(status)) {
          finalStatus = status;
          break;
        }
      }
    } catch (err) {
      console.warn('[relay/writeback] Relay status poll error', { requestId, err });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (finalStatus !== 'success') {
    console.warn('[relay/writeback] Relay did not reach success status within timeout', {
      requestId,
      finalStatus,
    });
    return null;
  }

  // Fetch the confirmed delivered amount from GET /requests/v2
  try {
    const reqRes = await fetch(
      `https://api.relay.link/requests/v2?id=${encodeURIComponent(requestId)}`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    if (!reqRes.ok) {
      console.warn('[relay/writeback] GET /requests/v2 failed', { requestId, status: reqRes.status });
      return null;
    }
    const reqData = (await reqRes.json()) as {
      requests?: {
        data?: {
          outTxs?: Array<{ data?: { value?: string } }>;
        };
      };
    };
    const value = reqData?.requests?.data?.outTxs?.[0]?.data?.value;
    if (typeof value === 'string' && value.trim().length > 0) {
      // Validate it's a parseable integer string
      try {
        BigInt(value.trim());
        console.log('[relay/writeback] Confirmed Relay buy amount from outTxs', { requestId, value });
        return value.trim();
      } catch {
        console.warn('[relay/writeback] outTxs value is not a valid integer', { requestId, value });
      }
    }
  } catch (err) {
    console.warn('[relay/writeback] GET /requests/v2 fetch error', { requestId, err });
  }

  return null;
};

const toBalanceEntryFromRelayToken = (params: {
  token: RelayWritebackToken;
  chainKey: ChainKey;
}): { symbol: string; entry: BalanceEntry } | null => {
  const symbol = params.token.symbol?.trim().toUpperCase() ?? '';
  const balanceAfter = params.token.balanceAfter?.trim() ?? '';
  if (!symbol || !balanceAfter) return null;

  const isSolana = params.chainKey === 'SOLANA_MAINNET' || params.chainKey === 'SOLANA_DEVNET';
  const decimals = typeof params.token.decimals === 'number'
    ? params.token.decimals
    : (isSolana ? 9 : 18);
  const address = typeof params.token.contractAddress === 'string' ? params.token.contractAddress.trim() : '';

  return {
    symbol,
    entry: {
      symbol,
      balance: balanceAfter,
      decimals,
      name: symbol,
      address,
      source: 'blockchain',
      verifiedAt: Date.now(),
    },
  };
};

export async function POST(req: Request) {
  try {
    console.log('[relay/writeback] Received writeback request');
    const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
    const payload = (await req.json()) as {
      cid?: string | null;
      intentString?: string | null;
      sellToken?: RelayWritebackToken | null;
      buyToken?: RelayWritebackToken | null;
      txHash?: string | null;
      requestId?: string | null;
      _altairFee?: {
        token: string;
        amount: string | null;
        decimals: number | null;
        bps: number;
      } | null;
    };

    console.log('[relay/writeback] Payload received', {
      hasSellToken: !!payload?.sellToken,
      hasBuyToken: !!payload?.buyToken,
      hasRequestId: !!payload?.requestId,
      intentString: payload?.intentString,
    });

    const authHeader = req.headers.get('authorization');
    const accessTokenHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const accessToken = accessTokenHeader ?? cookieToken;
    if (!accessToken) {
      console.error('[relay/writeback] Missing access token');
      return NextResponse.json({ error: 'Missing Privy access token for relay writeback.' }, { status: 401, headers: corsHeaders });
    }

    if (!payload?.sellToken || !payload?.buyToken) {
      console.error('[relay/writeback] Missing sellToken or buyToken');
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

    // --- Altair fee computation (EARLY) ---
    // Declare this early so it can be used in sellToken/buyToken construction
    // Will be populated after confirmed buy amount is resolved
    let resolvedAltairFee: { token: string; amount: string; decimals: number | null; bps: number } | null = null;

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
          token: resolvedAltairFee?.token ?? payload.sellToken.fees?.altair?.token ?? '',
          amount: resolvedAltairFee?.amount ?? payload.sellToken.fees?.altair?.amount ?? '',
          decimals: resolvedAltairFee?.decimals ?? (typeof payload.sellToken.fees?.altair?.decimals === 'number' ? payload.sellToken.fees.altair.decimals : null),
          bps: resolvedAltairFee?.bps ?? payload.sellToken.fees?.altair?.bps ?? null,
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
          token: resolvedAltairFee?.token ?? payload.buyToken.fees?.altair?.token ?? '',
          amount: resolvedAltairFee?.amount ?? payload.buyToken.fees?.altair?.amount ?? '',
          decimals: resolvedAltairFee?.decimals ?? (typeof payload.buyToken.fees?.altair?.decimals === 'number' ? payload.buyToken.fees.altair.decimals : null),
          bps: resolvedAltairFee?.bps ?? payload.buyToken.fees?.altair?.bps ?? null,
        },
      },
    };

    // --- Confirmed buy amount resolution via Relay GET /requests/v2 ---
    // Poll Relay's status API until the request reaches a terminal state, then
    // read the actual delivered amount from outTxs[0].data.value.  This replaces
    // the pre-execution quote estimate with the blockchain-confirmed value.
    const requestId = payload.requestId?.trim() ?? null;
    let confirmedBuyAmountRaw: string | null = null;
    if (requestId) {
      confirmedBuyAmountRaw = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
          target: 'pollRelayForConfirmedBuyAmount',
          description: 'poll Relay status + fetch confirmed buy amount',
        },
        () => pollRelayForConfirmedBuyAmount(requestId)
      );
    }

    // If we got a confirmed amount, override buyToken.amount and recompute
    // buyToken.balanceAfter using the same gas-correction logic the frontend uses.
    if (confirmedBuyAmountRaw !== null) {
      buyToken.amount = confirmedBuyAmountRaw;

      // Recompute balanceAfter: buyBalanceBefore + confirmedBuyAmount - gasFee (if buy = gas token)
      const buySymbolForGasCheck = buyToken.symbol?.trim().toUpperCase() ?? '';
      const gasTokenSymbolForCheck = sellToken.fees?.gas?.token?.trim().toUpperCase() ?? '';
      const gasIsGasBuy = buySymbolForGasCheck === gasTokenSymbolForCheck && gasTokenSymbolForCheck !== '';

      const buyBalanceBeforeRaw = buyToken.balanceBefore?.trim() ?? '';
      const gasFeeRaw = parseRawAmount(sellToken.fees?.gas?.amount ?? null) ?? 0n;

      if (buyBalanceBeforeRaw) {
        try {
          const before = BigInt(buyBalanceBeforeRaw);
          const amount = BigInt(confirmedBuyAmountRaw);
          const gas = gasIsGasBuy ? gasFeeRaw : 0n;
          const after = before + amount - gas;
          buyToken.balanceAfter = (after >= 0n ? after : 0n).toString();
          console.log('[relay/writeback] Recomputed buyToken.balanceAfter from confirmed amount', {
            requestId,
            confirmedBuyAmountRaw,
            buyBalanceBeforeRaw,
            gasFeeRaw: gasFeeRaw.toString(),
            gasIsGasBuy,
            buyBalanceAfter: buyToken.balanceAfter,
          });
        } catch (err) {
          console.warn('[relay/writeback] Failed to recompute buyToken.balanceAfter', { err });
        }
      }
    }

    // --- Altair fee computation (POPULATE) ---
    // The fee is deducted from the buy token (output) by Relay.
    // Compute it from the (possibly confirmed) buy amount.
    if (payload._altairFee && payload._altairFee.bps > 0) {
      const buyAmountForFee = confirmedBuyAmountRaw ?? buyToken.amount;
      const feeAmount = computeFeeAmount(buyAmountForFee, payload._altairFee.bps);
      if (feeAmount !== '0') {
        resolvedAltairFee = {
          token: payload._altairFee.token || buyToken.symbol || '',
          amount: feeAmount,
          decimals: payload._altairFee.decimals ?? buyToken.decimals,
          bps: payload._altairFee.bps,
        };
        console.log('[relay/writeback] Computed Altair fee', {
          buyAmountForFee,
          feeBps: payload._altairFee.bps,
          feeAmount,
          resolvedAltairFee,
        });
      }
    }

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

    const sellChainKey = normalizeChainKey(sellToken.chain);
    
    // If sellToken.balanceAfter is null, try to compute it from balanceBefore - amount - gas
    if (sellChainKey && !sellToken.balanceAfter && sellToken.balanceBefore && sellToken.amount) {
      try {
        const before = BigInt(sellToken.balanceBefore);
        const amount = BigInt(sellToken.amount);
        const gasRaw = parseRawAmount(sellToken.fees?.gas?.amount ?? null) ?? 0n;
        const sellSymbol = sellToken.symbol?.trim().toUpperCase() ?? '';
        const gasSymbol = sellToken.fees?.gas?.token?.trim().toUpperCase() ?? '';
        const gasIsGasSell = sellSymbol === gasSymbol && gasSymbol !== '';
        const gas = gasIsGasSell ? gasRaw : 0n;
        const after = before - amount - gas;
        sellToken.balanceAfter = (after >= 0n ? after : 0n).toString();
        console.log('[relay/writeback] Computed sellToken.balanceAfter', {
          before: sellToken.balanceBefore,
          amount: sellToken.amount,
          gas: gas.toString(),
          after: sellToken.balanceAfter,
        });
      } catch (err) {
        console.warn('[relay/writeback] Failed to compute sellToken.balanceAfter', { err });
      }
    }
    
    const sellBalanceEntry = sellChainKey
      ? toBalanceEntryFromRelayToken({ token: sellToken, chainKey: sellChainKey })
      : null;
    if (sellChainKey && sellBalanceEntry) {
      try {
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
            target: 'updateBalancesInMongoDB(sellToken)',
            description: 'relay durable sell-token balance persistence',
          },
          () => updateBalancesInMongoDB(user.UID, sellChainKey, { [sellBalanceEntry.symbol]: sellBalanceEntry.entry }, 'blockchain')
        );
      } catch (err) {
        console.warn('[relay/writeback] sell-token balance persistence failed', {
          uid: user.UID,
          chain: sellChainKey,
          symbol: sellBalanceEntry.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Get gas token info early for use in buy token correction
    const gasSymbol = payload.sellToken.fees?.gas?.token?.trim().toUpperCase() ?? '';
    const gasBalanceAfter = payload.sellToken.fees?.gas?.balanceAfter?.trim() ?? '';
    const gasBalanceBefore = payload.sellToken.fees?.gas?.balanceBefore?.trim() ?? '';
    const gasAmount = payload.sellToken.fees?.gas?.amount?.trim() ?? '';
    const gasDecimals = typeof payload.sellToken.fees?.gas?.decimals === 'number'
      ? payload.sellToken.fees?.gas?.decimals
      : null;
    const sellSymbolNormalized = sellToken.symbol?.trim().toUpperCase() ?? '';
    const buySymbolNormalized = buyToken.symbol?.trim().toUpperCase() ?? '';

    const buyChainKey = normalizeChainKey(buyToken.chain);
    const buyBalanceEntry = buyChainKey
      ? toBalanceEntryFromRelayToken({ token: buyToken, chainKey: buyChainKey })
      : null;

    // Persist buy-token balance. When a confirmed buy amount was resolved from
    // Relay's GET /requests/v2, buyToken.balanceAfter has already been recomputed
    // above using the confirmed amount + gas-correction. Otherwise it falls back
    // to the frontend-computed estimate.
    if (buyChainKey && buyBalanceEntry) {
      try {
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
            target: 'updateBalancesInMongoDB(buyToken)',
            description: 'relay durable buy-token balance persistence',
          },
          () => updateBalancesInMongoDB(user.UID, buyChainKey, { [buyBalanceEntry.symbol]: buyBalanceEntry.entry }, 'blockchain')
        );
      } catch (err) {
        console.warn('[relay/writeback] buy-token balance persistence failed', {
          uid: user.UID,
          chain: buyChainKey,
          symbol: buyBalanceEntry.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (sellChainKey && gasSymbol && gasBalanceAfter && gasSymbol !== sellSymbolNormalized && gasSymbol !== buySymbolNormalized) {
      try {
        const gasEntry: BalanceEntry = {
          symbol: gasSymbol,
          balance: gasBalanceAfter,
          decimals: gasDecimals ?? (sellChainKey === 'SOLANA_MAINNET' || sellChainKey === 'SOLANA_DEVNET' ? 9 : 18),
          name: gasSymbol,
          address: '',
          source: 'blockchain',
          verifiedAt: Date.now(),
        };
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/relay/writeback/route.ts',
            target: 'updateBalancesInMongoDB(gasToken)',
            description: 'relay durable gas-token balance persistence',
          },
          () => updateBalancesInMongoDB(user.UID, sellChainKey, { [gasSymbol]: gasEntry }, 'blockchain')
        );
      } catch (err) {
        console.warn('[relay/writeback] gas-token balance persistence failed', {
          uid: user.UID,
          chain: sellChainKey,
          symbol: gasSymbol,
          balanceBefore: gasBalanceBefore || null,
          balanceAfter: gasBalanceAfter || null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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

    // Construct balanceUpdates for frontend immediate UI update.
    // buyToken.balanceAfter has been overridden with the confirmed amount from Relay's
    // GET /requests/v2 (when available), so buyBalanceEntry reflects the true on-chain value.
    const balanceUpdates = [];

    if (sellChainKey && sellBalanceEntry) {
      balanceUpdates.push({
        chain: sellChainKey,
        symbol: sellBalanceEntry.symbol,
        balanceAfterRaw: sellBalanceEntry.entry.balance,
        decimals: sellBalanceEntry.entry.decimals,
      });
    }

    if (buyChainKey && buyBalanceEntry) {
      balanceUpdates.push({
        chain: buyChainKey,
        symbol: buyBalanceEntry.symbol,
        balanceAfterRaw: buyBalanceEntry.entry.balance,
        decimals: buyBalanceEntry.entry.decimals,
      });
    }

    // Add standalone gas token update when gas token is different from sell and buy tokens.
    // The frontend computes gasBalanceAfter as gasBalanceBefore - gasFee in this case.
    if (sellChainKey && gasSymbol && gasBalanceAfter && gasSymbol !== sellSymbolNormalized && gasSymbol !== buySymbolNormalized) {
      balanceUpdates.push({
        chain: sellChainKey,
        symbol: gasSymbol,
        balanceAfterRaw: gasBalanceAfter,
        decimals: gasDecimals ?? (sellChainKey === 'SOLANA_MAINNET' || sellChainKey === 'SOLANA_DEVNET' ? 9 : 18),
      });
    }

    console.log('[relay/writeback] Success, returning balanceUpdates', { count: balanceUpdates.length });
    return NextResponse.json({ ok: true, balanceUpdates }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    console.error('[relay/writeback] Error', { message, error });
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
