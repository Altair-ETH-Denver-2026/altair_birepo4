## CHAT_SUMMARY_LATEST Walkthrough (MongoDB vs 0G)

This note traces one full request path using `CHAT_SUMMARY_LATEST.source = 'MongoDB'` vs `'0G'` and confirms payload shape + CID swap linkage end-to-end.

---

### Path A — `CHAT_SUMMARY_LATEST.source = 'MongoDB'`
1. **Request entry + config read**
   - `POST()` reads `CHAT_SUMMARY_LATEST.source` and `CHAT_SUMMARY_LATEST.chatQuantity` to decide pre-read strategy and limits. See [`POST()`](../../src/app/api/chat/route.ts:424).

2. **Mongo pre-read builds the *same* v3 summary shape**
   - `shouldUseMongoSummary` is true, so it reads `Chat` and `Swap` documents (limited to `chatQuantity`), then builds `chatTurns` with a swap linked by `CID`.
   - This happens inside [`POST()`](../../src/app/api/chat/route.ts:424) at lines 580–621:
     - `swapEntries` is created from swap docs.
     - `chatTurns` is built from chats (ordered oldest → newest), and for each chat, `swapMatch` is found by `CID`.
   - The resulting `priorMemory` has:
     - `schemaVersion: 'v3'`
     - `runningSummary: ''`
     - `chatTurns: [...]`
   - This is then normalized into `priorSummaryText` via [`extractRunningSummary()`](../../src/app/api/chat/route.ts:374).

3. **Summary update + persistence**
   - After response, async flow generates a new running summary with the summary model list, then calls `buildChatSummaryPayload()` → `buildUpdatedChatSummary()`.
   - `buildUpdatedChatSummary()`:
     - Normalizes previous `chatTurns`, appends `nextTurn`, links swaps by `CID`, and **slices to `CHAT_SUMMARY_LATEST.chatQuantity`** (with an internal fallback of 3 if the config value is missing). See [`buildUpdatedChatSummary()`](../../src/app/api/chat/route.ts:254).
   - The payload shape written to 0G/local bundle is:
     ```ts
     {
       schemaVersion: 'v3',
       updatedAt: ISO,
       runningSummary: string,
       chatTurns: [
         {
           CID,
           userMessage,
           assistantReply,
           intentString,        // string | null
           intentExecuted,      // boolean
           timestamp,
           swap?: { SID, CID, sellToken, buyToken, txHash, timestamp, intentString } | null
         }
       ]
     }
     ```
   - This payload is stored in the chat bundle by [`appendChatAndSummary()`](../../src/lib/zg-storage.ts:860).

**Why it works (MongoDB mode):** you construct the **exact same v3 summary payload shape** from MongoDB that would otherwise come from 0G, so downstream logic (prompt memory, summary update, write-back) stays consistent and bounded by `chatQuantity`, with swap linkage by `CID` preserved end-to-end.

---

### Path B — `CHAT_SUMMARY_LATEST.source = '0G'`
1. **Request entry + 0G pre-read**
   - `POST()` checks `summarySource === '0G'` and calls [`getChatSummaryMemory()`](../../src/lib/zg-storage.ts:745) to read the bundled summary (`chat_bundle_v1`). See [`POST()`](../../src/app/api/chat/route.ts:424).

2. **Summary normalization**
   - `getChatSummaryMemory()` returns the bundled `summary` if present; if not, it falls back to legacy keys and normalizes legacy `recentTurns` into v3 shape. See [`getChatSummaryMemory()`](../../src/lib/zg-storage.ts:745).
   - `extractRunningSummary()` then uses `runningSummary` or flattens `chatTurns` as fallback. See [`extractRunningSummary()`](../../src/app/api/chat/route.ts:374).

3. **Summary update + persistence**
   - Same async flow as MongoDB mode: generate running summary, then `buildUpdatedChatSummary()` merges and links swaps by `CID`, slices to `chatQuantity`, and returns v3 payload. See [`buildUpdatedChatSummary()`](../../src/app/api/chat/route.ts:254).
   - Persisted via [`appendChatAndSummary()`](../../src/lib/zg-storage.ts:860) into the bundle.

**Why it works (0G mode):** pre-read is already the authoritative v3 summary (bundle), and the same builder function preserves CID swap linkage and bounded `chatTurns`. The bundle write keeps summary + chat history in one key, so reads remain consistent.

---

### CID swap linkage confirmation (both modes)
- In MongoDB mode, `swapMatch` is found by `CID` when constructing `chatTurns`. See [`POST()`](../../src/app/api/chat/route.ts:424) (chat-turn loop at lines 593–613).
- In both modes, `buildUpdatedChatSummary()` re-links swaps by `CID` when merging the new turn into the existing `chatTurns`, ensuring the attached swap data persists across updates. See [`buildUpdatedChatSummary()`](../../src/app/api/chat/route.ts:254).

---

### Net result
Both paths converge on the same v3 payload shape and the same update/write logic. The `source` flag only changes **where the pre-read comes from**, not how the summary payload is built or written, which matches the intended design: **consistent summary schema + bounded turns + CID-linked swaps** regardless of source.
