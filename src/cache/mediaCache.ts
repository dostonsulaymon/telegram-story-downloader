import { redis } from "../redis";
import { CACHE_TTL_SECONDS } from "../config";
import { logger } from "../logger";

const PAGINATION_TTL = 600; // 10 minutes

function cacheKey(storyId: number): string {
  return `story:media:${storyId}`;
}

function paginationKey(userId: string, targetUsername: string): string {
  return `pagination:${userId}:${targetUsername.toLowerCase()}`;
}

function paginationItemsKey(userId: string, targetUsername: string): string {
  return `pagination:items:${userId}:${targetUsername.toLowerCase()}`;
}

export async function getCachedStory(storyId: number): Promise<Buffer | null> {
  const key = cacheKey(storyId);
  const value = await redis.get(key);

  if (!value) {
    logger.info({ key }, "cache miss");
    return null;
  }

  const buffer = Buffer.from(value, "base64");
  logger.info({ key, size: buffer.byteLength }, "cache hit");
  return buffer;
}

export async function setCachedStory(storyId: number, buffer: Buffer, mediaType: "photo" | "video"): Promise<void> {
  if (mediaType === "video") {
    // Videos are too large to cache in Redis — skip silently.
    return;
  }
  const key = cacheKey(storyId);
  await redis.set(key, buffer.toString("base64"), "EX", CACHE_TTL_SECONDS);
  logger.info({ key, size: buffer.byteLength, ttl: CACHE_TTL_SECONDS }, "cache set");
}

export async function getCacheCount(): Promise<number> {
  let cursor = "0";
  let count = 0;

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "story:media:*", "COUNT", 100);
    cursor = next;
    count += keys.length;
  } while (cursor !== "0");

  return count;
}

// ---------------------------------------------------------------------------
// Pagination state — ordered story ID list

export async function setPaginationState(
  userId: string,
  targetUsername: string,
  storyIds: number[]
): Promise<void> {
  const key = paginationKey(userId, targetUsername);
  await redis.set(key, JSON.stringify(storyIds), "EX", PAGINATION_TTL);
  logger.info({ key, count: storyIds.length, ttl: PAGINATION_TTL }, "pagination state set");
}

export async function getPaginationState(
  userId: string,
  targetUsername: string
): Promise<number[] | null> {
  const key = paginationKey(userId, targetUsername);
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}

export async function clearPaginationState(
  userId: string,
  targetUsername: string
): Promise<void> {
  const idsKey = paginationKey(userId, targetUsername);
  const itemsKey = paginationItemsKey(userId, targetUsername);
  await redis.del(idsKey, itemsKey);
  logger.info({ idsKey, itemsKey }, "pagination state cleared");
}

// ---------------------------------------------------------------------------
// Pagination item metadata — lightweight per-story info for subsequent pages.
// Storing caption and mediaType here lets the worker serve cached items on
// "Load more" taps without re-fetching the full story list from Telegram.

export type PaginationItemMeta = {
  id: number;
  caption?: string;
  mediaType: "photo" | "video";
};

export async function setPaginationItems(
  userId: string,
  username: string,
  items: PaginationItemMeta[]
): Promise<void> {
  const key = paginationItemsKey(userId, username);
  await redis.set(key, JSON.stringify(items), "EX", PAGINATION_TTL);
  logger.info({ key, count: items.length, ttl: PAGINATION_TTL }, "pagination items set");
}

export async function getPaginationItems(
  userId: string,
  username: string
): Promise<PaginationItemMeta[] | null> {
  const key = paginationItemsKey(userId, username);
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PaginationItemMeta[];
  } catch {
    return null;
  }
}
