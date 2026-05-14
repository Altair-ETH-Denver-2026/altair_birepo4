import { COINGECKO_API } from '../../config/coinGecko_config';
import { withWaitLogger } from '@/lib/waitLogger';

export interface CoinGeckoPriceEntry {
  // EVM addresses returned lowercased; Solana addresses returned as-is.
  contractAddress: string;
  usd: number;
  lastUpdatedAt: number | null;
}

interface RawTokenPriceResponse {
  [contractAddress: string]: {
    usd?: number;
    last_updated_at?: number;
  };
}

const isSolanaPlatform = (platform: string) => platform === 'solana';

const normalizeAddressForPlatform = (platform: string, address: string): string => {
  const trimmed = address.trim();
  return isSolanaPlatform(platform) ? trimmed : trimmed.toLowerCase();
};

const chunk = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetch USD prices for a list of contract addresses on a single CoinGecko asset platform.
 *
 * Failures are soft: a non-200 response (including 429s) on a single chunk logs and
 * yields an empty result for that chunk, while other chunks continue. Partial price
 * updates are preferred over zero.
 */
export async function fetchPricesForPlatform(params: {
  platform: string; // CoinGecko asset platform id (e.g. 'ethereum', 'base', 'solana')
  contractAddresses: string[];
}): Promise<CoinGeckoPriceEntry[]> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    throw new Error('Missing COINGECKO_API_KEY environment variable');
  }

  const dedupedAddresses = Array.from(
    new Set(
      params.contractAddresses
        .map((addr) => addr?.trim())
        .filter((addr): addr is string => typeof addr === 'string' && addr.length > 0)
    )
  );

  if (dedupedAddresses.length === 0) {
    return [];
  }

  const out: CoinGeckoPriceEntry[] = [];
  const chunks = chunk(dedupedAddresses, COINGECKO_API.contractBatchSize);

  for (let i = 0; i < chunks.length; i += 1) {
    const batch = chunks[i];
    const url = new URL(`${COINGECKO_API.baseUrl}/simple/token_price/${encodeURIComponent(params.platform)}`);
    url.searchParams.set('contract_addresses', batch.join(','));
    url.searchParams.set('vs_currencies', 'usd');
    url.searchParams.set('include_last_updated_at', 'true');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COINGECKO_API.requestTimeoutMs);

    try {
      const response = await withWaitLogger(
        {
          file: 'altair_backend1/src/lib/coinGecko.ts',
          target: 'CoinGecko /simple/token_price',
          description: `prices for ${params.platform} batch ${i + 1}/${chunks.length} (${batch.length} addresses)`,
        },
        () =>
          fetch(url.toString(), {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'x-cg-pro-api-key': apiKey,
            },
            signal: controller.signal,
          })
      );

      if (response.status === 429) {
        console.warn('[coinGecko][rate-limit] 429 from CoinGecko; skipping chunk', {
          platform: params.platform,
          chunkIndex: i,
          chunkSize: batch.length,
          retryAfter: response.headers.get('retry-after'),
        });
        continue;
      }

      if (!response.ok) {
        console.warn('[coinGecko] non-200 from CoinGecko; skipping chunk', {
          platform: params.platform,
          status: response.status,
          chunkIndex: i,
          chunkSize: batch.length,
        });
        continue;
      }

      const data = (await response.json()) as RawTokenPriceResponse;
      Object.entries(data).forEach(([rawAddress, value]) => {
        if (!value || typeof value.usd !== 'number' || !Number.isFinite(value.usd)) return;
        out.push({
          contractAddress: normalizeAddressForPlatform(params.platform, rawAddress),
          usd: value.usd,
          lastUpdatedAt: typeof value.last_updated_at === 'number' ? value.last_updated_at : null,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[coinGecko] fetch error; skipping chunk', {
        platform: params.platform,
        chunkIndex: i,
        chunkSize: batch.length,
        error: message,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (i < chunks.length - 1 && COINGECKO_API.interBatchDelayMs > 0) {
      await sleep(COINGECKO_API.interBatchDelayMs);
    }
  }

  return out;
}
