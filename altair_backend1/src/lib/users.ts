import { connectToDatabase } from '@/lib/db';
import {
  ensurePrivyEmbeddedEvmWallet,
  ensurePrivyEmbeddedSolanaWallet,
  getPrivyUserFromAccessToken,
} from '@/lib/privy';
import { generateUserID } from '@/lib/id';
import { User } from '@/models/User';
import { withWaitLogger } from '@/lib/waitLogger';
import { ensureDefaultTokensInMongoDB } from '@/lib/balanceService';
import { DEFAULT_TOKENS, type ChainKey } from '../../config/blockchain_config';

type LinkedAccountSnapshot = {
  type: string;
  address?: string;
  chainType?: string;
  chainId?: string;
  verifiedAt?: string;
};

export type UserSyncMode = 'createAccount' | 'login' | 'runtime';

type SyncUserOptions = {
  mode?: UserSyncMode;
};

function normalizeEvmWalletAddress(address: string): string {
  return address.startsWith('0x') ? address : `0x${address}`;
}

function extractLinkedAccounts(user: any): LinkedAccountSnapshot[] {
  if (!Array.isArray(user?.linkedAccounts)) return [];
  return user.linkedAccounts
    .filter((account: any) => account && typeof account === 'object' && typeof account.type === 'string')
    .map((account: any) => ({
      type: account.type,
      address: typeof account.address === 'string' ? account.address : undefined,
      chainType: typeof account.chainType === 'string' ? account.chainType : undefined,
      chainId: typeof account.chainId === 'string' ? account.chainId : undefined,
      email:
        (typeof account.email?.address === 'string' && account.email.address) ||
        (typeof account.email === 'string' ? account.email : undefined),
      name:
        (typeof account.name === 'string' && account.name) ||
        (typeof account.displayName === 'string' ? account.displayName : undefined),
      username: typeof account.username === 'string' ? account.username : undefined,
      profileImageUrl:
        (typeof account.profile?.imageUrl === 'string' && account.profile.imageUrl) ||
        (typeof account.profileImageUrl === 'string' ? account.profileImageUrl : undefined),
      subject:
        (typeof account.subject === 'string' && account.subject) ||
        (typeof account.sub === 'string' ? account.sub : undefined),
      verifiedAt: typeof account.verifiedAt === 'string' ? account.verifiedAt : undefined,
    }));
}

function extractEvmAddress(user: any): string | null {
  if (
    user?.wallet?.address &&
    typeof user.wallet.address === 'string' &&
    (user.wallet.chainType === 'ethereum' || user.wallet.chainId?.startsWith('eip155'))
  ) {
    return normalizeEvmWalletAddress(user.wallet.address);
  }

  if (Array.isArray(user?.linkedAccounts)) {
    const account = user.linkedAccounts.find((entry: any) =>
      entry?.type === 'wallet' &&
      typeof entry.address === 'string' &&
      (entry.chainType === 'ethereum' || entry.chainId?.startsWith('eip155'))
    );
    if (account?.address) return normalizeEvmWalletAddress(account.address);
  }

  return null;
}

function extractSolAddress(user: any): string | null {
  if (
    user?.wallet?.address &&
    typeof user.wallet.address === 'string' &&
    (user.wallet.chainType === 'solana' || user.wallet.chainId?.startsWith('solana'))
  ) {
    return user.wallet.address;
  }

  if (Array.isArray(user?.linkedAccounts)) {
    const account = user.linkedAccounts.find((entry: any) =>
      entry?.type === 'wallet' &&
      typeof entry.address === 'string' &&
      (entry.chainType === 'solana' || entry.chainId?.startsWith('solana'))
    );
    if (account?.address) return account.address;
  }

  return null;
}

function normalizeEmailCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    return null;
  }
  return normalized;
}

function getAccountEmailCandidate(account: any): string | null {
  const candidates: unknown[] = [
    account?.email?.address,
    account?.email_address,
    account?.email,
    account?.address,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeEmailCandidate(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function isPreferredEmailAccountType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const normalized = type.toLowerCase();
  const preferred = ['email', 'google', 'google_oauth', 'github', 'apple', 'microsoft'];
  return preferred.includes(normalized);
}

function extractEmail(user: any): string | null {
  const topLevelEmail = normalizeEmailCandidate(user?.email?.address);
  if (topLevelEmail) return topLevelEmail;

  if (Array.isArray(user?.linkedAccounts)) {
    // Prefer known auth providers that commonly carry email claims.
    for (const account of user.linkedAccounts) {
      if (!isPreferredEmailAccountType(account?.type)) continue;
      const candidate = getAccountEmailCandidate(account);
      if (candidate) return candidate;
    }

    // Fallback: scan every linked account for any email-like field.
    for (const account of user.linkedAccounts) {
      const candidate = getAccountEmailCandidate(account);
      if (candidate) return candidate;
    }
  }

  return null;
}

function extractPhone(user: any): string | null {
  if (typeof user?.phone?.number === 'string') return user.phone.number;
  if (Array.isArray(user?.linkedAccounts)) {
    const phoneAccount = user.linkedAccounts.find((a: any) => a?.type === 'phone' && typeof a?.number === 'string');
    if (phoneAccount?.number) return phoneAccount.number;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncUserFromAccessToken(accessToken: string, options: SyncUserOptions = {}) {
  const mode: UserSyncMode = options.mode ?? 'runtime';
  const { claims, user } = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'getPrivyUserFromAccessToken',
      description: 'Privy user lookup',
    },
    () => getPrivyUserFromAccessToken(accessToken)
  );
  let privyUser = user as any;
  let evmAddress = extractEvmAddress(privyUser);
  let solAddress = extractSolAddress(privyUser);
  let ensuredEvmWallet: { walletId: string; address: string } | null = null;
  let ensuredSolanaWallet: { walletId: string; address: string } | null = null;

  // Privy wallet linking can lag briefly right after signup.
  // Retry profile reads before attempting wallet creation fallback.
  if (!evmAddress || !solAddress) {
    const retryDelaysMs = [350, 700, 1200];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      try {
        const refreshed = await withWaitLogger(
          {
            file: 'altair_backend1/src/lib/users.ts',
            target: 'getPrivyUserFromAccessToken',
            description: `Privy user re-check after ${delayMs}ms delay`,
          },
          () => getPrivyUserFromAccessToken(accessToken)
        );
        privyUser = refreshed.user as any;
        if (!evmAddress) evmAddress = extractEvmAddress(privyUser);
        if (!solAddress) solAddress = extractSolAddress(privyUser);
        if (evmAddress && solAddress) break;
      } catch (error) {
        console.warn('[users] Privy user re-check failed during wallet propagation wait', error);
      }
    }
  }

  if (mode === 'runtime' && !evmAddress) {
    try {
      ensuredEvmWallet = await withWaitLogger(
        {
          file: 'altair_backend1/src/lib/users.ts',
          target: 'ensurePrivyEmbeddedEvmWallet',
          description: 'fallback ensure embedded EVM wallet',
        },
        () => ensurePrivyEmbeddedEvmWallet(accessToken)
      );
      evmAddress = ensuredEvmWallet.address;
    } catch (error) {
      console.warn('[users] fallback ensure embedded EVM wallet failed; continuing with profile sync', error);
    }
  }

  if (mode === 'runtime' && !solAddress) {
    try {
      ensuredSolanaWallet = await withWaitLogger(
        {
          file: 'altair_backend1/src/lib/users.ts',
          target: 'ensurePrivyEmbeddedSolanaWallet',
          description: 'fallback ensure embedded Solana wallet',
        },
        () => ensurePrivyEmbeddedSolanaWallet(accessToken)
      );
      solAddress = ensuredSolanaWallet.address;
    } catch (error) {
      console.warn('[users] fallback ensure embedded Solana wallet failed; continuing with profile sync', error);
    }
  }

  const linkedAccounts = extractLinkedAccounts(privyUser);
  const email = extractEmail(privyUser);
  const phone = extractPhone(privyUser);
  const profileImageUrl = typeof privyUser?.profile?.imageUrl === 'string'
    ? privyUser.profile.imageUrl
    : typeof privyUser?.profileImageUrl === 'string'
      ? privyUser.profileImageUrl
      : null;
  const embeddedWalletId = typeof privyUser?.wallet?.id === 'string'
    ? privyUser.wallet.id
    : ensuredEvmWallet?.walletId ?? ensuredSolanaWallet?.walletId ?? null;

  if (typeof claims?.userId !== 'string' || claims.userId.length === 0) {
    throw new Error('Invalid Privy user id in token claims');
  }

  const hasIdentitySignal =
    linkedAccounts.length > 0 ||
    email !== null ||
    phone !== null ||
    evmAddress !== null ||
    solAddress !== null ||
    embeddedWalletId !== null;

  if (!hasIdentitySignal) {
    console.warn('[users] skipping Mongo upsert for incomplete Privy identity payload', {
      privyUserId: claims.userId,
    });

    await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/users.ts',
        target: 'connectToDatabase',
        description: 'MongoDB connection for incomplete identity lookup',
      },
      () => connectToDatabase()
    );

    const existingUser = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/users.ts',
        target: 'User.findOne',
        description: 'lookup existing user by privyUserId for incomplete identity payload',
      },
      () => User.findOne({ privyUserId: claims.userId })
    );

    if (existingUser) {
      return existingUser;
    }

    throw new Error('Incomplete Privy identity payload; user sync deferred until profile hydration completes');
  }

  await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'connectToDatabase',
      description: 'MongoDB connection for user sync',
    },
    () => connectToDatabase()
  );

  const updateFields: Record<string, unknown> = {
    linkedAccounts,
    lastSeenAt: new Date(),
  };

  if (email !== null && email !== undefined) updateFields.email = email;
  if (phone !== null && phone !== undefined) updateFields.phone = phone;
  if (evmAddress !== null && evmAddress !== undefined) updateFields.evmAddress = evmAddress;
  if (solAddress !== null && solAddress !== undefined) updateFields.solAddress = solAddress;
  if (embeddedWalletId !== null && embeddedWalletId !== undefined) updateFields.embeddedWalletId = embeddedWalletId;
  if (profileImageUrl !== null && profileImageUrl !== undefined) updateFields.profileImageUrl = profileImageUrl;

  const result = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'User.findOneAndUpdate',
      description: 'Mongo user upsert',
    },
    async () =>
      User.findOneAndUpdate(
        { privyUserId: claims.userId },
        {
          $set: updateFields,
          $setOnInsert: {
            privyUserId: claims.userId,
            UID: await generateUserID(),
          },
        },
        { upsert: true, new: true }
      )
  );

  // Ensure default tokens are initialized in MongoDB for all chains
  // This runs asynchronously in the background
  if (result?.UID) {
    const chains = Object.keys(DEFAULT_TOKENS) as ChainKey[];
    for (const chainKey of chains) {
      try {
        await ensureDefaultTokensInMongoDB(result.UID, chainKey);
      } catch (error) {
        console.error(`Failed to ensure default tokens for chain ${chainKey}:`, error);
        // Don't fail the whole sync if token initialization fails
      }
    }
  }

  return result;
}

export async function getUserUIDFromAccessToken(accessToken: string): Promise<string> {
  return getUserUIDFromAccessTokenByMode(accessToken, 'runtime');
}

export async function getUserUIDFromAccessTokenByMode(
  accessToken: string,
  mode: UserSyncMode
): Promise<string> {
  const synced = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'syncUserFromAccessToken',
      description: `resolve user UID (${mode})`,
    },
    () => syncUserFromAccessToken(accessToken, { mode })
  );
  if (!synced?.UID) {
    throw new Error('Unable to resolve UID for access token');
  }
  return synced.UID;
}
