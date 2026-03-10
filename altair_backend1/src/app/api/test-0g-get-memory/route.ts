import { NextResponse } from 'next/server';
import { getUserMemory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key : 'chat_bundle_v1';
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
    const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress : null;
    const uid = typeof body.uid === 'string' ? body.uid : null;

    const read = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-0g-get-memory/route.ts',
        target: 'getUserMemory',
        description: '0G memory read',
      },
      () =>
        getUserMemory({
          key,
          accessToken,
          walletAddressOverride: walletAddress,
          userIdOverride: uid,
        })
    );

    return NextResponse.json({ ok: true, key, read });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown read error',
      },
      { status: 500 }
    );
  }
}
