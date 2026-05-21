/**
 * One-time seed: upsert EVM tokens from config/token_info/*.ts into the `tokens`
 * MongoDB collection so the periodic CoinGecko price job has rows to refresh.
 *
 * Solana tokens are populated organically by the `saveJupiterToken` flow inside
 * /api/test-swap, so they are not seeded here. EVM has no equivalent population
 * path — without this seed, the price job would do nothing on EVM chains.
 *
 * Run (requires a TS runtime):
 *   npx tsx altair_backend1/scripts/seed-evm-tokens.ts
 *
 * Re-running is safe — uses `$setOnInsert` so existing prices are not clobbered.
 */
import mongoose from 'mongoose';
import { connectToDatabase } from '../src/lib/db';
import { Token } from '../src/models/Token';
import { CHAINS, type ChainKey } from '../config/blockchain_config';
import { BASE_MAINNET, ETH_MAINNET } from '../config/chain_info';
import * as BaseTokens from '../config/token_info/base_tokens';
import * as EthTokens from '../config/token_info/eth_tokens';
import type { TokenInfo } from '../config/token_info/types';

interface SeedSourceEntry {
  chainKey: ChainKey;
  chainId: string;
  tokens: Record<string, TokenInfo>;
}

const SEED_SOURCES: SeedSourceEntry[] = [
  {
    chainKey: CHAINS.ETH_MAINNET,
    chainId: String(ETH_MAINNET.chainId),
    tokens: EthTokens as unknown as Record<string, TokenInfo>,
  },
  {
    chainKey: CHAINS.BASE_MAINNET,
    chainId: String(BASE_MAINNET.chainId),
    tokens: BaseTokens as unknown as Record<string, TokenInfo>,
  },
];

const normalizeEvmAddress = (value: string): string => value.trim().toLowerCase();

interface SeedCounts {
  considered: number;
  inserted: number;
  alreadyPresent: number;
  skippedInvalid: number;
}

const seedOneChain = async (source: SeedSourceEntry): Promise<SeedCounts> => {
  const counts: SeedCounts = { considered: 0, inserted: 0, alreadyPresent: 0, skippedInvalid: 0 };

  for (const [exportKey, info] of Object.entries(source.tokens)) {
    if (!info || typeof info !== 'object') continue;
    counts.considered += 1;

    const symbol = typeof info.symbol === 'string' && info.symbol.length > 0 ? info.symbol : exportKey;
    const address = typeof info.address === 'string' ? info.address.trim() : '';
    if (!address || address.length < 4) {
      counts.skippedInvalid += 1;
      continue;
    }
    const decimals = typeof info.decimals === 'number' ? info.decimals : 18;
    const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : symbol;
    const mint = normalizeEvmAddress(address);

    const result = await Token.updateOne(
      { mint },
      {
        $setOnInsert: {
          mint,
          chain: source.chainKey,
          chainId: source.chainId,
          symbol,
          name,
          decimals,
          source: 'token_info',
          priceInfo: {
            lastPrice: null,
            updatedAt: new Date(),
            source: 'token_info',
          },
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount && result.upsertedCount > 0) {
      counts.inserted += 1;
      console.log(`[seed] inserted ${source.chainKey} ${symbol} (${mint})`);
    } else {
      counts.alreadyPresent += 1;
    }
  }

  return counts;
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI environment variable.');
    process.exit(1);
  }

  await connectToDatabase();
  console.log('[seed] connected to MongoDB');

  const summary: Record<string, SeedCounts> = {};
  for (const source of SEED_SOURCES) {
    console.log(`[seed] seeding ${source.chainKey}...`);
    summary[source.chainKey] = await seedOneChain(source);
  }

  console.log('[seed] done', summary);

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
