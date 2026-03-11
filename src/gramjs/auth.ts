import { StringSession } from "telegram/sessions";
import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { computeCheck } from "telegram/Password";
import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from "../config";

export async function createAuthClient(): Promise<TelegramClient> {
  const client = new TelegramClient(new StringSession(""), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    connectionRetries: 5,
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
