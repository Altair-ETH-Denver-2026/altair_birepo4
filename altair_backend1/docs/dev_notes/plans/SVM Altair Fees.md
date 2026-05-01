# SVM Altair Fees — Implementation Plan

## Overview

Integrate Altair's 0.5% fee on single-chain Solana Mainnet swaps using Jupiter's referral program. The fee is deducted via Jupiter's Ultra API referral account mechanism — Jupiter handles the fee collection on-chain, and Altair claims accumulated fees later via the referral token account.

---

## 1. Fee Resolution Logic

### 1.1 Config Values (already defined)

From [`fees_config.ts`](../../config/fees_config.ts):

| Key | Value |
|-----|-------|
| `UNIVERSAL_FEES.ALL` | `0.5` (percent) |
| `SVM_FEES.singleChainSwap` | `null` (falls through to `UNIVERSAL_FEES.ALL`) |
| `REFERRAL_ACCOUNTS.Jupiter.Ultra` | `5i4S34dC7gHY9CBC92sDdH7ciCLgduAPb57k3AFU7NP4` |
| `REFERRAL_ACCOUNTS.Jupiter.SwapAndTrigger` | `FeuYEwwvQHtuVNNspXVUrg4AoDw1pybL9V3BNKYamv2Y` |

### 1.2 Fee Lookup Helper

Create a new file [`altair_backend1/src/lib/feeResolver.ts`](../../src/lib/feeResolver.ts) with a single exported function:

```ts
export function resolveFeeBps(params: {
  action: 'singleChainSwap' | 'crossChainSwap' | 'bridge' | 'liquidityPoolDeposit' | 'loanDeposit';
  platform?: 'Jupiter' | '0x' | 'Relay' | 'Helius';
  chainType?: 'EVM' | 'SVM' | 'BRIDGING';
}): number | null
```

**Resolution order** (matching the priority comment in `fees_config.ts`):

1. `UNIVERSAL_FEES.ALL` — global catch-all
2. `UNIVERSAL_FEES[action]` — universal, action-specific
3. `{EVM|SVM|BRIDGING}_FEES.ALL` — chain-type catch-all
4. `{EVM|SVM|BRIDGING}_FEES[action]` — chain-type, action-specific
5. `{EVM|SVM|BRIDGING}_FEES[platform].ALL` — platform catch-all
6. `{EVM|SVM|BRIDGING}_FEES[platform][action]` — platform + action specific

The first non-null value wins. Return `null` if all levels are `null` (no fee configured).

For Solana single-chain swaps via Jupiter, the effective resolution is:

```
UNIVERSAL_FEES.ALL = 0.5 → SVM_FEES.singleChainSwap = null → SVM_FEES.Jupiter.singleChainSwap = null
→ Result: 0.5 (from UNIVERSAL_FEES.ALL)
```

### 1.3 Referral Account Lookup

Add a second exported function in `feeResolver.ts`:

```ts
export function resolveReferralAccount(params: {
  platform: 'Jupiter';
  apiType: 'Ultra' | 'SwapAndTrigger';
}): string | null
```

Returns `REFERRAL_ACCOUNTS.Jupiter.Ultra` or `REFERRAL_ACCOUNTS.Jupiter.SwapAndTrigger`, or `null` if not configured.

---

## 2. Backend Changes — `test-swap/route.ts`

### 2.1 Import the new resolver

Add to the imports at the top of [`test-swap/route.ts`](../../src/app/api/test-swap/route.ts):

```ts
import { resolveFeeBps, resolveReferralAccount } from '@/lib/feeResolver';
```

### 2.2 Fee computation at quote time (Solana path only)

Inside the `if (isSolana)` block, **after** `amountInRaw` is computed (line ~2038) and **before** the Jupiter Ultra order URL is built (line ~2046):

1. Call `resolveFeeBps({ action: 'singleChainSwap', platform: 'Jupiter', chainType: 'SVM' })`
2. If the result is non-null and > 0:
   - Compute `feeBps = resolvedFeeBps * 100` (convert 0.5% → 50 bps)
   - Call `resolveReferralAccount({ platform: 'Jupiter', apiType: 'Ultra' })`
   - If a referral account is returned, append `&referralAccount=${encodeURIComponent(referralAccount)}&feeBps=${feeBps}` to the Jupiter Ultra order URL

**Current URL (line 2046):**

```
https://api.jup.ag/ultra/v1/order?inputMint=...&outputMint=...&amount=...&taker=...
```

**Modified URL:**

```
https://api.jup.ag/ultra/v1/order?inputMint=...&outputMint=...&amount=...&taker=...&referralAccount=5i4S34dC7gHY9CBC92sDdH7ciCLgduAPb57k3AFU7NP4&feeBps=50
```

### 2.3 Fee metadata in the writeback payload

The Jupiter Ultra API response includes the fee deduction in the `outAmount` — the `outAmount` already reflects the post-fee buy amount. No additional on-chain computation is needed.

However, the **Swap document** should record the Altair fee for audit/history. In the writeback path (around lines 1638–1660), populate the `altair` fee slot in both `sellTokenPayload.fees` and `buyTokenPayload.fees`:

```ts
// After feeBps is resolved at quote time, store it for writeback
const altairFeeBps = feeBps; // captured in closure

// In sellTokenPayload.fees and buyTokenPayload.fees:
altair: {
  token: normalizedSellToken, // fee deducted from sell token
  amount: computeFeeAmount(sellAmountRaw, altairFeeBps), // raw amount
  decimals: sellDecimals,
  bps: altairFeeBps,          // NEW field — add bps to the fee schema
}
```

**Note:** The exact fee amount in raw units is `BigInt(sellAmountRaw) * BigInt(altairFeeBps) / 10000n`. This is what Jupiter deducts on-chain via the referral program.

### 2.4 Fee amount computation helper

Add a small utility in `feeResolver.ts`:

```ts
export function computeFeeAmount(
  amountRaw: string | null | undefined,
  feeBps: number
): string {
  if (!amountRaw) return '0';
  try {
    const amount = BigInt(amountRaw);
    const fee = amount * BigInt(feeBps) / 10000n;
    return fee.toString();
  } catch {
    return '0';
  }
}
```

---

## 3. Frontend Changes — `useSolanaSwap.ts`

### 3.1 No changes needed

The frontend [`useSolanaSwap.ts`](../../../altair_frontend1/src/lib/useSolanaSwap.ts) does not need modification because:

- The fee is handled entirely server-side in the Jupiter Ultra API call
- The `outAmount` returned by Jupiter already reflects the post-fee buy amount
- The writeback response (`balanceUpdates`) already contains the correct post-swap balances
- The `altair:swap-complete` event carries the correct balance updates to the UI

The fee is transparent to the user — they see the expected output amount minus the fee, which is standard DEX behavior.

---

## 4. Swap Model Update

### 4.1 Add `bps` field to fee schema

In [`Swap.ts`](../../src/models/Swap.ts), update the fee sub-object to include `bps`:

```ts
fees: {
  type: Schema.Types.Mixed,
  default: {
    gas: { token: '', amount: '', decimals: null, bps: null },
    provider: { token: '', amount: '', decimals: null, bps: null },
    altair: { token: '', amount: '', decimals: null, bps: null },
  },
},
```

This is a non-breaking additive change — existing documents without `bps` will simply have `null`.

---

## 5. Fee Claiming (Out of Scope for This Plan)

Jupiter fees accumulate in the referral token account. Claiming them requires:

1. Using the Jupiter DevRel helper scripts (referenced in the [Ultra API docs](../../docs/external_docs/Jupiter%20Docs/Taking%20Transaction%20Fees/Ultra%20API%20-%20Order%20&%20Execute%20with%20Referral%20Accounts%20Script.md))
2. Running `claim-all-fees` periodically (e.g., weekly via cron job)
3. The referral account addresses are already configured in `fees_config.ts`

This is a separate operational concern and not part of the code implementation.

---

## 6. Files to Modify

| File | Change |
|------|--------|
| [`altair_backend1/src/lib/feeResolver.ts`](../../src/lib/feeResolver.ts) | **Create** — fee resolution + referral account lookup + fee computation |
| [`altair_backend1/src/app/api/test-swap/route.ts`](../../src/app/api/test-swap/route.ts) | **Modify** — add `referralAccount` + `feeBps` to Jupiter Ultra order URL; populate `altair.fees` in writeback |
| [`altair_backend1/src/models/Swap.ts`](../../src/models/Swap.ts) | **Modify** — add `bps` field to fee schema default |

---

## 7. Testing Checklist

- [ ] **Unit test** `resolveFeeBps()` with various priority scenarios
- [ ] **Unit test** `computeFeeAmount()` with known amounts and bps values
- [ ] **Integration test**: Execute a Solana swap with fee enabled, verify:
  - Jupiter Ultra URL contains `referralAccount` and `feeBps` params
  - Swap document in MongoDB has `altair.fees` populated with correct token, amount, decimals, bps
  - `balanceUpdates` in writeback response reflect post-fee balances
- [ ] **Regression test**: EVM swaps (0x) are unaffected — fee resolution returns `null` for non-SVM paths
- [ ] **Regression test**: Solana swaps with `UNIVERSAL_FEES.ALL = 0` or `null` — no referral params added to URL

---

## 8. Rollout

1. Merge the code changes
2. Verify on devnet first (SOLANA_DEVNET) — note: Jupiter Ultra may not support devnet; test with mainnet RPC in a controlled environment
3. Monitor swap documents in MongoDB to confirm `altair.fees` is populated
4. After ~1 week of production swaps, run `claim-all-fees` to verify fee accumulation
