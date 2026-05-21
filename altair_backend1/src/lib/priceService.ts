import { Token } from '@/models/Token';
import { connectToDatabase } from '@/lib/db';
import { withWaitLogger } from '@/lib/waitLogger';
import { fetchPricesForPlatform, type CoinGeckoPriceEntry } from '@/lib/coinGecko';
import { COINGECKO_ASSET_PLATFORMS } from '../../config/coinGecko_config';
import { CHAINS, PRICE_RULES, type ChainKey } from '../../config/blockchain_config';

const PRICE_SOURCE = 'coingecko';

interface TokenLean {
  mint: string;
  chain: string | null | undefined;
  price: number | null | undefined;
  gasToken?: boolean | null;
  wrappedProxy?: { symbol?: string | null; address?: string | null } | null;
}

/**
 * The on-chain address used to fetch this token's price from CoinGecko.
 * For gasToken=true rows with a wrappedProxy, this is the wrapped contract's
 * address (CoinGecko has no row for native ETH; WETH proxies it). For all other
 * rows it's just the token's own mint.
 */
const resolveLookupAddress = (chain: ChainKey, token: TokenLean): string => {
  if (token.gasToken && token.wrappedProxy?.address) {
    return normalizeAddressForChain(chain, token.wrappedProxy.address);
  }
  return normalizeAddressForChain(chain, token.mint);
};

interface PerChainCounts {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface RefreshAllTokenPricesResult {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  byChain: Record<string, PerChainCounts>;
}

const isPricedChain = (chain: string | null | undefined): chain is ChainKey => {
  if (typeof chain !== 'string') return false;
  if (!(chain in CHAINS)) return false;
  return COINGECKO_ASSET_PLATFORMS[chain as ChainKey] !== undefined;
};

const normalizeAddressForChain = (chain: ChainKey, address: string): string => {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (chain === 'SOLANA_MAINNET' || chain === 'SOLANA_DEVNET') return trimmed;
  return trimmed.toLowerCase();
};

const emptyChainCounts = (): PerChainCounts => ({ scanned: 0, updated: 0, skipped: 0, failed: 0 });

// Collapse concurrent triggers (cron + boot + page-mount) into a single in-flight run.
let refreshInFlight: Promise<RefreshAllTokenPricesResult> | null = null;

/**
 * Periodic price refresh job. Loads every token in the `tokens` collection whose
 * `chain` is a mainnet CoinGecko-supported chain, fetches USD prices in batches,
 * and writes back to MongoDB.
 *
 * Per-token write rules:
 *  - If CoinGecko returned the same `usd` value already stored → no price write,
 *    but `priceInfo.updatedAt` is still bumped (batched) so staleness checks stay valid.
 *  - Else `price` is updated and `priceInfo` is overwritten with the snapshot of
 *    the value being replaced (`null` on first-ever write).
 *
 * Concurrent callers (cron + boot + page-mount) share a single in-flight Promise.
 */
export function refreshAllTokenPrices(): Promise<RefreshAllTokenPricesResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshAllTokenPrices().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshAllTokenPrices(): Promise<RefreshAllTokenPricesResult> {
  const startedAt = new Date();
  console.log('[priceService] refreshAllTokenPrices started', {
    startedAt: startedAt.toISOString(),
  });

  await connectToDatabase();

  const tokens = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/priceService.ts',
      target: 'Token.find',
      description: 'load all tokens for price refresh',
    },
    () =>
      Token.find(
        {},
        { mint: 1, chain: 1, price: 1, gasToken: 1, wrappedProxy: 1 }
      ).lean<TokenLean[]>()
  );

  const result: RefreshAllTokenPricesResult = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    byChain: {},
  };

  const tokensByChain = new Map<ChainKey, TokenLean[]>();
  for (const token of tokens) {
    if (!isPricedChain(token.chain)) continue;
    const chain = token.chain as ChainKey;
    if (!tokensByChain.has(chain)) tokensByChain.set(chain, []);
    tokensByChain.get(chain)!.push(token);
  }

  for (const [chain, chainTokens] of tokensByChain.entries()) {
    const counts = emptyChainCounts();
    result.byChain[chain] = counts;
    counts.scanned = chainTokens.length;
    result.scanned += chainTokens.length;

    const platform = COINGECKO_ASSET_PLATFORMS[chain];
    if (!platform) continue;

    // Multi-map so a single CoinGecko response can fan out to multiple rows
    // (e.g., WETH's price applies to both the WETH row and the native-ETH row
    // whose wrappedProxy points at WETH).
    const tokensByLookupAddress = new Map<string, TokenLean[]>();
    for (const token of chainTokens) {
      const lookupAddress = resolveLookupAddress(chain, token);
      if (!lookupAddress) continue;
      const bucket = tokensByLookupAddress.get(lookupAddress);
      if (bucket) bucket.push(token);
      else tokensByLookupAddress.set(lookupAddress, [token]);
    }

    const uniqueLookupAddresses = Array.from(tokensByLookupAddress.keys());

    let entries: CoinGeckoPriceEntry[] = [];
    try {
      entries = await fetchPricesForPlatform({
        platform,
        contractAddresses: uniqueLookupAddresses,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[priceService] fetchPricesForPlatform failed', { chain, platform, error: message });
      counts.failed = chainTokens.length;
      result.failed += chainTokens.length;
      continue;
    }

    // Mints whose price was unchanged this poll — still want priceInfo.updatedAt
    // bumped so staleness checks don't false-positive into another fetch loop.
    const skippedMints: string[] = [];

    for (const entry of entries) {
      const lookupAddress = normalizeAddressForChain(chain, entry.contractAddress);
      const matchedDocs = tokensByLookupAddress.get(lookupAddress) ?? [];
      if (matchedDocs.length === 0) continue;

      for (const doc of matchedDocs) {
        const priorPrice = typeof doc.price === 'number' && Number.isFinite(doc.price) ? doc.price : null;
        if (priorPrice !== null && priorPrice === entry.usd) {
          skippedMints.push(doc.mint);
          counts.skipped += 1;
          result.skipped += 1;
          continue;
        }

        const now = new Date();
        // priorPrice is null on a token's first successful poll. Keep priceInfo
        // populated regardless so the source/lineage tag is never lost — only
        // lastPrice is allowed to be null in that case.
        const update = {
          $set: {
            price: entry.usd,
            priceInfo: { lastPrice: priorPrice, updatedAt: now, source: PRICE_SOURCE },
          },
        };

        try {
          const writeResult = await withWaitLogger(
            {
              file: 'altair_backend1/src/lib/priceService.ts',
              target: 'Token.updateOne',
              description: `write price for ${doc.mint} on ${chain}`,
            },
            () => Token.updateOne({ mint: doc.mint }, update)
          );

          if (writeResult.matchedCount > 0) {
            counts.updated += 1;
            result.updated += 1;
          } else {
            counts.failed += 1;
            result.failed += 1;
            console.warn('[priceService] updateOne matched zero docs', { mint: doc.mint, chain });
          }
        } catch (err) {
          counts.failed += 1;
          result.failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          console.error('[priceService] updateOne failed', { mint: doc.mint, chain, error: message });
        }
      }
    }

    if (skippedMints.length > 0) {
      try {
        const now = new Date();
        await withWaitLogger(
          {
            file: 'altair_backend1/src/lib/priceService.ts',
            target: 'Token.updateMany',
            description: `bump priceInfo.updatedAt for ${skippedMints.length} unchanged tokens on ${chain}`,
          },
          () =>
            Token.updateMany(
              { mint: { $in: skippedMints } },
              {
                $set: {
                  'priceInfo.updatedAt': now,
                  'priceInfo.source': PRICE_SOURCE,
                },
              }
            )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[priceService] updateMany (skipped priceInfo.updatedAt) failed', { chain, error: message });
      }
    }
  }

  const finishedAt = new Date();
  console.log('[priceService] refreshAllTokenPrices complete', {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...result,
  });
  return result;
}

/**
 * Most recent `priceInfo.updatedAt` across the entire `tokens` collection, or
 * null if no token has a priceInfo subdoc yet. Used as the staleness signal so
 * we don't need a dedicated "last successful run" canary doc.
 */
export async function getMaxPriceUpdatedAt(): Promise<Date | null> {
  await connectToDatabase();
  const doc = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/priceService.ts',
      target: 'Token.findOne(priceInfo.updatedAt)',
      description: 'find newest priceInfo.updatedAt across tokens',
    },
    () =>
      Token.findOne(
        { 'priceInfo.updatedAt': { $ne: null } },
        { 'priceInfo.updatedAt': 1 }
      )
        .sort({ 'priceInfo.updatedAt': -1 })
        .lean<{ priceInfo?: { updatedAt?: Date | null } | null } | null>()
  );
  return doc?.priceInfo?.updatedAt ?? null;
}

/**
 * True if the newest `priceInfo.updatedAt` is older than the configured period
 * (or if nothing has been recorded yet).
 */
export async function isPriceDataStale(): Promise<boolean> {
  const maxPriceUpdatedAt = await getMaxPriceUpdatedAt();
  if (!maxPriceUpdatedAt) return true;
  const periodMs = PRICE_RULES.fetchAllConditions.periodically * 60_000;
  return Date.now() - maxPriceUpdatedAt.getTime() > periodMs;
}

export interface RefreshPricesIfStaleResult {
  triggered: boolean;
  maxPriceUpdatedAt: Date | null;
  result: RefreshAllTokenPricesResult | null;
}

/**
 * Triggers a refresh only if price data is stale per `PRICE_RULES.fetchAllConditions.periodically`.
 * Safe to call from multiple entry points (server boot, page mount, manual ping) —
 * the in-flight guard inside `refreshAllTokenPrices` collapses concurrent runs.
 */
export async function refreshPricesIfStale(): Promise<RefreshPricesIfStaleResult> {
  const maxPriceUpdatedAt = await getMaxPriceUpdatedAt();
  const periodMs = PRICE_RULES.fetchAllConditions.periodically * 60_000;
  const stale = !maxPriceUpdatedAt || Date.now() - maxPriceUpdatedAt.getTime() > periodMs;

  if (!stale) {
    return { triggered: false, maxPriceUpdatedAt, result: null };
  }

  const result = await refreshAllTokenPrices();
  return { triggered: true, maxPriceUpdatedAt, result };
}
