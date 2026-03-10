# MongoDB integrations and schema overview

## MongoDB usage map

### Database connection
- [`connectToDatabase()`](../src/lib/db.ts:23) initializes a shared Mongoose connection using `MONGODB_URI` and `MONGODB_DB`.

### User sync (Privy)
- [`syncUserFromAccessToken()`](../src/lib/users.ts:115) verifies Privy access tokens and upserts users into MongoDB. This is called by chat, balance sync, and login endpoints.

### Chat storage
- [`POST /api/chat`](../src/app/api/chat/route.ts:253) persists each chat turn to MongoDB via [`Chat`](../src/models/Chat.ts:21). Used for audit/history outside 0G storage.

### Swap storage
- [`POST /api/test-swap`](../src/app/api/test-swap/route.ts:376) writes swap records to MongoDB via [`Swap`](../src/models/Swap.ts:24) when a client reports a completed swap (`txHash` + `CID`).

### Token metadata caching (Solana/Jupiter)
- [`findJupiterToken()`](../src/app/api/test-swap/route.ts:306) stores Jupiter token metadata in MongoDB via [`Token`](../src/models/Token.ts:21) for later lookups (decimals, symbol, name, etc.).

### Balance snapshots
- [`POST /api/balances`](../src/app/api/balances/route.ts:39) fetches balances from chain RPCs and writes a normalized snapshot to the user document’s `balances` field.

## Schema structures

### User
- File: [`src/models/User.ts`](../src/models/User.ts:1)
- Purpose: User identity, wallet addresses, linked accounts, and stored balance snapshots.
- Fields:
  - `UID` (string, required, unique): Internal user ID used across records.
  - `privyUserId` (string, required, unique): Privy user ID.
  - `email`, `phone`: Contact info when available.
  - `evmAddress`, `solAddress`: Primary wallet addresses.
  - `webWallets`: Optional list of manually connected wallets.
  - `embeddedWalletId`: Privy embedded wallet ID.
  - `profileImageUrl`: Profile image.
  - `linkedAccounts`: Array of linked auth accounts (email, wallet, social, etc.).
  - `balances`: Chain->symbol->list of token entries. Each entry has `symbol`, `name`, `address`, `decimals`, `balance` (raw string), and the chat pipeline formats a `balance` value for LLM prompts. See normalization in [`POST /api/chat`](../src/app/api/chat/route.ts:253).
  - `lastSeenAt`: Timestamp of most recent activity.

### Chat
- File: [`src/models/Chat.ts`](../src/models/Chat.ts:1)
- Purpose: Store each user chat turn for server-side history and analytics.
- Fields:
  - `CID` (string, required, unique): Chat record ID.
  - `UID` (string, required): User ID.
  - `evmAddress`, `solAddress`: Wallet addresses at time of chat.
  - `userMessage`: The user’s prompt.
  - `assistantReply`: The model response.
  - `hadSwapExecution`: Whether the response contained a swap intent.
  - `timestamp`: ISO timestamp.

### Swap
- File: [`src/models/Swap.ts`](../src/models/Swap.ts:1)
- Purpose: Store completed swaps reported by the client after signing.
- Fields:
  - `SID` (string, required, unique): Swap record ID.
  - `UID` (string, required): User ID.
  - `CID`: Chat record ID that triggered the swap.
  - `walletAddress`: Address that executed the swap.
  - `chain`: Chain key (`ETH_MAINNET`, `BASE_MAINNET`, `SOLANA_MAINNET`, etc.).
  - `sellToken`, `buyToken`: Token symbols.
  - `sellAmount`, `buyAmount`: Human-readable amounts computed by the backend.
  - `txHash`: Transaction hash or Solana signature.
  - `timestamp`: ISO timestamp.

### Token
- File: [`src/models/Token.ts`](../src/models/Token.ts:1)
- Purpose: Cache Solana token metadata (mints, decimals, symbols, tags, verification) from Jupiter, enabling accurate decimals and matching for swaps.

## Supporting flows and references

### Chat memory and summaries (0G + MongoDB)
- MongoDB stores chat rows, while 0G storage maintains summaries and chat history. MongoDB + 0G are complementary.
- See [`POST /api/chat`](../src/app/api/chat/route.ts:253) for MongoDB writes and 0G summary writes.

### Balance formatting for LLM prompts
- Balances are stored raw (string, base units) in MongoDB and then formatted for the LLM prompt in [`POST /api/chat`](../src/app/api/chat/route.ts:253).
