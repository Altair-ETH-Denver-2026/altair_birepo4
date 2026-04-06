# Altair Backend (`altair_backend1`)

This package is the API and persistence layer for Altair. It handles chat orchestration, swap/bridge writeback, Privy-backed identity syncing, MongoDB balance persistence, and on-chain balance verification for EVM + Solana.

---

## Backend responsibilities

The backend is responsible for:

- authenticating/syncing users from Privy tokens,
- serving chat responses and storing chat rows,
- storing swap/bridge execution records,
- maintaining durable user balances in Mongo,
- reconciling balances with on-chain data,
- exposing API routes consumed by the frontend.

---

## Architecture at a glance

- API routes: [`src/app/api`](src/app/api)
- Services/helpers: [`src/lib`](src/lib)
- Mongo models: [`src/models`](src/models)
- Config: [`config`](config)

Key backend integrations:

- Privy auth/wallet resolution: [`src/lib/privy.ts`](src/lib/privy.ts)
- MongoDB connection: [`src/lib/db.ts`](src/lib/db.ts)
- 0G memory/history integration: [`src/lib/zg-storage.ts`](src/lib/zg-storage.ts)

---

## Core API routes

### Chat

- [`POST /api/chat`](src/app/api/chat/route.ts)
  - Processes user prompts,
  - performs model selection/fallback,
  - persists chat rows,
  - links chat intents with swap execution metadata.

### Balances

- [`POST /api/balances`](src/app/api/balances/route.ts)
  - Resolves chain + wallet + UID,
  - returns fast Mongo snapshot when available,
  - performs blockchain verification (sync or async depending on request path),
  - persists updated balances in Mongo.

Verification paths:

- EVM: Alchemy Portfolio multi-chain balance fetch.
- Solana: RPC + token account scans.

### Swap writeback

- [`POST /api/test-swap`](src/app/api/test-swap/route.ts)
  - writes swap details and updates execution history.

### Relay writeback

- [`POST /api/relay/writeback`](src/app/api/relay/writeback/route.ts)
  - writes Relay swap/bridge record,
  - links CID/SID for chat state,
  - writes 0G history,
  - persists `sellToken` + `buyToken` `balanceAfter` snapshots directly into `User.balances`.

### Relay quote passthrough

- [`POST /api/relay/quote`](src/app/api/relay/quote/route.ts)

---

## How backend functionality is used by the frontend

This section maps backend functionality to the exact frontend usage patterns.

### 1) Chat flow integration

- Frontend chat component [`Chat.tsx`](../altair_frontend1/src/components/Chat.tsx) sends prompts to [`POST /api/chat`](src/app/api/chat/route.ts).
- Backend returns assistant content + intent context used by frontend confirmation/action rows.
- When execution metadata is present, frontend ties it to subsequent swap/relay writeback paths.

### 2) Wallet/balance integration

- Frontend wallet controller [`UserMenu.tsx`](../altair_frontend1/src/components/UserMenu.tsx) calls [`POST /api/balances`](src/app/api/balances/route.ts) per chain.
- Backend may return fast Mongo snapshot or force/async chain-verified balances depending on request flags.
- Frontend normalizes and applies payload into `balancesByChain`, then caches in localStorage for fast rerender.

### 3) Swap execution integration

- Frontend EVM/Solana swap hooks ([`useSwap.ts`](../altair_frontend1/src/lib/useSwap.ts), [`useSolanaSwap.ts`](../altair_frontend1/src/lib/useSolanaSwap.ts)) trigger backend writeback via [`POST /api/test-swap`](src/app/api/test-swap/route.ts).
- Backend stores swap row + supporting token metadata and writes execution context used in chat/history linkage.

### 4) Relay bridge/swap integration

- Frontend relay hook [`useRelay.ts`](../altair_frontend1/src/lib/useRelay.ts) requests routes from [`POST /api/relay/quote`](src/app/api/relay/quote/route.ts).
- After execution, frontend posts final payload to [`POST /api/relay/writeback`](src/app/api/relay/writeback/route.ts).
- Backend then:
  - writes `Swap` record,
  - updates chat execution state (`CID`/`SID` linkage),
  - appends 0G history,
  - persists sell/buy `balanceAfter` into `User.balances` for durability.

### 5) Frontend swap-complete event ↔ backend durability

- Frontend emits `altair:swap-complete` after local execution in swap/relay hooks.
- Frontend wallet logic consumes it to update UI immediately, mark affected-chain cache stale, and force-refresh affected chains.
- Those force refreshes call [`POST /api/balances`](src/app/api/balances/route.ts), which drives backend reconciliation and durable persistence convergence.

### 6) Identity/session coupling

- Frontend sends Privy access token context (header/cookie flow) to backend.
- Backend resolves user/UID/address via Privy helpers and [`syncUserFromAccessToken()`](src/lib/users.ts), enabling consistent user-scoped persistence across chat, balances, and swaps.

### 7) Why this split exists

- Frontend is optimized for immediate responsiveness (state/cache-first rendering).
- Backend is optimized for durable correctness (Mongo writes + chain verification).
- Together they provide fast UX with eventual authoritative convergence.

---

## MongoDB model + balance semantics

### User balance structure

In [`src/models/User.ts`](src/models/User.ts), `balances` is:

- `chainKey -> symbol -> BalanceEntry[]`

This supports same-symbol collisions by keeping multiple entries in a symbol bucket.

### Collision-safe merge behavior

Balance writes in [`updateBalancesInMongoDB()`](src/lib/balanceService.ts) are address-aware:

1. normalize symbol key,
2. scan existing symbol entries,
3. update by address match,
4. append new entry if no match.

Read paths for standard UX collapse to index `0` entry per symbol via [`getBalancesFromMongoDB()`](src/lib/balanceService.ts).

### Native token protections

EVM ingestion in [`/api/balances`](src/app/api/balances/route.ts) includes guard logic so non-native same-symbol assets do not overwrite native gas-token entries.

---

## Balance lifecycle (backend perspective)

1. Frontend requests [`/api/balances`](src/app/api/balances/route.ts).
2. Backend returns Mongo immediately when available (unless forced refresh).
3. Backend verifies against on-chain sources and writes updated snapshots.
4. Relay writeback also persists post-execution `balanceAfter` snapshots directly.

This gives fast responses plus durable convergence.

---

## Configuration

Primary backend config files:

- Chains/tokens: [`config/blockchain_config.ts`](config/blockchain_config.ts)
- Chain RPC/URLs: [`config/chain_info.ts`](config/chain_info.ts)
- AI/model config: [`config/ai_config.ts`](config/ai_config.ts)
- Mongo config: [`config/mongodb_config.ts`](config/mongodb_config.ts)

### Environment variables (common)

- Privy: `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `PRIVY_WALLET_AUTH_PRIVATE_KEY`
- LLM/provider keys: `OPENAI_API_KEY` (+ any configured provider keys)
- Chain providers: `NEXT_PUBLIC_ALCHEMY_API_KEY`, `NEXT_PUBLIC_HELIUS_API_KEY` (if used)
- Mongo: `MONGODB_URI`, `MONGODB_DB`
- 0G: `ZG_PRIVATE_KEY`, `ZG_RPC_URL`, `ZG_INDEXER_RPC`, `ZG_NETWORK`, `ZG_STORAGE_MODE`, `ZG_ENABLE_LOCAL_FALLBACK`, `ZG_CIRCUIT_BREAKER_THRESHOLD`, `ZG_CIRCUIT_BREAKER_COOLDOWN_MS`, `ZG_LOCAL_FALLBACK_PATH`, `ZG_LOCAL_INDEX_PATH`

---

## Run locally

```bash
cd altair_backend1
corepack yarn install
corepack yarn dev
```

Default local URL: `http://localhost:3001`

Type check:

```bash
yarn tsc --noEmit
```

---

## Related docs

- Workspace overview: [`../README.md`](../README.md)
- Balance deep dive: [`docs/dev_notes/Balances.md`](docs/dev_notes/Balances.md)
- Mongo deep dive: [`docs/dev_notes/MongoDB.md`](docs/dev_notes/MongoDB.md)
- Panel/balance UI behavior linkage: [`docs/dev_notes/Panels.md`](docs/dev_notes/Panels.md)

---

## Developer note

Operational diagnostics are intended for developer/operator logs and telemetry. Product UX is designed around successful execution flows rather than user-facing error surfaces.
