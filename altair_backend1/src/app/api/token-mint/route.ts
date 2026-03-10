// app/api/token-mint/route.ts (Next.js App Router)
// POST { "q": "BONK" } -> { mint, token, candidates }

import { NextResponse } from "next/server";
import { pickBestMatch, searchJupiterTokens } from "@/lib/jupTokens";

export async function POST(req: Request) {
  const { q } = (await req.json().catch(() => ({}))) as { q?: string };
  if (!q?.trim()) return NextResponse.json({ error: "Missing q" }, { status: 400 });

  const apiKey = process.env.JUPITER_API_KEY; // optional
  const candidates = await searchJupiterTokens(q, {
    apiKey,
    maxResults: 10,
    // requireVerified: true, // uncomment if you only want verified/strict-like results
  });

  if (candidates.length === 0) {
    return NextResponse.json({ mint: null, token: null, candidates: [] }, { status: 200 });
  }

  const best = pickBestMatch(candidates, q);

  return NextResponse.json(
    {
      mint: best?.id ?? null,
      token: best ?? null,
      candidates,
    },
    { status: 200 }
  );
}