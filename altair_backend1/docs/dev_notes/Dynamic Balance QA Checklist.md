## Dynamic Balance QA Checklist

### Preconditions
- User is authenticated in Privy.
- At least one EVM wallet is linked.
- For Solana checks, one Solana wallet is linked.

### 1) Cache → Mongo → async chain verify order
1. Open wallet UI once while authenticated.
2. Confirm balances render immediately (cached snapshot if present).
3. Confirm `/api/balances` responds quickly with token-map payload (`tokens: { ... }`).
4. Confirm values can update shortly after initial render (background verification writeback path).

Expected:
- First paint is not blocked by blockchain reads.
- Response shape is dynamic token map, not flattened legacy fields.

### 2) Wallet-open refresh path (non-blocking)
1. Trigger wallet open multiple times.
2. Confirm no UI freeze while refresh happens.
3. Confirm repeated opens do not create runaway parallel refreshes.

Expected:
- Wallet open remains responsive.
- Balances may refresh, but opening is instant.

### 3) Compatibility shim behavior
1. Validate normal API response where payload contains `tokens` map.
2. Simulate legacy flattened payload (eth/usdc/weth/etc.) in client-side normalization path.

Expected:
- Both shapes normalize into token rows without rendering errors.
- Solana fallback address is preserved when needed.

### 4) Panel mode rendering
1. Set wallet mode to `panel` in UI config and verify dynamic rows per selected chain.
2. Switch to `drop_down` mode and verify dynamic rows again.
3. Verify `ALL` chain aggregates mainnet token rows without testnet-only pollution.

Expected:
- Same dynamic token behavior across both modes.
- No hardcoded-token-only rendering path remains.

### 5) Swap/instant update lifecycle
1. Execute swap flow that emits `altair:swap-complete` with balance updates.
2. Confirm immediate optimistic row updates.
3. Confirm stale cache marker behavior for affected chains.

Expected:
- Immediate user-visible updates.
- Follow-up refresh converges to backend/API truth.

### 6) Regression checks
- Frontend typecheck passes.
- Backend typecheck passes.
- Added unit tests for response normalization and token-row resolution compile successfully.

### Notes
- Optional cleanup of legacy Mongo fallback logic should be done only after production data confirms no label-keyed legacy structure remains.

