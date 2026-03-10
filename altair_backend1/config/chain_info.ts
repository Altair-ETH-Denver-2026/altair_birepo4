export const ALCHEMY_API_KEY_PLACEHOLDER = 'NEXT_PUBLIC_ALCHEMY_API_KEY';

export const resolveRpcUrls = (rpcUrls: string[]) => {
  const apiKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  const resolved = rpcUrls
    .map((url) => (apiKey ? url.replace(ALCHEMY_API_KEY_PLACEHOLDER, apiKey) : url))
    .filter((url) => !url.includes(ALCHEMY_API_KEY_PLACEHOLDER));
  console.log('[RPC] resolveRpcUrls input:', rpcUrls);
  console.log('[RPC] resolveRpcUrls output:', resolved);
  return resolved;
};

export const BASE_SEPOLIA = {
  chainId: 84532,
  rpcUrls: [
    `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY_PLACEHOLDER}`,
    'https://sepolia.base.org',
  ],
  scanUrl: 'https://sepolia.basescan.org',
  uniswapAddresses: {
    router: '0x050E797f3625EC8785265e1d9BDd4799b97528A1',
    factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
  },
};

export const ETH_SEPOLIA = {
  chainId: 11155111,
  rpcUrls: [
    `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY_PLACEHOLDER}`,
    'https://rpc.sepolia.org',
  ],
  scanUrl: 'https://sepolia.etherscan.io',
  uniswapAddresses: {
    router: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
    swapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  },
};

export const ETH_MAINNET = {
  chainId: 1,
  rpcUrls: [
    `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY_PLACEHOLDER}`,
    'https://cloudflare-eth.com',
  ],
  scanUrl: 'https://etherscan.io',
  uniswapAddresses: {
    router: '',
    factory: '',
    swapRouter: '',
  },
};

export const BASE_MAINNET = {
  chainId: 8453,
  rpcUrls: [
    `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY_PLACEHOLDER}`,
    'https://mainnet.base.org',
  ],
  scanUrl: 'https://basescan.org',
  uniswapAddresses: {
    router: '',
    factory: '',
    swapRouter: '',
  },
};

export const SOLANA_MAINNET = {
  rpcUrls: [
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com/',
    'https://api.mainnet-beta.solana.com/',
  ],
  scanUrl: 'https://solscan.io',
  chainId: 792703809,
};

export const RELAY_CHAIN_INFO: Record<string, { chainId: number; scanUrl?: string; rpcUrls: string[] }> = {
  ethereum: { chainId: 1, scanUrl: 'https://etherscan.io', rpcUrls: [] },
  optimism: { chainId: 10, scanUrl: 'https://optimistic.etherscan.io', rpcUrls: [] },
  cronos: { chainId: 25, scanUrl: 'https://cronoscan.com', rpcUrls: [] },
  bsc: { chainId: 56, scanUrl: 'https://bscscan.com', rpcUrls: [] },
  gnosis: { chainId: 100, scanUrl: 'https://gnosisscan.io', rpcUrls: [] },
  unichain: { chainId: 130, scanUrl: 'https://uniscan.xyz', rpcUrls: [] },
  polygon: { chainId: 137, scanUrl: 'https://polygonscan.com', rpcUrls: [] },
  monad: { chainId: 143, scanUrl: 'https://monadvision.com', rpcUrls: [] },
  sonic: { chainId: 146, scanUrl: 'https://sonicscan.org', rpcUrls: [] },
  'manta-pacific': { chainId: 169, scanUrl: 'https://pacific-explorer.manta.network', rpcUrls: [] },
  mint: { chainId: 185, scanUrl: 'https://explorer.mintchain.io', rpcUrls: [] },
  boba: { chainId: 288, scanUrl: 'https://bobascan.com', rpcUrls: [] },
  zksync: { chainId: 324, scanUrl: 'https://explorer.zksync.io', rpcUrls: [] },
  shape: { chainId: 360, scanUrl: 'https://shapescan.xyz', rpcUrls: [] },
  appchain: { chainId: 466, scanUrl: 'https://explorer.appchain.xyz', rpcUrls: [] },
  'world-chain': { chainId: 480, scanUrl: 'https://worldscan.org', rpcUrls: [] },
  redstone: { chainId: 690, scanUrl: 'https://explorer.redstone.xyz', rpcUrls: [] },
  'flow-evm': { chainId: 747, scanUrl: 'https://evm.flowscan.io', rpcUrls: [] },
  stable: { chainId: 988, scanUrl: 'https://stablescan.xyz', rpcUrls: [] },
  hyperevm: { chainId: 999, scanUrl: 'https://hyperevmscan.io', rpcUrls: [] },
  metis: { chainId: 1088, scanUrl: 'https://explorer.metis.io', rpcUrls: [] },
  'polygon-zkevm': { chainId: 1101, scanUrl: 'https://zkevm.polygonscan.com', rpcUrls: [] },
  lisk: { chainId: 1135, scanUrl: 'https://blockscout.lisk.com', rpcUrls: [] },
  sei: { chainId: 1329, scanUrl: 'https://seitrace.com', rpcUrls: [] },
  hyperliquid: { chainId: 1337, scanUrl: 'https://app.hyperliquid.xyz/explorer', rpcUrls: [] },
  perennial: { chainId: 1424, scanUrl: 'https://explorer.perennial.foundation', rpcUrls: [] },
  story: { chainId: 1514, scanUrl: 'https://storyscan.xyz', rpcUrls: [] },
  gravity: { chainId: 1625, scanUrl: 'https://explorer.gravity.xyz', rpcUrls: [] },
  soneium: { chainId: 1868, scanUrl: 'https://soneium.blockscout.com', rpcUrls: [] },
  swellchain: { chainId: 1923, scanUrl: 'https://explorer.swellnetwork.io', rpcUrls: [] },
  ronin: { chainId: 2020, scanUrl: 'https://app.roninchain.com', rpcUrls: [] },
  abstract: { chainId: 2741, scanUrl: 'https://abscan.org', rpcUrls: [] },
  morph: { chainId: 2818, scanUrl: 'https://explorer.morphl2.io', rpcUrls: [] },
  megaeth: { chainId: 4326, scanUrl: 'https://megaeth.blockscout.com', rpcUrls: [] },
  mantle: { chainId: 5000, scanUrl: 'https://mantlescan.xyz', rpcUrls: [] },
  somnia: { chainId: 5031, scanUrl: 'https://explorer.somnia.network', rpcUrls: [] },
  superseed: { chainId: 5330, scanUrl: 'https://explorer.superseed.xyz', rpcUrls: [] },
  cyber: { chainId: 7560, scanUrl: 'https://cyberscan.co', rpcUrls: [] },
  'powerloom-v2': { chainId: 7869, scanUrl: 'https://explorer-v2.powerloom.network', rpcUrls: [] },
  'arena-z': { chainId: 7897, scanUrl: 'https://explorer.arena-z.gg', rpcUrls: [] },
  B3: { chainId: 8333, scanUrl: 'https://explorer.b3.fun', rpcUrls: [] },
  base: { chainId: 8453, scanUrl: 'https://basescan.org', rpcUrls: [] },
  plasma: { chainId: 9745, scanUrl: 'https://plasmascan.to', rpcUrls: [] },
  apechain: { chainId: 33139, scanUrl: 'https://apescan.io', rpcUrls: [] },
  funki: { chainId: 33979, scanUrl: 'https://explorer.funkichain.com', rpcUrls: [] },
  mode: { chainId: 34443, scanUrl: 'https://explorer.mode.network', rpcUrls: [] },
  mythos: { chainId: 42018, scanUrl: 'https://mythos-mainnet.explorer.alchemy.com', rpcUrls: [] },
  arbitrum: { chainId: 42161, scanUrl: 'https://arbiscan.io', rpcUrls: [] },
  'arbitrum-nova': { chainId: 42170, scanUrl: 'https://nova.arbiscan.io', rpcUrls: [] },
  celo: { chainId: 42220, scanUrl: 'https://celoscan.io', rpcUrls: [] },
  hemi: { chainId: 43111, scanUrl: 'https://explorer.hemi.xyz', rpcUrls: [] },
  avalanche: { chainId: 43114, scanUrl: 'https://snowtrace.io', rpcUrls: [] },
  gunz: { chainId: 43419, scanUrl: 'https://gunzscan.io', rpcUrls: [] },
  zircuit: { chainId: 48900, scanUrl: 'https://explorer.zircuit.com', rpcUrls: [] },
  superposition: { chainId: 55244, scanUrl: 'https://explorer.superposition.so', rpcUrls: [] },
  ink: { chainId: 57073, scanUrl: 'https://explorer.inkonchain.com', rpcUrls: [] },
  linea: { chainId: 59144, scanUrl: 'https://lineascan.build', rpcUrls: [] },
  bob: { chainId: 60808, scanUrl: 'https://explorer.gobob.xyz', rpcUrls: [] },
  animechain: { chainId: 69000, scanUrl: 'https://explorer-animechain-39xf6m45e3.t.conduit.xyz', rpcUrls: [] },
  berachain: { chainId: 80094, scanUrl: 'https://beratrail.io', rpcUrls: [] },
  blast: { chainId: 81457, scanUrl: 'https://blastscan.io', rpcUrls: [] },
  plume: { chainId: 98866, scanUrl: 'https://explorer.plume.org', rpcUrls: [] },
  taiko: { chainId: 167000, scanUrl: 'https://taikoscan.io', rpcUrls: [] },
  syndicate: { chainId: 510003, scanUrl: 'https://commons.explorer.syndicate.io', rpcUrls: [] },
  scroll: { chainId: 534352, scanUrl: 'https://scrollscan.com', rpcUrls: [] },
  'zero-network': { chainId: 543210, scanUrl: 'https://explorer.zero.network', rpcUrls: [] },
  xai: { chainId: 660279, scanUrl: 'https://explorer.xai-chain.net', rpcUrls: [] },
  katana: { chainId: 747474, scanUrl: 'https://explorer.katanarpc.com', rpcUrls: [] },
  lighter: { chainId: 3586256, scanUrl: 'https://lighter.exchange/explorer', rpcUrls: [] },
  ethereal: { chainId: 5064014, scanUrl: 'https://explorer.ethereal.trade', rpcUrls: [] },
  zora: { chainId: 7777777, scanUrl: 'https://explorer.zora.energy', rpcUrls: [] },
  bitcoin: { chainId: 8253038, scanUrl: 'https://mempool.space', rpcUrls: [] },
  eclipse: { chainId: 9286185, scanUrl: 'https://eclipsescan.xyz', rpcUrls: [] },
  soon: { chainId: 9286186, scanUrl: 'https://explorer.soo.network', rpcUrls: [] },
  corn: { chainId: 21000000, scanUrl: 'https://cornscan.io', rpcUrls: [] },
  degen: { chainId: 666666666, scanUrl: 'https://explorer.degen.tips', rpcUrls: [] },
  tron: { chainId: 728126428, scanUrl: 'https://tronscan.org/#', rpcUrls: [] },
  solana: { chainId: 792703809, scanUrl: 'https://solscan.io', rpcUrls: [] },
  ancient8: { chainId: 888888888, scanUrl: 'https://scan.ancient8.gg', rpcUrls: [] },
  rari: { chainId: 1380012617, scanUrl: 'https://mainnet.explorer.rarichain.org', rpcUrls: [] },
};
