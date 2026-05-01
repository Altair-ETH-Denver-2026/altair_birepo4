// lib/feeResolver.ts
// Fee resolution with config-driven priority chain.
// Priority (first non-null wins):
//   1. UNIVERSAL_FEES.ALL
//   2. UNIVERSAL_FEES specific to action
//   3. EVM.ALL / SVM.ALL / BRIDGING.ALL
//   4. EVM / SVM / BRIDGING specific to action, but the same across platforms
//   5. EVM.[platform].ALL / SVM.[platform].ALL / BRIDGING.[platform].ALL
//   6. EVM.[platform] / SVM.[platform] / BRIDGING.[platform] specific to action and platform

import {
  UNIVERSAL_FEES,
  EVM_FEES,
  SVM_FEES,
  BRIDGING_FEES,
  REFERRAL_ACCOUNTS,
} from '../../config/fees_config';

type Action =
  | 'singleChainSwap'
  | 'crossChainSwap'
  | 'bridge'
  | 'liquidityPoolDeposit'
  | 'loanDeposit';

type Platform = 'Jupiter' | '0x' | 'Relay' | 'Helius';

type ChainType = 'EVM' | 'SVM' | 'BRIDGING';

type ResolveFeeParams = {
  action: Action;
  platform?: Platform;
  chainType?: ChainType;
};

type ResolveReferralAccountParams = {
  platform: 'Jupiter';
  apiType: 'Ultra' | 'SwapAndTrigger';
};

/**
 * Resolve the fee percentage for a given action/platform/chain-type combination.
 * Returns the fee as a percentage (e.g., 0.5 for 0.5%), or null if no fee is configured.
 */
export function resolveFeePct(params: ResolveFeeParams): number | null {
  const { action, platform, chainType } = params;

  // Level 1: UNIVERSAL_FEES.ALL
  if (UNIVERSAL_FEES.ALL !== null && UNIVERSAL_FEES.ALL !== undefined) {
    return UNIVERSAL_FEES.ALL;
  }

  // Level 2: UNIVERSAL_FEES[action]
  const universalAction = UNIVERSAL_FEES[action as keyof typeof UNIVERSAL_FEES];
  if (universalAction !== null && universalAction !== undefined) {
    return universalAction;
  }

  // Level 3: chain-type catch-all
  if (chainType === 'EVM' && EVM_FEES.ALL !== null) return EVM_FEES.ALL;
  if (chainType === 'SVM' && SVM_FEES.ALL !== null) return SVM_FEES.ALL;
  if (chainType === 'BRIDGING' && BRIDGING_FEES.ALL !== null) return BRIDGING_FEES.ALL;

  // Level 4: chain-type, action-specific
  if (chainType === 'EVM') {
    const evmAction = EVM_FEES[action as keyof typeof EVM_FEES];
    if (evmAction !== null && evmAction !== undefined && typeof evmAction === 'number') {
      return evmAction;
    }
  }
  if (chainType === 'SVM') {
    const svmAction = SVM_FEES[action as keyof typeof SVM_FEES];
    if (svmAction !== null && svmAction !== undefined && typeof svmAction === 'number') {
      return svmAction;
    }
  }
  if (chainType === 'BRIDGING') {
    const bridgingAction = BRIDGING_FEES[action as keyof typeof BRIDGING_FEES];
    if (bridgingAction !== null && bridgingAction !== undefined && typeof bridgingAction === 'number') {
      return bridgingAction;
    }
  }

  // Level 5: platform catch-all
  if (chainType === 'EVM' && platform) {
    const evmPlatform = EVM_FEES[platform as keyof typeof EVM_FEES];
    if (evmPlatform && typeof evmPlatform === 'object' && 'ALL' in evmPlatform) {
      const platformAll = (evmPlatform as Record<string, number | null>).ALL;
      if (platformAll !== null && platformAll !== undefined) return platformAll;
    }
  }
  if (chainType === 'SVM' && platform) {
    const svmPlatform = SVM_FEES[platform as keyof typeof SVM_FEES];
    if (svmPlatform && typeof svmPlatform === 'object' && 'ALL' in svmPlatform) {
      const platformAll = (svmPlatform as Record<string, number | null>).ALL;
      if (platformAll !== null && platformAll !== undefined) return platformAll;
    }
  }
  if (chainType === 'BRIDGING' && platform) {
    const bridgingPlatform = BRIDGING_FEES[platform as keyof typeof BRIDGING_FEES];
    if (bridgingPlatform && typeof bridgingPlatform === 'object' && 'ALL' in bridgingPlatform) {
      const platformAll = (bridgingPlatform as Record<string, number | null>).ALL;
      if (platformAll !== null && platformAll !== undefined) return platformAll;
    }
  }

  // Level 6: platform + action specific
  if (chainType === 'EVM' && platform) {
    const evmPlatform = EVM_FEES[platform as keyof typeof EVM_FEES];
    if (evmPlatform && typeof evmPlatform === 'object') {
      const platformAction = (evmPlatform as Record<string, number | null>)[action];
      if (platformAction !== null && platformAction !== undefined) return platformAction;
    }
  }
  if (chainType === 'SVM' && platform) {
    const svmPlatform = SVM_FEES[platform as keyof typeof SVM_FEES];
    if (svmPlatform && typeof svmPlatform === 'object') {
      const platformAction = (svmPlatform as Record<string, number | null>)[action];
      if (platformAction !== null && platformAction !== undefined) return platformAction;
    }
  }
  if (chainType === 'BRIDGING' && platform) {
    const bridgingPlatform = BRIDGING_FEES[platform as keyof typeof BRIDGING_FEES];
    if (bridgingPlatform && typeof bridgingPlatform === 'object') {
      const platformAction = (bridgingPlatform as Record<string, number | null>)[action];
      if (platformAction !== null && platformAction !== undefined) return platformAction;
    }
  }

  return null;
}

/**
 * Resolve the referral account address for a given platform and API type.
 */
export function resolveReferralAccount(
  params: ResolveReferralAccountParams
): string | null {
  const { platform, apiType } = params;

  if (platform === 'Jupiter') {
    const jupiterAccounts = REFERRAL_ACCOUNTS.Jupiter;
    if (!jupiterAccounts) return null;
    return jupiterAccounts[apiType] ?? null;
  }

  return null;
}

/**
 * Compute the fee amount in raw units for a given amount and fee bps.
 * Formula: amountRaw * feeBps / 10000
 */
export function computeFeeAmount(
  amountRaw: string | null | undefined,
  feeBps: number
): string {
  if (!amountRaw) return '0';
  try {
    const amount = BigInt(amountRaw);
    if (amount <= 0n) return '0';
    const fee = (amount * BigInt(feeBps)) / 10000n;
    return fee.toString();
  } catch {
    return '0';
  }
}

/**
 * Convert a fee percentage (e.g., 0.5 for 0.5%) to basis points (e.g., 50).
 */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}
