import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from "../config";
import { SessionModel } from "../models/session.model";

type PoolEntry = {
  client: TelegramClient;
  lastUsed: Date | null;
};

function buildClient(sessionString: string): TelegramClient {
  return new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    connectionRetries: 5,
    deviceModel: "iPhone 14 Pro",
    systemVersion: "iOS 16.6",
    appVersion: "9.6.3",
    langCode: "en",
    systemLangCode: "en",
  });
}

export class GramJsPool {
  private readonly clients = new Map<string, PoolEntry>();

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
      } catch (error) {
        console.error(`Failed to load session ${session.phone}`, error);
        await SessionModel.updateOne({ phone: session.phone }, { $set: { status: "banned" } });
      }
    }
  }

  async addReadyClient(phone: string, client: TelegramClient): Promise<void> {
    this.clients.set(phone, { client, lastUsed: null });
  }

  async addSessionFromString(phone: string, sessionString: string): Promise<void> {
    const client = buildClient(sessionString);
    await client.connect();
    this.clients.set(phone, { client, lastUsed: null });
  }

  async removeSession(phone: string): Promise<boolean> {
    const entry = this.clients.get(phone);
    if (entry) {
      try {
        await entry.client.disconnect();
      } catch (error) {
        console.error(`Failed to disconnect session ${phone}`, error);
      }
      this.clients.delete(phone);
    }

    const result = await SessionModel.deleteOne({ phone });
    return result.deletedCount > 0;
  }

  async pickClient(): Promise<{ phone: string; client: TelegramClient }> {
    if (this.clients.size === 0) {
      throw new Error("No active GramJS sessions available");
    }

    let selectedPhone: string | null = null;
    let selectedEntry: PoolEntry | null = null;

    for (const [phone, entry] of this.clients.entries()) {
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
      throw new Error("Failed to pick GramJS session");
    }

    const now = new Date();
    selectedEntry.lastUsed = now;
    await SessionModel.updateOne({ phone: selectedPhone }, { $set: { lastUsed: now } });

    return { phone: selectedPhone, client: selectedEntry.client };
  }

  getActiveCount(): number {
    return this.clients.size;
  }

  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [, entry] of this.clients) {
      tasks.push(entry.client.disconnect());
    }
    await Promise.allSettled(tasks);
    this.clients.clear();
  }
}

export function createEmptyClient(): TelegramClient {
  return buildClient("");
}

export const gramJsPool = new GramJsPool();
