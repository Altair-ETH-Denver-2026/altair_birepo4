import { NextResponse } from 'next/server';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Connection, PublicKey } from '@solana/web3.js';
import { BLOCKCHAIN, CHAINS, type ChainKey } from '../../../../config/blockchain_config';
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  ETH_MAINNET,
  ETH_SEPOLIA,
  SOLANA_MAINNET,
  resolveRpcUrls,
} from '../../../../config/chain_info';
import { USDC as BASE_USDC, WETH as BASE_WETH, DAI as BASE_DAI } from '../../../../config/token_info/base_tokens';
import { USDC as BASE_SEPOLIA_USDC, WETH as BASE_SEPOLIA_WETH } from '../../../../config/token_info/base_testnet_sepolia_tokens';
import { USDC as ETH_USDC, WETH as ETH_WETH, DAI as ETH_DAI } from '../../../../config/token_info/eth_tokens';
import { USDC as ETH_SEPOLIA_USDC, WETH as ETH_SEPOLIA_WETH } from '../../../../config/token_info/eth_sepolia_testnet_tokens';
import { SOL as SOLANA_SOL, USDC as SOLANA_USDC } from '../../../../config/token_info/solana_tokens';
import { getPrivyEvmWalletAddress, getPrivySolanaWalletAddress } from '@/lib/privy';
import { syncUserFromAccessToken } from '@/lib/users';
import { User } from '@/models/User';
import { Swap } from '@/models/Swap';
import { connectToDatabase } from '@/lib/db';
import { cookies } from 'next/headers';
import { withWaitLogger } from '@/lib/waitLogger';
import { formatAmountFromRaw } from '@/lib/amounts';

const ERC20_BALANCE_ABI = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const NATIVE_EVM_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const CHAIN_LABELS: Record<ChainKey, string> = {
  ETH_MAINNET: 'Ethereum',
  ETH_SEPOLIA: 'Ethereum',
  BASE_MAINNET: 'Base',
  BASE_SEPOLIA: 'Base',
  SOLANA_MAINNET: 'Solana',
};

type BalanceEntry = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  balance: string;
};

const buildBalanceEntry = (params: {
  symbol: string;
  name?: string | null;
  address?: string | null;
  decimals: number;
  balance: string;
}): BalanceEntry => ({
  symbol: params.symbol,
  name: params.name ?? params.symbol,
  address: params.address ?? '',
  decimals: params.decimals,
  balance: params.balance,
});

type SwapOverrideCacheEntry = {
  expiresAt: number;
  swap: Record<string, any> | null;
};

const SWAP_OVERRIDE_TTL_MS = 20_000;
const SWAP_OVERRIDE_MAX_AGE_MS = 3 * 60_000;
const swapOverrideCache = new Map<string, SwapOverrideCacheEntry>();

const buildSwapOverrideCacheKey = (uid: string, chainKey: ChainKey) => `${uid}:${chainKey}`;

const resolveSwapBalanceOverrides = (params: {
  chainKey: ChainKey;
  swap: Record<string, any> | null;
  tokenConfig: { USDC?: typeof BASE_USDC; WETH?: typeof BASE_WETH; DAI?: typeof BASE_DAI };
}): { eth?: string; usdc?: string; weth?: string; dai?: string; sol?: string } | null => {
  const { chainKey, swap, tokenConfig } = params;
  if (!swap) return null;
  const candidates = [swap.sellToken, swap.buyToken].filter(Boolean);
  if (chainKey === 'SOLANA_MAINNET') {
    const overrides: { sol?: string; usdc?: string } = {};
    for (const token of candidates) {
      if (token?.chain !== chainKey || !token?.balanceAfter || !token?.symbol) continue;
      const symbol = String(token.symbol).toUpperCase();
      if (symbol === 'SOL') {
        overrides.sol = formatAmountFromRaw(String(token.balanceAfter), SOLANA_SOL.decimals ?? 9);
      }
      if (symbol === 'USDC') {
        overrides.usdc = formatAmountFromRaw(String(token.balanceAfter), SOLANA_USDC.decimals ?? 6);
      }
    }
    return Object.keys(overrides).length ? overrides : null;
  }

  const overrides: { eth?: string; usdc?: string; weth?: string; dai?: string } = {};
  for (const token of candidates) {
    if (token?.chain !== chainKey || !token?.balanceAfter || !token?.symbol) continue;
    const symbol = String(token.symbol).toUpperCase();
    if (symbol === 'ETH') {
      overrides.eth = formatAmountFromRaw(String(token.balanceAfter), 18);
    }
    if (symbol === 'USDC' && tokenConfig.USDC?.decimals) {
      overrides.usdc = formatAmountFromRaw(String(token.balanceAfter), tokenConfig.USDC.decimals);
    }
    if (symbol === 'WETH' && tokenConfig.WETH?.decimals) {
      overrides.weth = formatAmountFromRaw(String(token.balanceAfter), tokenConfig.WETH.decimals);
    }
    if (symbol === 'DAI' && tokenConfig.DAI?.decimals) {
      overrides.dai = formatAmountFromRaw(String(token.balanceAfter), tokenConfig.DAI.decimals);
    }
  }
  return Object.keys(overrides).length ? overrides : null;
};

export async function POST(req: Request) {
  try {
    const {
      walletAddress: overrideAddress,
      chain: chainKey,
      accessToken: bodyToken,
      email,
      phone,
      evmAddress: bodyEvmAddress,
      solanaAddress: bodySolanaAddress,
      forceRefresh,
    } = (await req.json().catch(() => ({
      walletAddress: undefined,
      chain: undefined,
      accessToken: undefined,
      email: undefined,
      phone: undefined,
      evmAddress: undefined,
      solanaAddress: undefined,
      forceRefresh: undefined,
    }))) as {
      walletAddress?: string;
      chain?: ChainKey;
      accessToken?: string;
      email?: string;
      phone?: string;
      evmAddress?: string;
      solanaAddress?: string;
      forceRefresh?: boolean;
    };

    // Prefer signed Privy token from cookie; fall back to body token, then override address
    const cookieStore = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/balances/route.ts',
        target: 'cookies()',
        description: 'read auth cookies',
      },
      () => cookies()
    );
    const cookieToken = cookieStore.get('privy-token')?.value;
    const tokenToVerify = cookieToken ?? bodyToken ?? null;

    const chainConfigs = {
      BASE_SEPOLIA,
      ETH_SEPOLIA,
      ETH_MAINNET,
      BASE_MAINNET,
      SOLANA_MAINNET,
    } as const;

    const resolvedChainKey: ChainKey =
      chainKey && chainKey in CHAINS ? chainKey : (BLOCKCHAIN as ChainKey);

    const chainConfig = chainConfigs[resolvedChainKey];

    const hasEmail = typeof email === 'string' && email.length > 0;
    const hasPhone = typeof phone === 'string' && phone.length > 0;
    const hasEvmAddress = typeof bodyEvmAddress === 'string' && bodyEvmAddress.length > 0;
    const hasSolanaAddress = typeof bodySolanaAddress === 'string' && bodySolanaAddress.length > 0;
    const shouldForceRefresh = Boolean(forceRefresh);
    const contactUpdate: Record<string, string | Date> = {};
    if (hasEmail) contactUpdate.email = email;
    if (hasPhone) contactUpdate.phone = phone;
    if (hasEmail || hasPhone) contactUpdate.lastSeenAt = new Date();

    if (resolvedChainKey === 'SOLANA_MAINNET') {
      const resolvedSolanaAddress = overrideAddress ?? (tokenToVerify
        ? await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/balances/route.ts',
              target: 'getPrivySolanaWalletAddress',
              description: 'resolve Solana wallet address',
            },
            () => getPrivySolanaWalletAddress(tokenToVerify)
          )
        : null);
      if (!resolvedSolanaAddress) {
        return NextResponse.json({ error: 'Unable to resolve Solana wallet address' }, { status: 401 });
      }

      const rpcUrl = SOLANA_MAINNET.rpcUrls[0];
      const connection = new Connection(rpcUrl, 'confirmed');
      const owner = new PublicKey(resolvedSolanaAddress);

      const solLamports = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/balances/route.ts',
          target: 'Solana getBalance',
          description: 'SOL balance lookup',
        },
        () => connection.getBalance(owner)
      );
      const sol = (solLamports / 1_000_000_000).toString();
      const solRaw = solLamports.toString();

      let usdc = '0';
      let usdcRaw = '0';
      let usdcDecimals = SOLANA_USDC.decimals ?? 6;
      try {
        const usdcMint = new PublicKey(SOLANA_USDC.address);
        const accounts = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/balances/route.ts',
            target: 'Solana getParsedTokenAccountsByOwner',
            description: 'USDC token accounts lookup',
          },
          () => connection.getParsedTokenAccountsByOwner(owner, { mint: usdcMint })
        );
        const first = accounts.value[0];
        if (first?.account?.data && 'parsed' in first.account.data) {
          const parsed = first.account.data.parsed as {
            info?: { tokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number } };
          };
          usdc = parsed?.info?.tokenAmount?.uiAmountString ?? '0';
          usdcRaw = parsed?.info?.tokenAmount?.amount ?? '0';
          if (typeof parsed?.info?.tokenAmount?.decimals === 'number') {
            usdcDecimals = parsed.info.tokenAmount.decimals;
          }
        }
      } catch (err) {
        console.warn('Solana USDC balance fetch failed:', err);
      }

        if (tokenToVerify) {
          try {
            const user = await withWaitLogger(
              {
                file: 'altair_backend1/src/app/api/balances/route.ts',
                target: 'syncUserFromAccessToken',
                description: 'Privy + Mongo user sync',
              },
              () => syncUserFromAccessToken(tokenToVerify)
            );
            const swapCacheKey = buildSwapOverrideCacheKey(user.UID, resolvedChainKey);
            let latestSwap = swapOverrideCache.get(swapCacheKey)?.swap ?? null;
            const cacheExpiresAt = swapOverrideCache.get(swapCacheKey)?.expiresAt ?? 0;
            const cacheFresh = cacheExpiresAt > Date.now();
            if (!cacheFresh) {
              await withWaitLogger(
                {
                  file: 'altair_backend1/src/app/api/balances/route.ts',
                  target: 'connectToDatabase',
                  description: 'MongoDB connection for swap lookup',
                },
                () => connectToDatabase()
              );
              const swapCutoff = new Date(Date.now() - SWAP_OVERRIDE_MAX_AGE_MS);
              latestSwap = await withWaitLogger(
                {
                  file: 'altair_backend1/src/app/api/balances/route.ts',
                  target: 'Swap.findOne',
                  description: 'load latest swap for balance fast path',
                },
                () =>
                  Swap.findOne({
                    UID: user.UID,
                    createdAt: { $gte: swapCutoff },
                    $or: [
                      { 'sellToken.chain': resolvedChainKey },
                      { 'buyToken.chain': resolvedChainKey },
                    ],
                  })
                    .sort({ createdAt: -1 })
                    .lean()
              );
              swapOverrideCache.set(swapCacheKey, {
                swap: latestSwap as Record<string, any> | null,
                expiresAt: Date.now() + SWAP_OVERRIDE_TTL_MS,
              });
            }
            const swapOverrides = resolveSwapBalanceOverrides({
              chainKey: resolvedChainKey,
              swap: latestSwap as Record<string, any> | null,
              tokenConfig: {} as { USDC?: typeof BASE_USDC; WETH?: typeof BASE_WETH; DAI?: typeof BASE_DAI },
            });
            if (swapOverrides) {
              const chainLabel = CHAIN_LABELS[resolvedChainKey];
              const chainBalances = {
                SOL: [
                  buildBalanceEntry({
                    symbol: 'SOL',
                    name: SOLANA_SOL.name ?? 'Solana',
                    address: SOLANA_SOL.address,
                    decimals: SOLANA_SOL.decimals ?? 9,
                    balance: solRaw,
                  }),
                ],
                USDC: [
                  buildBalanceEntry({
                    symbol: 'USDC',
                    name: SOLANA_USDC.name ?? 'USD Coin',
                    address: SOLANA_USDC.address,
                    decimals: usdcDecimals,
                    balance: usdcRaw,
                  }),
                ],
              };
              const updatePayload: Record<string, unknown> = {
                [`balances.${chainLabel}`]: chainBalances,
                ...(hasEmail || hasPhone ? contactUpdate : {}),
                ...(hasEvmAddress ? { evmAddress: bodyEvmAddress } : {}),
                ...(hasSolanaAddress ? { solAddress: bodySolanaAddress } : {}),
              };
              void (async () => {
                try {
                  await connectToDatabase();
                  await User.updateOne({ UID: user.UID }, { $set: updatePayload });
                } catch (err) {
                  console.warn('Solana balance async write failed:', err);
                }
              })();
              return NextResponse.json({
                address: resolvedSolanaAddress,
                eth: '0',
                usdc: swapOverrides.usdc ?? usdc,
                weth: '0',
                dai: '0',
                sol: swapOverrides.sol ?? sol,
              });
            }
            const chainLabel = CHAIN_LABELS[resolvedChainKey];
            const chainBalances = {
              SOL: [
                buildBalanceEntry({
                  symbol: 'SOL',
                name: SOLANA_SOL.name ?? 'Solana',
                address: SOLANA_SOL.address,
                decimals: SOLANA_SOL.decimals ?? 9,
                balance: solRaw,
              }),
            ],
            USDC: [
              buildBalanceEntry({
                symbol: 'USDC',
                name: SOLANA_USDC.name ?? 'USD Coin',
                address: SOLANA_USDC.address,
                decimals: usdcDecimals,
                balance: usdcRaw,
              }),
            ],
          };
          const existingBalances = (user as { balances?: Record<string, unknown> }).balances?.[chainLabel] ?? null;
          const balancesChanged =
            !existingBalances || JSON.stringify(existingBalances) !== JSON.stringify(chainBalances);
          const shouldWriteBalances =
            shouldForceRefresh || balancesChanged || hasEmail || hasPhone || hasEvmAddress || hasSolanaAddress;
          if (!shouldWriteBalances) {
            return NextResponse.json({
              address: resolvedSolanaAddress,
              eth: '0',
              usdc,
              weth: '0',
              dai: '0',
              sol,
            });
          }
          const updatePayload: Record<string, unknown> = {
            [`balances.${chainLabel}`]: chainBalances,
            ...(hasEmail || hasPhone ? contactUpdate : {}),
            ...(hasEvmAddress ? { evmAddress: bodyEvmAddress } : {}),
            ...(hasSolanaAddress ? { solAddress: bodySolanaAddress } : {}),
          };
          await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/balances/route.ts',
              target: 'User.updateOne',
              description: 'Mongo balances write (Solana)',
            },
            () =>
              User.updateOne(
                { UID: user.UID },
                { $set: updatePayload }
              )
          );
        } catch (updateErr) {
          console.warn('Solana balance sync failed:', updateErr);
        }
      }

      return NextResponse.json({
        address: resolvedSolanaAddress,
        eth: '0',
        usdc,
        weth: '0',
        dai: '0',
        sol,
      });
    }

    const addressToQuery = (overrideAddress
      ?? (tokenToVerify
        ? await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/balances/route.ts',
              target: 'getPrivyEvmWalletAddress',
              description: 'resolve EVM wallet address',
            },
            () => getPrivyEvmWalletAddress(tokenToVerify)
          )
        : null)) as `0x${string}` | null;

    if (!addressToQuery) {
      return NextResponse.json({ error: 'Unable to resolve wallet address' }, { status: 401 });
    }

    const resolvedRpcUrls = resolveRpcUrls(chainConfig.rpcUrls);
    const primaryRpcUrl = resolvedRpcUrls[0];
    const tokenConfigs: Record<ChainKey, { USDC?: typeof BASE_USDC; WETH?: typeof BASE_WETH; DAI?: typeof BASE_DAI }> = {
      BASE_SEPOLIA: { USDC: BASE_SEPOLIA_USDC, WETH: BASE_SEPOLIA_WETH },
      ETH_SEPOLIA: { USDC: ETH_SEPOLIA_USDC, WETH: ETH_SEPOLIA_WETH },
      ETH_MAINNET: { USDC: ETH_USDC, WETH: ETH_WETH, DAI: ETH_DAI },
      BASE_MAINNET: { USDC: BASE_USDC, WETH: BASE_WETH, DAI: BASE_DAI },
      SOLANA_MAINNET: {},
    } as const;

    const tokenConfig = tokenConfigs[resolvedChainKey];

    if (!('chainId' in chainConfig)) {
      return NextResponse.json({ error: 'Unsupported EVM chain configuration' }, { status: 400 });
    }

    const client = createPublicClient({
      chain: {
        ...baseSepolia,
        id: chainConfig.chainId,
        rpcUrls: { default: { http: resolvedRpcUrls }, public: { http: resolvedRpcUrls } },
      },
      transport: http(primaryRpcUrl),
    });

    const ethBalanceRaw = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/balances/route.ts',
        target: 'EVM getBalance',
        description: 'ETH balance lookup',
      },
      () => client.getBalance({ address: addressToQuery })
    );
    const eth = formatEther(ethBalanceRaw);
    const ethRaw = ethBalanceRaw.toString();
    let usdc = '0';
    let weth = '0';
    let dai = '0';
    let usdcRaw = '0';
    let wethRaw = '0';
    let daiRaw = '0';
    let usdcDecimals = tokenConfig?.USDC?.decimals ?? 6;
    let wethDecimals = tokenConfig?.WETH?.decimals ?? 18;
    let daiDecimals = tokenConfig?.DAI?.decimals ?? 18;

    const usdcAddress = tokenConfig?.USDC?.address;
    if (usdcAddress) {
      try {
        const [decimals, usdcBalanceRaw] = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/balances/route.ts',
            target: 'EVM readContract',
            description: 'USDC decimals + balance lookup',
          },
          () =>
            Promise.all([
              client.readContract({
                address: usdcAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'decimals',
              }),
              client.readContract({
                address: usdcAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [addressToQuery],
              }),
            ])
        );

        usdcDecimals = Number(decimals);
        usdc = formatUnits(usdcBalanceRaw, usdcDecimals);
        usdcRaw = usdcBalanceRaw.toString();
      } catch (erc20Err) {
        console.warn('USDC balance fetch failed, returning 0:', erc20Err);
        usdc = '0';
        usdcRaw = '0';
      }
    }

    const wethAddress = tokenConfig?.WETH?.address;
    if (wethAddress) {
      try {
        const [decimals, wethBalanceRaw] = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/balances/route.ts',
            target: 'EVM readContract',
            description: 'WETH decimals + balance lookup',
          },
          () =>
            Promise.all([
              client.readContract({
                address: wethAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'decimals',
              }),
              client.readContract({
                address: wethAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [addressToQuery],
              }),
            ])
        );

        wethDecimals = Number(decimals);
        weth = formatUnits(wethBalanceRaw, wethDecimals);
        wethRaw = wethBalanceRaw.toString();
      } catch (erc20Err) {
        console.warn('WETH balance fetch failed, returning 0:', erc20Err);
        weth = '0';
        wethRaw = '0';
      }
    }

    const daiAddress = tokenConfig?.DAI?.address;
    if (daiAddress) {
      try {
        const [decimals, daiBalanceRaw] = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/balances/route.ts',
            target: 'EVM readContract',
            description: 'DAI decimals + balance lookup',
          },
          () =>
            Promise.all([
              client.readContract({
                address: daiAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'decimals',
              }),
              client.readContract({
                address: daiAddress as `0x${string}`,
                abi: ERC20_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [addressToQuery],
              }),
            ])
        );

        daiDecimals = Number(decimals);
        dai = formatUnits(daiBalanceRaw, daiDecimals);
        daiRaw = daiBalanceRaw.toString();
      } catch (erc20Err) {
        console.warn('DAI balance fetch failed, returning 0:', erc20Err);
        dai = '0';
        daiRaw = '0';
      }
    }

    if (tokenToVerify) {
      try {
          const user = await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/balances/route.ts',
              target: 'syncUserFromAccessToken',
              description: 'Privy + Mongo user sync',
            },
            () => syncUserFromAccessToken(tokenToVerify)
          );
          const swapCacheKey = buildSwapOverrideCacheKey(user.UID, resolvedChainKey);
          let latestSwap = swapOverrideCache.get(swapCacheKey)?.swap ?? null;
          const cacheExpiresAt = swapOverrideCache.get(swapCacheKey)?.expiresAt ?? 0;
          const cacheFresh = cacheExpiresAt > Date.now();
          if (!cacheFresh) {
            await withWaitLogger(
              {
                file: 'altair_backend1/src/app/api/balances/route.ts',
                target: 'connectToDatabase',
                description: 'MongoDB connection for swap lookup',
              },
              () => connectToDatabase()
            );
            const swapCutoff = new Date(Date.now() - SWAP_OVERRIDE_MAX_AGE_MS);
            latestSwap = await withWaitLogger(
              {
                file: 'altair_backend1/src/app/api/balances/route.ts',
                target: 'Swap.findOne',
                description: 'load latest swap for balance fast path',
              },
              () =>
                Swap.findOne({
                  UID: user.UID,
                  createdAt: { $gte: swapCutoff },
                  $or: [
                    { 'sellToken.chain': resolvedChainKey },
                    { 'buyToken.chain': resolvedChainKey },
                  ],
                })
                  .sort({ createdAt: -1 })
                  .lean()
            );
            swapOverrideCache.set(swapCacheKey, {
              swap: latestSwap as Record<string, any> | null,
              expiresAt: Date.now() + SWAP_OVERRIDE_TTL_MS,
            });
          }
          const swapOverrides = resolveSwapBalanceOverrides({
            chainKey: resolvedChainKey,
            swap: latestSwap as Record<string, any> | null,
            tokenConfig,
          });
          if (swapOverrides) {
            const chainLabel = CHAIN_LABELS[resolvedChainKey];
            const chainBalances: Record<string, BalanceEntry[]> = {
              ETH: [
                buildBalanceEntry({
                  symbol: 'ETH',
                  name: 'Ethereum',
                  address: NATIVE_EVM_ADDRESS,
                  decimals: 18,
                  balance: ethRaw,
                }),
              ],
            };
            if (tokenConfig?.USDC?.address) {
              chainBalances.USDC = [
                buildBalanceEntry({
                  symbol: 'USDC',
                  name: tokenConfig.USDC.name ?? 'USD Coin',
                  address: tokenConfig.USDC.address,
                  decimals: usdcDecimals,
                  balance: usdcRaw,
                }),
              ];
            }
            if (tokenConfig?.WETH?.address) {
              chainBalances.WETH = [
                buildBalanceEntry({
                  symbol: 'WETH',
                  name: tokenConfig.WETH.name ?? 'Wrapped Ether',
                  address: tokenConfig.WETH.address,
                  decimals: wethDecimals,
                  balance: wethRaw,
                }),
              ];
            }
            if (tokenConfig?.DAI?.address) {
              chainBalances.DAI = [
                buildBalanceEntry({
                  symbol: 'DAI',
                  name: tokenConfig.DAI.name ?? 'Dai',
                  address: tokenConfig.DAI.address,
                  decimals: daiDecimals,
                  balance: daiRaw,
                }),
              ];
            }
            const updatePayload: Record<string, unknown> = {
              [`balances.${chainLabel}`]: chainBalances,
              ...(hasEmail || hasPhone ? contactUpdate : {}),
              ...(hasEvmAddress ? { evmAddress: bodyEvmAddress } : {}),
              ...(hasSolanaAddress ? { solAddress: bodySolanaAddress } : {}),
            };
            void (async () => {
              try {
                await connectToDatabase();
                await User.updateOne({ UID: user.UID }, { $set: updatePayload });
              } catch (err) {
                console.warn('EVM balance async write failed:', err);
              }
            })();
            return NextResponse.json({
              address: addressToQuery,
              eth: swapOverrides.eth ?? eth,
              usdc: swapOverrides.usdc ?? usdc,
              weth: swapOverrides.weth ?? weth,
              dai: swapOverrides.dai ?? dai,
            });
          }
          const chainLabel = CHAIN_LABELS[resolvedChainKey];
          const chainBalances: Record<string, BalanceEntry[]> = {
            ETH: [
            buildBalanceEntry({
              symbol: 'ETH',
              name: 'Ethereum',
              address: NATIVE_EVM_ADDRESS,
              decimals: 18,
              balance: ethRaw,
            }),
          ],
        };
        if (tokenConfig?.USDC?.address) {
          chainBalances.USDC = [
            buildBalanceEntry({
              symbol: 'USDC',
              name: tokenConfig.USDC.name ?? 'USD Coin',
              address: tokenConfig.USDC.address,
              decimals: usdcDecimals,
              balance: usdcRaw,
            }),
          ];
        }
        if (tokenConfig?.WETH?.address) {
          chainBalances.WETH = [
            buildBalanceEntry({
              symbol: 'WETH',
              name: tokenConfig.WETH.name ?? 'Wrapped Ether',
              address: tokenConfig.WETH.address,
              decimals: wethDecimals,
              balance: wethRaw,
            }),
          ];
        }
        if (tokenConfig?.DAI?.address) {
          chainBalances.DAI = [
            buildBalanceEntry({
              symbol: 'DAI',
              name: tokenConfig.DAI.name ?? 'Dai',
              address: tokenConfig.DAI.address,
              decimals: daiDecimals,
              balance: daiRaw,
            }),
          ];
        }
        const existingBalances = (user as { balances?: Record<string, unknown> }).balances?.[chainLabel] ?? null;
        const balancesChanged =
          !existingBalances || JSON.stringify(existingBalances) !== JSON.stringify(chainBalances);
        const shouldWriteBalances =
          shouldForceRefresh || balancesChanged || hasEmail || hasPhone || hasEvmAddress || hasSolanaAddress;
        if (!shouldWriteBalances) {
          return NextResponse.json({
            address: addressToQuery,
            eth,
            usdc,
            weth,
            dai,
          });
        }
        const updatePayload: Record<string, unknown> = {
          [`balances.${chainLabel}`]: chainBalances,
          ...(hasEmail || hasPhone ? contactUpdate : {}),
          ...(hasEvmAddress ? { evmAddress: bodyEvmAddress } : {}),
          ...(hasSolanaAddress ? { solAddress: bodySolanaAddress } : {}),
        };
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/balances/route.ts',
            target: 'User.updateOne',
            description: 'Mongo balances write (EVM)',
          },
          () =>
            User.updateOne(
              { UID: user.UID },
              { $set: updatePayload }
            )
        );
      } catch (updateErr) {
        console.warn('EVM balance sync failed:', updateErr);
      }
    }

    console.log('addressToQuery', addressToQuery);

    return NextResponse.json({
      address: addressToQuery,
      eth,
      usdc,
      weth,
      dai,
    });
  } catch (error) {
    console.error('Balance fetch error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
