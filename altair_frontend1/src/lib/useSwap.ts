'use client';

import { usePrivy, useWallets } from '@privy-io/react-auth';
import { ethers } from 'ethers';
import { withWaitLogger } from './waitLogger';
import { BLOCKCHAIN, CHAINS, GAS_TOKENS, type ChainKey } from '@config/blockchain_config';
import { BASE_MAINNET, BASE_SEPOLIA, ETH_MAINNET, ETH_SEPOLIA, resolveRpcUrls } from '@config/chain_info';

const chainConfigs = {
  BASE_SEPOLIA,
  ETH_SEPOLIA,
  ETH_MAINNET,
  BASE_MAINNET,
} as const;

type EvmChainKey = Exclude<ChainKey, 'SOLANA_MAINNET' | 'SOLANA_DEVNET'>;
const isSolanaChain = (chainKey: ChainKey) => chainKey === 'SOLANA_MAINNET' || chainKey === 'SOLANA_DEVNET';

let swapQueue: Promise<void> = Promise.resolve();

const withSwapQueue = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = swapQueue.then(task, task);
  swapQueue = run.then(() => undefined, () => undefined);
  return run;
};

export const resolveSelectedChain = (explicitChain?: ChainKey) => {
  if (explicitChain) return explicitChain;
  if (typeof window === 'undefined') return BLOCKCHAIN;
  const stored = localStorage.getItem('selectedChain');
  if (stored && stored in CHAINS) return stored as ChainKey;
  return BLOCKCHAIN;
};

export const readCachedTokenSnapshot = (params: {
  chainKey: ChainKey;
  walletAddress: string | null | undefined;
  symbol: string;
}): { raw: string | null; decimals: number | null } => {
  const { chainKey, walletAddress, symbol } = params;
  if (typeof window === 'undefined') return { raw: null, decimals: null };
  if (!walletAddress) return { raw: null, decimals: null };
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) return { raw: null, decimals: null };

  const cacheKey = `cached:balances:${chainKey}:${walletAddress}`;
  const raw = localStorage.getItem(cacheKey);
  if (!raw) return { raw: null, decimals: null };

  try {
    const payload = JSON.parse(raw) as {
      source?: 'cache' | 'mongo' | 'blockchain' | 'stale';
      tokens?: Record<string, { symbol?: string; balance?: unknown; decimals?: unknown }>;
    };
    if (payload?.source === 'stale') return { raw: null, decimals: null };
    const tokens = payload?.tokens;
    if (!tokens || typeof tokens !== 'object') return { raw: null, decimals: null };

    const direct = tokens[normalizedSymbol];
    const bySymbol = direct ?? Object.values(tokens).find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = (entry as { symbol?: unknown }).symbol;
      return typeof candidate === 'string' && candidate.trim().toUpperCase() === normalizedSymbol;
    });

    if (!bySymbol || typeof bySymbol !== 'object') return { raw: null, decimals: null };
    const decimals = typeof bySymbol.decimals === 'number' ? bySymbol.decimals : null;
    if (decimals === null || decimals < 0) return { raw: null, decimals: null };

    const human = bySymbol.balance;
    if (typeof human === 'number' && Number.isFinite(human) && human >= 0) {
      return { raw: ethers.parseUnits(human.toString(), decimals).toString(), decimals };
    }
    if (typeof human === 'string' && human.trim().length > 0) {
      return { raw: ethers.parseUnits(human.trim(), decimals).toString(), decimals };
    }
    return { raw: null, decimals };
  } catch {
    return { raw: null, decimals: null };
  }
};

const ensureEvmChain = async (
  ethereumProvider: ethers.Eip1193Provider,
  chainKey: ChainKey,
) => {
  if (isSolanaChain(chainKey)) {
    throw new Error('Solana is not supported by the EVM swap flow.');
  }
  const chainConfig = chainConfigs[chainKey as EvmChainKey];
  console.log('[RPC] ensureEvmChain chainKey:', chainKey);
  console.log('[RPC] ensureEvmChain rpcUrls:', chainConfig.rpcUrls);
  const resolvedRpcUrls = resolveRpcUrls(chainConfig.rpcUrls);
  console.log('[RPC] ensureEvmChain resolvedRpcUrls:', resolvedRpcUrls);
  const targetChainId = `0x${chainConfig.chainId.toString(16)}`;
  const chainName = typeof chainConfig.name === 'string' && chainConfig.name.trim().length > 0
    ? chainConfig.name
    : chainKey;
  const explorerUrl = typeof chainConfig.explorerUrl === 'string' && chainConfig.explorerUrl.trim().length > 0
    ? chainConfig.explorerUrl
    : undefined;

  try {
    await ethereumProvider.request?.({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: targetChainId }],
    });
  } catch (switchError: unknown) {
    const error = switchError as { code?: number; message?: string };
    const unsupportedChain =
      error?.code === 4902 ||
      error?.code === -32602 ||
      (error?.message?.toLowerCase().includes('unsupported') ?? false);

    if (unsupportedChain) {
      await ethereumProvider.request?.({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: targetChainId,
            chainName,
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: resolvedRpcUrls,
            blockExplorerUrls: explorerUrl ? [explorerUrl] : [],
          },
        ],
      });
      return;
    }
    throw switchError;
  }
};

export const useSwap = (explicitChain?: ChainKey) => {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();

  return async (sellToken: string, sellAmount: string, buyToken: string, CID?: string | null) =>
    withSwapQueue(async () => {
      if (!authenticated || !wallets?.length) {
        throw new Error('No authenticated wallet available.');
      }

      const selectedChain = resolveSelectedChain(explicitChain);
      console.log('[RPC] selectedChain:', selectedChain);
      if (isSolanaChain(selectedChain)) {
        throw new Error('Solana is not supported by useSwap. Use useSolanaSwap instead.');
      }
      const evmChain = selectedChain as EvmChainKey;
      const chainConfig = chainConfigs[evmChain];
      console.log('[RPC] chainConfig rpcUrls:', chainConfig?.rpcUrls);
      if (!chainConfig) {
        throw new Error('Unsupported chain configuration.');
      }

      const wallet = wallets[0];
      const ethereumProvider = await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'Privy wallet.getEthereumProvider',
          description: 'EVM provider for swap',
        },
        () => wallet.getEthereumProvider()
      );
      await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'wallet_switchEthereumChain',
          description: `ensure chain ${selectedChain}`,
        },
        () => ensureEvmChain(ethereumProvider, selectedChain)
      );

      const provider = new ethers.BrowserProvider(ethereumProvider);
      const signer = await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'ethers.getSigner',
          description: 'EVM signer for swap',
        },
        () => provider.getSigner()
      );
      const managedSigner = new ethers.NonceManager(signer);
      const recipient = await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'ethers.getAddress',
          description: 'EVM recipient address',
        },
        () => managedSigner.getAddress()
      );

      const normalizedSell = sellToken.toUpperCase();
      const normalizedBuy = buyToken.toUpperCase();
      const amountWei = ethers.parseEther(sellAmount);

      const effectiveSell = normalizedSell;
      const gasSymbol = (GAS_TOKENS[selectedChain] ?? 'ETH').toUpperCase();
      const sellSnapshot = readCachedTokenSnapshot({ chainKey: selectedChain, walletAddress: recipient, symbol: effectiveSell });
      const buySnapshot = readCachedTokenSnapshot({ chainKey: selectedChain, walletAddress: recipient, symbol: normalizedBuy });
      const gasSnapshot = readCachedTokenSnapshot({ chainKey: selectedChain, walletAddress: recipient, symbol: gasSymbol });

      const routeResponse = await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: '/api/test-swap',
          description: 'swap route response',
        },
        () =>
          fetch('/api/test-swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              chain: selectedChain,
              sellToken: effectiveSell,
              buyToken: normalizedBuy,
              amount: sellAmount,
              recipient,
              CID: CID ?? null,
              balanceSnapshots: {
                sellTokenBeforeRaw: sellSnapshot.raw,
                buyTokenBeforeRaw: buySnapshot.raw,
                gasTokenBeforeRaw: gasSnapshot.raw,
                gasTokenSymbol: gasSymbol,
                gasTokenDecimals: gasSnapshot.decimals,
              },
            }),
          })
      );

      if (!routeResponse.ok) {
        const errorPayload = await routeResponse.json().catch(() => ({}));
        const message = typeof errorPayload?.error === 'string'
          ? errorPayload.error
          : 'Failed to fetch swap route';
        const err = new Error(message) as Error & {
          code?: string;
          payload?: unknown;
          status?: number;
        };
        err.code = typeof errorPayload?.code === 'string' ? errorPayload.code : undefined;
        err.payload = errorPayload;
        err.status = routeResponse.status;
        throw err;
      }

      const routePayload = (await routeResponse.json()) as {
        methodParameters?: { to: string; calldata: string; value: string };
        sellTokenAddress?: string;
      };

      if (!routePayload.methodParameters) {
        throw new Error('No swap route found');
      }

      const methodParameters = routePayload.methodParameters;

      if (effectiveSell !== 'ETH') {
        const sellTokenAddress = routePayload.sellTokenAddress;
        if (!sellTokenAddress) {
          throw new Error('Missing sell token address for approval');
        }
        const erc20Approve = new ethers.Contract(
          sellTokenAddress,
          ['function approve(address,uint256)'],
          managedSigner,
        );
        const approveTx = await withWaitLogger(
          {
            file: 'altair_frontend1/src/lib/useSwap.ts',
            target: 'ERC20.approve',
            description: 'token approval transaction submission',
          },
          () => erc20Approve.approve(methodParameters.to, ethers.MaxUint256)
        );
        await withWaitLogger(
          {
            file: 'altair_frontend1/src/lib/useSwap.ts',
            target: 'ERC20.approve.wait',
            description: 'token approval confirmation',
          },
          () => approveTx.wait()
        );
      }

      const tx = await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'sendTransaction',
          description: 'swap transaction submission',
        },
        () =>
          managedSigner.sendTransaction({
            to: methodParameters.to,
            data: methodParameters.calldata,
            value: methodParameters.value,
            gasLimit: 1_000_000n,
          })
      );

      await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: 'sendTransaction.wait',
          description: 'swap transaction confirmation',
        },
        () => tx.wait()
      );
      await withWaitLogger(
        {
          file: 'altair_frontend1/src/lib/useSwap.ts',
          target: '/api/test-swap writeback',
          description: 'swap writeback after confirmation',
        },
        async () => {
          const writebackRes = await fetch('/api/test-swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              chain: selectedChain,
              sellToken: effectiveSell,
              buyToken: normalizedBuy,
              amount: sellAmount,
              recipient,
              CID: CID ?? null,
              txHash: tx.hash,
              balanceSnapshots: {
                sellTokenBeforeRaw: sellSnapshot.raw,
                buyTokenBeforeRaw: buySnapshot.raw,
                gasTokenBeforeRaw: gasSnapshot.raw,
                gasTokenSymbol: gasSymbol,
                gasTokenDecimals: gasSnapshot.decimals,
              },
            }),
          });
          const writebackPayload = await writebackRes.json().catch(() => ({} as {
            error?: string;
            balanceUpdates?: Array<{ chain: ChainKey; symbol: string; balanceAfterRaw: string | null; decimals: number }>;
          }));
          if (!writebackRes.ok) {
            throw new Error(
              typeof writebackPayload?.error === 'string'
                ? writebackPayload.error
                : 'Swap writeback failed'
            );
          }

          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('altair:swap-complete', {
                detail: {
                  chain: selectedChain,
                  sellToken: effectiveSell,
                  buyToken: normalizedBuy,
                  balanceUpdates: Array.isArray(writebackPayload?.balanceUpdates)
                    ? writebackPayload.balanceUpdates
                    : [],
                },
              })
            );
          }
        }
      );
      return tx.hash as string;
    });
};
