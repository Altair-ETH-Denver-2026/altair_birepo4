import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const LinkedAccountSchema = new Schema(
  {
    type: { type: String, required: true },
    address: { type: String },
    chainType: { type: String },
    chainId: { type: String },
    email: { type: String },
    name: { type: String },
    username: { type: String },
    profileImageUrl: { type: String },
    subject: { type: String },
    verifiedAt: { type: String },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    UID: { type: String, required: true, unique: true, index: true },
    privyUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, index: true },
    phone: { type: String, index: true },
    evmAddress: { type: String, index: true },
    solAddress: { type: String, index: true },
    webWallets: {
      type: [
        new Schema(
          {
            provider: { type: String, required: true },
            address: { type: String, required: true },
            addedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: null,
    },
    embeddedWalletId: { type: String },
    profileImageUrl: { type: String },
    linkedAccounts: { type: [LinkedAccountSchema], default: [] },
    balances: { type: Schema.Types.Mixed, default: {} },
    lastSeenAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

export type UserDocument = InferSchemaType<typeof UserSchema>;

export const User: Model<UserDocument> =
  mongoose.models.User ?? mongoose.model<UserDocument>('User', UserSchema);
