import { NextResponse } from 'next/server';
import { refreshAllTokenPrices } from '@/lib/priceService';
import { buildCorsHeaders } from '@/lib/appUrls';

/**
 * Page-mount forced refresh endpoint. The frontend gates whether to call this
 * via `PRICE_RULES.fetchAllConditions.refresh`; when called, this endpoint always
 * triggers a full price pull regardless of timing source (setInterval or
 * cron-job.org) and regardless of staleness.
 *
 * Concurrent calls are collapsed by the in-flight Promise guard inside
 * `refreshAllTokenPrices`, so multiple rapid page mounts trigger only one
 * actual CoinGecko fetch cycle.
 *
 * No auth — abuse cost is bounded by the in-flight guard.
 */
const handle = async (req: Request) => {
  const requestOrigin = req.headers.get('origin');
  const corsHeaders = buildCorsHeaders(requestOrigin);

  try {
    const result = await refreshAllTokenPrices();
    return NextResponse.json({ ok: true, ...result }, { headers: corsHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[prices/check-freshness] refresh failed', { error: message });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
};

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

export async function OPTIONS(req: Request) {
  const requestOrigin = req.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: buildCorsHeaders(requestOrigin) });
}
