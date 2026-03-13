export const ZG_NAMESPACE = {
  prefix: 'altair:', // namespace prefix used to isolate Altair data in 0G storage
  idMode: 'UID', // default identifier type used to scope 0G records per user
  idOptions: [
    'UID', 'wallet', 'evmAddress', 'solAddress', // supported identifier keys for 0G storage lookups
  ],
};

export type ZgStorageMode = 'onchain_0g' | 'hybrid' | 'local_only'; // storage strategy options for AI memory in Altair

export const ZG_STORAGE_MODE: ZgStorageMode = 'hybrid'; // default mode blending 0G onchain storage with local fallback

export const ZG_JSONS = {
  chat: {
    schemaVersion: 'v1', // schema tag for chat JSON payloads stored in 0G
    chats: [
      {
        userMessage: '', // user utterance stored for AI context and audit
        assistantReply: '', // assistant response stored for AI context and audit
        intentString: null, // nullable intent classification for this chat turn
        intentExecuted: false, // whether detected intent from this turn was executed
        timestamp: '', // timestamp recorded for ordering 0G chat history
      },
    ],
  },
  swap: {
    schemaVersion: 'v1', // schema tag for swap JSON payloads stored in 0G
    swaps: [
      {
        CID: null, // content ID linking swap details to 0G archival data
        intentString: '', // intent classification for this swap/bridge
        sellToken: {
          amount: '',
          decimals: 0,
          symbol: '',
          contractAddress: '',
          chain: '',
          chainId: '',
          walletAddress: '',
          balanceBefore: '',
          balanceAfter: '',
        },
        buyToken: {
          amount: '',
          decimals: 0,
          symbol: '',
          contractAddress: '',
          chain: '',
          chainId: '',
          walletAddress: '',
          balanceBefore: '',
          balanceAfter: '',
        },
        txHash: '', // transaction hash for the onchain swap
        timestamp: '', // timestamp recorded for swap history ordering
      },
    ],
  },
  chat_history_latest: {
    schemaVersion: 'v3', // schema tag for summarized chat history in 0G
    updatedAt: '', // last-updated timestamp for the running summary cache
    runningSummary: '', // condensed AI summary of recent conversation state
    chatTurns: [
      {
        CID: '', // content ID for each chat turn stored in 0G
        userMessage: '', // user utterance stored for AI recall
        assistantReply: '', // assistant reply stored for AI recall
        intentString: null, // nullable intent classification for this chat turn
        intentExecuted: false, // indicates whether the intent was executed
        timestamp: '', // timestamp for ordering summary chat turns
        swap: null, // optional swap metadata attached to the chat turn
      },
    ],
  },
};
