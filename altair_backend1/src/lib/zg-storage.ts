/* eslint-disable @typescript-eslint/no-explicit-any */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
import { ZG_VERBOSE } from '../../config/logging_config';
import { ZG_JSONS, ZG_NAMESPACE, ZG_STORAGE_MODE, type ZgStorageMode } from '../../config/zerog_config';
import { withWaitLogger } from '@/lib/waitLogger';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { getPrivyEvmWalletAddress, getPrivySolanaWalletAddress } from '@/lib/privy';
import { getUserUIDFromAccessToken } from '@/lib/users';

const ZG_RPC_URL = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const ZG_PRIVATE_KEY = process.env.ZG_PRIVATE_KEY;
const ZG_INDEXER_RPC = process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai';
const ZG_ENABLE_LOCAL_FALLBACK = (process.env.ZG_ENABLE_LOCAL_FALLBACK ?? 'true') === 'true';
const ZG_LOCAL_FALLBACK_PATH =
  process.env.ZG_LOCAL_FALLBACK_PATH ?? path.join(process.cwd(), '.cache', 'zg-memory-fallback.json');
const ZG_LOCAL_INDEX_PATH =
  process.env.ZG_LOCAL_INDEX_PATH ?? path.join(process.cwd(), '.cache', 'zg-storage-index.json');
const ZG_STORAGE_MODE_RESOLVED: ZgStorageMode = ZG_STORAGE_MODE ?? 'hybrid';

const ZG_CIRCUIT_BREAKER_THRESHOLD = Number(process.env.ZG_CIRCUIT_BREAKER_THRESHOLD ?? 3);
const ZG_CIRCUIT_BREAKER_COOLDOWN_MS = Number(process.env.ZG_CIRCUIT_BREAKER_COOLDOWN_MS ?? 300000);
const ZG_MIN_BALANCE_WEI = BigInt(process.env.ZG_MIN_BALANCE_WEI ?? '30000000000000000'); // 0.03 0G

const writeCircuitState: { consecutiveFailures: number; openUntil: number } = {
  consecutiveFailures: 0,
  openUntil: 0,
};

let writeQueue: Promise<void> = Promise.resolve();

const withWriteQueue = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
};

type SaveMemoryParams = {
  key: string;
  value: string;
  accessToken?: string | null;
  walletAddressOverride?: string | null;
  userIdOverride?: string | null;
};

type GetMemoryParams = {
  key: string;
  accessToken?: string | null;
  walletAddressOverride?: string | null;
  userIdOverride?: string | null;
};

export type ArchiveResult = {
  txHash: string | null;
  rootHash: string | null;
  error?: string | null;
  namespace?: string;
  userId?: string | null;
  backend?: '0g_file' | 'local_file';
};

type StorageIndex = {
  memory: Record<string, { rootHash: string; transactionHash: string | null; updatedAt: string }>;
};

type ReadMemoryResult = {
  status: 'memory_retrieved' | 'not_found' | 'memory_retrieved_fallback';
  key: string;
  namespace: string;
  userId: string | null;
  walletAddress: string;
  backend: '0g_file' | 'local_file' | 'none';
  value?: string;
  rootHash?: string;
  transactionHash?: string | null;
  warning?: string;
};

function maskSecret(value?: string | null): string {
  if (!value) return 'unset';
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function truncateLogValue(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[${value.length - max} chars more]`;
}

function log0gConfig(context: string): void {
  if (!ZG_VERBOSE) return;
  console.log(`[0G][${context}] config`, {
    ZG_RPC_URL,
    ZG_INDEXER_RPC,
    ZG_STORAGE_MODE: ZG_STORAGE_MODE_RESOLVED,
    ZG_ENABLE_LOCAL_FALLBACK,
    ZG_CIRCUIT_BREAKER_THRESHOLD,
    ZG_CIRCUIT_BREAKER_COOLDOWN_MS,
    ZG_MIN_BALANCE_WEI: ZG_MIN_BALANCE_WEI.toString(),
    ZG_PRIVATE_KEY: maskSecret(ZG_PRIVATE_KEY),
  });
}

function sessionKeyFromAccessToken(accessToken?: string | null): string {
  if (!accessToken) return 'anonymous';
  const parts = accessToken.split('.');
  if (parts.length < 2) return accessToken;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      sub?: string;
      sid?: string;
    };
    return payload.sub ?? payload.sid ?? accessToken;
  } catch {
    return accessToken;
  }
}

function composeMemoryNamespace(userId?: string): string {
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId) return `${ZG_NAMESPACE.prefix}0`;
  const namespace = `${ZG_NAMESPACE.prefix}${normalizedUserId}`;
  console.log(`[0G]namespace: [${namespace}]`);
  return namespace;
}

function composeLegacyWalletNamespace(userId: string, walletAddress: string): string {
  return `uid:${userId.trim()}:wallet:${walletAddress.toLowerCase()}`;
}

function safeFilePrefix(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, '_');
}

function indexMemoryKey(namespace: string, key: string): string {
  return `user:${namespace}:${key}`;
}

function extractTxHash(tx: unknown): string | null {
  if (typeof tx === 'string') return tx;
  if (typeof tx === 'object' && tx !== null) {
    const maybe = tx as { txHash?: string; transactionHash?: string; hash?: string };
    return maybe.txHash ?? maybe.transactionHash ?? maybe.hash ?? null;
  }
  return null;
}

function emptyIndex(): StorageIndex {
  return { memory: {} };
}

async function loadIndex(): Promise<StorageIndex> {
  try {
    const raw = await fs.readFile(ZG_LOCAL_INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as StorageIndex;
    if (parsed && typeof parsed === 'object' && parsed.memory && typeof parsed.memory === 'object') {
      return parsed;
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
}

async function saveIndex(index: StorageIndex): Promise<void> {
  await fs.mkdir(path.dirname(ZG_LOCAL_INDEX_PATH), { recursive: true });
  await fs.writeFile(ZG_LOCAL_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
}

async function loadFallbackStore(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ZG_LOCAL_FALLBACK_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

async function writeFallback(namespace: string, key: string, value: string): Promise<void> {
  const store = await loadFallbackStore();
  store[indexMemoryKey(namespace, key)] = value;
  await fs.mkdir(path.dirname(ZG_LOCAL_FALLBACK_PATH), { recursive: true });
  await fs.writeFile(ZG_LOCAL_FALLBACK_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function readFallback(
  namespace: string,
  key: string,
  legacyNamespace?: string | null
): Promise<string | null> {
  const store = await loadFallbackStore();
  const primary = store[indexMemoryKey(namespace, key)];
  if (typeof primary === 'string') return primary;
  if (legacyNamespace && legacyNamespace !== namespace) {
    const legacy = store[indexMemoryKey(legacyNamespace, key)];
    if (typeof legacy === 'string') return legacy;
  }
  return null;
}

function isCircuitOpenNow(): boolean {
  return Date.now() < writeCircuitState.openUntil;
}

function shouldAttemptOnchainWrite(): { shouldAttempt: boolean; reason?: string } {
  if (ZG_STORAGE_MODE_RESOLVED === 'local_only') return { shouldAttempt: false, reason: 'storage_mode_local_only' };
  if (isCircuitOpenNow()) return { shouldAttempt: false, reason: 'circuit_breaker_open' };
  return { shouldAttempt: true };
}

function markOnchainWriteSuccess(): void {
  writeCircuitState.consecutiveFailures = 0;
  writeCircuitState.openUntil = 0;
}

function markOnchainWriteFailure(): void {
  writeCircuitState.consecutiveFailures += 1;
  if (writeCircuitState.consecutiveFailures >= ZG_CIRCUIT_BREAKER_THRESHOLD) {
    writeCircuitState.openUntil = Date.now() + ZG_CIRCUIT_BREAKER_COOLDOWN_MS;
  }
}

function getEthersSigner(): ethers.Wallet {
  if (!ZG_PRIVATE_KEY) {
    throw new Error('ZG_PRIVATE_KEY is not set. This wallet must hold 0G tokens for storage operations.');
  }
  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL);
  return new ethers.Wallet(ZG_PRIVATE_KEY, provider);
}

async function uploadContentTo0g(content: string, namePrefix: string): Promise<{
  rootHash: string;
  transactionHash: string;
}> {
  log0gConfig('upload');
  console.log('[0G][upload] payload', {
    namePrefix,
    bytes: Buffer.byteLength(content, 'utf-8'),
    contentPreview: truncateLogValue(content),
  });
  const signer = getEthersSigner();
  const provider = signer.provider ?? new ethers.JsonRpcProvider(ZG_RPC_URL);
  const signerAddress = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'ethers.getAddress',
      description: '0G signer address',
    },
    () => signer.getAddress()
  );
  const signerBalanceWei = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'provider.getBalance',
      description: '0G signer balance',
    },
    () => provider.getBalance(signerAddress)
  );
  if (signerBalanceWei < ZG_MIN_BALANCE_WEI) {
    throw new Error(
      `Insufficient 0G signer balance for upload. Current=${ethers.formatEther(
        signerBalanceWei
      )} 0G, required_min=${ethers.formatEther(ZG_MIN_BALANCE_WEI)} 0G. ` +
        `Top up signer wallet ${signerAddress} on ${ZG_RPC_URL}.`
    );
  }

  const indexer = new Indexer(ZG_INDEXER_RPC);
  const tmpFile = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}.json`);
  await fs.writeFile(tmpFile, content, 'utf-8');
  const file = await ZgFile.fromFilePath(tmpFile);

  try {
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr !== null || !tree) {
      throw new Error(`Error computing Merkle tree: ${String(treeErr)}`);
    }
    const rootHash = tree.rootHash();
    if (!rootHash) throw new Error('Error computing Merkle root hash');

    const [tx, uploadErr] = await withWaitLogger(
      {
        file: 'altair_backend1/src/lib/zg-storage.ts',
        target: '0G indexer.upload',
        description: 'upload memory payload',
      },
      () => indexer.upload(file, ZG_RPC_URL, signer as any)
    );
    if (uploadErr !== null) throw new Error(`Error uploading to 0G Storage: ${String(uploadErr)}`);
    const txHash = extractTxHash(tx);
    return { rootHash, transactionHash: txHash ?? '' };
  } finally {
    await file.close().catch(() => undefined);
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}

async function downloadContentFrom0g(rootHash: string): Promise<string> {
  log0gConfig('download');
  if (ZG_VERBOSE) {
    console.log('[0G][download] request', { rootHash });
  }
  const indexer = new Indexer(ZG_INDEXER_RPC);
  const outputPath = path.join(os.tmpdir(), `0g-read-${Date.now()}.json`);
  const downloadErr = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: '0G indexer.download',
      description: 'download memory payload',
    },
    () => indexer.download(rootHash, outputPath, true)
  );
  if (downloadErr !== null) {
    throw new Error(`Error downloading from 0G Storage: ${String(downloadErr)}`);
  }
  const content = await fs.readFile(outputPath, 'utf-8');
  await fs.unlink(outputPath).catch(() => undefined);
  return content;
}

async function resolveNamespace(
  accessToken?: string | null,
  walletAddressOverride?: string | null,
  userIdOverride?: string | null
): Promise<{
  userId: string | null;
  walletAddress: string;
  namespace: string;
}> {
  const userId = userIdOverride ?? (accessToken ? await getUserUIDFromAccessToken(accessToken) : null);
  if (ZG_VERBOSE) {
    console.log('[0G] userId', userId);
    console.log('[0G] accessToken', accessToken);
    console.log('[0G] userIdOverride', userIdOverride);
  };
  let walletAddress = walletAddressOverride?.toLowerCase() ?? null;
  if (ZG_VERBOSE) {
    console.log('[0G] walletAddress', walletAddress);
    console.log('[0G] walletAddressOverride', walletAddressOverride);
  };
  if (!walletAddress && accessToken) {
    try {
      try {
        walletAddress = (
          await withWaitLogger(
            {
              file: 'altair_backend1/src/lib/zg-storage.ts',
              target: 'getPrivyEvmWalletAddress',
              description: 'resolve EVM wallet address for namespace',
            },
            () => getPrivyEvmWalletAddress(accessToken)
          )
        ).toLowerCase();
      } catch {
        walletAddress = (
          await withWaitLogger(
            {
              file: 'altair_backend1/src/lib/zg-storage.ts',
              target: 'getPrivySolanaWalletAddress',
              description: 'resolve Solana wallet address for namespace',
            },
            () => getPrivySolanaWalletAddress(accessToken)
          )
        ).toLowerCase();
      }
    } catch {
      walletAddress = null;
    }
  }
  const safeWallet = walletAddress ?? 'unknown_wallet';
  return {
    userId,
    walletAddress: safeWallet,
    namespace: composeMemoryNamespace(userId ?? undefined),
  };
}

export async function saveUserMemory(params: SaveMemoryParams): Promise<ArchiveResult> {
  const { key, value, accessToken, walletAddressOverride, userIdOverride } = params;
  const { userId, walletAddress, namespace } = await resolveNamespace(
    accessToken,
    walletAddressOverride,
    userIdOverride
  );
  const legacyNamespace =
    userId && walletAddress !== 'unknown_wallet' ? composeLegacyWalletNamespace(userId, walletAddress) : null;
  if (ZG_VERBOSE) {
    console.log('[0G][saveUserMemory] input', {
      key,
      namespace,
      userId,
      walletAddress,
      bytes: Buffer.byteLength(value, 'utf-8'),
      valuePreview: truncateLogValue(value),
    });
  }
  if (ZG_ENABLE_LOCAL_FALLBACK) {
    await writeFallback(namespace, key, value);
  }

  if (ZG_STORAGE_MODE_RESOLVED === 'local_only') {
    return {
      txHash: null,
      rootHash: null,
      namespace,
      userId,
      backend: 'local_file',
      error: null,
    };
  }

  const attemptDecision = shouldAttemptOnchainWrite();
  if (!attemptDecision.shouldAttempt) {
    return {
      txHash: null,
      rootHash: null,
      namespace,
      userId,
      backend: 'local_file',
      error: `0G write skipped: ${attemptDecision.reason}`,
    };
  }

  void withWriteQueue(async () => {
    try {
      const payload = JSON.stringify(
        {
          kind: 'memory',
          namespace,
          userId,
          walletAddress,
          key,
          value,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      );

      const prefixBase = userId ? `0g-memory-${userId}-${key}` : `0g-memory-anonymous-${key}`;
      const { rootHash, transactionHash } = await uploadContentTo0g(payload, safeFilePrefix(prefixBase));
      markOnchainWriteSuccess();

      const index = await loadIndex();
      index.memory[indexMemoryKey(namespace, key)] = {
        rootHash,
        transactionHash,
        updatedAt: new Date().toISOString(),
      };
      await saveIndex(index);
    } catch (err: any) {
      markOnchainWriteFailure();
      console.warn('[0G][saveUserMemory] async 0G write failed', {
        error: err?.message ?? String(err),
        key,
        namespace,
        userId,
      });
    }
  });

  return {
    txHash: null,
    rootHash: null,
    namespace,
    userId,
    backend: 'local_file',
    error: null,
  };
}

export async function getUserMemory(params: GetMemoryParams): Promise<ReadMemoryResult> {
  const { key, accessToken, walletAddressOverride, userIdOverride } = params;
  const { userId, walletAddress, namespace } = await resolveNamespace(
    accessToken,
    walletAddressOverride,
    userIdOverride
  );
  const legacyNamespace =
    userId && walletAddress !== 'unknown_wallet' ? composeLegacyWalletNamespace(userId, walletAddress) : null;
  if (ZG_VERBOSE) {
    console.log('[0G][getUserMemory] input', { key, namespace, userId, walletAddress });
  }

  try {
    const fallbackOnly = await readFallback(namespace, key, legacyNamespace);
    if (typeof fallbackOnly === 'string') {
      if (ZG_VERBOSE) {
        console.log('[0G][getUserMemory] read', {
          key,
          namespace,
          backend: 'local_file',
          bytes: Buffer.byteLength(fallbackOnly, 'utf-8'),
          valuePreview: truncateLogValue(fallbackOnly),
        });
      }
      return {
        status: 'memory_retrieved',
        key,
        namespace,
        userId,
        walletAddress,
        backend: 'local_file',
        value: fallbackOnly,
      };
    }

    if (ZG_STORAGE_MODE_RESOLVED === 'local_only') {
      return { status: 'not_found', key, namespace, userId, walletAddress, backend: 'none' };
    }

    const index = await loadIndex();
    const entry = index.memory[indexMemoryKey(namespace, key)];
    if (!entry) {
      const fallbackValue = await readFallback(namespace, key, legacyNamespace);
      if (typeof fallbackValue === 'string') {
        if (ZG_VERBOSE) {
          console.log('[0G][getUserMemory] read', {
            key,
            namespace,
            backend: 'local_file',
            bytes: Buffer.byteLength(fallbackValue, 'utf-8'),
            valuePreview: truncateLogValue(fallbackValue),
          });
        }
        return {
          status: 'memory_retrieved_fallback',
          key,
          namespace,
          userId,
          walletAddress,
          backend: 'local_file',
          value: fallbackValue,
        };
      }
      return { status: 'not_found', key, namespace, userId, walletAddress, backend: 'none' };
    }

    const raw = await downloadContentFrom0g(entry.rootHash);
    let value = raw;
    try {
      const parsed = JSON.parse(raw) as { value?: string };
      if (typeof parsed.value === 'string') value = parsed.value;
    } catch {
      // Keep raw for compatibility if file format changes.
    }

    if (ZG_ENABLE_LOCAL_FALLBACK) {
      await writeFallback(namespace, key, value);
    }

    console.log('[0G][getUserMemory] read', {
      key,
      namespace,
      backend: '0g_file',
      rootHash: entry.rootHash,
      bytes: Buffer.byteLength(value, 'utf-8'),
      valuePreview: truncateLogValue(value),
    });
    return {
      status: 'memory_retrieved',
      key,
      namespace,
      userId,
      walletAddress,
      backend: '0g_file',
      value,
      rootHash: entry.rootHash,
      transactionHash: entry.transactionHash ?? null,
    };
  } catch (err: any) {
    const fallbackValue = await readFallback(namespace, key, legacyNamespace);
    if (typeof fallbackValue === 'string') {
      if (ZG_VERBOSE) {
        console.log('[0G][getUserMemory] read', {
          key,
          namespace,
          backend: 'local_file',
          bytes: Buffer.byteLength(fallbackValue, 'utf-8'),
          valuePreview: truncateLogValue(fallbackValue),
          warning: err?.message ?? String(err),
        });
      }
      return {
        status: 'memory_retrieved_fallback',
        key,
        namespace,
        userId,
        walletAddress,
        backend: 'local_file',
        value: fallbackValue,
        warning: `0G file read failed: ${err?.message ?? String(err)}`,
      };
    }
    return {
      status: 'not_found',
      key,
      namespace,
      userId,
      walletAddress,
      backend: 'none',
      warning: err?.message ?? String(err),
    };
  }
}

export async function archiveTo0g(payload: object): Promise<ArchiveResult> {
  const serialized = JSON.stringify({
    schemaVersion: 'v1',
    chats: [],
    summary: payload ?? {},
    updatedAt: new Date().toISOString(),
  });
  return saveUserMemory({
    key: CHAT_BUNDLE_KEY,
    value: serialized,
    accessToken: undefined,
    walletAddressOverride: 'legacy_archive',
  });
}

export function parseMemoryValue(value?: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function compactMemoryForPrompt(memory: Record<string, unknown>): Record<string, unknown> {
  const turns = Array.isArray(memory.chatTurns)
    ? memory.chatTurns
        .filter((t) => t && typeof t === 'object')
        .slice(-2)
        .map((t) => {
          const turn = t as Record<string, unknown>;
          const swap = typeof turn.swap === 'object' && turn.swap !== null
            ? (turn.swap as Record<string, unknown>)
            : null;
          return {
            CID: typeof turn.CID === 'string' ? turn.CID : null,
            userMessage: typeof turn.userMessage === 'string' ? turn.userMessage.slice(0, 160) : null,
            assistantReply: typeof turn.assistantReply === 'string' ? turn.assistantReply.slice(0, 220) : null,
            hadSwapExecution: typeof turn.hadSwapExecution === 'boolean' ? turn.hadSwapExecution : null,
            timestamp: typeof turn.timestamp === 'string' ? turn.timestamp : null,
            swap: swap
              ? {
                  SID: typeof swap.SID === 'string' ? swap.SID : null,
                  intentString: typeof swap.intentString === 'string' ? swap.intentString : null,
                  sellToken: typeof swap.sellToken === 'object' && swap.sellToken !== null ? swap.sellToken : null,
                  buyToken: typeof swap.buyToken === 'object' && swap.buyToken !== null ? swap.buyToken : null,
                  txHash: typeof swap.txHash === 'string' ? swap.txHash : null,
                  timestamp: typeof swap.timestamp === 'string' ? swap.timestamp : null,
                }
              : null,
          };
        })
    : [];

  return {
    schemaVersion: typeof memory.schemaVersion === 'string' ? memory.schemaVersion : null,
    updatedAt: typeof memory.updatedAt === 'string' ? memory.updatedAt : null,
    runningSummary: typeof memory.runningSummary === 'string' ? memory.runningSummary : null,
    chatTurns: turns,
  };
}

/** Key for 0G swap history (same user namespace as chat bundle). */
export const SWAP_HISTORY_KEY = 'swap_history';

const SWAP_HISTORY_MAX = 100;

export type SwapHistoryEntry = {
  CID?: string | null;
  intentString?: string | null;
  sellToken: {
    amount: string;
    symbol: string;
    contractAddress: string | null;
    chain: string;
    chainId: string | number | null;
    walletAddress: string | null;
    balanceBefore?: string | null;
    balanceAfter?: string | null;
  };
  buyToken: {
    amount: string;
    symbol: string;
    contractAddress: string | null;
    chain: string;
    chainId: string | number | null;
    walletAddress: string | null;
    balanceBefore?: string | null;
    balanceAfter?: string | null;
  };
  txHash: string;
  timestamp: string;
};

/** Key for 0G chat history (legacy, same user namespace as chat bundle). */
export const CHAT_HISTORY_KEY = 'chat_history';
/** Key for combined chat history + summary payload. */
export const CHAT_BUNDLE_KEY = 'chat_bundle_v1';

const CHAT_HISTORY_MAX = 100;

export type ChatHistoryEntry = {
  userMessage: string;
  assistantReply: string;
  hadSwapExecution: boolean;
  timestamp: string;
};

type ChatHistoryPayload = { schemaVersion: string; chats: ChatHistoryEntry[] };
type ChatBundlePayload = {
  schemaVersion: string;
  chats: ChatHistoryEntry[];
  summary?: Record<string, unknown> | null;
  updatedAt?: string;
};

const parseChatBundle = (value?: string): ChatBundlePayload | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ChatBundlePayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.chats)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export async function getChatSummaryMemory(params: GetMemoryParams): Promise<Record<string, unknown> | null> {
  const bundleRead = await getUserMemory({ ...params, key: CHAT_BUNDLE_KEY });
  const bundle = parseChatBundle(bundleRead.value);
  if (bundle?.summary && typeof bundle.summary === 'object') {
    return bundle.summary;
  }

  const legacyRead = await getUserMemory({ ...params, key: 'chat_summary_latest' });
  const legacy = parseMemoryValue(legacyRead.value);
  if (!legacy || typeof legacy !== 'object') return legacy;

  if (Array.isArray(legacy.recentTurns)) {
    return {
      schemaVersion: 'v3',
      updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : null,
      runningSummary: typeof legacy.runningSummary === 'string' ? legacy.runningSummary : null,
      chatTurns: legacy.recentTurns,
    };
  }

  return legacy;
}

export async function getChatHistory(
  params: GetMemoryParams & { key: typeof CHAT_HISTORY_KEY },
  limit = 10
): Promise<ChatHistoryEntry[]> {
  if (ZG_VERBOSE) {
    console.log('[0G][chat-history] read start', {
      key: CHAT_HISTORY_KEY,
      limit,
    });
  }
  const bundleRead = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'read chat bundle memory',
    },
    () => getUserMemory({ ...params, key: CHAT_BUNDLE_KEY })
  );
  const bundle = parseChatBundle(bundleRead.value);
  if (bundle?.chats) {
    const chats = bundle.chats;
    if (ZG_VERBOSE) {
      console.log('[0G][chat-history] read success', {
        status: bundleRead.status,
        backend: bundleRead.backend,
        namespace: bundleRead.namespace,
        userId: bundleRead.userId,
        total: chats.length,
        returned: Math.min(limit, chats.length),
      });
    }
    return chats.slice(-limit).reverse();
  }

  const legacyRead = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'read chat history memory (legacy)',
    },
    () => getUserMemory(params)
  );
  if (!legacyRead.value) {
    if (ZG_VERBOSE) {
      console.log('[0G][chat-history] read empty', {
        status: legacyRead.status,
        backend: legacyRead.backend,
        namespace: legacyRead.namespace,
        userId: legacyRead.userId,
      });
    }
    return [];
  }
  try {
    const parsed = JSON.parse(legacyRead.value) as ChatHistoryPayload;
    const chats = Array.isArray(parsed?.chats) ? parsed.chats : [];
    if (ZG_VERBOSE) {
      console.log('[0G][chat-history] read success (legacy)', {
        status: legacyRead.status,
        backend: legacyRead.backend,
        namespace: legacyRead.namespace,
        userId: legacyRead.userId,
        total: chats.length,
        returned: Math.min(limit, chats.length),
      });
    }
    return chats.slice(-limit).reverse();
  } catch {
    if (ZG_VERBOSE) {
      console.warn('[0G][chat-history] read parse failed', {
        status: legacyRead.status,
        backend: legacyRead.backend,
        namespace: legacyRead.namespace,
        userId: legacyRead.userId,
      });
    }
    return [];
  }
}

type AppendChatParams = Omit<GetMemoryParams, 'key'> & {
  userMessage: string;
  assistantReply: string;
  hadSwapExecution?: boolean;
  timestamp?: string;
};

type AppendChatSummaryParams = AppendChatParams & {
  summary?: Record<string, unknown> | null;
};

export async function appendChatAndSummary(params: AppendChatSummaryParams): Promise<ArchiveResult> {
  const { userMessage, assistantReply, hadSwapExecution, accessToken, timestamp, summary } = params;
  if (ZG_VERBOSE) {
    console.log('[0G][chat-bundle] append start', {
      hadSwapExecution: Boolean(hadSwapExecution),
      timestamp: timestamp ?? null,
    });
  }
  const read = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'load chat bundle memory',
    },
    () => getUserMemory({ ...params, key: CHAT_BUNDLE_KEY })
  );
  const existingBundle = parseChatBundle(read.value);
  let chats = existingBundle?.chats ?? [];
  if (!existingBundle && read.value) {
    try {
      const parsed = JSON.parse(read.value) as ChatHistoryPayload;
      chats = Array.isArray(parsed?.chats) ? parsed.chats : [];
    } catch {
      // ignore
    }
  }
  if (ZG_VERBOSE) {
    console.log('[0G][chat-bundle] append loaded', {
      status: read.status,
      backend: read.backend,
      namespace: read.namespace,
      userId: read.userId,
      existing: chats.length,
    });
  }
  const entry: ChatHistoryEntry = {
    userMessage,
    assistantReply,
    hadSwapExecution: Boolean(hadSwapExecution),
    timestamp: timestamp ?? new Date().toISOString(),
  };
  chats = [...chats, entry].slice(-CHAT_HISTORY_MAX);
  const payload: ChatBundlePayload = {
    schemaVersion: CHAT_JSON_TEMPLATE.schemaVersion ?? 'v1',
    chats,
    summary: summary ?? existingBundle?.summary ?? null,
    updatedAt: new Date().toISOString(),
  };
  const write = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'saveUserMemory',
      description: 'write chat bundle memory',
    },
    () =>
      saveUserMemory({
        key: CHAT_BUNDLE_KEY,
        value: JSON.stringify(payload),
        accessToken: accessToken ?? null,
      })
  );
  if (ZG_VERBOSE) {
    console.log('[0G][chat-bundle] append complete', {
      backend: write.backend,
      rootHash: write.rootHash ?? null,
      namespace: write.namespace ?? null,
      userId: write.userId ?? null,
      total: chats.length,
      error: write.error ?? null,
    });
  }
  return write;
}

export async function appendChatToHistoryLegacy(params: AppendChatParams): Promise<ArchiveResult> {
  const { userMessage, assistantReply, hadSwapExecution, accessToken, timestamp } = params;
  if (ZG_VERBOSE) {
    console.log('[0G][chat-history] append start', {
      hadSwapExecution: Boolean(hadSwapExecution),
      timestamp: timestamp ?? null,
    });
  }
  const read = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'load chat history memory',
    },
    () => getUserMemory({ ...params, key: CHAT_HISTORY_KEY })
  );
  let chats: ChatHistoryEntry[] = [];
  if (read.value) {
    try {
      const parsed = JSON.parse(read.value) as ChatHistoryPayload;
      chats = Array.isArray(parsed?.chats) ? parsed.chats : [];
    } catch {
      // ignore
    }
  }
  if (ZG_VERBOSE) {
    console.log('[0G][chat-history] append loaded', {
      status: read.status,
      backend: read.backend,
      namespace: read.namespace,
      userId: read.userId,
      existing: chats.length,
    });
  }
  const entry: ChatHistoryEntry = {
    userMessage,
    assistantReply,
    hadSwapExecution: Boolean(hadSwapExecution),
    timestamp: timestamp ?? new Date().toISOString(),
  };
  console.log('[0G][chat-history] Newest Chat: entry', entry);
  chats = [...chats, entry].slice(-CHAT_HISTORY_MAX);
  const value = JSON.stringify({
    ...CHAT_JSON_TEMPLATE,
    schemaVersion: CHAT_JSON_TEMPLATE.schemaVersion ?? 'v1',
    chats,
  });
  const write = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'saveUserMemory',
      description: 'write chat history memory',
    },
    () =>
      saveUserMemory({
        key: CHAT_HISTORY_KEY,
        value,
        accessToken: accessToken ?? null,
      })
  );
  if (ZG_VERBOSE) {
    console.log('[0G][chat-history] append complete', {
      backend: write.backend,
      rootHash: write.rootHash ?? null,
      namespace: write.namespace ?? null,
      userId: write.userId ?? null,
      total: chats.length,
      error: write.error ?? null,
    });
  }
  return write;
}

type SwapHistoryPayload = { schemaVersion: string; swaps: SwapHistoryEntry[] };

const CHAT_JSON_TEMPLATE = ZG_JSONS.chat as { schemaVersion?: string };
const SWAP_JSON_TEMPLATE = ZG_JSONS.swap as { schemaVersion?: string };

export async function getSwapHistory(
  params: GetMemoryParams & { key: typeof SWAP_HISTORY_KEY },
  limit = 10
): Promise<SwapHistoryEntry[]> {
  if (ZG_VERBOSE) {
    console.log('[0G][swap-history] read start', {
      key: SWAP_HISTORY_KEY,
      limit,
    });
  }
  const read = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'read swap history memory',
    },
    () => getUserMemory(params)
  );
  if (!read.value) {
    if (ZG_VERBOSE) {
      console.log('[0G][swap-history] read empty', {
        status: read.status,
        backend: read.backend,
        namespace: read.namespace,
        userId: read.userId,
      });
    }
    return [];
  }
  try {
    const parsed = JSON.parse(read.value) as SwapHistoryPayload;
    const swaps = Array.isArray(parsed?.swaps) ? parsed.swaps : [];
    if (ZG_VERBOSE) {
      console.log('[0G][swap-history] read success', {
        status: read.status,
        backend: read.backend,
        namespace: read.namespace,
        userId: read.userId,
        total: swaps.length,
        returned: Math.min(limit, swaps.length),
      });
    }
    return swaps.slice(-limit).reverse();
  } catch {
    if (ZG_VERBOSE) {
      console.warn('[0G][swap-history] read parse failed', {
        status: read.status,
        backend: read.backend,
        namespace: read.namespace,
        userId: read.userId,
      });
    }
    return [];
  }
}

type AppendSwapParams = Omit<GetMemoryParams, 'key'> & {
  CID?: string | null;
  intentString?: string | null;
  sellToken: SwapHistoryEntry['sellToken'];
  buyToken: SwapHistoryEntry['buyToken'];
  txHash: string;
  timestamp?: string;
};

export async function appendSwapToHistory(params: AppendSwapParams): Promise<ArchiveResult> {
  const { CID, intentString, sellToken, buyToken, txHash, accessToken, timestamp } = params;
  if (ZG_VERBOSE) {
    console.log('[0G][swap-history] append start', {
      CID: CID ?? null,
      intentString: intentString ?? null,
      sellToken,
      buyToken,
      txHash,
      timestamp: timestamp ?? null,
    });
  }
  const read = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'getUserMemory',
      description: 'load swap history memory',
    },
    () => getUserMemory({ ...params, key: SWAP_HISTORY_KEY })
  );
  let swaps: SwapHistoryEntry[] = [];
  if (read.value) {
    try {
      const parsed = JSON.parse(read.value) as SwapHistoryPayload;
      swaps = Array.isArray(parsed?.swaps) ? parsed.swaps : [];
    } catch {
      // ignore
    }
  }
  if (ZG_VERBOSE) {
    console.log('[0G][swap-history] append loaded', {
      status: read.status,
      backend: read.backend,
      namespace: read.namespace,
      userId: read.userId,
      existing: swaps.length,
    });
  }
  const entry: SwapHistoryEntry = {
    CID: CID ?? null,
    intentString: intentString ?? null,
    sellToken,
    buyToken,
    txHash,
    timestamp: timestamp ?? new Date().toISOString(),
  };
  swaps = [...swaps, entry].slice(-SWAP_HISTORY_MAX);
  const value = JSON.stringify({
    ...SWAP_JSON_TEMPLATE,
    schemaVersion: SWAP_JSON_TEMPLATE.schemaVersion ?? 'v1',
    swaps,
  });
  const write = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/zg-storage.ts',
      target: 'saveUserMemory',
      description: 'write swap history memory',
    },
    () =>
      saveUserMemory({
        key: SWAP_HISTORY_KEY,
        value,
        accessToken: accessToken ?? null,
      })
  );
  if (ZG_VERBOSE) {
    console.log('[0G][swap-history] append complete', {
      intentString: intentString ?? null,
      txHash,
      backend: write.backend,
      rootHash: write.rootHash ?? null,
      namespace: write.namespace ?? null,
      userId: write.userId ?? null,
      total: swaps.length,
      error: write.error ?? null,
    });
  }
  return write;
}
