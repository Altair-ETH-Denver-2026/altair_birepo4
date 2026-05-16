import { Token } from '@/models/Token';
import { connectToDatabase } from '@/lib/db';
import { withWaitLogger } from '@/lib/waitLogger';
import { CHAINS, type ChainKey } from '../../config/blockchain_config';

/**
 * Canonical chainId per chain key, used when we record a token and want the
 * `chainId` field to match what downstream consumers (price refresher, balance
 * resolver) expect.
 *
 * For EVM we keep a string (matches existing convention in test-swap). For
 * Solana mainnet we store the cluster genesis hash (matches saveJupiterToken's
 * historical value).
 */
const CHAIN_IDS_BY_KEY: Partial<Record<ChainKey, string>> = {
  ETH_MAINNET: '1',
  ETH_SEPOLIA: '11155111',
  BASE_MAINNET: '8453',
  BASE_SEPOLIA: '84532',
  SOLANA_MAINNET: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

const isSolanaChain = (chain: ChainKey): boolean =>
  chain === 'SOLANA_MAINNET' || chain === 'SOLANA_DEVNET';

const isEvmChain = (chain: ChainKey): boolean =>
  chain === 'ETH_MAINNET' ||
  chain === 'ETH_SEPOLIA' ||
  chain === 'BASE_MAINNET' ||
  chain === 'BASE_SEPOLIA';

/**
 * Synthetic `mint` for an EVM chain's native gas token (ETH). Native ETH has no
 * real ERC-20 contract address, so we use this stable per-chain key to give it a
 * row in the `tokens` collection. The row is intended to be flagged
 * `gasToken: true` and given a `wrappedProxy` pointing at WETH so the price
 * refresher can populate its USD price via the wrapped contract.
 *
 * (Solana native SOL uses the real WSOL mint — `So111...` — rather than a
 * synthetic key, because WSOL is itself a valid SPL mint that CoinGecko prices.
 * This helper is EVM-only.)
 */
export function buildEvmNativeMint(chain: ChainKey): string {
  return `native:${chain.toLowerCase()}`;
}

/**
 * True when (symbol, chain) refers to the native gas token of that chain.
 * Used to redirect `mint` lookups to `buildEvmNativeMint` for native ETH paths.
 */
export function isNativeGasSymbol(symbol: string | null | undefined, chain: ChainKey): boolean {
  if (typeof symbol !== 'string') return false;
  const upper = symbol.trim().toUpperCase();
  if (!upper) return false;
  if (isEvmChain(chain)) return upper === 'ETH';
  if (isSolanaChain(chain)) return upper === 'SOL';
  return false;
}

/**
 * Normalize an address for use as the `mint` primary key.
 *  - Solana mints are case-sensitive base58 — preserve.
 *  - EVM contract addresses are case-insensitive — lowercase for stable keys.
 */
const normalizeMint = (chain: ChainKey, raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return isSolanaChain(chain) ? trimmed : trimmed.toLowerCase();
};

export type TokenSource = 'jupiter' | 'config' | 'alchemy' | 'relay' | 'mint-only';

export interface TokenRecordInput {
  mint: string;
  chain: ChainKey;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
  icon?: string | null;
  tags?: string[];
  isVerified?: boolean | null;
  tokenProgram?: string | null;
  source: TokenSource;
}

/**
 * Quick existence check by mint/contract address. Returns false on empty input
 * so callers can skip external API calls without guarding the input themselves.
 */
export async function isTokenRecorded(mint: string, chain?: ChainKey): Promise<boolean> {
  if (!mint || !mint.trim()) return false;
  const normalized = chain ? normalizeMint(chain, mint) : mint.trim();
  await connectToDatabase();
  const doc = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/tokenRegistry.ts',
      target: 'Token.findOne (existence check)',
      description: `check token presence for ${normalized}`,
    },
    () => Token.findOne({ mint: normalized }, { _id: 1 }).lean()
  );
  return !!doc;
}

/**
 * Insert a token doc only if no doc with this mint exists yet. Uses
 * `$setOnInsert` so an existing entry's fields are never overwritten — callers
 * that want to refresh metadata must do so explicitly elsewhere.
 *
 * Any field passed as `null`/`undefined`/empty is omitted from the insert,
 * which keeps fake placeholder data (e.g. `decimals: 9`) out of the collection.
 *
 * `lastFetchedAt` is deliberately not set — it is owned by the price refresher
 * and signals "last successful price poll", not "last metadata write".
 */
export async function recordTokenIfMissing(input: TokenRecordInput): Promise<{ created: boolean }> {
  if (!(input.chain in CHAINS)) {
    console.warn('[tokenRegistry] unknown chain key, skipping record', {
      chain: input.chain,
      mint: input.mint,
    });
    return { created: false };
  }
  const mint = normalizeMint(input.chain, input.mint);
  if (!mint) return { created: false };

  const setOnInsert: Record<string, unknown> = {
    mint,
    chain: input.chain,
    source: input.source,
    // Always seed priceInfo on first insert so the source/lineage tag is
    // present even before any price has been observed. The periodic price
    // refresher and the swap-math back-fill both overwrite this subdocument
    // when they write a real price.
    priceInfo: {
      lastPrice: null,
      updatedAt: new Date(),
      source: input.source,
    },
  };
  const chainId = CHAIN_IDS_BY_KEY[input.chain];
  if (chainId) setOnInsert.chainId = chainId;

  if (typeof input.symbol === 'string') {
    const trimmed = input.symbol.trim();
    if (trimmed) setOnInsert.symbol = trimmed.toUpperCase();
  }
  if (typeof input.name === 'string') {
    const trimmed = input.name.trim();
    if (trimmed) setOnInsert.name = trimmed;
  }
  if (typeof input.decimals === 'number' && Number.isFinite(input.decimals)) {
    setOnInsert.decimals = input.decimals;
  }
  if (typeof input.icon === 'string') {
    const trimmed = input.icon.trim();
    if (trimmed) setOnInsert.icon = trimmed;
  }
  if (Array.isArray(input.tags) && input.tags.length > 0) {
    setOnInsert.tags = input.tags;
  }
  if (typeof input.isVerified === 'boolean') {
    setOnInsert.isVerified = input.isVerified;
  }
  if (typeof input.tokenProgram === 'string') {
    const trimmed = input.tokenProgram.trim();
    if (trimmed) setOnInsert.tokenProgram = trimmed;
  }

  try {
    await connectToDatabase();
    const result = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/tokenRegistry.ts',
        target: 'Token.updateOne (upsert if missing)',
        description: `record ${input.chain} token ${mint}`,
      },
      () =>
        Token.updateOne(
          { mint },
          { $setOnInsert: setOnInsert },
          { upsert: true, setDefaultsOnInsert: false }
        )
    );
    const created = (result.upsertedCount ?? 0) > 0;
    if (created) {
      console.log('[tokenRegistry] recorded new token', {
        mint,
        chain: input.chain,
        symbol: setOnInsert.symbol ?? null,
        decimals: setOnInsert.decimals ?? null,
        source: input.source,
      });
    }
    return { created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[tokenRegistry] recordTokenIfMissing failed', {
      mint,
      chain: input.chain,
      error: message,
    });
    return { created: false };
  }
}
