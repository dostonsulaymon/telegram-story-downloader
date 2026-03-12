import { redis } from "../redis";

function fileIdKey(storyId: number): string {
  return `fileid:${storyId}`;
}

// Permanent file_id cache — no TTL. Telegram file_ids obtained via the Bot API
// are stable for the lifetime of the file and can be reused indefinitely.
export async function getFileId(storyId: number): Promise<string | null> {
  return redis.get(fileIdKey(storyId));
}

export async function setFileId(storyId: number, fileId: string): Promise<void> {
  await redis.set(fileIdKey(storyId), fileId);
}
