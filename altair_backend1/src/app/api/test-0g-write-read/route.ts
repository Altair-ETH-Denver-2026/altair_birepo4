import { NextResponse } from 'next/server';
import { getUserMemory, saveUserMemory } from '@/lib/zg-storage';
import { withWaitLogger } from '@/lib/waitLogger';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : null;
    const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress : null;
    const uid = typeof body.uid === 'string' ? body.uid : null;

    const key = typeof body.key === 'string' ? body.key : 'chat_bundle_v1';
    const value =
      typeof body.value === 'string'
        ? body.value
        : JSON.stringify({
            schemaVersion: 'v1',
            updatedAt: new Date().toISOString(),
            chats: [
              {
                userMessage: 'test write',
                assistantReply: 'test read',
                intentString: null,
                intentExecuted: false,
                timestamp: new Date().toISOString(),
              },
            ],
            summary: {
              schemaVersion: 'v3',
              updatedAt: new Date().toISOString(),
              runningSummary: 'test summary',
              chatTurns: [
                {
                  CID: '0c-test',
                  userMessage: 'test write',
                  assistantReply: 'test read',
                  intentString: 'SINGLE_CHAIN_SWAP_INTENT',
                  intentExecuted: false,
                  timestamp: new Date().toISOString(),
                  swap: {
                    SID: '0s-test',
                    CID: '0c-test',
                    intentString: 'SINGLE_CHAIN_SWAP_INTENT',
                    sellToken: {
                      amount: '0.1',
                      symbol: 'ETH',
                      contractAddress: '0x0000000000000000000000000000000000000000',
                      chain: 'BASE_MAINNET',
                      chainId: 8453,
                      walletAddress: '0x-test-wallet',
                      balanceBefore: '1.5',
                      balanceAfter: '1.4',
                    },
                    buyToken: {
                      amount: '180',
                      symbol: 'USDC',
                      contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      chain: 'BASE_MAINNET',
                      chainId: 8453,
                      walletAddress: '0x-test-wallet',
                      balanceBefore: '50',
                      balanceAfter: '230',
                    },
                    txHash: '0x-test',
                    timestamp: new Date().toISOString(),
                  },
                },
              ],
            },
          });

    const write = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-0g-write-read/route.ts',
        target: 'saveUserMemory',
        description: '0G memory write',
      },
      () =>
        saveUserMemory({
          key,
          value,
          accessToken,
          walletAddressOverride: walletAddress,
          userIdOverride: uid,
        })
    );

    const read = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-0g-write-read/route.ts',
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

    return NextResponse.json({
      ok: true,
      key,
      write,
      read,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown write/read error',
      },
      { status: 500 }
    );
  }
}
