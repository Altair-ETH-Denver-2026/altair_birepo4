# Altair - Cryptocurrency Swapping & Bridging with LLM Chat UI

Altair is a modern cryptocurrency swapping and bridging application that allows users to execute transactions through natural language conversations with an AI assistant. The application features embedded wallets, high-accuracy balance tracking, and a modular UI system.

## Architecture Overview

The application follows a modern full-stack architecture:

- **Frontend**: Next.js with TypeScript, React components, and custom hooks
- **Backend**: Next.js API routes with MongoDB integration
- **Key Technologies**: Privy for embedded wallets, MongoDB for balance tracking, 0G storage for chat history, Uniswap/Jupiter for swap execution

## Core Features

### PANEL System Implementation

The PANEL system is a custom, modular UI system with the following characteristics:

- **Two Panel Types**: 
  - `WalletPanel`: Displays balances and allows withdrawals
  - `AddPanel`: Adds new wallet panel instances
- **Modular Design**: Base `Panel` component with logo and close functionality
- **Persistent UI**: Panels don't dismiss on outside clicks (as documented in `Panels.md`)
- **State Management**: `usePanels` hook manages panel state (`walletPanels`, `isWalletPanelOpen`)
- **Extensible**: Code is structured to support additional panel types in the future

### LLM Chat UI & Swap Execution

The chat interface enables natural language cryptocurrency transactions:

- **Natural Language Processing**: Users type intents, AI extracts JSON swap intents
- **Swap Intent Extraction**: `extractSwapIntent()` function in [`Chat.tsx`](altair_frontend1/src/components/Chat.tsx) parses user messages
- **AI Integration**: Backend chat API ([`route.ts`](altair_backend1/src/app/api/chat/route.ts)) uses multiple LLM providers (OpenAI, Groq, Anthropic) with fallback
- **Swap Execution**: 
  - Uses `/api/test-swap` for EVM chains (Uniswap-like routing)
  - Uses Jupiter for Solana swaps
- **Confirmation Flow**: Chat button rows for user confirmation before execution

### Privy Embedded Wallets

Privy integration provides server-side wallet management:

- **Server-Side Wallet Management**: [`privy.ts`](altair_backend1/src/lib/privy.ts) handles embedded wallet creation and management
- **Dual Chain Support**: Functions for both EVM (`getPrivyEvmWalletAddress`) and Solana (`getPrivySolanaWalletAddress`)
- **No Traditional Web Wallets**: No MetaMask or traditional wallet integration required
- **Embedded Wallet Creation**: `ensurePrivyEmbeddedEvmWallet` and `ensurePrivyEmbeddedSolanaWallet` create wallets on-demand

### MongoDB Balance Tracking with Enhanced Accuracy

The balance tracking system provides higher accuracy than traditional DeFi apps:

- **MongoDB as Source of Truth**: User balances stored in MongoDB with chain-specific schemas
- **Smart Caching Strategy**:
  - Client-side localStorage caching for immediate UI updates
  - MongoDB verification with 5-minute staleness threshold (`shouldVerifyBalances`)
  - Async blockchain verification in background (see [`balances/route.ts`](altair_backend1/src/app/api/balances/route.ts) lines 361-372)
- **Reduced Blockchain Calls**: Only verifies against blockchain when cache is stale or forced
- **Balance Verification Logic**: `mergeBalanceUpdates` prioritizes blockchain values over cached values

## Project Structure

```
altair_birepo4/
├── altair_backend1/          # Backend API server
│   ├── src/app/api/         # API routes
│   ├── src/lib/             # Shared libraries
│   ├── src/models/          # MongoDB models
│   └── config/              # Configuration files
├── altair_frontend1/        # Frontend UI
│   ├── src/app/            # Next.js app router
│   ├── src/components/     # React components
│   ├── src/lib/            # Frontend libraries
│   └── config/             # UI configuration
└── README.md               # This file
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- MongoDB instance
- Privy account for embedded wallets
- API keys for LLM providers (OpenAI, Groq, or Anthropic)

### Backend Setup

1. Navigate to `altair_backend1/`:
   ```bash
   cd altair_backend1
   ```

2. Install dependencies:
   ```bash
   corepack yarn install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys and configuration
   ```

4. Run the backend:
   ```bash
   corepack yarn dev
   ```
   Backend runs at `http://localhost:3001`

### Frontend Setup

1. Navigate to `altair_frontend1/`:
   ```bash
   cd altair_frontend1
   ```

2. Install dependencies:
   ```bash
   corepack yarn install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. Run the frontend:
   ```bash
   corepack yarn dev
   ```
   Frontend runs at `http://localhost:3000`

## Key Configuration Files

- **Backend Configuration**:
  - [`config/blockchain_config.ts`](altair_backend1/config/blockchain_config.ts): Chain and token configurations
  - [`config/ai_config.ts`](altair_backend1/config/ai_config.ts): LLM provider settings
  - [`config/mongodb_config.ts`](altair_backend1/config/mongodb_config.ts): Database configuration

- **Frontend Configuration**:
  - [`config/ui_config.ts`](altair_frontend1/config/ui_config.ts): UI styling and panel configuration
  - [`config/chain_info.ts`](altair_frontend1/config/chain_info.ts): Chain information for frontend
  - [`config/external_links.ts`](altair_frontend1/config/external_links.ts): External resource links

## Development Notes

- **PANEL System Documentation**: Detailed documentation available in [`altair_backend1/docs/dev_notes/Panels.md`](altair_backend1/docs/dev_notes/Panels.md)
- **Balance Tracking**: The system minimizes blockchain calls by using MongoDB as the source of truth with periodic verification
- **Swap Execution**: Supports both EVM chains (via Uniswap-like routing) and Solana (via Jupiter)
- **Chat History**: Persisted using 0G decentralized storage for user memory and conversation history

## API Endpoints

### Backend API Routes

- `POST /api/chat` - Process chat messages and execute swap intents
- `POST /api/balances` - Retrieve and verify user balances
- `POST /api/test-swap` - Execute test swaps (EVM chains)
- `POST /api/auth/login` - User authentication
- `POST /api/user/sync` - User data synchronization

## License

[Add appropriate license information]

## Support

For issues and feature requests, please use the project's issue tracker.