# Altair - Cryptocurrency Swapping & Bridging with LLM Chat UI

Altair is a full-stack crypto app that executes swaps/bridges from conversational intents, supports Privy embedded wallets for EVM + Solana, and maintains a multi-layer balance system designed for fast UX plus durable reconciliation.

## Architecture Overview

- **Frontend**: Next.js + TypeScript + React components/hooks in [`altair_frontend1`](altair_frontend1/)
- **Backend**: Next.js API routes + MongoDB models/services in [`altair_backend1`](altair_backend1/)
- **Wallet/Auth**: Privy embedded wallet flows via [`privy.ts`](altair_backend1/src/lib/privy.ts)
- **Balance persistence**: MongoDB `User.balances` + chain verification via [`/api/balances`](altair_backend1/src/app/api/balances/route.ts)
- **Swap/bridge providers**: EVM paths + Solana paths + Relay bridge flow

---

## Core Product Flows

### Chat → intent → execution

- Chat orchestration in [`Chat.tsx`](altair_frontend1/src/components/Chat.tsx)
- Backend chat processing in [`/api/chat`](altair_backend1/src/app/api/chat/route.ts)
- EVM swap writeback in [`/api/test-swap`](altair_backend1/src/app/api/test-swap/route.ts)
- Relay bridge/writeback in [`/api/relay/writeback`](altair_backend1/src/app/api/relay/writeback/route.ts)

### Wallet display modes (panel/dropdown)

- Config-driven by [`WALLET_DISPLAY`](altair_frontend1/config/ui_config.ts)
- Shared balance render state in [`UserMenu.tsx`](altair_frontend1/src/components/UserMenu.tsx)
- PANEL behavior documented in [`Panels.md`](altair_backend1/docs/dev_notes/Panels.md)

---

## Balance System (Current Behavior)

### Three-layer model

1. **Frontend immediate state/cache** (fast UI):
   - in-memory `balancesByChain` + localStorage in [`UserMenu.tsx`](altair_frontend1/src/components/UserMenu.tsx)
2. **Mongo durable state**:
   - `User.balances` in [`User.ts`](altair_backend1/src/models/User.ts)
3. **On-chain verification**:
   - EVM multi-chain via Alchemy Portfolio and Solana RPC in [`/api/balances`](altair_backend1/src/app/api/balances/route.ts)

### `/api/balances` strategy

- Fast path: return Mongo snapshot first when available, then async verify/write.
- Force path: fetch on-chain now, return verified payload, write/update Mongo.
- EVM verification is batched across EVM chains to reduce calls.

### Collision-safe symbol handling

- Mongo schema supports `chain -> symbol -> BalanceEntry[]`.
- Updates are address-aware in [`updateBalancesInMongoDB()`](altair_backend1/src/lib/balanceService.ts), so same-symbol/different-address tokens do not overwrite each other.
- Default read paths still use index `0` for symbol-level UX compatibility.

### Native token protection

- EVM native token entry is protected from non-native same-symbol overwrite during balance ingestion in [`/api/balances`](altair_backend1/src/app/api/balances/route.ts).

### Swap-complete behavior

- Frontend dispatches `altair:swap-complete` from swap/relay flows (immediate local update).
- Wallet logic applies instant updates and now force-refreshes all affected chains for faster durable convergence in [`handleSwapComplete()`](altair_frontend1/src/components/UserMenu.tsx).
- Relay writeback now also persists `sellToken` and `buyToken` `balanceAfter` snapshots directly to `User.balances` in [`/api/relay/writeback`](altair_backend1/src/app/api/relay/writeback/route.ts).

For full details, see:
- [`Balances.md`](altair_backend1/docs/dev_notes/Balances.md)
- [`MongoDB.md`](altair_backend1/docs/dev_notes/MongoDB.md)
- [`Panels.md`](altair_backend1/docs/dev_notes/Panels.md)

---

## Project Structure

```
altair_birepo4/
├── altair_backend1/
│   ├── src/app/api/
│   ├── src/lib/
│   ├── src/models/
│   ├── config/
│   └── docs/dev_notes/
├── altair_frontend1/
│   ├── src/app/
│   ├── src/components/
│   ├── src/lib/
│   └── config/
└── README.md
```

---

## Setup

### Prerequisites

- Node.js 18+
- MongoDB
- Privy credentials
- Required API keys (LLM + chain providers)

### Backend

```bash
cd altair_backend1
corepack yarn install
corepack yarn dev
```

### Frontend

```bash
cd altair_frontend1
corepack yarn install
corepack yarn dev
```

---

## Key Files

- Balance API: [`altair_backend1/src/app/api/balances/route.ts`](altair_backend1/src/app/api/balances/route.ts)
- Balance persistence service: [`altair_backend1/src/lib/balanceService.ts`](altair_backend1/src/lib/balanceService.ts)
- Relay writeback: [`altair_backend1/src/app/api/relay/writeback/route.ts`](altair_backend1/src/app/api/relay/writeback/route.ts)
- Wallet UI state/reconciliation: [`altair_frontend1/src/components/UserMenu.tsx`](altair_frontend1/src/components/UserMenu.tsx)
- Relay execution flow: [`altair_frontend1/src/lib/useRelay.ts`](altair_frontend1/src/lib/useRelay.ts)

---

## Developer Notes

- Diagnostics are developer/operator-facing (logs/telemetry), not user-facing product messaging.
- Frontend updates are intentionally fast; authoritative persistence converges through backend write/verification paths.
