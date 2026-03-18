import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const ChatSchema = new Schema(
  {
    CID: { type: String, required: true, unique: true, index: true },
    SID: { type: String, default: null, index: true },
    UID: { type: String, required: true, index: true },
    evmAddress: { type: String, index: true },
    solAddress: { type: String, index: true },
    userMessage: { type: String },
    assistantReply: { type: String },
    intentString: { type: String, default: null },
    intentExecuted: { type: Boolean, default: false },
    timestamp: { type: String },
  },
  {
    timestamps: true,
  }
);

export type ChatDocument = InferSchemaType<typeof ChatSchema>;

export const Chat: Model<ChatDocument> =
  mongoose.models.Chat ?? mongoose.model<ChatDocument>('Chat', ChatSchema);
