# MongoDB integrations and schema overview

## MongoDB usage map

### Database connection
- [`connectToDatabase()`](../../src/lib/db.ts:44) initializes and reuses the Mongoose connection (`MONGODB_URI`, `MONGODB_DB`).

### User sync (Privy)
- [`syncUserFromAccessToken()`](../../src/lib/users.ts:171) validates Privy identity and upserts user profile data (`UID`, addresses, linked accounts).

### Chat storage
- [`POST /api/chat`](../../src/app/api/chat/route.ts:424) writes chat turns to Mongo via [`Chat`](../../src/models/Chat.ts:1) (`Chat.create` call at `route.ts:775`).

### Swap storage
- EVM/Solana swap writeback path in [`POST /api/test-swap`](../../src/app/api/test-swap/route.ts:943).
- Relay bridge/swap writeback path in [`POST /api/relay/writeback`](../../src/app/api/relay/writeback/route.ts:214).
- Both persist swap records to [`Swap`](../../src/models/Swap.ts:1).

### Token metadata caching
- Solana/Jupiter metadata caching in module-local helpers `findJupiterToken()` ([`test-swap/route.ts:865`](../../src/app/api/test-swap/route.ts:865)) and `saveJupiterToken()` ([`test-swap/route.ts:796`](../../src/app/api/test-swap/route.ts:796)), persisted to [`Token`](../../src/models/Token.ts:1). These helpers are file-private; they are not exported from the route module.

### Balance snapshots / persistence
- Authoritative balance API is [`POST /api/balances`](../../src/app/api/balances/route.ts:628).
- The balances API persists via [`updateBalancesSnapshotInMongoDB()`](../../src/lib/balanceService.ts:265), which replaces each chain's symbol buckets with single-entry arrays.
- The relay writeback API persists via [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts:112), which performs the address-aware multi-entry merge described below.

---

## User balance schema (critical)

In [`User`](../../src/models/User.ts:33), `balances` is:

- `Map<chainKey, Map<symbol, TokenBalanceEntry[]>>`

This means each symbol bucket is an array and can store multiple entries for same-symbol collisions (distinguished by token address). The schema is defined at [`User.ts:60`](../../src/models/User.ts:60).

### Two write paths with different collision semantics

- **`updateBalancesInMongoDB`** ([`balanceService.ts:112`](../../src/lib/balanceService.ts:112)) — address-aware merge, used by `/api/relay/writeback`:
  1. Normalize symbol key (uppercase, strip leading `$`).
  2. Load existing chain/symbol arrays.
  3. Match by normalized token address.
  4. Update matched entry, else append new array entry.

- **`updateBalancesSnapshotInMongoDB`** ([`balanceService.ts:265`](../../src/lib/balanceService.ts:265)) — snapshot replace, used by `/api/balances`:
  1. Normalize symbol key.
  2. Build a single-entry array `[{ ...entry, symbol, address: normalizedAddress, source, verifiedAt }]`.
  3. Set `balances.<chainKey>` to the new map of single-entry arrays.

The address-aware multi-entry capability described in the schema only materializes through the relay writeback path. Anything written by `/api/balances` collapses to one entry per symbol per chain.

### UX default read semantics

For compatibility and UI simplicity, standard read paths collapse to index `0` entry per symbol.

Reference: [`getBalancesFromMongoDB()`](../../src/lib/balanceService.ts:44).

---

## Balance write sources and timing

### A) `/api/balances` path

[`POST /api/balances`](../../src/app/api/balances/route.ts:628) can:

- return immediate Mongo payload (fast path), and asynchronously verify + write blockchain results, or
- force-refresh on-chain then return and write updated balances.

All writes from this path go through `updateBalancesSnapshotInMongoDB` (single-entry-per-symbol replacement).

### B) Relay writeback path

[`POST /api/relay/writeback`](../../src/app/api/relay/writeback/route.ts:214) persists `sellToken.balanceAfter` and `buyToken.balanceAfter` directly into `User.balances` via [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts:112) (address-aware merge), in addition to writing swap logs. The gas-token update is skipped when the gas symbol equals either the sell or buy symbol (`route.ts:460` and `:555`) to avoid clobbering the post-trade balanceAfter values.

This prevents the prior condition where swap history looked correct but destination-chain user balances stayed stale.

---

## EVM and Solana Mongo balance nuances

### EVM

- EVM blockchain verification is optimized through Alchemy Portfolio multi-chain fetch in [`fetchEvmBalancesViaAlchemyPortfolio()`](../../src/app/api/balances/route.ts:146).
- Native-token protection lives at ingest time in `fetchEvmBalancesViaAlchemyPortfolio` (`route.ts:281`) — incoming non-native tokens with the native symbol are skipped when an existing native entry is present. The Mongo write functions do not enforce this themselves.

### Solana

- Solana verification uses `Connection` + token account scans in [`fetchBlockchainBalancesDynamic()`](../../src/app/api/balances/route.ts:397).
- Solana RPC URLs are resolved through [`resolveRpcUrls()`](../../config/chain_info.ts:18) before connection creation. Note: `resolveRpcUrls` substitutes both `NEXT_PUBLIC_ALCHEMY_API_KEY` and `NEXT_PUBLIC_HELIUS_API_KEY` placeholders.

---

## Models summary

### User
- File: [`User.ts`](../../src/models/User.ts:1)
- Contains identity + addresses + `balances` map + `lastSeenAt`.

### Chat
- File: [`Chat.ts`](../../src/models/Chat.ts:1)
- Stores CID/UID/user message/assistant reply/intent execution metadata.

### Swap
- File: [`Swap.ts`](../../src/models/Swap.ts:1)
- Stores completed swap/bridge records with token-level before/after fields.

### Token
- File: [`Token.ts`](../../src/models/Token.ts:1)
- Caches token metadata used for symbol/address/decimals resolution.

---

## Developer notes

- Balances in Mongo are stored as raw base-unit strings and formatted only when needed.
- Developer diagnostics are log-first; user-facing error messaging is intentionally not part of product UX.
- For deep balance pipeline context, also see [`Balances.md`](./Balances.md).
