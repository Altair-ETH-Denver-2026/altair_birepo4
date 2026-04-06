# MongoDB integrations and schema overview

## MongoDB usage map

### Database connection
- [`connectToDatabase()`](../../src/lib/db.ts:23) initializes and reuses the Mongoose connection (`MONGODB_URI`, `MONGODB_DB`).

### User sync (Privy)
- [`syncUserFromAccessToken()`](../../src/lib/users.ts:166) validates Privy identity and upserts user profile data (`UID`, addresses, linked accounts).

### Chat storage
- [`POST /api/chat`](../../src/app/api/chat/route.ts:411) writes chat turns to Mongo via [`Chat`](../../src/models/Chat.ts:1).

### Swap storage
- EVM/Solana swap writeback path in [`POST /api/test-swap`](../../src/app/api/test-swap/route.ts:818).
- Relay bridge/swap writeback path in [`POST /api/relay/writeback`](../../src/app/api/relay/writeback/route.ts:91).
- Both persist swap records to [`Swap`](../../src/models/Swap.ts:1).

### Token metadata caching
- Solana/Jupiter metadata caching in [`findJupiterToken()`](../../src/app/api/test-swap/route.ts:740) and [`saveJupiterToken()`](../../src/app/api/test-swap/route.ts:671), persisted to [`Token`](../../src/models/Token.ts:1).

### Balance snapshots / persistence
- Authoritative balance API is [`POST /api/balances`](../../src/app/api/balances/route.ts:475).
- Durable writes to user balances are handled by [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts:145).

---

## User balance schema (critical)

In [`User`](../../src/models/User.ts:33), `balances` is:

- `Map<chainKey, Map<symbol, TokenBalanceEntry[]>>`

This means each symbol bucket is an array and can store multiple entries for same-symbol collisions (distinguished by token address).

### Collision-safe semantics implemented

`updateBalancesInMongoDB` now performs address-aware merges:

1. Normalize symbol key (uppercase, strip leading `$`).
2. Load existing chain/symbol arrays.
3. Match by normalized token address.
4. Update matched entry, else append new array entry.

Reference: [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts:145).

### UX default read semantics

For compatibility and UI simplicity, standard read paths collapse to index `0` entry per symbol.

Reference: [`getBalancesFromMongoDB()`](../../src/lib/balanceService.ts:44).

---

## Balance write sources and timing

### A) `/api/balances` path

[`POST /api/balances`](../../src/app/api/balances/route.ts:475) can:

- return immediate Mongo payload (fast path), and asynchronously verify + write blockchain results, or
- force-refresh on-chain then return and write updated balances.

### B) Relay writeback path

[`POST /api/relay/writeback`](../../src/app/api/relay/writeback/route.ts:91) now persists `sellToken.balanceAfter` and `buyToken.balanceAfter` directly into `User.balances` via [`updateBalancesInMongoDB()`](../../src/lib/balanceService.ts:145), in addition to writing swap logs.

This prevents the prior condition where swap history looked correct but destination-chain user balances stayed stale.

---

## EVM and Solana Mongo balance nuances

### EVM

- EVM blockchain verification is optimized through Alchemy Portfolio multi-chain fetch in [`fetchEvmBalancesViaAlchemyPortfolio()`](../../src/app/api/balances/route.ts:138).
- Native-token protection prevents non-native same-symbol overwrite of native gas token slot.

### Solana

- Solana verification uses `Connection` + token account scans in [`fetchBlockchainBalancesDynamic()`](../../src/app/api/balances/route.ts:266).
- Solana RPC URLs are resolved through [`resolveRpcUrls()`](../../config/chain_info.ts:18) before connection creation.

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
