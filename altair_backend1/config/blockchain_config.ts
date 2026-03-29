// ⚠️⚠️⚠️ CRITICAL SYNCHRONIZATION WARNING ⚠️⚠️⚠️
// This file MUST be kept IDENTICAL to altair_frontend1/config/blockchain_config.ts
// Any change made here MUST be duplicated in the other file immediately.
// Failure to synchronize will cause runtime errors and broken functionality.
//
// REASON: Both frontend and backend need identical blockchain configuration
// for token lists, chain definitions, and other shared constants.
//
// ✅ DO: Copy any addition/modification to both files
// ❌ DON'T: Modify only one file
//
// Last verified sync: $(date) - Ensure both files match line-for-line
// ⚠️⚠️⚠️ END WARNING ⚠️⚠️⚠️

export const BLOCKCHAIN = 'BASE_MAINNET' as const; // default chain context for backend swap, balance, and AI workflows
export const WRAP_ETH = false; // toggle to wrap native ETH for ERC-20 style swap execution

export const CHAINS = {
  BASE_SEPOLIA: 'BASE_SEPOLIA', // Base testnet key used for backend routing and token config
  ETH_SEPOLIA: 'ETH_SEPOLIA', // Ethereum testnet key used for backend routing and token config
  ETH_MAINNET: 'ETH_MAINNET', // Ethereum mainnet key for production routing and swaps
  BASE_MAINNET: 'BASE_MAINNET', // Base mainnet key for production routing and swaps
  SOLANA_MAINNET: 'SOLANA_MAINNET', // Solana mainnet key for Solana-specific swap logic
  SOLANA_DEVNET: 'SOLANA_DEVNET',
} as const;

export type ChainKey = keyof typeof CHAINS; // union of supported chain identifiers for backend logic

export const GAS_RESERVES = {
  BASE_SEPOLIA: '0.001',
  ETH_SEPOLIA: '0.001',
  ETH_MAINNET: '0.01',
  BASE_MAINNET: '0.0005',
  SOLANA_MAINNET: '0.02',
  SOLANA_DEVNET: '0.01',
};

export const GAS_TOKENS = {
  BASE_SEPOLIA: 'ETH',
  ETH_SEPOLIA: 'ETH',
  ETH_MAINNET: 'ETH',
  BASE_MAINNET: 'ETH',
  SOLANA_MAINNET: 'SOL',
  SOLANA_DEVNET: 'SOL',
};

export const FORCE_QUERY_CHAINS = {
  balances:  {
    login: true,
    refresh: true,
    openWallet: false,
    changeChain: false
  }
};

export const DEFAULT_TOKENS = { // These are added when a user creates their account
  ETH_MAINNET: ['ETH', 'WETH', 'WSOL', 'USDC', 'DAI'],
  ETH_SEPOLIA: ['ETH', 'WETH', 'WSOL', 'USDC', 'DAI'],
  BASE_MAINNET: ['ETH', 'WETH', 'WSOL', 'USDC', 'DAI'],
  BASE_SEPOLIA: ['ETH', 'WETH', 'WSOL', 'USDC', 'DAI'],
  SOLANA_MAINNET: ['SOL', 'WETH', 'WBTC', 'USDC', 'USDu'],
  SOLANA_DEVNET: ['SOL', 'WETH', 'WBTC', 'USDC', 'USDu'],
};