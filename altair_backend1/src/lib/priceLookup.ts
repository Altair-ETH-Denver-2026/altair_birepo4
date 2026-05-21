import { Token } from '@/models/Token';
import { connectToDatabase } from '@/lib/db';
import { withWaitLogger } from '@/lib/waitLogger';
import type { ChainKey } from '../../config/blockchain_config';
import type { ApiTokenBalance } from '@/lib/balanceTypes';

const NATIVE_EVM_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const isSolanaChain = (chain: ChainKey): boolean =>
  chain === 'SOLANA_MAINNET' || chain === 'SOLANA_DEVNET';

/**
 * Map a balance entry's on-chain address to the canonical `mint` key used in
 * the `tokens` collection. Mirrors the conventions in tokenRegistry:
 *   - EVM native (NATIVE_EVM_ADDRESS) → `native:<chain.toLowerCase()>`
 *   - EVM ERC-20 → lowercased address
 *   - Solana    → mint preserved as-is
 */
const resolveMintForBalance = (
  chain: ChainKey,
  address: string | null | undefined
): string | null => {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (isSolanaChain(chain)) return trimmed;
  if (trimmed.toLowerCase() === NATIVE_EVM_ADDRESS.toLowerCase()) {
    return `native:${chain.toLowerCase()}`;
  }
  return trimmed.toLowerCase();
};

/**
 * Mutate a tokens map by attaching `price` (USD number, or null when unknown)
 * to each entry.
 *
 * Lookup strategy (one DB query):
 *  1. Primary: address → mint, then match the `tokens` collection by mint.
 *  2. Fallback: any balance entry whose mint didn't resolve (or whose mint
 *     wasn't in the collection) is matched by symbol against rows on this
 *     chain that have `gasToken: true`. This handles native gas tokens whose
 *     balance entry carries no on-chain address (e.g. native SOL — its balance
 *     entry has `address: ''`, but the `tokens` row is keyed by the WSOL mint
 *     and flagged `gasToken: true`).
 */
export async function attachPricesToTokens(
  chain: ChainKey,
  tokens: Record<string, ApiTokenBalance>
): Promise<void> {
  const entries = Object.entries(tokens);
  if (entries.length === 0) return;

  const mintBySymbol = new Map<string, string>();
  const symbolByMint = new Map<string, string>();
  for (const [symbol, entry] of entries) {
    const upperSymbol = symbol.toUpperCase();
    const mint = resolveMintForBalance(chain, entry?.address);
    if (!mint) continue;
    mintBySymbol.set(upperSymbol, mint);
    symbolByMint.set(mint, upperSymbol);
  }

  await connectToDatabase();
  const mints = Array.from(symbolByMint.keys());
  // Always include `gasToken: true` rows for the chain so we can fall back to a
  // symbol match for balance entries (typically native gas tokens) whose
  // address resolution returned null. The gasToken set is tiny — at most one
  // row per chain — so this is essentially free on top of the main query.
  const queryClauses: Record<string, unknown>[] = [{ gasToken: true }];
  if (mints.length > 0) queryClauses.push({ mint: { $in: mints } });

  const docs = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/priceLookup.ts',
      target: 'Token.find (price lookup)',
      description: `look up prices for ${mints.length} tokens (+ gasTokens) on ${chain}`,
    },
    () =>
      Token.find(
        { chain, $or: queryClauses },
        { mint: 1, price: 1, symbol: 1, gasToken: 1 }
      ).lean<
        Array<{
          mint: string;
          price: number | null | undefined;
          symbol?: string | null;
          gasToken?: boolean | null;
        }>
      >()
  );

  const priceByMint = new Map<string, number | null>();
  const gasTokenPriceBySymbol = new Map<string, number | null>();
  for (const doc of docs) {
    const value =
      typeof doc.price === 'number' && Number.isFinite(doc.price) ? doc.price : null;
    priceByMint.set(doc.mint, value);
    if (doc.gasToken && typeof doc.symbol === 'string') {
      const upper = doc.symbol.trim().toUpperCase();
      if (upper) gasTokenPriceBySymbol.set(upper, value);
    }
  }

  for (const [symbolKey, entry] of entries) {
    const upperSymbol = symbolKey.toUpperCase();
    const mint = mintBySymbol.get(upperSymbol);
    let price: number | null;
    if (mint && priceByMint.has(mint)) {
      price = priceByMint.get(mint) ?? null;
    } else if (gasTokenPriceBySymbol.has(upperSymbol)) {
      price = gasTokenPriceBySymbol.get(upperSymbol) ?? null;
    } else {
      price = null;
    }
    entry.price = price;
  }
}
