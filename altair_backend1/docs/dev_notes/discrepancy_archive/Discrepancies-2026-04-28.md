# Discrepancies — `altair_backend1/docs/dev_notes`

This document lists places where the dev notes in this folder disagree with the actual code as of the current branch (`feature/take-altair-fees`). Each section names the doc, the claim, and what the code actually does. Stale line numbers throughout are flagged but grouped at the end of each section so the substantive claims stand out.

---

## `Balances.md`

### Substantive

- **Says**: `/api/balances` writes durable balances via `updateBalancesInMongoDB()` (referenced repeatedly as the address-aware merge function for the verification path).
  **Actually**: `/api/balances` (`src/app/api/balances/route.ts`) does not call `updateBalancesInMongoDB` at all. Its async/force writes go through **`updateBalancesSnapshotInMongoDB()`** (lines 779, 831, 885, 892, 940, 943, 947). Only `/api/relay/writeback` calls `updateBalancesInMongoDB`. This matters because the two functions have *different collision semantics*: `updateBalancesInMongoDB` does the address-aware array merge the doc describes (`balanceService.ts:194–227`), while `updateBalancesSnapshotInMongoDB` **replaces the whole symbol bucket with a single-entry array** per write (`balanceService.ts:302`). So the documented "address-aware, multi-entry array merge" only applies on the relay writeback path, not on the main balance verification path.

- **Says** (§4.3): "Native-token protection prevents non-native same-symbol overwrite of native gas token entry." in the EVM Alchemy verification block.
  **Actually**: That guard is in `fetchEvmBalancesViaAlchemyPortfolio` at `route.ts:281` (`if (!isLikelyNative && targetSymbol === nativeSymbol && existingIsNative) continue;`). Implementation is correct, but the doc implies the guard lives in `updateBalancesInMongoDB`. The Mongo write functions do **not** carry an equivalent native-token guard; protection is purely at ingest time.

- **Says** (§5.3): "Bug fix (2026-04-14): `gasSymbol !== buySymbolNormalized` was added so the gas update doesn't overwrite the buy token's `balanceAfter`."
  **Code matches**: `relay/writeback/route.ts:460` and `:555` both check `gasSymbol !== sellSymbolNormalized && gasSymbol !== buySymbolNormalized`. (Both sell-side and buy-side guards are present — the doc only mentions the buy-side case.)

- **Says** (§9): "Type-safety/sanity checks are done with `tsc --noEmit` per workspace."
  **Actually**: Only the frontend has a `typecheck` npm script (`altair_frontend1/package.json`). The backend has no `typecheck` script — `tsc --noEmit` works but is not wired up in `package.json`.

### Stale line numbers

- `updateBalancesInMongoDB()` cited at `balanceService.ts:145` → actual **line 112**.
- `getBalancesFromMongoDB()` cited at `balanceService.ts` (no line) — line 44, matches the MongoDB.md ref.
- `POST /api/relay/writeback` cited at `relay/writeback/route.ts:91` → actual **line 214**.
- `POST /api/balances` cited at `balances/route.ts:475` → actual **line 628**.
- `fetchEvmBalancesViaAlchemyPortfolio()` cited at `:138` → actual **line 146**.
- `fetchBlockchainBalancesDynamic()` cited at `:266` → actual **line 397**.

---

## `MongoDB.md`

### Substantive

- **Same `updateBalancesInMongoDB` vs `updateBalancesSnapshotInMongoDB` discrepancy as Balances.md** — §4 claims durable writes from the balances API go through `updateBalancesInMongoDB()`. They do not; they go through `updateBalancesSnapshotInMongoDB()`.

- **Says** (§Token metadata caching): Solana/Jupiter caching uses `findJupiterToken()` and `saveJupiterToken()`.
  **Actually**: Both functions exist and persist to the `Token` model, but they are **not exported** from `test-swap/route.ts` — they are file-local helpers. The doc treats them as a public surface.

### Stale line numbers

- `connectToDatabase()` at `db.ts:23` → actual **line 44**.
- `syncUserFromAccessToken()` at `users.ts:166` → actual **line 171** (close).
- `POST /api/chat` chat-write cited at `chat/route.ts:411` → the `Chat.create` call is at **line 775** (within a `POST` that starts at line 424).
- `POST /api/test-swap` writeback cited at `test-swap/route.ts:818` → `POST` actually at **line 943**.
- `findJupiterToken()` cited at `:740` → actual **line 865**.
- `saveJupiterToken()` cited at `:671` → actual **line 796**.
- `POST /api/relay/writeback` cited at `:91` → actual **line 214**.
- `POST /api/balances` cited at `:475` → actual **line 628**.
- `updateBalancesInMongoDB()` cited at `:145` → actual **line 112**.
- `fetchEvmBalancesViaAlchemyPortfolio()` cited at `:138` → actual **line 146**.
- `fetchBlockchainBalancesDynamic()` cited at `:266` → actual **line 397**.
- `User` schema cited at `User.ts:33` is correct (UserSchema starts at line 33).

---

## `Config.md`

### Substantive

- **Section `external_links.ts` is misplaced.** This file lives in `altair_frontend1/config/external_links.ts`. There is no `altair_backend1/config/external_links.ts`. The document is in the backend `dev_notes` folder but describes a frontend-only file as if it were a backend config.

- **Section `ui_config.ts` is also frontend-only.** `ui_config.ts` lives in `altair_frontend1/config/`, not the backend. The backend has `ui_messages.ts`, not `ui_config.ts`.

- **`blockchain_config.ts` exports list is incomplete.** Doc lists `BLOCKCHAIN`, `WRAP_ETH`, `CHAINS`, `ChainKey`. The actual file (`altair_backend1/config/blockchain_config.ts`) also exports **`GAS_RESERVES`, `GAS_TOKENS`, `FORCE_QUERY_CHAINS`, `BALANCE_RULES`, `DEFAULT_TOKENS`** — all of which are consumed throughout the codebase (e.g. `balanceService.ts`, `balances/route.ts`).

- **`chain_info.ts` exports list is incomplete and partly wrong.**
  - Doc lists exports: `BASE_SEPOLIA, ETH_SEPOLIA, ETH_MAINNET, BASE_MAINNET, resolveRpcUrls`.
  - Actual file also exports **`SOLANA_MAINNET`, `SOLANA_DEVNET`, `RELAY_CHAIN_INFO`, `ALCHEMY_API_KEY_PLACEHOLDER`, `HELIUS_API_KEY_PLACEHOLDER`**.
  - Doc says "the Alchemy API key is substituted via `resolveRpcUrls()`". `resolveRpcUrls` substitutes **both** the Alchemy *and* the Helius API keys (`chain_info.ts:18–35`).
  - Doc says each chain object contains `chainId`, `rpcUrls`, `explorerUrl`, `uniswapAddresses`. Actual EVM chain objects also include `name` and `isTestnet`. The Solana chain objects (`SOLANA_MAINNET`, `SOLANA_DEVNET`) have **no `uniswapAddresses` field**.

- **`token_info/*` exports are far broader than documented.**
  - Doc claims "Each file exports `WETH` and `USDC` objects with `symbol`, `name`, `address`."
  - Actual `eth_tokens.ts` exports `WETH, USDC, USDT, DAI, UNI, SUSHI, AAVE, LINK, BNB, APE, POL, AVAX, BASE, ARB, OP, WSOL` and each has a **`decimals`** field that the doc does not mention.
  - Doc lists only four files. Actual folder also contains **`solana_tokens.ts`, `arbitrum_tokens.ts`, and `types.ts`**.
  - Solana tokens use base58 mint addresses, not the EVM 0x format implied by the WETH/USDC examples.

### Stale line numbers

- All `:1` references after the bullet labels are stable, but the body uses many `:NN` references for usages in `useSwap`, `balances API`, and `test-swap API` that are no longer valid (e.g. "balances API:62", "test-swap:81") — the relevant code has shifted significantly.

---

## `LLMs and Model Providers.md`

### Substantive

- **`PROVIDER_BASE_URLS` claim is wrong.** Doc says: "The only provider that needs a custom `baseURL` is xAI" with a snippet showing only `X: 'https://api.x.ai/v1'`. Actual `ai_config.ts:81–84` defines:
  ```ts
  export const PROVIDER_BASE_URLS: Partial<Record<keyof typeof PROVIDER_KEYS, string>> = {
    X: 'https://api.x.ai/v1',
    Groq: 'https://api.groq.com/openai/v1',
  };
  ```
  Both `X` and `Groq` use a custom `baseURL`. The doc's claim that "adding a new provider only requires" three steps is still correct, but the example is now out of date.

- **Provider list claim** ("Currently six providers are registered: OpenAI, Anthropic, Google, Perplexity, X, Groq") matches the code. ✓

- **`mainChat` / `runningSummary` arrays** as documented (`['grok-4-fast', 'grok-4', 'gpt-4o-mini']`) match the code. ✓

- **System prompt block names** (`selectedChainBlock`, `memoryBlock`, `balancesBlock`, `swapsBlock`) match `SYSTEM_PROMPT.contextBlocks`. ✓

- **"Last 20 turns per `CHAT_SUMMARY_LATEST.chatQuantity`"** — actual `chatQuantity: 20` in `ai_config.ts:207`. ✓

- **Frontend Chat.tsx claims**:
  - Doc: "Chat.tsx (line 367) sends `messages.map(m => ({ role, content }))`." Actual call is at **`Chat.tsx:527`**, not 367. The pattern itself is correct.
  - Doc: "Chat.tsx (line 104) parses the LLM response for this JSON." Actual JSON parsing is in `extractSwapIntent` at **line 118** and `extractIntentJsonSlice` at **line 141**. Line 104 is in unrelated typing-animation logic.
  - Doc: confirmation phrases include "yes, confirm, ok, etc." Actual phrases at `Chat.tsx:189`: `['confirm', 'yes', 'execute', 'do it', 'ok', 'okay']`. The doc's example list is incomplete but not contradictory.

### Stale line numbers (chat/route.ts and ai_config.ts)

- `resolveProviderForModel` at `chat/route.ts:21` → actual **line 34**.
- `resolveApiKeyForModel` at `:29` → actual **line 42**.
- `createOpenAiClient` at `:46` → actual **line 95**.
- `generateChatCompletion` at `:63` → actual **line 113**.
- `generateChatCompletionWithFallback` at `:89` → actual **line 167**.
- `POST` at `:320` → actual **line 424**.
- `PROVIDER_KEYS` at `ai_config.ts:54` → actual **line 72**.
- `INTENTS.SWAP_INTENTS` at `:63` → actual **line 87**.
- `SYSTEM_PROMPT.basePrompt` at `:75` → actual **line 165**.
- `SYSTEM_PROMPT.contextBlocks` at `:96` → actual **line 186**.

---

## `Chat Summary Latest.md`

### Substantive

- **`chatTurns` field name discrepancy.** Doc shows the v3 payload has each chatTurn with `{ CID, userMessage, assistantReply, hadSwapExecution, timestamp, swap?: { SID, CID, ... } | null }`. Actual `ChatSummaryTurn` type (`chat/route.ts:218–252`) uses **`intentString` and `intentExecuted`** instead of `hadSwapExecution`. The 0G template (`zerog_config.ts:59–73`) confirms: fields are `intentString` and `intentExecuted`. There is no `hadSwapExecution` field anywhere in the current code.

- **Slicing claim** "slices to `CHAT_SUMMARY_LATEST.chatQuantity`" matches the code at `chat/route.ts:307–318` (`Math.max(1, Number(CHAT_SUMMARY_LATEST.chatQuantity ?? 3))`). The internal default fallback of `3` is undocumented but rarely matters because `chatQuantity` is set to 20.

### Stale line numbers

- `POST()` cited at `chat/route.ts:310` → actual **line 424**.
- `POST()` chatTurns construction cited at `:367` → actual range **lines 593–613**.
- `extractRunningSummary()` at `:260` → actual **line 374**.
- `buildUpdatedChatSummary()` at `:140` → actual **line 254**.
- `appendChatAndSummary()` at `zg-storage.ts:840` → actual **line 860**.
- `getChatSummaryMemory()` at `:726` → actual **line 745**.

---

## `Panels.md`

This doc is the **backend copy** of the panel notes; it cross-references the frontend (`../../altair_frontend1/...`).

### Substantive

- **Non-existent constants.** Doc claims "Chain labels and dropdown options are config-driven: `WALLET_CHAIN_LABELS` controls panel titles … `WALLET_CHAIN_OPTIONS` drives dropdown option lists." Neither `WALLET_CHAIN_LABELS` nor `WALLET_CHAIN_OPTIONS` exists anywhere in the codebase. The actual config is **`CHAIN_OPTIONS`** (`altair_frontend1/config/ui_config.ts:231`), and panel titles are derived from `walletDisplay.dropdownLabel` / `selectedLabel` per chain inside `CHAIN_OPTIONS`.

- **Panel state-persistence rule** ("only clears the `walletPanels` array if there is exactly one panel open at the time of dismissal") matches the code at `UserMenu.tsx:2447`: `setWalletPanels((existing) => (existing.length === 1 ? [] : existing));`. ✓

- **`initWalletPanels` claim** ("detects `existing.length > 0` and skips re-initialization") matches `usePanels.ts:46–58`. ✓

### Stale line numbers (frontend file references)

- `WALLET_DISPLAY` at `ui_config.ts:6` → actual **line 64** (line 6 is `LOGO_SPIN_MIN_MS`).
- `UserMenu.tsx:14` for "current implementation" → line 14 is unrelated (`PublicKey` import); the relevant `WALLET_DISPLAY` import is on **line 30**.
- `handleSwapComplete()` at `UserMenu.tsx:723` → actual **line 1131**.
- `balancesByChain` at `UserMenu.tsx:37` → actual **line 70**.
- `usePanels.ts:1` for `initWalletPanels` → function is at **line 46**.

---

## `Dynamic Balance QA Checklist.md`

This file is a checklist, not architecture documentation. It does not make many concrete code claims; the claims it does make are accurate:
- Response shape is "dynamic token map (`tokens: { ... }`)" — matches `ApiBalancesResponse` and the `tokens` map produced by `fromMongoToPayload` and `toResponseFromBlockchain`.
- "Compatibility shim" for legacy flattened payloads (`eth/usdc/weth/etc.`) — `balanceTransforms` in the frontend (`normalizeBalancesResponse`) handles a `tokens` map; older flattened legacy paths are no longer present in the current backend response, so the shim is largely defensive only. No active discrepancy.

---

## `user.balances Example.md`

This is a static JSON snapshot, not a doc with line refs. The shape matches the current schema (`chainKey -> symbol -> BalanceEntry[]`). Minor inconsistencies in the snapshot itself (e.g., `WSOL` on `ETH_SEPOLIA` shown with `decimals: 18`, while the same symbol on `ETH_MAINNET` is shown with `decimals: 9`) reflect placeholder/zero rows for testnets where the wormhole bridge isn't deployed; not a code/doc discrepancy.

---

## Summary

The main *substantive* divergences are:

1. **`/api/balances` uses `updateBalancesSnapshotInMongoDB`, not `updateBalancesInMongoDB`** — and the two functions have different collision semantics. `Balances.md` and `MongoDB.md` both attribute the address-aware multi-entry merge to the wrong path.
2. **`PROVIDER_BASE_URLS` now contains both `X` and `Groq`**, contradicting the doc's "only xAI needs a custom baseURL" claim.
3. **`Chat Summary Latest.md` references a `hadSwapExecution` field** that no longer exists; the schema uses `intentString` + `intentExecuted`.
4. **`Panels.md` references non-existent constants** `WALLET_CHAIN_LABELS` and `WALLET_CHAIN_OPTIONS` (the real config is `CHAIN_OPTIONS`).
5. **`Config.md` documents `external_links.ts` and `ui_config.ts` as backend files** — they are frontend-only.
6. **Most `.ts:NN` line references are stale** because the backing files have grown substantially (chat route, balances route, balanceService, zg-storage, test-swap route).
