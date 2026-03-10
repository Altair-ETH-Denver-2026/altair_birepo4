export const BLOCKCHAIN = 'ETH_SEPOLIA' as const; // default chain context for backend swap, balance, and AI workflows
export const WRAP_ETH = false; // toggle to wrap native ETH for ERC-20 style swap execution

export const CHAINS = {
  BASE_SEPOLIA: 'BASE_SEPOLIA', // Base testnet key used for backend routing and token config
  ETH_SEPOLIA: 'ETH_SEPOLIA', // Ethereum testnet key used for backend routing and token config
  ETH_MAINNET: 'ETH_MAINNET', // Ethereum mainnet key for production routing and swaps
  BASE_MAINNET: 'BASE_MAINNET', // Base mainnet key for production routing and swaps
  SOLANA_MAINNET: 'SOLANA_MAINNET', // Solana mainnet key for Solana-specific swap logic
} as const;

export type ChainKey = keyof typeof CHAINS; // union of supported chain identifiers for backend logic

export const GAS_RESERVES = {
  BASE_SEPOLIA: '0.001',
  ETH_SEPOLIA: '0.001',
  ETH_MAINNET: '0.01',
  BASE_MAINNET: '0.0005',
  SOLANA_MAINNET: '0.02',
};