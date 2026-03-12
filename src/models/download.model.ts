import { Schema, model, InferSchemaType, Types } from "mongoose";

const downloadSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetUsername: { type: String, required: true },
    type: { type: String, required: true, enum: ["current", "last", "all", "single"] },
    sessionPhone: { type: String, required: true },
    mediaCount: { type: Number, required: true },
    status: { type: String, required: true, enum: ["success", "failed"], default: "success" },
    downloadedAt: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    collection: "downloads",
  }
);

export type DownloadDocument = Omit<InferSchemaType<typeof downloadSchema>, "userId"> & {
  userId: Types.ObjectId;
};

export const DownloadModel = model<DownloadDocument>("Download", downloadSchema);
