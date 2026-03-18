import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvmTokenCacheKey,
  getAlchemyTokenMetadataByAddress,
  normalizeEvmAddress,
  searchAlchemyTokenAddressesBySymbol,
} from './alchemyTokens';

test('normalizeEvmAddress lowercases and normalizes checksummed addresses', () => {
  const normalized = normalizeEvmAddress('0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(normalized, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
});

test('buildEvmTokenCacheKey prefixes normalized address with chain id', () => {
  const key = buildEvmTokenCacheKey(8453, '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(key, '8453:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
});

test('searchAlchemyTokenAddressesBySymbol parses mixed response shapes', async (t) => {
  const prevKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  process.env.NEXT_PUBLIC_ALCHEMY_API_KEY = 'test-key';

  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env.NEXT_PUBLIC_ALCHEMY_API_KEY = prevKey;
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [{ address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }],
        tokens: [{ contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        results: [{ tokenAddress: '0x078d782b760474a361dda0af3839290b0ef57ad6' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const addresses = await searchAlchemyTokenAddressesBySymbol({ symbol: 'usdc' });
  assert.deepEqual(addresses, [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    '0x078d782b760474a361dda0af3839290b0ef57ad6',
  ]);
});

test('getAlchemyTokenMetadataByAddress returns normalized metadata', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        result: {
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          logo: 'https://example.com/usdc.png',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const out = await getAlchemyTokenMetadataByAddress({
    chainKey: 'ETH_MAINNET',
    address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  });

  assert.deepEqual(out, {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logo: 'https://example.com/usdc.png',
    source: 'alchemy',
  });
});

