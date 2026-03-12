import mongoose, { Schema, Document, Model } from "mongoose";

export interface IFileIdCache extends Document {
  storyId: number;
  fileId: string;
  kind: "photo" | "video";
  cachedAt: Date;
}

const FileIdCacheSchema = new Schema<IFileIdCache>({
  storyId: { type: Number, required: true, unique: true },
  fileId: { type: String, required: true },
  kind: { type: String, enum: ["photo", "video"], required: true },
  cachedAt: { type: Date, default: () => new Date() },
});

export const FileIdCacheModel: Model<IFileIdCache> = mongoose.model<IFileIdCache>(
  "FileIdCache",
  FileIdCacheSchema
);
