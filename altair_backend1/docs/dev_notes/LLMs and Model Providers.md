
## LLMs and Model Providers

### Model Selection

[`LLM_MODELS`](../../config/ai_config.ts) in `ai_config.ts` defines two **ordered fallback arrays**:

- **`mainChat`**: `['grok-4-fast', 'grok-4', 'gpt-4o-mini']` — used for the primary assistant response
- **`runningSummary`**: `['grok-4-fast', 'grok-4', 'gpt-4o-mini']` — used for the async background summarization after each chat turn

`LLM_MODELS.options` is a flat map of `modelId → provider` (e.g. `'grok-4-fast' → 'X'`, `'gpt-4o-mini' → 'OpenAI'`). This is the registry of every model the system knows about. Currently six providers are registered: `OpenAI`, `Anthropic`, `Google`, `Perplexity`, `X` (xAI/Grok), and `Groq`.

---

### Provider & API Key Resolution

In [`/api/chat/route.ts`](../../src/app/api/chat/route.ts), two functions handle routing:

**[`resolveProviderForModel(model)`](../../src/app/api/chat/route.ts:34)** — looks up the model in `LLM_MODELS.options` and returns the provider string (e.g. `'X'`). Throws if the model isn't registered.

**[`resolveApiKeyForModel(model)`](../../src/app/api/chat/route.ts:42)** — calls `resolveProviderForModel`, then looks up the provider in [`PROVIDER_KEYS`](../../config/ai_config.ts:72) to get the env var name (e.g. `'XAI_API_KEY'`), then reads `process.env[envKey]`. Throws if the env var is missing.

[`PROVIDER_KEYS`](../../config/ai_config.ts:72) maps:

| Provider | Env Var |
|---|---|
| `X` | `XAI_API_KEY` |
| `OpenAI` | `OPENAI_API_KEY` |
| `Anthropic` | `ANTHROPIC_API_KEY` |
| `Google` | `GOOGLE_API_KEY` |
| `Perplexity` | `PERPLEXITY_API_KEY` |
| `Groq` | `GROQ_API_KEY` |

---

### All Providers Use the OpenAI SDK

**[`createOpenAiClient(model)`](../../src/app/api/chat/route.ts:95)** creates a standard `new OpenAI({ apiKey, baseURL? })` client. Every provider is called through the OpenAI SDK because they all expose OpenAI-compatible APIs. Two providers need a custom `baseURL`:

```ts
export const PROVIDER_BASE_URLS: Partial<Record<keyof typeof PROVIDER_KEYS, string>> = {
  X: 'https://api.x.ai/v1',
  Groq: 'https://api.groq.com/openai/v1',
};
```

This means **adding a new provider** only requires:
1. An entry in `LLM_MODELS.options` mapping `modelId → providerName`
2. An entry in `PROVIDER_KEYS` mapping `providerName → 'ENV_VAR_NAME'`
3. Optionally, an entry in `PROVIDER_BASE_URLS` if the provider uses a non-default base URL

The `createOpenAiClient` call also installs a custom `fetch` wrapper (`openAiFetchWithRateLimitLogging`) that logs `429` responses with model/provider/url context.

---

### Fallback Execution Loop

**[`generateChatCompletionWithFallback()`](../../src/app/api/chat/route.ts:167)** iterates through the model candidates in order, trying each until one succeeds:

```ts
for (const model of candidates) {
  try {
    return await generateChatCompletion({ model, messages });
  } catch (err) {
    // log warning (rate-limit-aware), try next model
  }
}
throw lastError; // all models failed
```

**[`generateChatCompletion()`](../../src/app/api/chat/route.ts:113)** makes the actual API call:

```ts
createOpenAiClient(params.model).chat.completions.create({
  model: params.model,
  messages: params.messages,
})
```

Both the main chat call and the async running-summary call go through this same fallback mechanism, just with different model arrays from `LLM_MODELS`.

---

### What Gets Sent to the LLM

The system prompt is assembled dynamically in [`POST`](../../src/app/api/chat/route.ts:424) from four context blocks defined in [`SYSTEM_PROMPT.contextBlocks`](../../config/ai_config.ts:186):

| Block | Content |
|---|---|
| `selectedChainBlock` | The chain the user has selected in the UI (e.g. `BASE_MAINNET`) |
| `memoryBlock` | Compacted prior chat memory (from 0G or MongoDB, last 20 turns per `CHAT_SUMMARY_LATEST.chatQuantity`) |
| `balancesBlock` | MongoDB balance snapshot for the user, formatted with human-readable amounts |
| `swapsBlock` | Last N recent swaps from MongoDB |

The full message array sent to the LLM is:

```
[system prompt] + [prior conversation history from frontend] + [current user message]
```

The conversation history comes from the frontend — [`Chat.tsx:527`](../../../altair_frontend1/src/components/Chat.tsx) sends `messages.map((m) => ({ role: m.role, content: m.content }))` with each request, so the LLM always has the full in-session context.

---

### Async Running Summary

After the main response is returned to the user, a `setTimeout(..., 0)` fires a background task that:

1. Calls `generateRunningSummary()` — another LLM call using `LLM_MODELS.runningSummary` models, with a prompt asking the model to update a rolling plain-text summary of the conversation
2. Builds a structured `chatSummary` payload (last N turns + the new running summary text) via `buildUpdatedChatSummary()` ([`chat/route.ts:254`](../../src/app/api/chat/route.ts:254))
3. Writes it to 0G decentralized storage via `appendChatAndSummary()` ([`zg-storage.ts:860`](../../src/lib/zg-storage.ts:860))

This means the summary update never blocks the user's response — it happens fire-and-forget after the HTTP response is already sent.

---

### Swap Intent Detection

The LLM is instructed (via [`SYSTEM_PROMPT.basePrompt`](../../config/ai_config.ts:165)) to embed a JSON intent object in its response whenever it detects a swap request. Three intent types are defined in [`INTENTS.SWAP_INTENTS`](../../config/ai_config.ts:87):

| Intent Type | When Used |
|---|---|
| `SINGLE_CHAIN_SWAP_INTENT` | Same-chain token swap |
| `CROSS_CHAIN_SWAP_INTENT` | Swap where source and destination chains differ |
| `BRIDGE_INTENT` | Same token bridged across chains |

The frontend parses the LLM response for this JSON in `extractSwapIntent` ([`Chat.tsx:118`](../../../altair_frontend1/src/components/Chat.tsx)) and `extractIntentJsonSlice` ([`Chat.tsx:141`](../../../altair_frontend1/src/components/Chat.tsx)), strips it from the displayed text, stores it as a `pendingIntent`, and executes it when the user sends a confirmation phrase. The accepted phrases (`Chat.tsx:189`) are: `'confirm', 'yes', 'execute', 'do it', 'ok', 'okay'`.
