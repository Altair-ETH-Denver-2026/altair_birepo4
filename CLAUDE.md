# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is a two-package monorepo for **Altair**, a crypto chat app that turns conversational intents into swaps/bridges. The two packages run as independent Next.js apps:

- `altair_backend1/` — Next.js API routes + MongoDB (port **3001**)
- `altair_frontend1/` — Next.js App Router UI (port **3000**)

There is **no root `package.json`** — install and run each package separately. They communicate over HTTP; the backend does not import frontend code, and the frontend talks to the backend via fetch.

## Common commands

Run from each package directory (`altair_backend1/` or `altair_frontend1/`):

```bash
corepack yarn install        # install (backend postinstall runs scripts/patch-0g-sdk.js)
corepack yarn dev            # dev server (3001 backend, 3000 frontend; frontend uses --webpack)
corepack yarn build          # next build
corepack yarn start          # next start
corepack yarn lint           # eslint (backend) / next lint (frontend)
```

Frontend-only:

```bash
yarn typecheck               # tsc --noEmit
yarn test                    # vitest run
yarn test path/to/file.test.ts   # run a single test file
```

Backend has no test script; type-check with `yarn tsc --noEmit`.

## Architecture

### Three-layer balance system (most important concept in the codebase)

Balances exist in three layers and converge asynchronously — understand this before touching anything balance-related:

1. **Frontend immediate state** — `balancesByChain` React state + localStorage cache in `altair_frontend1/src/components/UserMenu.tsx`. Updates instantly on swap-complete events.
2. **MongoDB durable state** — `User.balances` is `Map<chainKey, Map<symbol, BalanceEntry[]>>` in `altair_backend1/src/models/User.ts`. Symbol buckets are **arrays** to support same-symbol/different-address collisions (e.g., real USDC vs a scam token). Standard read paths collapse to index `0` for UX simplicity (`getBalancesFromMongoDB` in `balanceService.ts`); writes are address-aware (`updateBalancesInMongoDB`).
3. **On-chain truth** — EVM via Alchemy Portfolio multi-chain fetch + per-symbol RPC fallback for missing tracked tokens; Solana via `@solana/web3.js` `Connection` token-account scans. Both live in `altair_backend1/src/app/api/balances/route.ts`.

`POST /api/balances` has two modes:
- **Fast path**: return Mongo snapshot immediately, async-verify and writeback.
- **Force path** (`forceRefresh`): fetch on-chain now, return verified, write Mongo.

Native gas tokens have explicit overwrite protection so a same-symbol non-native token cannot clobber the native entry.

### Swap completion flow (frontend ↔ backend reconciliation)

This is the contract that ties the layers together — preserve it:

1. Frontend swap/relay hook (`useSwap.ts`, `useSolanaSwap.ts`, `useRelay.ts`) executes the chain action.
2. Hook dispatches `altair:swap-complete` (window CustomEvent) with `balanceUpdates`.
3. `handleSwapComplete()` in `UserMenu.tsx` applies optimistic local updates, marks affected-chain caches stale, then **force-refreshes all affected chains** (not just the selected chain — important for cross-chain).
4. For Relay specifically, frontend also POSTs to `/api/relay/writeback`, which writes the `Swap` record AND persists `sellToken`/`buyToken` `balanceAfter` into `User.balances` directly. There is a known edge case (fixed 2026-04-14): when the buy token is also the gas token (e.g., buying ETH with USDC on Base), the writeback skips the gas-balance update so it doesn't overwrite the buy-token's `balanceAfter`.

### Chat → intent → execution

`POST /api/chat` (`altair_backend1/src/app/api/chat/route.ts`) builds a system prompt from four context blocks defined in `config/ai_config.ts` `SYSTEM_PROMPT.contextBlocks`: `selectedChainBlock`, `memoryBlock` (compacted prior chats from 0G/MongoDB), `balancesBlock` (current Mongo snapshot), `swapsBlock` (recent swaps). The LLM is instructed to embed a JSON intent (`SINGLE_CHAIN_SWAP_INTENT`, `CROSS_CHAIN_SWAP_INTENT`, `BRIDGE_INTENT`) in its reply. `Chat.tsx` parses the JSON, strips it from displayed text, and executes on user confirmation ("yes", "ok", etc.).

LLM provider routing: `LLM_MODELS.options` maps `modelId → providerName`; `PROVIDER_KEYS` maps provider → env-var name. **Every provider is called via the OpenAI SDK** (they all expose OpenAI-compatible APIs); only `X` (xAI) needs a custom `baseURL`. `mainChat` and `runningSummary` are ordered fallback arrays — the loop tries each model in order until one succeeds. Adding a provider = entry in `LLM_MODELS.options` + entry in `PROVIDER_KEYS` (+ optional `PROVIDER_BASE_URLS`).

After each chat response, a `setTimeout(..., 0)` fires a fire-and-forget background task that regenerates a running summary and writes it to **0G decentralized storage** via `appendChatAndSummary()` (`src/lib/zg-storage.ts`). This never blocks the response.

### Wallet display: panel vs dropdown

`WALLET_DISPLAY.active` in `altair_frontend1/config/ui_config.ts` switches between `panel` (persistent, stackable, only dismissed by explicit ×) and `drop_down` (transient). Panel mode keeps a stack of `WALLET_PANEL` instances (each with its own chain selection) plus an `ADD_PANEL` adder. State persists across open/close cycles when 2+ panels are open. Both modes render from the same `balancesByChain` source via `renderBalances` / `resolveBalanceForSymbol` — keep them consistent when changing balance rendering.

### Identity/auth

Privy tokens are validated server-side by `syncUserFromAccessToken()` in `altair_backend1/src/lib/users.ts`, which upserts `User` (UID, addresses, linked accounts). Wallet address is resolved from request override or token-derived address; UID falls back to wallet address if token lookup fails.

### CORS

`altair_backend1/middleware.ts` applies CORS headers to all `/api/*` routes via `buildCorsHeaders()` from `src/lib/appUrls.ts`. OPTIONS short-circuits to 204.

## Config conventions

All chain/token metadata is centralized — **do not introduce ad-hoc constants or new `.env` reads for chain/token data**:

- `config/blockchain_config.ts` — `BLOCKCHAIN` (default), `CHAINS` enum, `ChainKey` type, `WRAP_ETH`.
- `config/chain_info.ts` — per-chain RPC URLs (Alchemy first, with `ALCHEMY_API_KEY` placeholder substituted at runtime by `resolveRpcUrls()`), explorer URLs, Uniswap addresses.
- `config/token_info/*` — per-network WETH/USDC objects (`symbol`, `name`, `address`).
- `config/ai_config.ts` — LLM model lists, provider keys, system prompt blocks.
- `altair_frontend1/config/ui_config.ts` — `WALLET_DISPLAY`, `MENU_ICONS`, `CHAT_PANEL`, etc.
- `altair_frontend1/config/external_links.ts` — `AFFILIATE_LINKS` (single source of truth for external URLs).

Backend and frontend each have their own `config/` directory; values must stay aligned because they shape request payloads and parsing.

## Environment variables

Backend reads (see `altair_backend1/README.md` for full list):
- Privy: `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `PRIVY_WALLET_AUTH_PRIVATE_KEY`
- LLM: `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `GROQ_API_KEY`
- Chain: `NEXT_PUBLIC_ALCHEMY_API_KEY`, `NEXT_PUBLIC_HELIUS_API_KEY`
- Mongo: `MONGODB_URI`, `MONGODB_DB`
- 0G: `ZG_PRIVATE_KEY`, `ZG_RPC_URL`, `ZG_INDEXER_RPC`, `ZG_NETWORK`, `ZG_STORAGE_MODE`, `ZG_ENABLE_LOCAL_FALLBACK`, `ZG_CIRCUIT_BREAKER_THRESHOLD`, `ZG_CIRCUIT_BREAKER_COOLDOWN_MS`, `ZG_LOCAL_FALLBACK_PATH`, `ZG_LOCAL_INDEX_PATH`

## Conventions

- **Diagnostics are developer-facing.** Errors go to logs/telemetry, not user-facing UI strings. Don't surface backend errors to product UX.
- **Frontend optimizes for responsiveness; backend optimizes for durability.** When in doubt, push immediate feedback to the UI and let backend writes converge.
- **Mongo balance values are raw base-unit strings** — format to human-readable only at the render boundary.
- **EVM addresses are lowercased** for matching; **Solana addresses are exact-string** matched (after trim).
- The 0G SDK requires a postinstall patch — do not skip `scripts/patch-0g-sdk.js`. Re-run with `yarn patch:0g` if needed.

## Deeper documentation

For deep dives, read these in order when working on the relevant area:

- Balances end-to-end: `altair_backend1/docs/dev_notes/Balances.md`
- Mongo schema + write paths: `altair_backend1/docs/dev_notes/MongoDB.md`
- Panel UI behavior: `altair_backend1/docs/dev_notes/Panels.md`
- Config map: `altair_backend1/docs/dev_notes/Config.md`
- LLM/provider routing: `altair_backend1/docs/dev_notes/LLMs and Model Providers.md`

## Config Paradigm (CRITICAL)
All values — URLs, addresses, token lists, feature flags, thresholds, UI strings —
must live in `config/*.ts` as exported const objects. Source files import and
reference these values via variables. Never write a literal value directly in
component or logic code. When adding a new value:
1. Add it to the appropriate config file
2. Export it
3. Import it at the usage site