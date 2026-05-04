// Fee Prioritization:
//  1. UNIVERSAL_FEES.ALL
//  2. UNIVERSAL_FEES specific to action
//  3. EVM.ALL / SVM.ALL / BRIDGING.ALL
//  4. EVM / SVM / BRIDGING specific to action, but the same across platforms
//  5. EVM.[platform].ALL / SVM.[platform].ALL / BRIDGING.[platform].ALL
//  6. EVM.[platform] / SVM.[platform] / BRIDGING.[platform] specific to action and platform

export const FEE_RECIPIENT_ADDRESSES = {
    ETH_MAINNET: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935',
    ETH_SEPOLIA: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935',
    BASE_SEPOLIA: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935',
    BASE_MAINNET: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935',
    SOLANA_MAINNET: 'AfxJVaUqjyy8qwf6BKEmwAXCQ4WWJssAmzWPgNtRuRv9',
    SOLANA_DEVNET: 'AfxJVaUqjyy8qwf6BKEmwAXCQ4WWJssAmzWPgNtRuRv9',
    CROSS_CHAIN_SWAP: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935',
    BRIDGE: '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935'
};

// Relay uses a single wallet address for fee accumulation across all chains.
// This wallet will claim fees via Relay's /app-fees/{wallet}/claim API.
export const RELAY_FEE_RECIPIENT = '0xfA7b97Bc73521B5A9cfFF6F4863f91bf84810935';

export const REFERRAL_ACCOUNTS = {
    Jupiter: {
        SwapAndTrigger: 'FeuYEwwvQHtuVNNspXVUrg4AoDw1pybL9V3BNKYamv2Y',
        Ultra: '5i4S34dC7gHY9CBC92sDdH7ciCLgduAPb57k3AFU7NP4'
    }
};

export const UNIVERSAL_FEES = {
    ALL: 0.5,
    singleChainSwap: null,
    crossChainSwap: null,
    bridge: null,
    liquidityPoolDeposit: null,
    loanDeposit: null
};

export const EVM_FEES = {
    ALL: null,
    singleChainSwap: null,
    liquidityPoolDeposit: null,
    loanDeposit: null,
    '0x': {
        ALL: null,
        singleChainSwap: null,
        liquidityPoolDeposit: null,
        loanDeposit: null
    }
}

export const SVM_FEES = {
    ALL: null,
    singleChainSwap: null,
    liquidityPoolDeposit: null,
    loanDeposit: null,
    Helius: {
        singleChainSwap: null,
        liquidityPoolDeposit: null,
        loanDeposit: null
    }
}

export const BRIDGING_FEES = {
    ALL: null,
    singleChainSwap: null,
    crossChainSwap: null,
    Relay: {
        singleChainSwap: null,
        crossChainSwap: null,
    }
};