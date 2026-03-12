import { redis } from "../redis";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS } from "../config";

// Atomic Lua script: EXISTS + SET NX EX + INCR run as a single Redis operation.
// Eliminates the race condition where the process could crash between INCR and EXPIRE,
// which in the previous two-command version would leave the key with no TTL forever.
const RATE_LIMIT_SCRIPT = `
local key    = KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

local exists = redis.call('EXISTS', key)
local count

if exists == 0 then
  redis.call('SET', key, 1, 'EX', window)
  count = 1
else
  count = redis.call('INCR', key)
end

if count > limit then
  return {0, redis.call('TTL', key)}
end

return {1, 0}
`;

type RateLimitResult = { allowed: true } | { allowed: false; retryAfter: number };

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const key = `ratelimit:${userId}`;
  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,
    key,
    String(RATE_LIMIT_MAX),
    String(RATE_LIMIT_WINDOW_SECONDS)
  ) as [number, number];

  const [allowed, ttl] = result;
  if (allowed === 0) {
    return { allowed: false, retryAfter: Math.max(1, ttl) };
  }
  return { allowed: true };
}
