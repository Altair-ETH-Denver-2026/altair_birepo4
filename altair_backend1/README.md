# Altair Backend (API)

This repository contains the server-side API routes for Altair.

## Run Locally

```bash
corepack yarn install
corepack yarn dev
```

Backend runs at `http://localhost:3001`.

## Environment Variables

Copy `.env.example` to `.env` and fill in values.

- `NEXT_PUBLIC_PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `PRIVY_VERIFICATION_KEY`
- `PRIVY_WALLET_AUTH_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `ZEROX_API_KEY` (optional)
- `MONGODB_URI`
- `MONGODB_DB`
- `ZG_PRIVATE_KEY`
- `ZG_RPC_URL` (default: `https://evmrpc-testnet.0g.ai`)
- `ZG_INDEXER_RPC` (default: `https://indexer-storage-testnet-turbo.0g.ai`)
- `ZG_NETWORK` (default: `testnet`)
- `ZG_STORAGE_MODE=onchain_0g|hybrid|local_only` (default `hybrid`)
- `ZG_ENABLE_LOCAL_FALLBACK=true|false` (default `true`)
- `ZG_CIRCUIT_BREAKER_THRESHOLD` (default `3`)
- `ZG_CIRCUIT_BREAKER_COOLDOWN_MS` (default `300000`)
- `ZG_LOCAL_FALLBACK_PATH` (default `.cache/zg-memory-fallback.json`)
- `ZG_LOCAL_INDEX_PATH` (default `.cache/zg-storage-index.json`)
*** Add File: altair_backend/.env.example
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_VERIFICATION_KEY=
PRIVY_WALLET_AUTH_PRIVATE_KEY=

OPENAI_API_KEY=
ZEROX_API_KEY=

ZG_PRIVATE_KEY=
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_INDEXER_RPC=https://indexer-storage-testnet-turbo.0g.ai
ZG_NETWORK=testnet
ZG_STORAGE_MODE=hybrid
ZG_ENABLE_LOCAL_FALLBACK=true
ZG_CIRCUIT_BREAKER_THRESHOLD=3
ZG_CIRCUIT_BREAKER_COOLDOWN_MS=300000
ZG_LOCAL_FALLBACK_PATH=.cache/zg-memory-fallback.json
ZG_LOCAL_INDEX_PATH=.cache/zg-storage-index.json
