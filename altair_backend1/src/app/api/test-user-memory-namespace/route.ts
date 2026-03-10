import { NextResponse } from 'next/server';
import { getUserMemory, saveUserMemory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';

export async function GET() {
  try {
    const walletAddress = '0xA7b35a68E8Dcaf78624896372b3B20ba1654E5D5';
    const key = 'chat_bundle_v1';
    const userA = `did:test:userA:${Date.now()}`;
    const userB = `did:test:userB:${Date.now()}`;

    const writeA = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-user-memory-namespace/route.ts',
        target: 'saveUserMemory',
        description: '0G memory write (userA)',
      },
      () =>
        saveUserMemory({
          key,
          value: JSON.stringify({ schemaVersion: 'v1', chats: [], summary: { from: 'A', ts: new Date().toISOString() } }),
          walletAddressOverride: walletAddress,
          userIdOverride: userA,
        })
    );
    const writeB = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-user-memory-namespace/route.ts',
        target: 'saveUserMemory',
        description: '0G memory write (userB)',
      },
      () =>
        saveUserMemory({
          key,
          value: JSON.stringify({ schemaVersion: 'v1', chats: [], summary: { from: 'B', ts: new Date().toISOString() } }),
          walletAddressOverride: walletAddress,
          userIdOverride: userB,
        })
    );

    const readA = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-user-memory-namespace/route.ts',
        target: 'getUserMemory',
        description: '0G memory read (userA)',
      },
      () =>
        getUserMemory({
          key,
          walletAddressOverride: walletAddress,
          userIdOverride: userA,
        })
    );
    const readB = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-user-memory-namespace/route.ts',
        target: 'getUserMemory',
        description: '0G memory read (userB)',
      },
      () =>
        getUserMemory({
          key,
          walletAddressOverride: walletAddress,
          userIdOverride: userB,
        })
    );

    const same =
      typeof readA.value === 'string' &&
      typeof readB.value === 'string' &&
      readA.value === readB.value;

    return NextResponse.json({
      ok: true,
      key,
      walletAddress: walletAddress.toLowerCase(),
      users: { userA, userB },
      writes: { userA: writeA, userB: writeB },
      reads: { userA: readA, userB: readB },
      isolated: !same,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown namespace test error',
      },
      { status: 500 }
    );
  }
}
