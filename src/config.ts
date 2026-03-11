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
