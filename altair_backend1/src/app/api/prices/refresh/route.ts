import { NextResponse } from 'next/server';
import { refreshAllTokenPrices } from '@/lib/priceService';
import { buildCorsHeaders } from '@/lib/appUrls';

const corsHeaders = buildCorsHeaders(null);

const SECRET_HEADER = 'x-altair-cron-secret';

const isAuthorized = (req: Request): boolean => {
  const expected = process.env.CRONJOB_ORG_SECRET;
  if (!expected) {
    console.warn('[prices/refresh] CRONJOB_ORG_SECRET is not configured; rejecting all requests');
    return false;
  }
  const provided = req.headers.get(SECRET_HEADER);
  return typeof provided === 'string' && provided === expected;
};

const runRefresh = async (req: Request) => {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: corsHeaders }
    );
  }

  try {
    const result = await refreshAllTokenPrices();
    return NextResponse.json({ ok: true, ...result }, { headers: corsHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[prices/refresh] refresh failed', { error: message });
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
};

// POST is the production entry point used by the scheduler.
export async function POST(req: Request) {
  return runRefresh(req);
}

// GET is allowed for one-button manual runs from an authenticated browser session
// during ops/debugging; same secret check applies.
export async function GET(req: Request) {
  return runRefresh(req);
}
