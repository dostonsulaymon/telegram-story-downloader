import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import {
  TELEGRAM_API_HASH,
  TELEGRAM_API_ID,
  SESSION_MAX_CONCURRENCY,
  APP_MODE,
  DEV_SESSION_PHONE,
  SESSION_DAILY_LIMIT,
  SESSION_COOLDOWN_MS,
} from "../config";
import { SessionModel } from "../models/session.model";
import { redis, publishPoolUpdate, subscribePoolUpdates } from "../redis";
import { sleep, randomBetween } from "../utils/sleep";
import { getDeviceProfile } from "../utils/deviceFingerprint";
import { logger } from "../logger";

type PoolEntry = {
  client: TelegramClient;
  lastUsed: Date | null;
};

function buildClient(sessionString: string, phone?: string): TelegramClient {
  const profile = phone ? getDeviceProfile(phone) : getDeviceProfile("default");
  return new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    autoReconnect: true,
    connectionRetries: 10,
    retryDelay: 1000,
    timeout: 30,
    useWSS: false,
    downloadRetries: 5,
    deviceModel: profile.deviceModel,
    systemVersion: profile.systemVersion,
    appVersion: profile.appVersion,
    langCode: profile.langCode,
    systemLangCode: profile.systemLangCode,
  });
}

function reqCountKey(phone: string): string {
  return `session:reqcount:${phone}`;
}

export class GramJsPool {
  private readonly clients = new Map<string, PoolEntry>();
  private readonly activeJobs = new Map<string, number>();

  async loadActiveSessions(): Promise<void> {
    if (APP_MODE === "dev") {
      logger.warn(
        { devPhone: DEV_SESSION_PHONE },
        "APP_MODE=dev: only the dev session will be loaded"
      );
    }

    const allSessions = await SessionModel.find({ status: "active" }).lean();

    // In dev mode only connect the designated dev session — skip everything else
    // so production sessions are never touched during local development.
    const sessions =
      APP_MODE === "dev"
        ? allSessions.filter((s) => s.phone === DEV_SESSION_PHONE)
        : allSessions;

    if (APP_MODE === "dev" && sessions.length === 0) {
      logger.warn({ devPhone: DEV_SESSION_PHONE }, "APP_MODE=dev: dev session not found in DB, pool will be empty");
    }

    // Connect sessions sequentially with a random 1–2 s delay between each
    // to avoid a burst of parallel MTProto auth handshakes on startup, which
    // can trigger Telegram's abuse detection on accounts with many sessions.
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      try {
        const client = buildClient(session.sessionString, session.phone);
        await client.connect();

        this.clients.set(session.phone, {
          client,
          lastUsed: session.lastUsed ?? null,
        });
        this.activeJobs.set(session.phone, 0);
        logger.info({ phone: session.phone, index: i + 1, total: sessions.length }, "session connected");
      } catch (error) {
        logger.error({ phone: session.phone, err: error }, "failed to load session");
        await SessionModel.updateOne({ phone: session.phone }, { $set: { status: "banned" } });
      }

      // Stagger connections — skip delay after the last session.
      if (i < sessions.length - 1) {
        await sleep(randomBetween(1000, 2000));
      }
    }

    // Subscribe to cross-process pool events. When another process adds or
    // removes a session (e.g. bot adds via /addsession, worker receives the
    // event and syncs its own in-memory pool from MongoDB).
    subscribePoolUpdates((event, phone) => {
      // Skip events published by this process — the pool is already up to date.
      if (this.clients.has(phone) && event === "add") return;
      if (!this.clients.has(phone) && event === "remove") return;

      if (event === "add") {
        SessionModel.findOne({ phone, status: "active" })
          .lean()
          .then(async (session) => {
            if (!session) return;
            // Session may have been added by this process already; guard again.
            if (this.clients.has(phone)) return;
            try {
              const client = buildClient(session.sessionString, phone);
              await client.connect();
              this.clients.set(phone, { client, lastUsed: session.lastUsed ?? null });
              this.activeJobs.set(phone, 0);
              logger.info({ phone }, "cross-process add: loaded session");
            } catch (err) {
              logger.error({ phone, err }, "cross-process add: failed to connect session");
            }
          })
          .catch((err) => logger.error({ err }, "cross-process add: DB error"));
      }

      if (event === "remove") {
        const entry = this.clients.get(phone);
        if (entry) {
          entry.client.disconnect().catch(() => {});
          this.clients.delete(phone);
          this.activeJobs.delete(phone);
          logger.info({ phone }, "cross-process remove: evicted session");
        }
      }
    });
  }

  async addReadyClient(phone: string, client: TelegramClient): Promise<void> {
    this.clients.set(phone, { client, lastUsed: null });
    this.activeJobs.set(phone, 0);
    await publishPoolUpdate("add", phone);
  }

  async addSessionFromString(phone: string, sessionString: string): Promise<void> {
    const client = buildClient(sessionString, phone);
    await client.connect();
    this.clients.set(phone, { client, lastUsed: null });
    this.activeJobs.set(phone, 0);
    await publishPoolUpdate("add", phone);
  }

  async removeSession(phone: string): Promise<boolean> {
    const entry = this.clients.get(phone);
    if (entry) {
      try {
        await entry.client.disconnect();
      } catch (error) {
        logger.error({ phone, err: error }, "failed to disconnect session");
      }
      this.clients.delete(phone);
      this.activeJobs.delete(phone);
    }

    const result = await SessionModel.deleteOne({ phone });
    await publishPoolUpdate("remove", phone);
    return result.deletedCount > 0;
  }

  // Evicts a session that Telegram has revoked. Unlike removeSession it marks
  // the DB record as inactive (for audit purposes) rather than deleting it.
  async evictSession(phone: string): Promise<void> {
    const entry = this.clients.get(phone);
    if (entry) {
      await entry.client.disconnect().catch(() => {});
      this.clients.delete(phone);
      this.activeJobs.delete(phone);
    }
    await SessionModel.updateOne({ phone }, { $set: { status: "banned" } });
    await publishPoolUpdate("remove", phone);
    logger.info({ phone }, "evicted revoked session");
  }

  async pickClient(): Promise<{ phone: string; client: TelegramClient }> {
    if (this.clients.size === 0) {
      throw new Error("No active GramJS sessions available");
    }

    // In dev mode restrict candidates to the single designated dev session.
    const candidates: [string, PoolEntry][] =
      APP_MODE === "dev"
        ? this.clients.has(DEV_SESSION_PHONE)
          ? [[DEV_SESSION_PHONE, this.clients.get(DEV_SESSION_PHONE)!]]
          : []
        : Array.from(this.clients.entries());

    if (candidates.length === 0) {
      throw new Error(
        APP_MODE === "dev"
          ? `Dev session ${DEV_SESSION_PHONE} is not in the pool`
          : "No active GramJS sessions available"
      );
    }

    const now = Date.now();
    let selectedPhone: string | null = null;
    let selectedEntry: PoolEntry | null = null;

    for (const [phone, entry] of candidates) {
      // Skip overloaded sessions.
      const jobs = this.activeJobs.get(phone) ?? 0;
      if (jobs >= SESSION_MAX_CONCURRENCY) continue;

      // Skip sessions over their daily request cap.
      const dailyCount = await this.getDailyCount(phone);
      if (dailyCount >= SESSION_DAILY_LIMIT) {
        logger.warn({ phone, dailyCount, limit: SESSION_DAILY_LIMIT }, "session daily limit reached, skipping");
        continue;
      }

      // Skip sessions that are currently FLOOD_WAITed by Telegram.
      const isFloodWaited = await redis.exists(`session:floodwait:${phone}`);
      if (isFloodWaited) {
        logger.warn({ phone }, "session flood-waited, skipping");
        continue;
      }

      // Skip sessions still within their post-job cooldown window.
      if (entry.lastUsed && now - entry.lastUsed.getTime() < SESSION_COOLDOWN_MS) continue;

      // Among eligible sessions prefer the least-recently-used.
      if (!selectedEntry) {
        selectedPhone = phone;
        selectedEntry = entry;
        continue;
      }

      const selectedTs = selectedEntry.lastUsed ? selectedEntry.lastUsed.getTime() : 0;
      const currentTs = entry.lastUsed ? entry.lastUsed.getTime() : 0;
      if (currentTs < selectedTs) {
        selectedPhone = phone;
        selectedEntry = entry;
      }
    }

    if (!selectedPhone || !selectedEntry) {
      throw new Error("All sessions are busy, please wait.");
    }

    const nowDate = new Date(now);
    selectedEntry.lastUsed = nowDate;
    await SessionModel.updateOne({ phone: selectedPhone }, { $set: { lastUsed: nowDate } });

    // Increment atomically before returning so no concurrent caller can pick
    // the same session and overshoot SESSION_MAX_CONCURRENCY.
    this.activeJobs.set(selectedPhone, (this.activeJobs.get(selectedPhone) ?? 0) + 1);

    // Increment the 24-hour request counter for this session.
    await this.incrementDailyCount(selectedPhone);

    return { phone: selectedPhone, client: selectedEntry.client };
  }

  private async getDailyCount(phone: string): Promise<number> {
    const val = await redis.get(reqCountKey(phone));
    return val ? parseInt(val, 10) : 0;
  }

  private async incrementDailyCount(phone: string): Promise<void> {
    const key = reqCountKey(phone);
    const count = await redis.incr(key);
    // Set TTL only on first increment so the window resets ~24h after first use.
    if (count === 1) {
      await redis.expire(key, 86400);
    }
  }

  incrementSessionLoad(phone: string): void {
    this.activeJobs.set(phone, (this.activeJobs.get(phone) ?? 0) + 1);
  }

  decrementSessionLoad(phone: string): void {
    const current = this.activeJobs.get(phone) ?? 0;
    this.activeJobs.set(phone, Math.max(0, current - 1));
  }

  // Updates lastUsed to now. Called when a job finishes (finally block) so the
  // cooldown window measures idle time since the last job completed, not started.
  touchLastUsed(phone: string): void {
    const entry = this.clients.get(phone);
    if (entry) entry.lastUsed = new Date();
  }

  getActiveCount(): number {
    return this.clients.size;
  }

  getSessionLoads(): { phone: string; activeJobs: number }[] {
    return Array.from(this.clients.keys()).map((phone) => ({
      phone,
      activeJobs: this.activeJobs.get(phone) ?? 0,
    }));
  }

  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [, entry] of this.clients) {
      tasks.push(entry.client.disconnect());
    }
    await Promise.allSettled(tasks);
    this.clients.clear();
    this.activeJobs.clear();
  }
}

export function createEmptyClient(): TelegramClient {
  return buildClient("");
}

export const gramJsPool = new GramJsPool();
