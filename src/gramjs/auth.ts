import { StringSession } from "telegram/sessions";
import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { computeCheck } from "telegram/Password";
import { randomUUID } from "node:crypto";
import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from "../config";
import { getDeviceProfile } from "../utils/deviceFingerprint";

export async function createAuthClient(phone: string): Promise<TelegramClient> {
  const profile = getDeviceProfile(phone);
  const client = new TelegramClient(new StringSession(""), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
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
  await client.connect();
  return client;
}

export async function sendAuthCode(client: TelegramClient, phone: string): Promise<string> {
  const { phoneCodeHash } = await client.sendCode(
    { apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH },
    phone
  );
  return phoneCodeHash;
}

export async function signInWithCode(
  client: TelegramClient,
  phone: string,
  phoneCodeHash: string,
  code: string
): Promise<void> {
  await client.invoke(
    new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash,
      phoneCode: code,
    })
  );
}

export async function signInWith2FA(client: TelegramClient, password: string): Promise<void> {
  const passwordData = await client.invoke(new Api.account.GetPassword());
  const inputCheck = await computeCheck(passwordData, password);
  await client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));
}

export function extractSessionString(client: TelegramClient): string {
  return (client.session as StringSession).save();
}

// In-process registry mapping a random UUID key → TelegramClient.
// Redis stores userId → clientKey so multiple bot instances can agree on
// who owns an in-progress auth session. The client itself must stay in memory.
export const clientRegistry = new Map<string, TelegramClient>();

export function registerClient(client: TelegramClient): string {
  const key = randomUUID();
  clientRegistry.set(key, client);
  return key;
}

export function getRegisteredClient(key: string): TelegramClient | undefined {
  return clientRegistry.get(key);
}

export function unregisterClient(key: string): void {
  clientRegistry.delete(key);
}
