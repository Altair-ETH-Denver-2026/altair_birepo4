import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const TokenSchema = new Schema(
  {
    amount: { type: String },
    decimals: { type: Number },
    symbol: { type: String },
    contractAddress: { type: String },
    chain: { type: String },
    chainId: { type: Schema.Types.Mixed },
    walletAddress: { type: String },
    balanceBefore: { type: String },
    balanceAfter: { type: String },
    fees: {
      type: Schema.Types.Mixed,
      default: {
        gas: { token: '', amount: '', decimals: null },
        provider: { token: '', amount: '', decimals: null },
        altair: { token: '', amount: '', decimals: null },
      },
    },
  },
  { _id: false }
);

const SwapSchema = new Schema(
  {
    SID: { type: String, required: true, unique: true, index: true },
    UID: { type: String, required: true, index: true },
    CID: { type: String, index: true },
    provider: { type: String, default: null, index: true },
    intentString: { type: String, index: true },
    sellToken: { type: TokenSchema },
    buyToken: { type: TokenSchema },
    txHash: { type: String, index: true },
    timestamp: { type: String },
  },
  {
    timestamps: true,
  }
);

export type SwapDocument = InferSchemaType<typeof SwapSchema>;

export const Swap: Model<SwapDocument> =
  mongoose.models.Swap ?? mongoose.model<SwapDocument>('Swap', SwapSchema);
