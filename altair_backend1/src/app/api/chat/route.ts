import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import OpenAI from 'openai';
import { CHAT_SUMMARY_LATEST, LLM_MODELS, PROVIDER_BASE_URLS, PROVIDER_KEYS, SYSTEM_PROMPT } from '../../../../config/ai_config';
import { MONGODB_JSONS } from '../../../../config/mongodb_config';
import { ZG_JSONS } from '../../../../config/zerog_config';
import { appendChatAndSummary, compactMemoryForPrompt, getChatSummaryMemory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';
import { connectToDatabase } from '@/lib/db';
import { syncUserFromAccessToken } from '@/lib/users';
import { Chat } from '@/models/Chat';
import { User } from '@/models/User';
import { Swap } from '@/models/Swap';
import { generateChatID } from '@/lib/id';
import { buildCorsHeaders } from '@/lib/appUrls';

const corsHeaders = buildCorsHeaders(null);

type LlmProvider = typeof LLM_MODELS.options[keyof typeof LLM_MODELS.options];

const resolveProviderForModel = (model: string): LlmProvider => {
  const provider = LLM_MODELS.options[model as keyof typeof LLM_MODELS.options] as LlmProvider | undefined;
  if (!provider) {
    throw new Error(`Unknown LLM provider for model: ${model}`);
  }
  return provider;
};

const resolveApiKeyForModel = (model: string): string => {
  const provider = resolveProviderForModel(model);
  const envKey = PROVIDER_KEYS[provider as keyof typeof PROVIDER_KEYS];
  if (!envKey) {
    throw new Error(`Missing provider key mapping for ${provider} (model ${model})`);
  }
  const apiKey = process.env[envKey];
  if (!apiKey) {
    throw new Error(`Missing API key for provider ${provider} (env ${envKey})`);
  }
  return apiKey;
};

const createOpenAiClient = (model: string) => {
  const provider = resolveProviderForModel(model);
  return new OpenAI({
    apiKey: resolveApiKeyForModel(model),
    ...(PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS] ? { baseURL: PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS] } : {}),
  });
};

const resolveMongoTemplate = (key: 'chat' | 'swap'): Record<string, unknown> => {
  const configValue = MONGODB_JSONS[key];
  if (configValue === 'ZG_JSONS') {
    const source = ZG_JSONS[key];
    return source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  }
  return configValue && typeof configValue === 'object' ? (configValue as Record<string, unknown>) : {};
};

const generateChatCompletion = async (params: {
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
}): Promise<string> => {
  const response = await withWaitLogger(
    {
      file: 'altair_backend1/src/app/api/chat/route.ts',
      target: 'chat completions',
      description: 'LLM response',
    },
    () =>
      createOpenAiClient(params.model).chat.completions.create({
        model: params.model,
        messages: params.messages,
      })
  );
  return response.choices[0]?.message?.content?.trim() ?? '';
};

const resolveModelCandidates = (models: ReadonlyArray<string> | string): string[] => {
  if (Array.isArray(models)) {
    return models.filter((model) => typeof model === 'string' && model.length > 0);
  }
  return typeof models === 'string' && models.length > 0 ? [models] : [];
};

const generateChatCompletionWithFallback = async (params: {
  models: ReadonlyArray<string> | string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
}): Promise<string> => {
  const candidates = resolveModelCandidates(params.models);
  if (candidates.length === 0) {
    throw new Error('No LLM models configured for this request');
  }
  let lastError: unknown = null;
  for (const model of candidates) {
    console.log('[chat] generateChatCompletion with model:', model);
    try {
      return await generateChatCompletion({ model, messages: params.messages });
    } catch (err) {
      lastError = err;
      console.warn('[chat] LLM model failed, trying next', {
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All LLM model attempts failed');
};

function truncateText(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

type ChatSummaryTurn = {
  CID?: string | null;
  userMessage: string;
  assistantReply: string;
  intentString?: string | null;
  intentExecuted: boolean;
  timestamp: string;
  swap?: {
    SID?: string | null;
    CID?: string | null;
    intentString?: string | null;
    sellToken?: {
      amount?: string | null;
      symbol?: string | null;
      contractAddress?: string | null;
      chain?: string | null;
      chainId?: string | number | null;
      walletAddress?: string | null;
      balanceBefore?: string | null;
      balanceAfter?: string | null;
    } | null;
    buyToken?: {
      amount?: string | null;
      symbol?: string | null;
      contractAddress?: string | null;
      chain?: string | null;
      chainId?: string | number | null;
      walletAddress?: string | null;
      balanceBefore?: string | null;
      balanceAfter?: string | null;
    } | null;
    txHash?: string | null;
    timestamp?: string | null;
  } | null;
};

function buildUpdatedChatSummary(params: {
  prevMemory: Record<string, unknown> | null;
  userMessage: string;
  assistantReply: string;
  runningSummary?: string | null;
  recentSwaps?: Array<Record<string, unknown>> | null;
  chatCID?: string | null;
}): Record<string, unknown> {
  const previousTurnsRaw = Array.isArray(params.prevMemory?.chatTurns)
    ? (params.prevMemory?.chatTurns as unknown[])
    : [];
  const previousTurns: ChatSummaryTurn[] = previousTurnsRaw
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const turn = t as Record<string, unknown>;
      return {
        CID: typeof turn.CID === 'string' ? turn.CID : null,
        userMessage: typeof turn.userMessage === 'string' ? turn.userMessage : '',
        assistantReply: typeof turn.assistantReply === 'string' ? turn.assistantReply : '',
        intentString: typeof turn.intentString === 'string' ? turn.intentString : null,
        intentExecuted: Boolean(turn.intentExecuted),
        timestamp: typeof turn.timestamp === 'string' ? turn.timestamp : new Date().toISOString(),
        swap: typeof turn.swap === 'object' && turn.swap !== null ? (turn.swap as ChatSummaryTurn['swap']) : null,
      };
    });

  const swapEntries = Array.isArray(params.recentSwaps)
    ? params.recentSwaps
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => {
          const item = entry as Record<string, unknown>;
          return {
            SID: typeof item.SID === 'string' ? item.SID : null,
            CID: typeof item.CID === 'string' ? item.CID : null,
            intentString: typeof item.intentString === 'string' ? item.intentString : null,
            sellToken: typeof item.sellToken === 'object' && item.sellToken !== null ? item.sellToken : null,
            buyToken: typeof item.buyToken === 'object' && item.buyToken !== null ? item.buyToken : null,
            txHash: typeof item.txHash === 'string' ? item.txHash : null,
            timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
          };
        })
    : [];

  const nextTurn: ChatSummaryTurn = {
    CID: params.chatCID ?? null,
    userMessage: truncateText(params.userMessage, 260),
    assistantReply: truncateText(params.assistantReply, 340),
    intentString: null,
    intentExecuted: false,
    timestamp: new Date().toISOString(),
    swap: null,
  };

  const turnsToStore = Math.max(1, Number(CHAT_SUMMARY_LATEST.chatQuantity ?? 3));
  const combined = [...previousTurns, nextTurn]
    .map((turn) => {
      const swapMatch = turn.CID
        ? swapEntries.find((swap) => swap.CID === turn.CID)
        : null;
      return {
        ...turn,
        swap: swapMatch ?? turn.swap ?? null,
      };
    })
    .slice(-turnsToStore);

  return {
    ...ZG_JSONS.chat_history_latest,
    schemaVersion: ZG_JSONS.chat_history_latest.schemaVersion ?? 'v3',
    updatedAt: new Date().toISOString(),
    runningSummary: typeof params.runningSummary === 'string' ? params.runningSummary : '',
    chatTurns: combined,
  };
}

function buildSummaryPrompt(params: {
  latestSummary: string;
  userMessage: string;
  aiMessage: string;
}): string {
  const { latestSummary, userMessage, aiMessage } = params;
  const prompt = `
I am an AI agent that helps people swap cryptocurrencies. My goal is to keep track of my conversations with a specific user, particularly their token preferences, trading history, and other blockchain and currency related details about them.

I have a running summary of my conversation with this user. Read it carefully.

Here is the latest summary:

"${latestSummary}"

I just received a new message from the user, and I responded. Please, update my summary with the latest back-and-forth between me, the AI agent, and the user.

Here is the latest chat:

User: "${userMessage}"
Me (AI Agent): "${aiMessage}"

Respond only with the newly updated summary. Do not respond with anything else besides the newly updated summary.

I am an AI agent that helps people swap cryptocurrencies. My goal is to keep track of my conversations with a specific user, particularly their token preferences, trading history, and other blockchain and currency related details about them.

I have a running summary of my conversation with this user. Read it carefully.

Here is the latest summary:

"${latestSummary}"

I just received a new message from the user, and I responded. Please, update my summary with the latest back-and-forth between me, the AI agent, and the user.

Here is the latest chat:

User: "${userMessage}"
Me (AI Agent): "${aiMessage}"

Respond only with the newly updated summary. Do not respond with anything else besides the newly updated summary.
`;

  return prompt.trim();
}

function extractRunningSummary(prevMemory: Record<string, unknown> | null): string {
  if (!prevMemory) return '';
  const runningSummary = prevMemory.runningSummary;
  if (typeof runningSummary === 'string') return runningSummary;
  const chatTurns = Array.isArray(prevMemory.chatTurns) ? prevMemory.chatTurns : [];
  if (chatTurns.length === 0) return '';
  const flattened = chatTurns
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const turn = t as Record<string, unknown>;
      const user = typeof turn.userMessage === 'string' ? turn.userMessage : '';
      const assistant = typeof turn.assistantReply === 'string' ? turn.assistantReply : '';
      if (!user && !assistant) return '';
      return `User: ${user}\nAssistant: ${assistant}`.trim();
    })
    .filter(Boolean)
    .join('\n');
  return flattened;
}

async function generateRunningSummary(params: {
  latestSummary: string;
  userMessage: string;
  aiMessage: string;
}): Promise<string> {
  const prompt = buildSummaryPrompt(params);
  return generateChatCompletionWithFallback({
    models: LLM_MODELS.runningSummary,
    messages: [{ role: 'system', content: prompt }],
  });
}

function buildChatSummaryPayload(params: {
  priorMemory: Record<string, unknown> | null;
  userMessage: string;
  aiResponse: string;
  runningSummary: string;
  recentSwaps?: Array<Record<string, unknown>> | null;
  chatCID?: string | null;
}): Record<string, unknown> {
  return buildUpdatedChatSummary({
    prevMemory: params.priorMemory,
    userMessage: params.userMessage,
    assistantReply: params.aiResponse,
    runningSummary: params.runningSummary,
    recentSwaps: params.recentSwaps,
    chatCID: params.chatCID,
  });
}

export async function POST(req: Request) {
  try {
  const t0 = Date.now();
    console.log('[chat] request start', { at: new Date(t0).toISOString() });
    const { message, history, accessToken, selectedChain, solanaAddress } = await req.json();
    const cookieStore = await cookies();
    const cookieToken = cookieStore.get('privy-token')?.value ?? null;
    const resolvedAccessToken =
      typeof accessToken === 'string' && accessToken.length > 0
        ? accessToken
        : (cookieToken ?? null);

    let zgHash: string | null = null;
    let zgError: string | null = null;
    let priorMemory: Record<string, unknown> | null = null;
    let priorSummaryText = '';
    let intentString: string | null = null;
    let intentExecuted = false;
    let balanceContext: Record<string, unknown> | null = null;
    let balanceContextForPrompt: Record<string, unknown> | null = null;
    let swapHistoryContext: Record<string, unknown>[] | null = null;

    // Pre-read latest user-scoped memory and inject compact context into the system prompt.
    let syncedUser: Awaited<ReturnType<typeof syncUserFromAccessToken>> | null = null;
    if (typeof resolvedAccessToken === 'string' && resolvedAccessToken.length > 0) {
      const summarySource = CHAT_SUMMARY_LATEST.source;
      if (summarySource === '0G') {
        try {
          priorMemory = await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/chat/route.ts',
              target: '0G getChatSummaryMemory',
              description: 'chat summary memory read',
            },
            () => getChatSummaryMemory({ key: 'chat_bundle_v1', accessToken: resolvedAccessToken })
          );
          priorSummaryText = extractRunningSummary(priorMemory);
        } catch (readErr) {
          console.warn('0G pre-read memory failed:', readErr);
        }
      }

      let userFromMongo: Awaited<ReturnType<typeof syncUserFromAccessToken>> | null = null;
      try {
        userFromMongo = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/chat/route.ts',
            target: 'syncUserFromAccessToken',
            description: 'Privy + Mongo user sync',
          },
          () => syncUserFromAccessToken(resolvedAccessToken, { mode: 'runtime' })
        );
        syncedUser = userFromMongo;
        await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/chat/route.ts',
            target: 'connectToDatabase',
            description: 'MongoDB connection for chat pre-read',
          },
          () => connectToDatabase()
        );
        const shouldUseMongoSummary = summarySource === 'MongoDB';
        const chatLimit = Math.max(1, Number(CHAT_SUMMARY_LATEST.chatQuantity ?? 3));
        const [userDoc, swapDocs, chatDocs] = await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/chat/route.ts',
            target: 'Mongo pre-read (user + swaps + chats)',
            description: 'Mongo pre-read for balances + swaps + chats',
          },
          () =>
            Promise.all([
              User.findOne({ UID: userFromMongo?.UID }, { balances: 1, solAddress: 1 }).lean(),
              Swap.find({ UID: userFromMongo?.UID })
                .select({
                  SID: 1,
                  CID: 1,
                  intentString: 1,
                  sellToken: 1,
                  buyToken: 1,
                  txHash: 1,
                  timestamp: 1,
                  createdAt: 1,
                })
                .sort({ createdAt: -1 })
                .limit(chatLimit)
                .lean(),
              shouldUseMongoSummary
                ? Chat.find({ UID: userFromMongo?.UID })
                    .select({
                      CID: 1,
                      userMessage: 1,
                      assistantReply: 1,
                      intentString: 1,
                      intentExecuted: 1,
                      timestamp: 1,
                      createdAt: 1,
                    })
                    .sort({ createdAt: -1 })
                    .limit(chatLimit)
                    .lean()
                : Promise.resolve([]),
            ])
        );
        if (userDoc?.balances && typeof userDoc.balances === 'object') {
          balanceContext = userDoc.balances as unknown as Record<string, unknown>;
        }
        if (!userFromMongo?.solAddress && typeof solanaAddress === 'string' && solanaAddress.length > 0) {
          await withWaitLogger(
            {
              file: 'altair_backend1/src/app/api/chat/route.ts',
              target: 'User.updateOne',
              description: 'Persist Solana address from frontend',
            },
            () => User.updateOne({ UID: userFromMongo?.UID }, { $set: { solAddress: solanaAddress } })
          );
        }
        if (swapDocs.length > 0) {
          swapHistoryContext = swapDocs.map((swap) => {
            const { _id, __v, ...rest } = swap as Record<string, unknown>;
            return rest;
          });
        }
        if (shouldUseMongoSummary) {
          const swapEntries = swapDocs.map((swap) => {
            const item = swap as Record<string, unknown>;
            return {
              SID: typeof item.SID === 'string' ? item.SID : null,
              CID: typeof item.CID === 'string' ? item.CID : null,
              intentString: typeof item.intentString === 'string' ? item.intentString : null,
              sellToken: typeof item.sellToken === 'object' && item.sellToken !== null ? item.sellToken : null,
              buyToken: typeof item.buyToken === 'object' && item.buyToken !== null ? item.buyToken : null,
              txHash: typeof item.txHash === 'string' ? item.txHash : null,
              timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
            };
          });
          const orderedChats = [...chatDocs].reverse();
          const chatTurns = orderedChats.map((chat) => {
            const item = chat as Record<string, unknown>;
            const cidValue = typeof item.CID === 'string' ? item.CID : null;
            const swapMatch = cidValue
              ? swapEntries.find((swap) => swap.CID === cidValue)
              : null;
            return {
              CID: cidValue,
              userMessage: typeof item.userMessage === 'string' ? item.userMessage : '',
              assistantReply: typeof item.assistantReply === 'string' ? item.assistantReply : '',
              intentString: typeof item.intentString === 'string' ? item.intentString : null,
              intentExecuted: Boolean(item.intentExecuted),
              timestamp: typeof item.timestamp === 'string'
                ? item.timestamp
                : typeof item.createdAt === 'string'
                  ? item.createdAt
                  : new Date().toISOString(),
              swap: swapMatch ?? null,
            };
          });
          priorMemory = {
            schemaVersion: 'v3',
            updatedAt: new Date().toISOString(),
            runningSummary: '',
            chatTurns,
          };
          priorSummaryText = extractRunningSummary(priorMemory);
        }
      } catch (balanceErr) {
        console.warn('Balance pre-read failed:', balanceErr);
      }
    }

    const formatBalanceFromRaw = (raw: string, decimals: number): string => {
      try {
        const normalized = raw?.trim?.() ?? '0';
        const value = BigInt(normalized || '0');
        if (!Number.isFinite(decimals) || decimals <= 0) return value.toString();
        const divisor = 10n ** BigInt(decimals);
        const whole = value / divisor;
        const fraction = value % divisor;
        if (fraction === 0n) return whole.toString();
        const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
        return `${whole.toString()}.${fractionStr}`;
      } catch {
        return raw;
      }
    };

    const buildBalancePromptContext = (balances: Record<string, unknown>): Record<string, unknown> => {
      const output: Record<string, unknown> = {};
      for (const [chain, symbols] of Object.entries(balances)) {
        if (!symbols || typeof symbols !== 'object') continue;
        const chainEntries = symbols as Record<string, unknown>;
        const chainOutput: Record<string, unknown> = {};
        for (const [symbol, entries] of Object.entries(chainEntries)) {
          if (!Array.isArray(entries)) continue;
          const normalizedEntries = entries
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => {
              const item = entry as {
                symbol?: string;
                name?: string;
                address?: string;
                decimals?: number;
                balance?: string;
              };
              const decimals = typeof item.decimals === 'number' ? item.decimals : 0;
              const rawBalance = typeof item.balance === 'string' ? item.balance : '0';
              return {
                ...item,
                balanceRaw: rawBalance,
                balance: formatBalanceFromRaw(rawBalance, decimals),
              };
            });
          chainOutput[symbol] = normalizedEntries;
        }
        output[chain] = chainOutput;
      }
      return output;
    };

    if (balanceContext) {
      balanceContextForPrompt = buildBalancePromptContext(balanceContext);
    }

    const memoryContextForPrompt = priorMemory ? compactMemoryForPrompt(priorMemory) : null;
    const memoryBlock = memoryContextForPrompt
      ? SYSTEM_PROMPT.contextBlocks.memoryBlock.withData.replace(
          '${JSON.stringify(memoryContextForPrompt)}',
          JSON.stringify(memoryContextForPrompt)
        )
      : SYSTEM_PROMPT.contextBlocks.memoryBlock.empty;
    const balancesBlock = balanceContextForPrompt
      ? SYSTEM_PROMPT.contextBlocks.balancesBlock.withData.replace(
          '${JSON.stringify(balanceContextForPrompt)}',
          JSON.stringify(balanceContextForPrompt)
        )
      : SYSTEM_PROMPT.contextBlocks.balancesBlock.empty;
    const swapsBlock = swapHistoryContext
      ? SYSTEM_PROMPT.contextBlocks.swapsBlock.withData.replace(
          '${JSON.stringify(swapHistoryContext)}',
          JSON.stringify(swapHistoryContext)
        )
      : SYSTEM_PROMPT.contextBlocks.swapsBlock.empty;

    const selectedChainBlock = typeof selectedChain === 'string' && selectedChain.length > 0
      ? SYSTEM_PROMPT.contextBlocks.selectedChainBlock.withData.replace('${selectedChain}', selectedChain)
      : SYSTEM_PROMPT.contextBlocks.selectedChainBlock.empty;

    const systemPrompt = `
      ${SYSTEM_PROMPT.basePrompt}
      ${selectedChainBlock}
      ${memoryBlock}
      ${balancesBlock}
      ${swapsBlock}
    `;

    // Actual OpenAI Call
    const modelCandidates = resolveModelCandidates(LLM_MODELS.mainChat);
    console.log('[chat] model candidates', modelCandidates);
    const normalizedHistory = Array.isArray(history)
      ? history
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => {
            const item = entry as { role?: string; content?: string };
            return {
              role: item.role ?? 'user',
              content: item.content ?? '',
            } as OpenAI.Chat.ChatCompletionMessageParam;
          })
      : [];

    const aiResponse: string = await generateChatCompletionWithFallback({
      models: modelCandidates,
      messages: [
        { role: 'system', content: systemPrompt },
        ...normalizedHistory,
        { role: 'user', content: message },
      ],
    });
    console.log('[chat] aiResponse:', aiResponse);
    const intentTypeCandidates = ['SINGLE_CHAIN_SWAP_INTENT', 'CROSS_CHAIN_SWAP_INTENT', 'BRIDGE_INTENT'] as const;
    intentString = intentTypeCandidates.find((candidate) => aiResponse.includes(candidate)) ?? null;
    intentExecuted = false;

    const executionNote: string | null = null;

    let cid: string | null = null;
    console.log('[chat] request complete', {
      durationMs: Date.now() - t0,
      hasZgHash: Boolean(zgHash),
      hasZgError: Boolean(zgError),
    });

    if (typeof resolvedAccessToken === 'string' && resolvedAccessToken.length > 0) {
      const user = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/chat/route.ts',
          target: 'syncUserFromAccessToken',
          description: 'Privy + Mongo user sync',
        },
        () => syncUserFromAccessToken(resolvedAccessToken, { mode: 'runtime' })
      );
      const chatTemplate = resolveMongoTemplate('chat');
      const chatEntry = {
        ...chatTemplate,
        userMessage: message,
        assistantReply: aiResponse,
        intentString,
        intentExecuted,
        timestamp: new Date().toISOString(),
      };
      await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/chat/route.ts',
          target: 'connectToDatabase',
          description: 'MongoDB connection for chat write',
        },
        () => connectToDatabase()
      );
      const CID = await generateChatID();
      const chatRecord = await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/chat/route.ts',
          target: 'Chat.create',
          description: 'Mongo chat write',
        },
        () =>
          Chat.create({
            CID,
            SID: null,
            UID: user.UID,
            evmAddress: user.evmAddress ?? null,
            solAddress: user.solAddress ?? null,
            ...chatEntry,
          })
      );
      cid = chatRecord.CID;

      setTimeout(() => {
        void (async () => {
          try {
            const runningSummary: string = await generateRunningSummary({
              latestSummary: priorSummaryText,
              userMessage: message,
              aiMessage: aiResponse,
            });
            const summaryPayload = buildChatSummaryPayload({
              priorMemory,
              userMessage: message,
              aiResponse,
              runningSummary,
              recentSwaps: swapHistoryContext ?? null,
              chatCID: cid,
            });
            const write = await appendChatAndSummary({
              accessToken: resolvedAccessToken,
              userMessage: message,
              assistantReply: aiResponse,
              intentString,
              intentExecuted,
              summary: summaryPayload,
            });
            const asyncHash = write.txHash ?? null;
            const asyncError = write.backend === 'local_file' && write.error ? write.error : null;
            console.log('[chat] async 0G write complete', {
              hasZgHash: Boolean(asyncHash),
              hasZgError: Boolean(asyncError),
              zgHash: asyncHash,
              zgError: asyncError,
            });
          } catch (saveErr) {
            const asyncError = saveErr instanceof Error ? saveErr.message : 'Failed to save memory to 0G';
            console.warn('[chat] async 0G write failed', { zgError: asyncError });
          }
        })();
      }, 0);
    }
    return NextResponse.json({
      content: executionNote ? `${executionNote}\n\n${aiResponse}` : aiResponse,
      zgHash,
      txHash: zgHash,
      zgError,
      cid,
      solAddress: syncedUser?.solAddress ?? null,
    }, { headers: corsHeaders });
  } catch (error) {
    console.error('Chat Error:', error);
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS(req: Request) {
  const headers = buildCorsHeaders(req.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
