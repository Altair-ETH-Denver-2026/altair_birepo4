# Altair Balance System: End-to-End Behavior

This document describes how balances move through Altair across frontend cache/state, MongoDB, and on-chain verification.

---

## 1) High-level architecture

Balance state exists in **three layers**:

1. **Frontend live state + local cache**
   - In-memory React state (`balancesByChain`) and localStorage cache in [`UserMenu.tsx`](../../../altair_frontend1/src/components/UserMenu.tsx).
2. **Durable user balances in MongoDB**
   - `User.balances` map in [`User.ts`](../../src/models/User.ts).
3. **On-chain truth sources**
   - EVM via Alchemy Portfolio in [`/api/balances`](../../src/app/api/balances/route.ts).
   - Solana via RPC in [`/api/balances`](../../src/app/api/balances/route.ts).

The system is designed for responsiveness (frontend immediate update) plus eventual durability (Mongo + chain verification).

---

## 2) Canonical data model in MongoDB

`User.balances` is:

- `chainKey -> symbol -> BalanceEntry[]`

See schema in [`User.ts`](../../src/models/User.ts).

### Collision handling

We support same-symbol collisions by storing multiple entries in the symbol array (e.g., `ETH[0]`, `ETH[1]`) and matching by token address when updating. This logic lives in two distinct write paths with different semantics:

- **`updateBalancesInMongoDB()`** ([`balanceService.ts:112`](../../src/lib/balanceService.ts)) — address-aware merge. Loads the existing symbol array, finds the entry with a matching normalized address, updates that entry in place, otherwise appends a new array entry. **Only used by `/api/relay/writeback`.**
- **`updateBalancesSnapshotInMongoDB()`** ([`balanceService.ts:265`](../../src/lib/balanceService.ts)) — snapshot replace. For each chain/symbol it writes a single-entry array, replacing the symbol bucket entirely. **Used by all `/api/balances` write paths** (force, async fast-path follow-up, and includeAllChains refresh).

This means address-aware collision handling only applies on the relay writeback path. The `/api/balances` verification path collapses to one entry per symbol when it persists.

### UX default behavior

Despite array support, most app read paths intentionally default to `entries[0]` per symbol for simplicity/compatibility. Collapse behavior is in [`getBalancesFromMongoDB()`](../../src/lib/balanceService.ts) (line 44).

---

## 3) Frontend wallet balance lifecycle

Core flow is in [`UserMenu.tsx`](../../../altair_frontend1/src/components/UserMenu.tsx).

### 3.1 Initial and periodic reads

- Wallet fetches balances by chain via [`fetchBalancesForChain()`](../../../altair_frontend1/src/components/UserMenu.tsx).
- Reads local cache first (fast render), then may fetch `/api/balances`.
- Normalized payload is applied to state by `applyBalanceSnapshot` and cached in localStorage.

### 3.2 Cache stale strategy

- On swap/relay completion, affected chain cache keys are marked stale.
- This allows immediate UI update while forcing reconciliation soon after.

### 3.3 UI rendering

- Wallet dropdown and wallet panels both render from the same balance state.
- Balance resolution is centralized in `resolveBalanceForSymbol`, and list rendering in `renderBalances` in [`UserMenu.tsx`](../../../altair_frontend1/src/components/UserMenu.tsx).

---

## 4) `/api/balances` backend behavior (source of truth API)

Main endpoint: [`POST` in `/api/balances`](../../src/app/api/balances/route.ts) (line 628).

### 4.1 Request identity and chain resolution

- Resolves chain key from input/default.
- Resolves wallet address from request override or Privy token-derived address.
- Resolves UID primarily from access token, with wallet-address fallback.

### 4.2 Read strategy

Route behavior is built around a one-read snapshot model:

1. Read `UID.balances` from Mongo once.
2. Build in-memory snapshot by chain from that single read.
3. Run verification against that snapshot (no additional Mongo reads in verification path).
4. Persist chain updates with snapshot writeback.

If Mongo has chain balances and request is not `forceRefresh`:

1. Return immediate Mongo payload quickly.
2. Trigger async blockchain verification/writeback in background.

If no immediate Mongo path (or `forceRefresh`):

1. Fetch blockchain balances synchronously.
2. Return blockchain payload.
3. Persist results to Mongo asynchronously.

### 4.3 EVM verification path

- Uses Alchemy Portfolio tokens-by-wallet for multi-chain fetch in one request (performance optimization). Implementation: [`fetchEvmBalancesViaAlchemyPortfolio()`](../../src/app/api/balances/route.ts) at line 146.
- The one-call endpoint is used as a broad portfolio aggregator, not as a strict per-token completeness guarantee.
- Parses per-chain token balances and updates tracked/seeded symbols (+ native symbol).
- Native-token overwrite protection lives at ingest time in `fetchEvmBalancesViaAlchemyPortfolio` (`route.ts:281`): if an incoming non-native token shares the native symbol and an existing native entry is present, the incoming entry is skipped. The Mongo write functions do **not** carry an equivalent guard.

#### 4.3.1 Missing-token fallback (new)

Nuance added in the current implementation:

- We still make one Alchemy portfolio call first.
- Then, for tracked seed symbols that were not returned by Alchemy for a chain, we run deterministic direct RPC fallback reads:
  - Native token via `getBalance`.
  - ERC-20 via `decimals` + `balanceOf`.

This closes the gap where a tracked token (for example `BASE_MAINNET.USDC`) might be absent in `data.tokens` for a specific portfolio response and therefore miss reconciliation.

Resulting EVM strategy is now:

1. One multi-chain Alchemy call.
2. Per-chain fallback only for missing tracked symbols.
3. Snapshot writeback to Mongo with reconciled balances.

### 4.4 Solana verification path

- Uses Solana RPC (`Connection`) with resolved RPC URLs (including placeholder substitution support).
- Reads native lamports + token accounts.
- Implementation: [`fetchBlockchainBalancesDynamic()`](../../src/app/api/balances/route.ts) at line 397.

---

## 5) Swap and relay balance updates

### 5.1 Standard swap UX updates

Swap hooks dispatch `altair:swap-complete` event from frontend swap execution paths.

### 5.2 Relay UX updates

Relay dispatches `altair:swap-complete` with `balanceUpdates` from [`useRelay.ts`](../../../altair_frontend1/src/lib/useRelay.ts).

Those are immediate local updates (fast UX), then reconciliation is forced.

### 5.3 Durable relay persistence (important)

Relay writeback endpoint in [`/api/relay/writeback`](../../src/app/api/relay/writeback/route.ts) (POST at line 214):

- Writes swap record/history (`Swap.create`, chat link, 0G history).
- Also persists `sellToken` and `buyToken` `balanceAfter` snapshots into `User.balances` via [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts) (line 112). This is the only write path that uses the address-aware multi-entry merge.
- **Bug fix (2026-04-14)**: When the sell or buy token is the chain's gas token (e.g., buying ETH with USDC on Base), the gas-balance update is skipped to avoid overwriting the sell/buy token's `balanceAfter` with the gas-only balance. The actual guard is `gasSymbol !== sellSymbolNormalized && gasSymbol !== buySymbolNormalized` and is applied in two places (`route.ts:460` and `:555`).

This closes the earlier gap where swap logs existed but destination-chain user balances could lag.

### 5.4 Affected-chain force refresh

On `altair:swap-complete`, frontend now force-refreshes **all affected chains** from `balanceUpdates`, not only selected chain. This improves destination-chain durability and convergence.

---

## 6) Collision and address matching semantics

Update semantics in [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts) (line 112) — the relay writeback path:

1. Symbol key is sanitized/normalized (including trimming leading `$`).
2. Existing symbol array is loaded.
3. Incoming token is matched by normalized address.
4. If address match exists, update that entry.
5. If no match, append new entry to same symbol array.

[`updateBalancesSnapshotInMongoDB()`](../../src/lib/balanceService.ts) (line 265) — the path used by `/api/balances` — does not perform this merge: it replaces each `chainKey -> symbol` bucket with a fresh single-entry array.

### Address case behavior

- EVM addresses are normalized lowercase for matching.
- Solana addresses are compared as trimmed exact strings.

---

## 7) Native token protection

EVM ingestion guards ensure native gas token entry cannot be overwritten by a non-native token with the same symbol (e.g., fake/alternate `ETH` symbol token).

---

## 8) Why UI can look right before Mongo is fully reconciled

Frontend applies immediate `balanceUpdates` and renders quickly.

Mongo durability and blockchain verification may finalize slightly later (depending on force-refresh timing, verification path, and async writes). With the current implementation, both relay writeback persistence and affected-chain force refresh are in place to minimize this window.

---

## 9) Operational notes

- Errors are treated as developer/operator diagnostics (logs), not user-facing messaging.
- Balance routes prefer resilience and progressive convergence over blocking UX.
- Type-safety/sanity checks: the frontend has `yarn typecheck` (`tsc --noEmit`); the backend has no typecheck script wired up — run `yarn tsc --noEmit` directly inside `altair_backend1/`.

---

## 10) Key files

- Backend API: [`/api/balances/route.ts`](../../src/app/api/balances/route.ts)
- Backend relay writeback: [`/api/relay/writeback/route.ts`](../../src/app/api/relay/writeback/route.ts)
- Backend balance service: [`balanceService.ts`](../../src/lib/balanceService.ts)
- User schema: [`User.ts`](../../src/models/User.ts)
- Frontend wallet state/render: [`UserMenu.tsx`](../../../altair_frontend1/src/components/UserMenu.tsx)
- Frontend relay execution/event: [`useRelay.ts`](../../../altair_frontend1/src/lib/useRelay.ts)
