import { Composer } from "grammy";
import { Conversation } from "@grammyjs/conversations";
import { TelegramClient } from "telegram";
import { RPCError } from "telegram/errors";
import { BotContext, InternalContext } from "../index";
import { SessionModel } from "../../models/session.model";
import { gramJsPool } from "../../gramjs/client";
import {
  createAuthClient,
  sendAuthCode,
  signInWithCode,
  signInWith2FA,
  extractSessionString,
} from "../../gramjs/auth";

// Holds the single GramJS client for each admin mid-auth.
// Keyed by Telegram user ID. Deleted on success or failure.
const pendingClients = new Map<string, TelegramClient>();

async function askText(
  conversation: Conversation<BotContext, InternalContext>,
  ctx: InternalContext,
  prompt: string
): Promise<string> {
  await ctx.reply(prompt);
  const answerCtx = await conversation.waitFor(":text");
  const text = answerCtx.msg?.text;
  if (!text) throw new Error("Expected text input");
  return text.trim();
}

async function cleanupPending(userId: string): Promise<void> {
  const client = pendingClients.get(userId);
  pendingClients.delete(userId);
  if (client) {
    await client.disconnect().catch(() => {});
  }
}

export async function addSessionConversation(
  conversation: Conversation<BotContext, InternalContext>,
  ctx: InternalContext
): Promise<void> {
  const userId = String(ctx.from!.id);
  const phone = await askText(conversation, ctx, "Send phone in international format (e.g. +15551234567):");

  // conversation.external() runs this block exactly once regardless of replays.
  // The client is stored in pendingClients so subsequent steps reuse the same
  // MTProto connection — the phoneCodeHash is bound to that connection.
  let phoneCodeHash: string;
  try {
    phoneCodeHash = await conversation.external(async () => {
      await cleanupPending(userId); // clear any stale client from a previous attempt
      const client = await createAuthClient();
      pendingClients.set(userId, client);
      return sendAuthCode(client, phone);
    });
  } catch (error) {
    await cleanupPending(userId);
    const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
    await ctx.reply(`Failed to send code: ${message}`);
    return;
  }

  const code = await askText(conversation, ctx, "Enter the login code from Telegram:");
  console.log(`[addsession] raw code from user: ${JSON.stringify(code)}`);

  // conversation.external() caches the result (or thrown error) on first run and
  // replays the cached value on subsequent replays — so signIn is never called twice.
  let needs2FA = false;
  try {
    await conversation.external(async () => {
      const client = pendingClients.get(userId);
      if (!client) throw new Error("Auth client not found — restart /addsession");
      await signInWithCode(client, phone, phoneCodeHash, code);
    });
  } catch (error) {
    if (error instanceof RPCError && error.errorMessage === "SESSION_PASSWORD_NEEDED") {
      needs2FA = true;
    } else {
      await cleanupPending(userId);
      const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
      await ctx.reply(`Auth failed: ${message}`);
      return;
    }
  }

  if (needs2FA) {
    const password = await askText(conversation, ctx, "2FA is enabled. Send your password:");
    try {
      await conversation.external(async () => {
        const client = pendingClients.get(userId);
        if (!client) throw new Error("Auth client not found — restart /addsession");
        await signInWith2FA(client, password);
      });
    } catch (error) {
      await cleanupPending(userId);
      const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
      await ctx.reply(`2FA failed: ${message}`);
      return;
    }
  }

  // No more waitFor calls after this point — runs once, no further replay.
  try {
    const client = pendingClients.get(userId);
    if (!client) throw new Error("Auth client not found — restart /addsession");

    const sessionString = extractSessionString(client);
    if (!sessionString) throw new Error("Empty session string after authentication");

    await SessionModel.findOneAndUpdate(
      { phone },
      {
        $set: { sessionString, status: "active", lastUsed: null },
        $setOnInsert: { phone, addedAt: new Date() },
      },
      { upsert: true }
    );

    await gramJsPool.addReadyClient(phone, client);
    pendingClients.delete(userId); // ownership transferred to pool — do not disconnect
    await ctx.reply("Session added and activated.");
  } catch (error) {
    await cleanupPending(userId);
    const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
    await ctx.reply(`Failed to save session: ${message}`);
  }
}

export function registerAddSessionCommand(composer: Composer<BotContext>): void {
  composer.command("addsession", async (ctx) => {
    await ctx.conversation.enter("addSessionConversation");
  });
}
