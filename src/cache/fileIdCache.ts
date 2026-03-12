import { redis } from "../redis";
import { logger } from "../logger";

function fileIdKey(storyId: number): string {
  return `fileid:${storyId}`;
}

// Permanent file_id cache — no TTL. Telegram file_ids obtained via the Bot API
// are stable for the lifetime of the file and can be reused indefinitely.
export async function getFileId(storyId: number): Promise<string | null> {
  const value = await redis.get(fileIdKey(storyId));
  if (value) {
    logger.debug({ storyId, fileId: value }, "file_id cache hit");
  } else {
    logger.debug({ storyId }, "file_id cache miss");
  }
  return value;
}

export async function setFileId(storyId: number, fileId: string): Promise<void> {
  await redis.set(fileIdKey(storyId), fileId);
  logger.debug({ storyId, fileId }, "file_id cached");
}
