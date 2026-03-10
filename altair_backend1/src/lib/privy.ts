import { PrivyClient, type LinkedAccountWithMetadata } from '@privy-io/server-auth';
import { withWaitLogger } from '@/lib/waitLogger';
import type { Transaction, VersionedTransaction } from '@solana/web3.js';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;

let privyClient: PrivyClient | null = null;

const getPrivyClient = () => {
  if (!PRIVY_APP_ID) {
    throw new Error('Missing NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) environment variable');
  }

  if (!PRIVY_APP_SECRET) {
    throw new Error('Missing PRIVY_APP_SECRET environment variable for server-side wallet access');
  }

  if (!privyClient) {
    privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET, {
      walletApi: {
        authorizationPrivateKey: process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY,
      },
    });
  }

  return privyClient;
};

type PrivyUser = Awaited<ReturnType<PrivyClient['getUserById']>>;

export async function getPrivyUserFromAccessToken(accessToken: string): Promise<{
  claims: { userId: string };
  user: PrivyUser;
}> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const privy = getPrivyClient();

  const claims = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.verifyAuthToken',
      description: 'verify access token',
    },
    () => privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY)
  );
  const user = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.getUserById',
      description: 'fetch user profile',
    },
    () => privy.getUserById(claims.userId)
  );
  return { claims, user };
}

export async function getPrivyEvmWalletAddress(accessToken: string): Promise<string> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const privy = getPrivyClient();

  const claims = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.verifyAuthToken',
      description: 'verify access token',
    },
    () => privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY)
  );
  console.log('[Privy] Token verified. userId:', claims.userId);

  const user = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.getUserById',
      description: 'fetch user profile',
    },
    () => privy.getUserById(claims.userId)
  );
  console.log('[Privy] Fetched user. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] All linked account types:', user.linkedAccounts?.map((a) => a.type));

  // Look for an EVM wallet (ethereum chainType/eip155 chainId) on the user or linked accounts
  const topLevelEvmAddress =
    (user.wallet &&
      (user.wallet.chainType === 'ethereum' || user.wallet.chainId?.startsWith('eip155')) &&
      user.wallet.address) ||
    undefined;

  const linkedEvmAddress = user.linkedAccounts?.find((a: LinkedAccountWithMetadata) => {
    const wallet = a as LinkedAccountWithMetadata & { address?: string; chainType?: string; chainId?: string };
    return (
      wallet.type === 'wallet' &&
      (wallet.chainType === 'ethereum' || wallet.chainId?.startsWith('eip155')) &&
      !!wallet.address
    );
  }) as (LinkedAccountWithMetadata & { address?: string }) | undefined;

  const evmAddress = topLevelEvmAddress || linkedEvmAddress?.address;

  if (evmAddress) {
    const normalized = evmAddress.startsWith('0x') ? evmAddress : `0x${evmAddress}`;
    console.log('[Privy] Found EVM wallet:', normalized);
    return normalized;
  }

  // Fetch wallets scoped to this specific user via walletApi
  try {
    const { data: wallets } = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/privy.ts',
        target: 'privy.walletApi.getWallets',
        description: 'fetch EVM wallets',
      },
      () =>
        privy.walletApi.getWallets({
          chainType: 'ethereum',
        })
    );

    console.log('[Privy] walletApi wallets for user:', wallets?.map((w) => ({ id: w.id, address: w.address })));

    const wallet = wallets?.find((w) => w.address);
    if (wallet?.address) {
      console.log('[Privy] Found via walletApi:', wallet.address);
      return wallet.address;
    }
  } catch (e) {
    console.warn('[Privy] walletApi.getWallets failed:', e);
  }

  throw new Error(
    `No Privy EVM wallet found for user ${claims.userId}. ` +
      `Linked account types: ${user.linkedAccounts?.map((a) => a.type).join(', ')}.`
  );
}

export async function getPrivySolanaWalletAddress(accessToken: string): Promise<string> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const privy = getPrivyClient();

  const claims = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.verifyAuthToken',
      description: 'verify access token',
    },
    () => privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY)
  );
  console.log('[Privy] Token verified. userId:', claims.userId);

  const user = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.getUserById',
      description: 'fetch user profile',
    },
    () => privy.getUserById(claims.userId)
  );
  console.log('[Privy] Fetched user. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] All linked account types:', user.linkedAccounts?.map((a) => a.type));

  const topLevelSolanaAddress =
    (user.wallet &&
      (user.wallet.chainType === 'solana' || user.wallet.chainId?.startsWith('solana')) &&
      user.wallet.address) ||
    undefined;

  const linkedSolanaAddress = user.linkedAccounts?.find((a: LinkedAccountWithMetadata) => {
    const wallet = a as LinkedAccountWithMetadata & { address?: string; chainType?: string; chainId?: string };
    return (
      wallet.type === 'wallet' &&
      (wallet.chainType === 'solana' || wallet.chainId?.startsWith('solana')) &&
      !!wallet.address
    );
  }) as (LinkedAccountWithMetadata & { address?: string }) | undefined;

  const solanaAddress = topLevelSolanaAddress || linkedSolanaAddress?.address;

  if (solanaAddress) {
    console.log('[Privy] Found Solana wallet:', solanaAddress);
    return solanaAddress;
  }

  try {
    const { data: wallets } = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/privy.ts',
        target: 'privy.walletApi.getWallets',
        description: 'fetch Solana wallets',
      },
      () =>
        privy.walletApi.getWallets({
          chainType: 'solana',
        })
    );

    console.log('[Privy] walletApi Solana wallets for user:', wallets?.map((w) => ({ id: w.id, address: w.address })));

    const wallet = wallets?.find((w) => w.address);
    if (wallet?.address) {
      console.log('[Privy] Found Solana via walletApi:', wallet.address);
      return wallet.address;
    }
  } catch (e) {
    console.warn('[Privy] walletApi.getWallets (solana) failed:', e);
  }

  throw new Error(
    `No Privy Solana wallet found for user ${claims.userId}. ` +
      `Linked account types: ${user.linkedAccounts?.map((a) => a.type).join(', ')}.`
  );
}

export async function ensurePrivyEmbeddedEvmWallet(
  accessToken: string
): Promise<{ walletId: string; address: string }> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const privy = getPrivyClient();

  if (!process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY) {
    throw new Error('Missing PRIVY_WALLET_AUTH_PRIVATE_KEY for server-side wallet control');
  }

  const claims = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.verifyAuthToken',
      description: 'verify access token',
    },
    () => privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY)
  );
  console.log('[Privy] ensure embedded wallet. userId:', claims.userId);

  const user = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.getUserById',
      description: 'fetch user profile',
    },
    () => privy.getUserById(claims.userId)
  );
  console.log('[Privy] ensure embedded wallet. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] ensure embedded wallet. account types:', user.linkedAccounts?.map((a) => a.type));

  const normalize = (addr: string) => (addr.startsWith('0x') ? addr : `0x${addr}`);

  const candidateAddresses: string[] = [];

  if (user.wallet && (user.wallet.chainType === 'ethereum' || user.wallet.chainId?.startsWith('eip155'))) {
    candidateAddresses.push(normalize(user.wallet.address));
  }

  user.linkedAccounts
    ?.filter((a: LinkedAccountWithMetadata) => {
      const w = a as LinkedAccountWithMetadata & { address?: string; chainType?: string; chainId?: string };
      return w.type === 'wallet' && (w.chainType === 'ethereum' || w.chainId?.startsWith('eip155')) && !!w.address;
    })
    .forEach((w) => {
      const addr = (w as { address?: string }).address;
      if (addr) candidateAddresses.push(normalize(addr));
    });

  // Fetch all app wallets (authorized via app secret + wallet auth key) and find a matching EVM wallet we can control.
  const findControllableWallet = async (): Promise<{ walletId: string; address: string } | null> => {
    const { data: wallets } = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/privy.ts',
        target: 'privy.walletApi.getWallets',
        description: 'fetch controllable EVM wallets',
      },
      () => privy.walletApi.getWallets({ chainType: 'ethereum' })
    );
    const match = wallets?.find((w) => candidateAddresses.includes(normalize(w.address)));
    if (match) {
      return { walletId: match.id, address: normalize(match.address) };
    }
    return null;
  };

  const existing = await findControllableWallet();
  if (existing) {
    console.log('[Privy] Found controllable embedded EVM wallet:', existing);
    return existing;
  }

  // If no controllable wallet exists, create an embedded EVM wallet for this user.
  console.log('[Privy] No controllable EVM wallet found. Creating embedded EVM wallet for user.');
  const createdUser = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.createWallets',
      description: 'create embedded EVM wallet',
    },
    () =>
      privy.createWallets({
        userId: claims.userId,
        createEthereumWallet: true,
        numberOfEthereumWalletsToCreate: 1,
      })
  );

  const newAddress = createdUser.wallet?.address
    ? normalize(createdUser.wallet.address)
    : candidateAddresses[0] // fallback
      ? normalize(candidateAddresses[0])
      : undefined;

  const afterCreate = await findControllableWallet();
  if (afterCreate) {
    console.log('[Privy] Created controllable embedded EVM wallet:', afterCreate);
    return afterCreate;
  }

  throw new Error(`Unable to find or create an embedded EVM wallet for user ${claims.userId}`);
}

export async function ensurePrivyEmbeddedSolanaWallet(
  accessToken: string
): Promise<{ walletId: string; address: string }> {
  if (!accessToken) {
    throw new Error('Missing Privy access token');
  }

  const privy = getPrivyClient();

  if (!process.env.PRIVY_WALLET_AUTH_PRIVATE_KEY) {
    throw new Error('Missing PRIVY_WALLET_AUTH_PRIVATE_KEY for server-side wallet control');
  }

  const claims = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.verifyAuthToken',
      description: 'verify access token',
    },
    () => privy.verifyAuthToken(accessToken, PRIVY_VERIFICATION_KEY)
  );
  console.log('[Privy] ensure embedded Solana wallet. userId:', claims.userId);

  const user = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.getUserById',
      description: 'fetch user profile',
    },
    () => privy.getUserById(claims.userId)
  );
  console.log('[Privy] ensure embedded Solana wallet. linkedAccounts:', user.linkedAccounts?.length ?? 0);
  console.log('[Privy] ensure embedded Solana wallet. account types:', user.linkedAccounts?.map((a) => a.type));

  const candidateAddresses: string[] = [];

  if (user.wallet && (user.wallet.chainType === 'solana' || user.wallet.chainId?.startsWith('solana'))) {
    candidateAddresses.push(user.wallet.address);
  }

  user.linkedAccounts
    ?.filter((a: LinkedAccountWithMetadata) => {
      const w = a as LinkedAccountWithMetadata & { address?: string; chainType?: string; chainId?: string };
      return w.type === 'wallet' && (w.chainType === 'solana' || w.chainId?.startsWith('solana')) && !!w.address;
    })
    .forEach((w) => {
      const addr = (w as { address?: string }).address;
      if (addr) candidateAddresses.push(addr);
    });

  const findControllableWallet = async (): Promise<{ walletId: string; address: string } | null> => {
    const { data: wallets } = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/privy.ts',
        target: 'privy.walletApi.getWallets',
        description: 'fetch controllable Solana wallets',
      },
      () => privy.walletApi.getWallets({ chainType: 'solana' })
    );
    const match = wallets?.find((w) => candidateAddresses.includes(w.address));
    if (match) {
      return { walletId: match.id, address: match.address };
    }
    return null;
  };

  const existing = await findControllableWallet();
  if (existing) {
    console.log('[Privy] Found controllable embedded Solana wallet:', existing);
    return existing;
  }

  console.log('[Privy] No controllable Solana wallet found. Creating embedded Solana wallet for user.');
  const createdUser = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.createWallets',
      description: 'create embedded Solana wallet',
    },
    () =>
      privy.createWallets({
        userId: claims.userId,
        createSolanaWallet: true,
        numberOfSolanaWalletsToCreate: 1,
      } as Parameters<typeof privy.createWallets>[0])
  );

  const newAddress = createdUser.wallet?.address
    ? createdUser.wallet.address
    : candidateAddresses[0]
      ? candidateAddresses[0]
      : undefined;

  const afterCreate = await findControllableWallet();
  if (afterCreate) {
    console.log('[Privy] Created controllable embedded Solana wallet:', afterCreate);
    return afterCreate;
  }

  throw new Error(`Unable to find or create an embedded Solana wallet for user ${claims.userId}`);
}

export async function signAndSendSolanaTransaction(params: {
  walletId: string;
  transaction: Transaction | VersionedTransaction;
  chain?: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
}): Promise<string> {
  const privy = getPrivyClient();
  const { walletId, transaction } = params;
  const caip2 = params.chain ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const result = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/privy.ts',
      target: 'privy.walletApi.solana.signAndSendTransaction',
      description: 'sign and send Solana transaction',
    },
    () =>
      privy.walletApi.solana.signAndSendTransaction({
        walletId,
        chainType: 'solana',
        caip2,
        transaction,
      } as Parameters<typeof privy.walletApi.solana.signAndSendTransaction>[0])
  );
  return result.hash;
}
