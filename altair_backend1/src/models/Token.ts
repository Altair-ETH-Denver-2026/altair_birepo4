import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const PriceInfoSchema = new Schema(
  {
    // Optional: a freshly-recorded token priced by swap-math has no prior price
    // to capture; only updatedAt + source are populated in that case.
    lastPrice: { type: Number, default: null },
    updatedAt: { type: Date, required: true },
    source: { type: String, required: true },
  },
  { _id: false }
);

const WrappedProxySchema = new Schema(
  {
    symbol: { type: String, required: true },
    address: { type: String, required: true },
  },
  { _id: false }
);

const TokenSchema = new Schema(
  {
    mint: { type: String, required: true, unique: true, index: true },
    chain: { type: String, index: true },
    chainId: { type: String },
    symbol: { type: String, index: true },
    name: { type: String, index: true },
    decimals: { type: Number },
    icon: { type: String },
    tags: { type: [String], default: [] },
    isVerified: { type: Boolean },
    tokenProgram: { type: String },
    jupUpdatedAt: { type: String },
    source: { type: String, default: 'jupiter', index: true },
    // Owned exclusively by the price refresher; signals "last successful price poll".
    // Defaults to null on newly-recorded tokens so the staleness signal stays valid
    // (a freshly inserted token must not look like it was just polled).
    lastFetchedAt: { type: Date, default: null },
    // Current last-known USD price for the token. `null` until the periodic price job runs.
    price: { type: Number, default: null, index: true },
    // Immediately prior price snapshot. Overwritten (not appended to) on each observed price change.
    priceInfo: { type: PriceInfoSchema, default: null },
    // True for native gas tokens (ETH on ETH_MAINNET/BASE_MAINNET/etc., SOL on
    // SOLANA_MAINNET). Set manually by an operator after the row is first created
    // by a swap. Default false keeps newly-inserted rows non-gas.
    gasToken: { type: Boolean, default: false, index: true },
    // For gasToken=true rows: the wrapped on-chain token whose CoinGecko price
    // proxies this native token. The periodic price refresher looks up CoinGecko
    // by `wrappedProxy.address` and writes the result onto this row.
    wrappedProxy: { type: WrappedProxySchema, default: null },
  },
  {
    timestamps: true,
  }
);

export type TokenDocument = InferSchemaType<typeof TokenSchema>;

export const Token: Model<TokenDocument> =
  mongoose.models.Token ?? mongoose.model<TokenDocument>('Token', TokenSchema);
