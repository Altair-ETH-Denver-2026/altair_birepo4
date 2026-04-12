# Swap API (V1) - Quote, Build & Send (with Referral Accounts) Script

This script demonstrates how to get a quote for a swap, build the swap (with referral accounts), and then send the swap using the Jupiter V1 API. This is useful for when you want to earn fees from the swaps.

## How to set up referral accounts

1. Head to [Jupiter Referral Dashboard](https://referral.jup.ag/dashboard), select the tokens that you want to earn fees from, and create a referral account. From the referral account, you will need to obtain your `Referral Key`.
2. Create a new referral account programatically via the Jupiter Referral SDK

## Prerequisites

- Node.js (v16 or higher)
- npm (v10 or higher)
- Solana Wallet Private Key
- Helius RPC API key
- Jupiter V1 API Key (optional) - get it [here](https://portal.jup.ag/)

## Usage

1. Clone the repository

```bash
git clone https://github.com/Jupiter-DevRel/typescript-examples.git
```

2. Navigate to the `swap/quote-build-send-with-referral-accounts` directory

```bash
cd swap/quote-build-send-with-referral-accounts
```

3. Install the dependencies

```bash
npm install
```

4. Run the script

```bash
npm run example
```

## Create a referral token account

1. Navigate to the `swap/quote-build-send-with-referral-accounts` directory

```bash
cd swap/quote-build-send-with-referral-accounts
```

2. Install the dependencies

```bash
npm install
```

3. Run the script

```bash
npm run create-token-account
```
