import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { Indexer } from '@0glabs/0g-ts-sdk';
import { withWaitLogger } from '@/lib/waitLogger';

export async function GET() {
  try {
    const rpcUrl = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
    const indexerRpc = process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai';
    const privateKey = process.env.ZG_PRIVATE_KEY;

    if (!privateKey) {
      return NextResponse.json({ ok: false, error: 'Missing ZG_PRIVATE_KEY' }, { status: 500 });
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const indexer = new Indexer(indexerRpc);

    const [network, balance] = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-0g-preflight/route.ts',
        target: '0G provider calls',
        description: 'network + balance lookup',
      },
      async () =>
        Promise.all([
          provider.getNetwork(),
          provider.getBalance(
            await withWaitLogger(
              {
                file: 'altair_backend1/src/app/api/test-0g-preflight/route.ts',
                target: 'signer.getAddress',
                description: '0G signer address',
              },
              () => signer.getAddress()
            )
          ),
        ])
    );
    const [nodes, nodesErr] = await withWaitLogger(
      {
        file: 'altair_backend1/src/app/api/test-0g-preflight/route.ts',
        target: '0G indexer.selectNodes',
        description: 'select storage nodes',
      },
      () => indexer.selectNodes(1)
    );
    const firstNode = nodes?.[0];
    const firstNodeStatus = firstNode
      ? await withWaitLogger(
          {
            file: 'altair_backend1/src/app/api/test-0g-preflight/route.ts',
            target: '0G node.getStatus',
            description: 'storage node status',
          },
          () => firstNode.getStatus()
        )
      : null;

    return NextResponse.json({
      ok: true,
      rpcUrl,
      indexerRpc,
      chainId: Number(network.chainId),
      signerAddress: await withWaitLogger(
        {
          file: 'altair_backend1/src/app/api/test-0g-preflight/route.ts',
          target: 'signer.getAddress',
          description: '0G signer address',
        },
        () => signer.getAddress()
      ),
      signerBalance0g: ethers.formatEther(balance),
      selectedNodes: nodes?.map((n) => n.url) ?? [],
      nodeSelectionError: nodesErr,
      firstNodeStatus,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown preflight error',
      },
      { status: 500 }
    );
  }
}
