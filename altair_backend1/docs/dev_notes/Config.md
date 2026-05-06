# Backend Configuration Overview

This project centralizes runtime configuration in the backend [`config`](../../config/blockchain_config.ts) directory. Backend code imports these modules directly instead of relying on scattered constants or `.env` values for chain and token metadata. This file documents each config module, what it contains, and where it is consumed.

> **Note:** UI configuration (`ui_config.ts`) and external link config (`external_links.ts`) live in `altair_frontend1/config/`, not the backend. They are documented in the **frontend** dev notes — see [`altair_frontend1/docs/dev_notes/Config.md`](../../../altair_frontend1/docs/dev_notes/Config.md).

## `blockchain_config.ts`

**Purpose:** Defines the chain key system and shared cross-chain rules used throughout the app. (This file is mirrored verbatim in `altair_frontend1/config/blockchain_config.ts` — see the synchronization warning at the top of both files.)

**Exports:**
- `BLOCKCHAIN`: the default chain key. Currently `'BASE_MAINNET'`.
- `WRAP_ETH`: whether ETH should be wrapped to WETH before swaps.
- `CHAINS`: enum-like map of supported chain keys (`BASE_SEPOLIA`, `ETH_SEPOLIA`, `ETH_MAINNET`, `BASE_MAINNET`, `SOLANA_MAINNET`, `SOLANA_DEVNET`).
- `ChainKey`: union type derived from `CHAINS` keys.
- `GAS_RESERVES`: per-chain minimum native balance to keep in reserve when sizing swaps.
- `GAS_TOKENS`: per-chain native gas token symbol (e.g., `BASE_MAINNET → 'ETH'`, `SOLANA_MAINNET → 'SOL'`).
- `FORCE_QUERY_CHAINS`: per-trigger boolean map controlling when balance refreshes are forced (login, refresh, openWallet, changeChain, swapComplete, swapStart).
- `BALANCE_RULES`: staleness/staleness-check rules (`staleTimer`, `stalenessCheckConditions`, `staleTimerCheckConditions`).
- `DEFAULT_TOKENS`: per-chain default token symbol list seeded for new users.

**Usage:**
- Chain resolution and validation are driven by `CHAINS`/`ChainKey` in [`useSwap`](../../../altair_frontend1/src/lib/useSwap.ts), the [`balances` API](../../src/app/api/balances/route.ts), and the [`test-swap` API](../../src/app/api/test-swap/route.ts).
- `GAS_TOKENS` and `BALANCE_RULES` drive native-token resolution and staleness gating in [`balanceService.ts`](../../src/lib/balanceService.ts) and [`balances/route.ts`](../../src/app/api/balances/route.ts).
- `DEFAULT_TOKENS` seeds new-user balances via `ensureDefaultTokensInMongoDB()` in [`balanceService.ts`](../../src/lib/balanceService.ts).
- UI chain switching uses the same keys in [`UserMenu`](../../../altair_frontend1/src/components/UserMenu.tsx).

## `chain_info.ts`

**Purpose:** Holds per-chain metadata (RPC endpoints, scan URLs, Uniswap addresses where applicable). RPC endpoints are stored as lists with the Alchemy/Helius URL first; at runtime, API keys are substituted via `resolveRpcUrls()`. (Mirrored to the frontend.)

**Exports:**
- Per-EVM-chain configs: `BASE_SEPOLIA`, `ETH_SEPOLIA`, `ETH_MAINNET`, `BASE_MAINNET`, each containing:
  - `name`, `isTestnet`
  - `chainId`
  - `rpcUrls` (array; Alchemy first, with `ALCHEMY_API_KEY_PLACEHOLDER` substitution)
  - `explorerUrl`
  - `uniswapAddresses` (`router`, `factory`, `swapRouter`)
- Per-Solana-chain configs: `SOLANA_MAINNET`, `SOLANA_DEVNET`, each containing:
  - `name`, `isTestnet`, `chainId`, `rpcUrls`, `explorerUrl` (no `uniswapAddresses`).
- `ALCHEMY_API_KEY_PLACEHOLDER`, `HELIUS_API_KEY_PLACEHOLDER`: literal placeholder tokens that `resolveRpcUrls` replaces.
- `resolveRpcUrls(rpcUrls)`: substitutes both `NEXT_PUBLIC_ALCHEMY_API_KEY` and `NEXT_PUBLIC_HELIUS_API_KEY` placeholders, then drops any URLs whose required keys are missing from env.
- `RELAY_CHAIN_INFO`: large lookup of chain-id / explorer-url metadata for chains supported by the Relay bridge provider.

**Usage:**
- RPC URL lists are resolved and used in [`balances` API](../../src/app/api/balances/route.ts) and [`test-swap` API](../../src/app/api/test-swap/route.ts).
- Chain IDs and RPC URLs are consumed in [`useSwap`](../../../altair_frontend1/src/lib/useSwap.ts).
- `RELAY_CHAIN_INFO` is read by the relay execution flow.

## `token_info/*`

**Purpose:** Per-network token metadata. All token addresses are defined here (no `.env` dependency).

**Files:**
- [`base_testnet_sepolia_tokens.ts`](../../config/token_info/base_testnet_sepolia_tokens.ts)
- [`eth_sepolia_testnet_tokens.ts`](../../config/token_info/eth_sepolia_testnet_tokens.ts)
- [`eth_tokens.ts`](../../config/token_info/eth_tokens.ts)
- [`base_tokens.ts`](../../config/token_info/base_tokens.ts)
- [`solana_tokens.ts`](../../config/token_info/solana_tokens.ts)
- [`arbitrum_tokens.ts`](../../config/token_info/arbitrum_tokens.ts)
- [`types.ts`](../../config/token_info/types.ts) — shared `TokenInfo` type.

**Each per-chain file exports a flat set of token objects** (e.g. `WETH`, `USDC`, `USDT`, `DAI`, plus chain-specific tokens like `WSOL`, `UNI`, `LINK`, `AAVE`, etc.). Each token object has:
- `symbol`
- `name`
- `address` (EVM `0x...` or Solana base58 mint, depending on chain)
- `decimals`

**Usage:**
- Token addresses and decimals are used in [`balances` API](../../src/app/api/balances/route.ts), [`test-swap` API](../../src/app/api/test-swap/route.ts), [`balanceService.ts`](../../src/lib/balanceService.ts), and [`useSwap`](../../../altair_frontend1/src/lib/useSwap.ts).
- The `getTokenInfo()` helper in `balanceService.ts` selects the right module by `chainKey` and resolves a token by symbol case-insensitively.

## `ai_config.ts`

LLM and chat configuration. See [`LLMs and Model Providers.md`](./LLMs%20and%20Model%20Providers.md) for the full provider routing walkthrough.

**Key exports:**
- `LLM_MODELS`: `mainChat` and `runningSummary` ordered fallback arrays, plus an `options` map of `modelId → providerName` for every registered model.
- `PROVIDER_KEYS`: `providerName → ENV_VAR_NAME` (e.g. `'X' → 'XAI_API_KEY'`).
- `PROVIDER_BASE_URLS`: providers needing a custom OpenAI-SDK `baseURL`. Currently `X` (xAI) and `Groq`.
- `INTENTS.SWAP_INTENTS`: prompt fragments for `SINGLE_CHAIN_SWAP_INTENT`, `CROSS_CHAIN_SWAP_INTENT`, `BRIDGE_INTENT`.
- `CHAT_BUTTON_ROW_TEMPLATES`: declarative button-row templates (`CONFIRM_SWAP`, `SWAP_FOLLOWUP`) consumed by the chat UI.
- `SYSTEM_PROMPT.basePrompt` and `SYSTEM_PROMPT.contextBlocks` (`selectedChainBlock`, `memoryBlock`, `balancesBlock`, `swapsBlock`).
- `CHAT_SUMMARY_LATEST.chatQuantity` (currently `20`) and `CHAT_SUMMARY_LATEST.source` (`'MongoDB' | '0G'`).

## `mongodb_config.ts`

**Purpose:** Shapes the document templates used when writing chats/swaps to Mongo. `MONGODB_JSONS.chat` and `MONGODB_JSONS.swap` are merged in via spread when records are created. The literal value `'ZG_JSONS'` is special-cased in `chat/route.ts` to indicate that the corresponding 0G template should be used instead.

## `zerog_config.ts`

**Purpose:** Templates for the 0G storage payloads — notably `ZG_JSONS.chat_history_latest` (the v3 chat-summary shape) and `ZG_JSONS.swap_history` (per-swap structure).

## `relay_config.ts`

**Purpose:** Relay bridge provider configuration consumed by the relay quote/writeback API routes.

## `logging_config.ts`

**Purpose:** Wait-logger thresholds and toggles consumed by [`waitLogger`](../../src/lib/waitLogger.ts).

## `ui_messages.ts`

**Purpose:** Centralized response strings (e.g. `SWAP_SUBMITTED`) used by chat-button-row templates and other UI-facing text origins on the backend.

## General Import Rules

- Chain key logic (`BLOCKCHAIN`, `CHAINS`, `ChainKey`, `GAS_TOKENS`, `BALANCE_RULES`, `DEFAULT_TOKENS`) comes from [`blockchain_config`](../../config/blockchain_config.ts).
- Chain RPC/scan/Uniswap metadata comes from [`chain_info`](../../config/chain_info.ts).
- Token addresses/decimals come from the appropriate file under [`token_info`](../../config/token_info).
- LLM/provider routing comes from [`ai_config`](../../config/ai_config.ts).
- UI behavior and external links live in the frontend's `config/` directory and are documented there.
