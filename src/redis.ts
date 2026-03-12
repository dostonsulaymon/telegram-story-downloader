import IORedis from "ioredis";
import { REDIS_URL } from "./config";
import { logger } from "./logger";

// Single shared Redis connection for all general-purpose operations
// (rate limiter, media cache, pagination state, pending auth).
// BullMQ consumers must call .duplicate() to get a dedicated connection —
// BullMQ uses blocking commands that cannot share a connection with other callers.
export const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// Dedicated connection for pub/sub. A subscribed Redis connection cannot issue
// regular commands, so it must be kept separate from the shared instance.
const redisPub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const redisSub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const POOL_CHANNEL = "gramjs:pool";

export type PoolEvent = "add" | "remove";

export async function publishPoolUpdate(event: PoolEvent, phone: string): Promise<void> {
  await redisPub.publish(POOL_CHANNEL, JSON.stringify({ event, phone }));
}

export function subscribePoolUpdates(
  handler: (event: PoolEvent, phone: string) => void
): void {
  redisSub.subscribe(POOL_CHANNEL, (err) => {
    if (err) logger.error({ err }, "failed to subscribe to pool channel");
  });

  redisSub.on("message", (_channel: string, raw: string) => {
    try {
      const { event, phone } = JSON.parse(raw) as { event: PoolEvent; phone: string };
      handler(event, phone);
    } catch (err) {
      logger.error({ raw, err }, "malformed pool update message");
    }
  });
}

// ---------------------------------------------------------------------------

const PENDING_AUTH_TTL = 600; // 10-minute auth window

function pendingAuthKey(userId: string): string {
  return `pending_auth:${userId}`;
}

// Stores a clientKey → userId mapping so multiple bot instances can coordinate
// on who owns which in-progress auth session. The TelegramClient itself always
// lives in process memory; Redis only holds the key that looks it up.
export async function setPendingClient(userId: string, clientKey: string): Promise<void> {
  await redis.set(pendingAuthKey(userId), clientKey, "EX", PENDING_AUTH_TTL);
}

export async function getPendingClient(userId: string): Promise<string | null> {
  return redis.get(pendingAuthKey(userId));
}

export async function deletePendingClient(userId: string): Promise<void> {
  await redis.del(pendingAuthKey(userId));
}
