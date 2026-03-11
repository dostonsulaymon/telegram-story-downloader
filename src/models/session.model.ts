import { Schema, model, InferSchemaType } from "mongoose";

const sessionSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    sessionString: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["active", "banned", "pending"],
      default: "pending",
      index: true,
    },
    lastUsed: { type: Date, default: null },
    addedAt: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    collection: "sessions",
  }
);

export type SessionDocument = InferSchemaType<typeof sessionSchema>;

export const SessionModel = model<SessionDocument>("Session", sessionSchema);
