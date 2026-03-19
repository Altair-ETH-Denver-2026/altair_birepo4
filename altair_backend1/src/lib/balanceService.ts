import { User } from '@/models/User';
import { connectToDatabase } from '@/lib/db';
import { withWaitLogger } from '@/lib/waitLogger';
import { ChainKey, DEFAULT_TOKENS, CHAINS } from '../../config/blockchain_config';
import * as EthTokens from '../../config/token_info/eth_tokens';
import * as EthSepoliaTokens from '../../config/token_info/eth_sepolia_testnet_tokens';
import * as BaseTokens from '../../config/token_info/base_tokens';
import * as BaseSepoliaTokens from '../../config/token_info/base_testnet_sepolia_tokens';
import * as SolanaTokens from '../../config/token_info/solana_tokens';
import type { TokenInfo } from '../../config/token_info/types';

// Note: Using chain keys (SOLANA_MAINNET) directly for consistency
// Previously used chain labels (Solana, Ethereum, Base) but now using chain keys

export interface BalanceEntry {
  symbol: string;
  balance: string; // Raw balance string
  decimals: number;
  address?: string;
  name?: string;
  verifiedAt?: number; // Timestamp of last blockchain verification
  source?: 'cache' | 'mongo' | 'blockchain';
}

export interface BalancesByChain {
  [chainKey: string]: {
    [tokenSymbol: string]: BalanceEntry;
  };
}

export interface UserBalances {
  uid: string;
  balancesByChain: BalancesByChain;
  lastUpdated: Date;
  lastBlockchainVerification?: Date;
  version: number; // For optimistic concurrency control
}

/**
 * Get balances from MongoDB for a specific user and chain
 * Returns null if no balances found
 * Uses chain keys (SOLANA_MAINNET) with backward compatibility for chain labels
 */
export async function getBalancesFromMongoDB(
  uid: string,
  chainKey: ChainKey
): Promise<Record<string, BalanceEntry> | null> {
  await connectToDatabase();
  
  try {
    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.findOne',
        description: 'fetch user balances from MongoDB',
      },
      () => User.findOne({ UID: uid }).lean()
    );

    if (!user || !user.balances) {
      return null;
    }

    const balances = user.balances as any;
    let chainBalances: Record<string, BalanceEntry> | null = null;
    
    // First try to get balances using chain key (new schema)
    if (balances[chainKey]) {
      const keyBalances = balances[chainKey];
      
      // Check if it's in array format (new schema) or object format (old schema)
      if (Array.isArray(keyBalances)) {
        // Array format - shouldn't happen at top level, but handle just in case
        console.warn(`Unexpected array format for balances.${chainKey}`);
        return null;
      } else if (typeof keyBalances === 'object') {
        // Could be object format (old) or object with arrays (new array format)
        const firstKey = Object.keys(keyBalances)[0];
        if (firstKey && Array.isArray(keyBalances[firstKey])) {
          // New array format: { TOKEN: [{...}] }
          const convertedBalances: Record<string, BalanceEntry> = {};
          Object.entries(keyBalances as Record<string, BalanceEntry[]>).forEach(([symbol, entries]) => {
            if (Array.isArray(entries) && entries.length > 0) {
              convertedBalances[symbol] = entries[0];
            }
          });
          chainBalances = convertedBalances;
        } else {
          // Old object format: { TOKEN: {...} }
          chainBalances = keyBalances as Record<string, BalanceEntry>;
        }
      }
    }
    // Fallback to chain label (old schema for backward compatibility)
    else {
      // Determine chain label for backward compatibility
      let chainLabel: string;
      switch (chainKey) {
        case 'ETH_MAINNET':
        case 'ETH_SEPOLIA':
          chainLabel = 'Ethereum';
          break;
        case 'BASE_MAINNET':
        case 'BASE_SEPOLIA':
          chainLabel = 'Base';
          break;
        case 'SOLANA_MAINNET':
          chainLabel = 'Solana';
          break;
        default:
          chainLabel = chainKey;
      }
      
      if (balances[chainLabel]) {
        const labelBalances = balances[chainLabel] as Record<string, BalanceEntry[]>;
        
        // Convert from array format to object format (take first element of each array)
        const convertedBalances: Record<string, BalanceEntry> = {};
        Object.entries(labelBalances).forEach(([symbol, entries]) => {
          if (Array.isArray(entries) && entries.length > 0) {
            convertedBalances[symbol] = entries[0];
          }
        });
        
        chainBalances = convertedBalances;
      }
    }
    
    if (!chainBalances) {
      return null;
    }

    // Return all tokens from user's MongoDB balances (no filtering by DEFAULT_TOKENS)
    return chainBalances;
  } catch (error) {
    console.error('Error fetching balances from MongoDB:', error);
    return null;
  }
}

/**
 * Update balances in MongoDB for a specific user and chain
 * Uses chain keys (SOLANA_MAINNET) and array format
 */
export async function updateBalancesInMongoDB(
  uid: string,
  chainKey: ChainKey,
  balances: Record<string, BalanceEntry>,
  source: 'blockchain' | 'cache' | 'mongo' = 'blockchain'
): Promise<boolean> {
  await connectToDatabase();
  
  try {
    // Convert to array format
    const chainBalances: Record<string, any> = {};
    
    Object.entries(balances).forEach(([symbol, entry]) => {
      chainBalances[symbol] = [entry];
    });

    const updateData: any = {
      [`balances.${chainKey}`]: chainBalances,
      lastSeenAt: new Date(),
    };

    const result = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.updateOne',
        description: 'update user balances in MongoDB',
      },
      () => User.updateOne(
        { UID: uid },
        { $set: updateData }
      )
    );

    if (result.matchedCount === 0) {
      console.warn(`[balances] skipped balance update; user not found for UID ${uid}`);
      return false;
    }

    return result.modifiedCount > 0;
  } catch (error) {
    console.error('Error updating balances in MongoDB:', error);
    return false;
  }
}

/**
 * Get all chains that have balances for a specific user
 * Checks chain keys with backward compatibility for chain labels
 */
export async function getChainsWithBalances(uid: string): Promise<ChainKey[]> {
  await connectToDatabase();
  
  try {
    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.findOne',
        description: 'fetch user to get chains with balances',
      },
      () => User.findOne({ UID: uid }).lean()
    );

    if (!user || !user.balances) {
      return [];
    }

    const balances = user.balances as any;
    const chains: ChainKey[] = [];
    
    // Check each possible chain key
    const allChainKeys = Object.keys(CHAINS) as ChainKey[];
    for (const chainKey of allChainKeys) {
      // Check for chain key (new schema)
      if (balances[chainKey]) {
        const chainBalances = balances[chainKey];
        // Check if there are any token entries
        if (typeof chainBalances === 'object') {
          const hasEntries = Object.values(chainBalances).some(
            (entries: any) => {
              if (Array.isArray(entries)) {
                return entries.length > 0;
              }
              // Could be object format (old)
              return true;
            }
          );
          if (hasEntries) {
            chains.push(chainKey);
            continue;
          }
        }
      }
      
      // Check for chain label (old schema for backward compatibility)
      let chainLabel: string;
      switch (chainKey) {
        case 'ETH_MAINNET':
        case 'ETH_SEPOLIA':
          chainLabel = 'Ethereum';
          break;
        case 'BASE_MAINNET':
        case 'BASE_SEPOLIA':
          chainLabel = 'Base';
          break;
        case 'SOLANA_MAINNET':
          chainLabel = 'Solana';
          break;
        default:
          chainLabel = chainKey;
      }
      
      if (balances[chainLabel]) {
        const labelBalances = balances[chainLabel] as Record<string, any>;
        // Check if there are any token entries (array with at least one element)
        const hasEntries = Object.values(labelBalances).some(
          (entries: any) => Array.isArray(entries) && entries.length > 0
        );
        if (hasEntries) {
          chains.push(chainKey);
        }
      }
    }

    return chains;
  } catch (error) {
    console.error('Error getting chains with balances:', error);
    return [];
  }
}

/**
 * Get all tokens across all chains for a user
 * Handles chain keys with backward compatibility for chain labels
 */
export async function getAllUserTokens(uid: string): Promise<Record<ChainKey, Record<string, BalanceEntry>>> {
  await connectToDatabase();
  
  try {
    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.findOne',
        description: 'fetch all user balances',
      },
      () => User.findOne({ UID: uid }).lean()
    );

    if (!user || !user.balances) {
      return {} as Record<ChainKey, Record<string, BalanceEntry>>;
    }

    const balances = user.balances as any;
    const result: Record<ChainKey, Record<string, BalanceEntry>> = {} as Record<ChainKey, Record<string, BalanceEntry>>;
    
    // Check each possible chain key
    const allChainKeys = Object.keys(CHAINS) as ChainKey[];
    for (const chainKey of allChainKeys) {
      let chainBalances: Record<string, BalanceEntry> | null = null;
      
      // First try chain key (new schema)
      if (balances[chainKey]) {
        const keyBalances = balances[chainKey];
        
        // Check if it's in array format or object format
        if (typeof keyBalances === 'object') {
          const firstKey = Object.keys(keyBalances)[0];
          if (firstKey && Array.isArray(keyBalances[firstKey])) {
            // New array format: { TOKEN: [{...}] }
            const convertedBalances: Record<string, BalanceEntry> = {};
            Object.entries(keyBalances as Record<string, BalanceEntry[]>).forEach(([symbol, entries]) => {
              if (Array.isArray(entries) && entries.length > 0) {
                convertedBalances[symbol] = entries[0];
              }
            });
            chainBalances = convertedBalances;
          } else {
            // Old object format: { TOKEN: {...} }
            chainBalances = keyBalances as Record<string, BalanceEntry>;
          }
        }
      }
      // Then try chain label (old schema for backward compatibility)
      else {
        // Determine chain label for backward compatibility
        let chainLabel: string;
        switch (chainKey) {
          case 'ETH_MAINNET':
          case 'ETH_SEPOLIA':
            chainLabel = 'Ethereum';
            break;
          case 'BASE_MAINNET':
          case 'BASE_SEPOLIA':
            chainLabel = 'Base';
            break;
          case 'SOLANA_MAINNET':
            chainLabel = 'Solana';
            break;
          default:
            chainLabel = chainKey;
        }
        
        if (balances[chainLabel]) {
          const labelBalances = balances[chainLabel] as Record<string, BalanceEntry[]>;
          // Convert from array format to object format (take first element of each array)
          const convertedBalances: Record<string, BalanceEntry> = {};
          Object.entries(labelBalances).forEach(([symbol, entries]) => {
            if (Array.isArray(entries) && entries.length > 0) {
              convertedBalances[symbol] = entries[0];
            }
          });
          
          if (Object.keys(convertedBalances).length > 0) {
            chainBalances = convertedBalances;
          }
        }
      }
      
      if (chainBalances) {
        result[chainKey] = chainBalances;
      }
    }

    return result;
  } catch (error) {
    console.error('Error getting all user tokens:', error);
    return {} as Record<ChainKey, Record<string, BalanceEntry>>;
  }
}

/**
 * Get the user's UID from access token
 */
export async function getUIDFromAccessToken(accessToken: string): Promise<string | null> {
  await connectToDatabase();
  
  try {
    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.findOne',
        description: 'find user by access token',
      },
      () => User.findOne({ 
        $or: [
          { 'linkedAccounts.subject': accessToken },
          { evmAddress: accessToken },
          { solAddress: accessToken }
        ]
      }).lean()
    );

    return user?.UID || null;
  } catch (error) {
    console.error('Error getting UID from access token:', error);
    return null;
  }
}

/**
 * Check if balances need verification (stale or never verified)
 */
export function shouldVerifyBalances(
  balances: Record<string, BalanceEntry> | null,
  maxAgeMs: number = 5 * 60 * 1000 // 5 minutes default
): boolean {
  if (!balances) {
    return true; // No balances, need verification
  }

  // Check metadata for last verification
  const metadata = (balances as any).$metadata;
  if (metadata?.lastBlockchainVerification) {
    const lastVerification = new Date(metadata.lastBlockchainVerification).getTime();
    const now = Date.now();
    return (now - lastVerification) > maxAgeMs;
  }

  return true; // No verification timestamp, need verification
}

/**
 * Merge balance updates, preferring newer/blockchain values
 */
export function mergeBalanceUpdates(
  existing: Record<string, BalanceEntry>,
  updates: Record<string, BalanceEntry>,
  source: 'blockchain' | 'cache' | 'mongo'
): Record<string, BalanceEntry> {
  const merged = { ...existing };
  
  for (const [symbol, update] of Object.entries(updates)) {
    const existingEntry = existing[symbol];
    
    if (!existingEntry) {
      // New token
      merged[symbol] = {
        ...update,
        source,
        verifiedAt: source === 'blockchain' ? Date.now() : update.verifiedAt
      };
    } else if (source === 'blockchain') {
      // Blockchain source always wins
      merged[symbol] = {
        ...update,
        source: 'blockchain',
        verifiedAt: Date.now()
      };
    } else if ((source === 'cache' || source === 'mongo') && existingEntry.source !== 'blockchain') {
      // Cache or mongo only updates if not already blockchain-verified
      merged[symbol] = {
        ...update,
        source,
        verifiedAt: update.verifiedAt || existingEntry.verifiedAt
      };
    }
    // Otherwise keep existing blockchain-verified entry
  }

  // Add metadata
  (merged as any).$metadata = {
    lastUpdated: new Date().toISOString(),
    source: source === 'blockchain' ? 'blockchain' : (source === 'mongo' ? 'mongo' : ((existing as any).$metadata?.source || 'cache'))
  };

  return merged;
}

/**
 * Schedule async blockchain verification for all user tokens across all chains
 * This would be called from the main balance endpoint to trigger background verification
 */
export async function scheduleBlockchainVerificationForAllUserTokens(
  uid: string,
  accessToken: string
): Promise<void> {
  try {
    // Get all chains with balances for this user
    const chains = await getChainsWithBalances(uid);
    
    if (chains.length === 0) {
      console.log(`No chains with balances found for user ${uid}`);
      return;
    }
    
    console.log(`Scheduling blockchain verification for user ${uid} across ${chains.length} chains: ${chains.join(', ')}`);
    
    // For each chain, schedule verification
    for (const chainKey of chains) {
      try {
        // Get wallet address for this chain
        let address: string | null = null;
        
        if (chainKey === 'SOLANA_MAINNET') {
          // Import here to avoid circular dependencies
          const { getPrivySolanaWalletAddress } = await import('./privy');
          address = await getPrivySolanaWalletAddress(accessToken);
        } else {
          // Import here to avoid circular dependencies
          const { getPrivyEvmWalletAddress } = await import('./privy');
          address = await getPrivyEvmWalletAddress(accessToken);
        }
        
        if (address) {
          console.log(`Scheduled blockchain verification for ${uid} on ${chainKey} at ${address}`);
          // In a real implementation, this would queue a background job
          // For now, we'll just log it
        } else {
          console.warn(`Could not resolve address for user ${uid} on chain ${chainKey}`);
        }
      } catch (chainError) {
        console.error(`Error scheduling verification for chain ${chainKey}:`, chainError);
      }
    }
    
    console.log(`Completed scheduling blockchain verification for user ${uid}`);
  } catch (error) {
    console.error('Error scheduling blockchain verification for all user tokens:', error);
  }
}

/**
 * Schedule async blockchain verification for a specific chain
 * This would be called from the main balance endpoint to trigger background verification
 */
export async function scheduleBlockchainVerification(
  uid: string,
  chainKey: ChainKey,
  address: string
): Promise<void> {
  // In a real implementation, this would queue a background job
  // For now, we'll just log it
  console.log(`Scheduled blockchain verification for ${uid} on ${chainKey} at ${address}`);
  
  // This is where you would integrate with a job queue (Bull, Agenda, etc.)
  // or trigger a background fetch
}

/**
 * Helper function to get token info from token_info modules
 */
function getTokenInfo(chainKey: ChainKey, symbol: string): TokenInfo | null {
  // Map chain keys to their corresponding token modules
  let tokenModule: Record<string, TokenInfo>;
  
  switch (chainKey) {
    case 'ETH_MAINNET':
      tokenModule = EthTokens as Record<string, TokenInfo>;
      break;
    case 'ETH_SEPOLIA':
      tokenModule = EthSepoliaTokens as Record<string, TokenInfo>;
      break;
    case 'BASE_MAINNET':
      tokenModule = BaseTokens as Record<string, TokenInfo>;
      break;
    case 'BASE_SEPOLIA':
      tokenModule = BaseSepoliaTokens as Record<string, TokenInfo>;
      break;
    case 'SOLANA_MAINNET':
      tokenModule = SolanaTokens as Record<string, TokenInfo>;
      break;
    default:
      return null;
  }
  
  // Find token by symbol (case-insensitive)
  const tokenKey = Object.keys(tokenModule).find(key => {
    const token = tokenModule[key];
    return token.symbol.toUpperCase() === symbol.toUpperCase();
  });
  
  if (!tokenKey) {
    return null;
  }
  
  return tokenModule[tokenKey];
}

/**
 * Ensure default tokens are initialized in MongoDB for a user
 * This should be called when a new user is created or when we detect missing tokens
 * Uses chain keys (SOLANA_MAINNET) for consistency
 */
export async function ensureDefaultTokensInMongoDB(
  uid: string,
  chainKey: ChainKey
): Promise<boolean> {
  await connectToDatabase();
  
  try {
    const user = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.findOne',
        description: 'fetch user balances for default token initialization',
      },
      () => User.findOne({ UID: uid }).lean()
    );
    
    if (!user) {
      console.error(`User ${uid} not found`);
      return false;
    }
    
    // Get default tokens for this chain
    const defaultTokens = DEFAULT_TOKENS[chainKey] || [];
    
    if (defaultTokens.length === 0) {
      console.log(`No default tokens defined for chain ${chainKey}`);
      return false;
    }
    
    // `lean()` returns plain objects, not Map instances
    const balancesObj = (user.balances ?? {}) as Record<string, unknown>;
    let currentChainBalances = balancesObj[chainKey] as Record<string, BalanceEntry[]> | undefined;
    
    // If not found with chain key, try chain label (backward compatibility)
    if (!currentChainBalances) {
      // Determine chain label for backward compatibility check
      let chainLabel: string;
      switch (chainKey) {
        case 'ETH_MAINNET':
        case 'ETH_SEPOLIA':
          chainLabel = 'Ethereum';
          break;
        case 'BASE_MAINNET':
        case 'BASE_SEPOLIA':
          chainLabel = 'Base';
          break;
        case 'SOLANA_MAINNET':
          chainLabel = 'Solana';
          break;
        default:
          chainLabel = chainKey;
      }
      currentChainBalances = balancesObj[chainLabel] as Record<string, BalanceEntry[]> | undefined;
    }
    
    // Check if we need to add any missing tokens
    const missingTokens = defaultTokens.filter(token => {
      if (!currentChainBalances) return true;
      return !currentChainBalances[token] || currentChainBalances[token].length === 0;
    });
    
    if (missingTokens.length === 0) {
      // All default tokens already present
      return true;
    }
    
    // Create zero-balance entries for missing tokens in array format
    const chainBalances: Record<string, BalanceEntry[]> = currentChainBalances ? { ...currentChainBalances } : {};
    
    for (const token of missingTokens) {
      // Get token info from token_info folder
      const tokenInfo = getTokenInfo(chainKey, token);
      
      let decimals = 18; // Default for most ERC-20 tokens
      let address = '';
      let name = token;
      
      if (tokenInfo) {
        decimals = tokenInfo.decimals || decimals;
        address = tokenInfo.address || '';
        name = tokenInfo.name || token;
      }
      
      // Create balance entry in array format
      chainBalances[token] = [{
        symbol: token,
        balance: '0',
        decimals,
        name,
        address,
        verifiedAt: Date.now(),
        source: 'mongo' as const,
      }];
    }
    
    // Update MongoDB with chain key (SOLANA_MAINNET)
    const updatePayload = {
      [`balances.${chainKey}`]: chainBalances,
    };
    
    const result = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/balanceService.ts',
        target: 'User.updateOne',
        description: 'initialize default tokens in MongoDB',
      },
      () => User.updateOne({ UID: uid }, { $set: updatePayload })
    );
    
    const success = result.modifiedCount > 0 || result.upsertedCount > 0;
    
    if (success) {
      console.log(`Added ${missingTokens.length} default tokens to MongoDB for ${uid} on ${chainKey}: ${missingTokens.join(', ')}`);
    } else {
      console.log(`Default tokens already present for ${uid} on ${chainKey}`);
    }
    
    return success;
  } catch (error) {
    console.error('Error ensuring default tokens in MongoDB:', error);
    return false;
  }
}

/**
 * Get the list of tokens that should be tracked for a specific chain
 * This uses DEFAULT_TOKENS configuration as the source of truth
 */
export function getTokensForChain(chainKey: ChainKey): string[] {
  return DEFAULT_TOKENS[chainKey] || [];
}
