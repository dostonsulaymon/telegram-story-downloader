import { Schema, model, InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    lastSeen: { type: Date, required: true, default: Date.now },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    collection: "users",
  }
);

export type UserDocument = InferSchemaType<typeof userSchema>;

export const UserModel = model<UserDocument>("User", userSchema);
