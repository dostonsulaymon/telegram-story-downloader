import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TELEGRAM_API_HASH, TELEGRAM_API_ID, SESSION_MAX_CONCURRENCY } from "../config";
import { SessionModel } from "../models/session.model";
import { publishPoolUpdate, subscribePoolUpdates } from "../redis";
import { logger } from "../logger";

type PoolEntry = {
  client: TelegramClient;
  lastUsed: Date | null;
};

function buildClient(sessionString: string): TelegramClient {
  return new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    autoReconnect: true,
    connectionRetries: 10,
    retryDelay: 1000,
    timeout: 30,
    useWSS: false,
    downloadRetries: 5,
    deviceModel: "iPhone 14 Pro",  
    systemVersion: "iOS 16.6",
    appVersion: "9.6.3",
    langCode: "en",
    systemLangCode: "en",
  });
}

export class GramJsPool {
  private readonly clients = new Map<string, PoolEntry>();
  private readonly activeJobs = new Map<string, number>();

  async loadActiveSessions(): Promise<void> {
    const sessions = await SessionModel.find({ status: "active" }).lean();

    for (const session of sessions) {
      try {
        const client = buildClient(session.sessionString);
        await client.connect();

        this.clients.set(session.phone, {
          client,
          lastUsed: session.lastUsed ?? null,
        });
        this.activeJobs.set(session.phone, 0);
      } catch (error) {
        logger.error({ phone: session.phone, err: error }, "failed to load session");
        await SessionModel.updateOne({ phone: session.phone }, { $set: { status: "banned" } });
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
              const client = buildClient(session.sessionString);
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
    const client = buildClient(sessionString);
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
    await SessionModel.updateOne({ phone }, { $set: { status: "inactive" } });
    await publishPoolUpdate("remove", phone);
    logger.info({ phone }, "evicted revoked session");
  }

  async pickClient(): Promise<{ phone: string; client: TelegramClient }> {
    if (this.clients.size === 0) {
      throw new Error("No active GramJS sessions available");
    }

    let selectedPhone: string | null = null;
    let selectedEntry: PoolEntry | null = null;

    for (const [phone, entry] of this.clients.entries()) {
      const jobs = this.activeJobs.get(phone) ?? 0;
      if (jobs >= SESSION_MAX_CONCURRENCY) continue;

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

    const now = new Date();
    selectedEntry.lastUsed = now;
    await SessionModel.updateOne({ phone: selectedPhone }, { $set: { lastUsed: now } });

    // Increment atomically before returning so no concurrent caller can pick
    // the same session and overshoot SESSION_MAX_CONCURRENCY.
    this.activeJobs.set(selectedPhone, (this.activeJobs.get(selectedPhone) ?? 0) + 1);

    return { phone: selectedPhone, client: selectedEntry.client };
  }

  incrementSessionLoad(phone: string): void {
    this.activeJobs.set(phone, (this.activeJobs.get(phone) ?? 0) + 1);
  }

  decrementSessionLoad(phone: string): void {
    const current = this.activeJobs.get(phone) ?? 0;
    this.activeJobs.set(phone, Math.max(0, current - 1));
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
