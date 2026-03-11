import { Schema, model, InferSchemaType } from "mongoose";

const adminSchema = new Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    addedBy: { type: Number, required: true },
    addedAt: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    collection: "admins",
  }
);

export type AdminDocument = InferSchemaType<typeof adminSchema>;

export const AdminModel = model<AdminDocument>("Admin", adminSchema);
