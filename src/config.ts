import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireNumberEnv(name: string): number {
  const value = requireEnv(name);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid numeric env var: ${name}`);
  }
  return numeric;
}

export const BOT_TOKEN = requireEnv("BOT_TOKEN");
export const MONGO_URI = requireEnv("MONGO_URI");
export const SUPER_ADMIN_ID = requireNumberEnv("SUPER_ADMIN_ID");
export const TELEGRAM_API_ID = requireNumberEnv("TELEGRAM_API_ID");
export const TELEGRAM_API_HASH = requireEnv("TELEGRAM_API_HASH");
export const REDIS_URL = requireEnv("REDIS_URL");
export const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? "10", 10);
export const SESSION_MAX_CONCURRENCY = parseInt(process.env.SESSION_MAX_CONCURRENCY ?? "5", 10);
export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "5", 10);
export const RATE_LIMIT_WINDOW_SECONDS = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60", 10);
export const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS ?? "3600", 10);
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
export const LOG_CHANNEL_IDS: number[] = process.env.LOG_CHANNEL_IDS
  ? (JSON.parse(process.env.LOG_CHANNEL_IDS) as number[])
  : [CHANNEL_ID_REDACTED, CHANNEL_ID_REDACTED, CHANNEL_ID_REDACTED, CHANNEL_ID_REDACTED];

// "dev" restricts the session pool to DEV_SESSION_PHONE only.
// "prod" uses all active sessions with normal selection logic.
export const APP_MODE = (process.env.APP_MODE ?? "prod") as "dev" | "prod";

// Required when APP_MODE=dev — the sole session used for all downloads.
export const DEV_SESSION_PHONE = process.env.DEV_SESSION_PHONE ?? "";

// Random jitter added after each MTProto download to spread per-session request rate.
export const REQUEST_JITTER_MS_MIN = parseInt(process.env.REQUEST_JITTER_MS_MIN ?? "200", 10);
export const REQUEST_JITTER_MS_MAX = parseInt(process.env.REQUEST_JITTER_MS_MAX ?? "800", 10);

// Sessions that exceed this many jobs in a 24-hour window are skipped in pickClient.
export const SESSION_DAILY_LIMIT = parseInt(process.env.SESSION_DAILY_LIMIT ?? "200", 10);

// Minimum milliseconds between consecutive job picks for the same session.
export const SESSION_COOLDOWN_MS = parseInt(process.env.SESSION_COOLDOWN_MS ?? "5000", 10);
