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

We support same-symbol collisions by storing multiple entries in the symbol array (e.g., `ETH[0]`, `ETH[1]`) and matching by token address when updating. This logic is in [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts).

### UX default behavior

Despite array support, most app read paths intentionally default to `entries[0]` per symbol for simplicity/compatibility. Collapse behavior is in [`getBalancesFromMongoDB()`](../../src/lib/balanceService.ts).

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

Main endpoint: [`POST` in `/api/balances`](../../src/app/api/balances/route.ts).

### 4.1 Request identity and chain resolution

- Resolves chain key from input/default.
- Resolves wallet address from request override or Privy token-derived address.
- Resolves UID primarily from access token, with wallet-address fallback.

### 4.2 Read strategy

If Mongo has chain balances and request is not `forceRefresh`:

1. Return immediate Mongo payload quickly.
2. Trigger async blockchain verification/writeback in background.

If no immediate Mongo path (or `forceRefresh`):

1. Fetch blockchain balances synchronously.
2. Return blockchain payload.
3. Persist results to Mongo asynchronously.

### 4.3 EVM verification path

- Uses Alchemy Portfolio tokens-by-wallet for multi-chain fetch in one request (performance optimization).
- Parses per-chain token balances and updates tracked/seeded symbols (+ native symbol).
- Prevents non-native same-symbol token overwrite of native gas token entry.

### 4.4 Solana verification path

- Uses Solana RPC (`Connection`) with resolved RPC URLs (including placeholder substitution support).
- Reads native lamports + token accounts.

---

## 5) Swap and relay balance updates

### 5.1 Standard swap UX updates

Swap hooks dispatch `altair:swap-complete` event from frontend swap execution paths.

### 5.2 Relay UX updates

Relay dispatches `altair:swap-complete` with `balanceUpdates` from [`useRelay.ts`](../../../altair_frontend1/src/lib/useRelay.ts).

Those are immediate local updates (fast UX), then reconciliation is forced.

### 5.3 Durable relay persistence (important)

Relay writeback endpoint in [`/api/relay/writeback`](../../src/app/api/relay/writeback/route.ts):

- Writes swap record/history (`Swap.create`, chat link, 0G history).
- Also persists `sellToken` and `buyToken` `balanceAfter` snapshots into `User.balances` via [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts).

This closes the earlier gap where swap logs existed but destination-chain user balances could lag.

### 5.4 Affected-chain force refresh

On `altair:swap-complete`, frontend now force-refreshes **all affected chains** from `balanceUpdates`, not only selected chain. This improves destination-chain durability and convergence.

---

## 6) Collision and address matching semantics

Update semantics in [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts):

1. Symbol key is sanitized/normalized (including trimming leading `$`).
2. Existing symbol array is loaded.
3. Incoming token is matched by normalized address.
4. If address match exists, update that entry.
5. If no match, append new entry to same symbol array.

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
- Type-safety/sanity checks are done with `tsc --noEmit` per workspace.

---

## 10) Key files

- Backend API: [`/api/balances/route.ts`](../../src/app/api/balances/route.ts)
- Backend relay writeback: [`/api/relay/writeback/route.ts`](../../src/app/api/relay/writeback/route.ts)
- Backend balance service: [`balanceService.ts`](../../src/lib/balanceService.ts)
- User schema: [`User.ts`](../../src/models/User.ts)
- Frontend wallet state/render: [`UserMenu.tsx`](../../../altair_frontend1/src/components/UserMenu.tsx)
- Frontend relay execution/event: [`useRelay.ts`](../../../altair_frontend1/src/lib/useRelay.ts)
