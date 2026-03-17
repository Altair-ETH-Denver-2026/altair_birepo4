import { connectToDatabase } from '@/lib/db';
import { getPrivyUserFromAccessToken } from '@/lib/privy';
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

function extractEmail(user: any): string | null {
  if (typeof user?.email?.address === 'string') return user.email.address;
  if (Array.isArray(user?.linkedAccounts)) {
    const emailAccount = user.linkedAccounts.find((a: any) => a?.type === 'email' && typeof a?.address === 'string');
    if (emailAccount?.address) return emailAccount.address;

    const googleAccount = user.linkedAccounts.find((a: any) => a?.type === 'google');
    const googleEmail =
      (googleAccount?.email?.address && typeof googleAccount.email.address === 'string')
        ? googleAccount.email.address
        : (typeof googleAccount?.email === 'string' ? googleAccount.email : null);
    if (googleEmail) return googleEmail;

    if (typeof googleAccount?.address === 'string' && googleAccount.address.includes('@')) {
      return googleAccount.address;
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

export async function syncUserFromAccessToken(accessToken: string) {
  const { claims, user } = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'getPrivyUserFromAccessToken',
      description: 'Privy user lookup',
    },
    () => getPrivyUserFromAccessToken(accessToken)
  );
  const privyUser = user as any;
  const evmAddress = extractEvmAddress(privyUser);
  const solAddress = extractSolAddress(privyUser);
  const linkedAccounts = extractLinkedAccounts(privyUser);
  const email = extractEmail(privyUser);
  const phone = extractPhone(privyUser);
  const profileImageUrl = typeof privyUser?.profile?.imageUrl === 'string'
    ? privyUser.profile.imageUrl
    : typeof privyUser?.profileImageUrl === 'string'
      ? privyUser.profileImageUrl
      : null;
  const embeddedWalletId = typeof privyUser?.wallet?.id === 'string' ? privyUser.wallet.id : null;

  await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'connectToDatabase',
      description: 'MongoDB connection for user sync',
    },
    () => connectToDatabase()
  );

  const existing = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'User.findOne',
      description: 'Mongo user lookup',
    },
    () => User.findOne({ privyUserId: claims.userId })
  );
  const UID = existing?.UID ?? (await generateUserID());

  const updateFields: Record<string, unknown> = {
    UID,
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
    () =>
      User.findOneAndUpdate(
        { privyUserId: claims.userId },
        {
          $set: updateFields,
          $setOnInsert: {
            privyUserId: claims.userId,
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
  const synced = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/users.ts',
      target: 'syncUserFromAccessToken',
      description: 'resolve user UID',
    },
    () => syncUserFromAccessToken(accessToken)
  );
  if (!synced?.UID) {
    throw new Error('Unable to resolve UID for access token');
  }
  return synced.UID;
}
