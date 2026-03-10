import { NextResponse } from 'next/server';
import {
  RELAY_API_KEY,
  resolveRelayApiUrl,
  type RelayQuoteRequest,
  type RelayQuoteResponse,
} from '../../../../../config/relay_config';
import { withWaitLogger } from '@/lib/waitLogger';
import { buildCorsHeaders } from '@/lib/appUrls';

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
          body: JSON.stringify(payload),
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
    return NextResponse.json(data, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
