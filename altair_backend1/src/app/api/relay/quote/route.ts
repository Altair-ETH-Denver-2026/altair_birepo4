import { NextResponse } from 'next/server';
import {
  RELAY_API_KEY,
  resolveRelayApiUrl,
  type RelayQuoteRequest,
  type RelayQuoteResponse,
} from '../../../../../config/relay_config';
import { withWaitLogger } from '@/lib/waitLogger';
import { buildCorsHeaders } from '@/lib/appUrls';
import { resolveFeePct, pctToBps, resolveRelayFeeRecipient } from '@/lib/feeResolver';

const corsHeaders = buildCorsHeaders(null);

export async function POST(req: Request) {
  try {
    const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
    const payload = (await req.json()) as RelayQuoteRequest;
    if (!payload?.user || !payload.originChainId || !payload.destinationChainId) {
      return NextResponse.json({ error: 'Missing required Relay quote fields.' }, { status: 400, headers: corsHeaders });
    }

    const relayApiUrl = resolveRelayApiUrl({
      originChainId: payload.originChainId,
      destinationChainId: payload.destinationChainId,
    });
    console.log('[Relay] relayApiUrl', relayApiUrl);

    // Resolve Altair fee for Relay
    const feePct = resolveFeePct({ action: 'crossChainSwap', platform: 'Relay', chainType: 'BRIDGING' });
    let appFees: Array<{ recipient: string; fee: string; currency: string }> | undefined;
    let altairFeeMeta: { token: string; amount: string | null; decimals: number | null; bps: number } | null = null;

    if (feePct !== null && feePct > 0) {
      const feeRecipient = resolveRelayFeeRecipient();
      const feeBps = pctToBps(feePct); // e.g., 0.5 → 50
      if (feeRecipient) {
        // The fee currency is the ORIGIN currency (sell token on origin chain)
        // Relay's docs: "for cross-chain swaps the fee is calculated based on the solver's deposit currency on the origin chain"
        // Parameter is "fee" (in basis points), not "amount"
        appFees = [{
          recipient: feeRecipient,
          fee: String(feeBps),
          currency: payload.originCurrency,
        }];
        altairFeeMeta = {
          token: payload.originCurrency,
          amount: null, // will be computed in writeback from confirmed buy amount
          decimals: null,
          bps: feeBps,
        };
        console.log('[Relay] Injecting appFees', { appFees, altairFeeMeta });
      }
    }

    // Add appFees to the forwarded payload
    const relayPayload = {
      ...payload,
      ...(appFees ? { appFees } : {}),
    };

    const response = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/relay/quote/route.ts',
        target: 'relay quote',
        description: 'Relay quote request',
      },
      () =>
        fetch(`${relayApiUrl}/quote/v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(RELAY_API_KEY ? { Authorization: `Bearer ${RELAY_API_KEY}` } : {}),
          },
          body: JSON.stringify(relayPayload),
        })
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Relay quote failed: ${errorText}` },
        { status: 502, headers: corsHeaders }
      );
    }

    const data = (await response.json()) as RelayQuoteResponse;
    
    // Attach Altair fee metadata for writeback propagation
    const responseWithFee: RelayQuoteResponse = {
      ...data,
      _altairFee: altairFeeMeta,
    };

    return NextResponse.json(responseWithFee, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
