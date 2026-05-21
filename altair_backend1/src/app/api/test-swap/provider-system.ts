// Provider fallback and retry system for swap operations
// This module handles iterating through provider options with retry logic

import { type ChainKey, SWAP_PROVIDER_OPTIONS } from '../../../../config/blockchain_config';

export type SwapProvider = '0x v1' | '0x v2' | 'Jupiter Ultra' | 'Relay';

export type ProviderAttemptContext = {
  provider: SwapProvider;
  attemptNumber: number;
  totalAttempts: number;
  isLastAttempt: boolean;
};

export type ProviderError = {
  provider: SwapProvider;
  attemptNumber: number;
  error: unknown;
  shouldRetry: boolean;
  reason?: string;
};

/**
 * Determines if an error should trigger a fallback to the next provider
 */
export function shouldFallbackToNextProvider(error: unknown): boolean {
  if (!error) return false;
  
  const errorString = error instanceof Error ? error.message : String(error);
  const errorLower = errorString.toLowerCase();
  
  // Errors that should trigger provider fallback
  const fallbackTriggers = [
    'swap_validation_failed',
    'no liquidity',
    'unsupported token',
    'no route',
    'no swap route',
    'insufficient liquidity',
    'token not supported',
  ];
  
  return fallbackTriggers.some(trigger => errorLower.includes(trigger));
}

/**
 * Determines if an error should trigger a retry with the same provider
 */
export function shouldRetryWithSameProvider(error: unknown): boolean {
  if (!error) return false;
  
  const errorString = error instanceof Error ? error.message : String(error);
  const errorLower = errorString.toLowerCase();
  
  // Errors that should trigger same-provider retry (transient errors)
  const retryTriggers = [
    'rate limit',
    'timeout',
    'network',
    'econnreset',
    'enotfound',
    'etimedout',
  ];
  
  return retryTriggers.some(trigger => errorLower.includes(trigger));
}

/**
 * Gets the list of providers to try for a given chain
 */
export function getProvidersForChain(chainKey: ChainKey): SwapProvider[] {
  const providers = SWAP_PROVIDER_OPTIONS[chainKey as keyof typeof SWAP_PROVIDER_OPTIONS];
  if (Array.isArray(providers)) {
    return providers as SwapProvider[];
  }
  // Fallback to default providers if not configured
  if (chainKey === 'SOLANA_MAINNET' || chainKey === 'SOLANA_DEVNET') {
    return ['Jupiter Ultra'];
  }
  return ['0x v2', '0x v1'];
}

/**
 * Creates an iterator for provider attempts with retry logic
 */
export function* createProviderAttemptIterator(
  chainKey: ChainKey
): Generator<ProviderAttemptContext, void, ProviderError | null> {
  const providers = getProvidersForChain(chainKey);
  const maxIterations = SWAP_PROVIDER_OPTIONS.maxAttemptsPerOption || 2;
  const isInfinite = maxIterations === 0;
  
  let globalAttemptNumber = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 10; // Safety limit for infinite mode
  
  console.log(`[provider-system] Starting provider iteration with ${providers.length} providers: ${providers.join(', ')}`);
  console.log(`[provider-system] maxIterations (maxAttemptsPerOption): ${maxIterations}, isInfinite: ${isInfinite}`);
  
  // Iterate through the provider list maxIterations times
  for (let iteration = 1; iteration <= (isInfinite ? 1 : maxIterations); iteration++) {
    console.log(`[provider-system] Beginning iteration ${iteration}/${maxIterations} through provider list`);
    
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      globalAttemptNumber++;
      
      // Safety check for infinite mode
      if (isInfinite && consecutiveFailures >= maxConsecutiveFailures) {
        console.error('[provider-system] Max consecutive failures reached in infinite mode, stopping');
        return;
      }
      
      const totalAttempts = isInfinite ? Infinity : providers.length * maxIterations;
      const isLastIteration = iteration === maxIterations;
      const isLastProvider = i === providers.length - 1;
      const isLastAttempt = !isInfinite && isLastIteration && isLastProvider;
      
      console.log(`[provider-system] Trying provider ${i + 1}/${providers.length}: ${provider} (iteration ${iteration}/${maxIterations}, global attempt ${globalAttemptNumber})`);
      
      const context: ProviderAttemptContext = {
        provider,
        attemptNumber: globalAttemptNumber,
        totalAttempts,
        isLastAttempt,
      };
      
      // Yield the attempt context and wait for result
      console.log(`[provider-system] Yielding context for ${provider}`);
      const result = yield context;
      console.log(`[provider-system] Received result for ${provider}:`, result ? 'ERROR' : 'SUCCESS');
      
      // If no error (success), we're done
      if (!result) {
        console.log(`[provider-system] Success! Exiting iterator`);
        return;
      }
      
      // Handle error
      consecutiveFailures++;
      console.log(`[provider-system] Attempt failed for ${provider}, continuing to next provider in list`);
    }
    
    console.log(`[provider-system] Completed iteration ${iteration}/${maxIterations} through provider list`);
    
    // If we've exhausted all iterations and we're not in infinite mode, stop
    if (!isInfinite && iteration === maxIterations) {
      console.log(`[provider-system] Exhausted all ${maxIterations} iterations through provider list, exiting iterator`);
      return;
    }
    
    // In infinite mode, loop continues indefinitely
    if (isInfinite) {
      console.log(`[provider-system] Infinite mode: restarting provider list iteration`);
      iteration = 0; // Reset to continue infinite loop
    }
  }
}

/**
 * Executes a swap operation with provider fallback and retry logic
 */
export async function executeWithProviderFallback<T>(
  chainKey: ChainKey,
  operation: (context: ProviderAttemptContext) => Promise<T>
): Promise<T> {
  const iterator = createProviderAttemptIterator(chainKey);
  let lastError: unknown = null;
  let lastResult: ProviderError | null = null;
  
  while (true) {
    // Get next context - pass the result from the previous attempt
    const { value: context, done } = iterator.next(lastResult);
    
    if (done) {
      // All attempts exhausted
      throw lastError || new Error('All provider attempts exhausted');
    }
    
    try {
      console.log(`[provider-system] Attempting swap with ${context.provider} (attempt ${context.attemptNumber}/${context.totalAttempts === Infinity ? '∞' : context.totalAttempts})`);
      
      const result = await operation(context);
      
      console.log(`[provider-system] Swap succeeded with ${context.provider} on attempt ${context.attemptNumber}`);
      return result;
    } catch (error) {
      lastError = error;
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[provider-system] Swap failed with ${context.provider}:`, errorMessage);
      
      // Create error feedback for iterator
      lastResult = {
        provider: context.provider,
        attemptNumber: context.attemptNumber,
        error,
        shouldRetry: shouldRetryWithSameProvider(error),
        reason: shouldFallbackToNextProvider(error) ? 'fallback' : shouldRetryWithSameProvider(error) ? 'retry' : 'fatal',
      };
      
      // Continue to next iteration - the error will be sent via lastResult
    }
  }
}
