import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const PriceInfoSchema = new Schema(
  {
    lastPrice: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
    source: { type: String, required: true },
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
    lastFetchedAt: { type: Date, default: () => new Date() },
    // Current last-known USD price for the token. `null` until the periodic price job runs.
    price: { type: Number, default: null, index: true },
    // Immediately prior price snapshot. Overwritten (not appended to) on each observed price change.
    priceInfo: { type: PriceInfoSchema, default: null },
  },
  {
    timestamps: true,
  }
);

export type TokenDocument = InferSchemaType<typeof TokenSchema>;

export const Token: Model<TokenDocument> =
  mongoose.models.Token ?? mongoose.model<TokenDocument>('Token', TokenSchema);
