import assert from 'node:assert/strict';
import test from 'node:test';
import { fromMongoToPayload } from './route';

test('fromMongoToPayload returns dynamic token map for EVM chains', () => {
  const payload = fromMongoToPayload({
    chain: 'ETH_MAINNET',
    address: '0xabc',
    mongoBalances: {
      ETH: {
        symbol: 'ETH',
        name: 'Ether',
        address: '',
        decimals: 18,
        balance: '1200000000000000000',
        source: 'mongo',
        verifiedAt: 1700000000000,
      },
      USDC: {
        symbol: 'USDC',
        name: 'USD Coin',
        address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        balance: '4500000',
        source: 'mongo',
        verifiedAt: 1700000000000,
      },
    },
  });

  assert.equal(payload.chain, 'ETH_MAINNET');
  assert.equal(payload.address, '0xabc');
  assert.equal(payload.tokens.ETH?.symbol, 'ETH');
  assert.equal(payload.tokens.USDC?.symbol, 'USDC');
  assert.equal(typeof payload.tokens.ETH?.balance, 'string');
});

test('fromMongoToPayload uses solanaAddress on SOLANA_MAINNET', () => {
  const payload = fromMongoToPayload({
    chain: 'SOLANA_MAINNET',
    address: 'So11111111111111111111111111111111111111112',
    mongoBalances: {
      SOL: {
        symbol: 'SOL',
        name: 'Solana',
        address: '',
        decimals: 9,
        balance: '123456789',
        source: 'mongo',
        verifiedAt: 1700000000000,
      },
    },
  });

  assert.equal(payload.chain, 'SOLANA_MAINNET');
  assert.equal(payload.solanaAddress, 'So11111111111111111111111111111111111111112');
  assert.equal(payload.tokens.SOL?.symbol, 'SOL');
});

