import { Token } from '@/models/Token';
import { connectToDatabase } from '@/lib/db';
import { withWaitLogger } from '@/lib/waitLogger';

/**
 * Math for back-filling an approximate USD price on a buyToken when it's first
 * recorded via a swap. Assumes the swap traded roughly equal USD value across
 * the two sides (slippage + fees ignored — this is an approximation that gets
 * overwritten by the next periodic CoinGecko poll, typically within 5 minutes).
 *
 * The sellToken's stored price is the anchor; we read it from the `tokens`
 * collection. If the sellToken has no stored price (rare — would only happen
 * on a user's very first swap involving a token they got from a non-swap
 * source), we return null and the caller skips the back-fill.
 */

export interface ApproxPriceInput {
  sellMint: string;
  sellAmountRaw: string; // BigInt-parseable raw amount (no decimals applied)
  sellDecimals: number;
  buyAmountRaw: string;
  buyDecimals: number;
}

export interface ApproxPriceResult {
  price: number;
  /** Lineage tag — copied from sellToken's priceInfo.source so chained derivations stay traceable. */
  priceInfoSource: string;
}

/**
 * buyPrice ≈ (sellAmount * sellPrice) / buyAmount
 * Computed in actual (decimals-applied) units, so the formula is unit-correct USD per buyToken.
 */
export async function computeApproxBuyPrice(input: ApproxPriceInput): Promise<ApproxPriceResult | null> {
  if (!input.sellMint || !input.sellMint.trim()) return null;
  if (!Number.isFinite(input.sellDecimals) || !Number.isFinite(input.buyDecimals)) return null;

  let sellRaw: bigint;
  let buyRaw: bigint;
  try {
    sellRaw = BigInt(input.sellAmountRaw);
    buyRaw = BigInt(input.buyAmountRaw);
  } catch {
    return null;
  }
  if (sellRaw <= 0n || buyRaw <= 0n) return null;

  await connectToDatabase();
  const sellDoc = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/priceMath.ts',
      target: 'Token.findOne (sellToken price lookup)',
      description: `read sellToken price for approx back-fill: ${input.sellMint}`,
    },
    () =>
      Token.findOne(
        { mint: input.sellMint.trim() },
        { price: 1, priceInfo: 1 }
      ).lean<{ price?: number | null; priceInfo?: { source?: string | null } | null } | null>()
  );

  if (!sellDoc || typeof sellDoc.price !== 'number' || !Number.isFinite(sellDoc.price) || sellDoc.price <= 0) {
    return null;
  }

  const sellAmountActual = Number(sellRaw) / Math.pow(10, input.sellDecimals);
  const buyAmountActual = Number(buyRaw) / Math.pow(10, input.buyDecimals);
  if (!Number.isFinite(sellAmountActual) || !Number.isFinite(buyAmountActual)) return null;
  if (sellAmountActual <= 0 || buyAmountActual <= 0) return null;

  const buyPrice = (sellAmountActual * sellDoc.price) / buyAmountActual;
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) return null;

  // Lineage: if sellToken's priceInfo.source is recorded, copy it. Otherwise the
  // sellToken's price was set by the periodic CoinGecko refresher and has no
  // priceInfo yet (priceInfo is null until the second poll). In that case we
  // tag the lineage as 'coingecko' since that is the only other writer of price.
  const priceInfoSource =
    typeof sellDoc.priceInfo?.source === 'string' && sellDoc.priceInfo.source.trim()
      ? sellDoc.priceInfo.source
      : 'coingecko';

  return { price: buyPrice, priceInfoSource };
}

/**
 * Atomically set `price` + `priceInfo` on a token ONLY when its current `price`
 * is null/missing. This back-fills an approximation for a buyToken that was
 * just added by the registry, without ever overwriting a real price already
 * written by the periodic CoinGecko refresher.
 *
 * priceInfo.lastPrice is intentionally left null — there is no prior price to
 * record; this is the token's first observed price.
 */
export async function setPriceIfMissing(params: {
  mint: string;
  price: number;
  priceInfoSource: string;
}): Promise<{ updated: boolean }> {
  const mint = params.mint?.trim();
  if (!mint) return { updated: false };
  if (!Number.isFinite(params.price) || params.price <= 0) return { updated: false };

  await connectToDatabase();
  const now = new Date();
  try {
    const result = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/priceMath.ts',
        target: 'Token.updateOne (back-fill price if missing)',
        description: `set approx price for ${mint} if currently null`,
      },
      () =>
        Token.updateOne(
          { mint, $or: [{ price: null }, { price: { $exists: false } }] },
          {
            $set: {
              price: params.price,
              priceInfo: {
                lastPrice: null,
                updatedAt: now,
                source: params.priceInfoSource,
              },
            },
          }
        )
    );
    const updated = (result.modifiedCount ?? 0) > 0;
    if (updated) {
      console.log('[priceMath] back-filled approximate price', {
        mint,
        price: params.price,
        source: params.priceInfoSource,
      });
    }
    return { updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[priceMath] setPriceIfMissing failed', { mint, error: message });
    return { updated: false };
  }
}
