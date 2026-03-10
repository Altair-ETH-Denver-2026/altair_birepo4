// lib/jupTokens.ts
// Server-side helper for "1) token list API": Jupiter Tokens API V2 search
// Docs: https://api.jup.ag/tokens/v2/search?query=... :contentReference[oaicite:0]{index=0}

import { withWaitLogger } from '@/lib/waitLogger';

export type JupToken = {
  id: string;        // mint address
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  tags?: string[];
  isVerified?: boolean;
  tokenProgram?: string;
  updatedAt?: string;
};

type SearchOptions = {
  apiKey?: string;          // optional; pass if you have one
  maxResults?: number;      // client-side clamp; API defaults to 20 for name/symbol searches :contentReference[oaicite:1]{index=1}
  requireVerified?: boolean;
};

const JUP_BASE = "https://api.jup.ag";
const TOKEN_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
type TokenCacheEntry = { expiresAt: number; tokens: JupToken[] };
const tokenSearchCache = new Map<string, TokenCacheEntry>();

const buildCacheKey = (query: string, opts: SearchOptions) => {
  const normalizedQuery = query.trim().toLowerCase();
  return [
    normalizedQuery,
    opts.apiKey ? 'withKey' : 'noKey',
    opts.requireVerified ? 'verified' : 'all',
  ].join('|');
};

const getCachedTokens = (key: string): JupToken[] | null => {
  const entry = tokenSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenSearchCache.delete(key);
    return null;
  }
  return entry.tokens;
};

const setCachedTokens = (key: string, tokens: JupToken[]) => {
  tokenSearchCache.set(key, { expiresAt: Date.now() + TOKEN_SEARCH_CACHE_TTL_MS, tokens });
};

export async function searchJupiterTokens(
  query: string,
  opts: SearchOptions = {}
): Promise<JupToken[]> {
  if (!query?.trim()) return [];

  const cacheKey = buildCacheKey(query, opts);
  const cached = getCachedTokens(cacheKey);
  if (cached) {
    if (typeof opts.maxResults === "number" && opts.maxResults > 0) {
      return cached.slice(0, opts.maxResults);
    }
    return cached;
  }

  const url = new URL(`${JUP_BASE}/tokens/v2/search`);
  url.searchParams.set("query", query.trim());

  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey; // supported by docs :contentReference[oaicite:2]{index=2}

  const res = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/jupTokens.ts',
      target: 'Jupiter token search',
      description: 'token list response',
    },
    () =>
      fetch(url.toString(), {
        method: "GET",
        headers,
        // Next.js: avoid caching since token metadata can change
        cache: "no-store",
      })
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jupiter token search failed (${res.status}): ${text}`);
  }

  const data = await withWaitLogger(
    {
      file: 'altair_backend1/src/lib/jupTokens.ts',
      target: 'Jupiter token res.json',
      description: 'parse token list response',
    },
    () => res.json() as Promise<unknown>
  );

  if (!Array.isArray(data)) return [];

  let tokens = data as JupToken[];

  if (opts.requireVerified) {
    tokens = tokens.filter((t) => t.isVerified === true || t.tags?.includes("verified"));
  }

  setCachedTokens(cacheKey, tokens);

  if (typeof opts.maxResults === "number" && opts.maxResults > 0) {
    return tokens.slice(0, opts.maxResults);
  }

  return tokens;
}

export function pickBestMatch(tokens: JupToken[], userInput: string): JupToken | null {
  const q = userInput.trim().toLowerCase();
  if (!q) return null;

  // Prefer exact symbol match, then exact name match, then first verified, then first.
  const exactSymbol = tokens.find((t) => t.symbol?.toLowerCase() === q);
  if (exactSymbol) return exactSymbol;

  const exactName = tokens.find((t) => t.name?.toLowerCase() === q);
  if (exactName) return exactName;

  const verified = tokens.find((t) => t.isVerified === true || t.tags?.includes("verified"));
  return verified ?? tokens[0] ?? null;
}
