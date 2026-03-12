import { FileIdCacheModel } from "../models/fileid.model";
import { logger } from "../logger";

type FileIdEntry = { fileId: string; kind: "photo" | "video" };

// Permanent file_id store backed by MongoDB — survives Redis restarts.
// Stores both the file_id and media kind so the send path knows which
// Bot API method to call without a separate lookup.
export async function getFileId(storyId: number): Promise<FileIdEntry | null> {
  const doc = await FileIdCacheModel.findOne({ storyId }).lean();
  if (!doc) {
    logger.debug({ storyId }, "file_id cache miss");
    return null;
  }
  logger.debug({ storyId, fileId: doc.fileId, kind: doc.kind }, "file_id cache hit");
  return { fileId: doc.fileId, kind: doc.kind };
}

export async function setFileId(storyId: number, fileId: string, kind: "photo" | "video"): Promise<void> {
  await FileIdCacheModel.findOneAndUpdate(
    { storyId },
    { fileId, kind, cachedAt: new Date() },
    { upsert: true }
  );
  logger.debug({ storyId, fileId, kind }, "file_id cached");
}
