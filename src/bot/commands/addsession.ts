import { Composer } from "grammy";
import { Conversation } from "@grammyjs/conversations";
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
  registerClient,
  getRegisteredClient,
  unregisterClient,
} from "../../gramjs/auth";
import {
  setPendingClient,
  getPendingClient,
  deletePendingClient,
} from "../../redis";
import { logger } from "../../logger";

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

// Removes the pending auth entry from Redis and disconnects the client from the
// in-process registry. Safe to call even if the entry is already gone.
async function cleanupPending(userId: string): Promise<void> {
  const clientKey = await getPendingClient(userId);
  await deletePendingClient(userId);
  if (clientKey) {
    const client = getRegisteredClient(clientKey);
    unregisterClient(clientKey);
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function addSessionConversation(
  conversation: Conversation<BotContext, InternalContext>,
  ctx: InternalContext
): Promise<void> {
  const userId = String(ctx.from!.id);
  const phone = await askText(conversation, ctx, "Send phone in international format (e.g. +15551234567):");

  // Runs once; client is registered in clientRegistry so every subsequent step
  // reuses the same MTProto connection and phoneCodeHash binding.
  // Redis stores userId → clientKey so other bot instances see who owns this auth.
  let phoneCodeHash: string;
  try {
    phoneCodeHash = await conversation.external(async () => {
      await cleanupPending(userId);
      const client = await createAuthClient();
      const clientKey = registerClient(client);
      await setPendingClient(userId, clientKey);
      return sendAuthCode(client, phone);
    });
  } catch (error) {
    await cleanupPending(userId);
    const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
    await ctx.reply(`Failed to send code: ${message}`);
    return;
  }

  const code = await askText(conversation, ctx, "Enter the login code from Telegram:");
  logger.info({ userId }, "received login code from user");

  // SESSION_PASSWORD_NEEDED is caught inside external() and returned as a plain
  // serialisable object. Catching a thrown RPCError after external() is unreliable
  // because the session store serialises errors as plain objects, breaking instanceof.
  type SignInResult = { ok: true } | { ok: false; needs2FA: true } | { ok: false; needs2FA: false; error: string };

  let signInResult: SignInResult;
  try {
    signInResult = await conversation.external(async (): Promise<SignInResult> => {
      const clientKey = await getPendingClient(userId);
      const client = clientKey ? getRegisteredClient(clientKey) : undefined;
      if (!client) throw new Error("Auth client not found — restart /addsession");
      try {
        await signInWithCode(client, phone, phoneCodeHash, code);
        return { ok: true };
      } catch (error) {
        if (error instanceof RPCError && error.errorMessage === "SESSION_PASSWORD_NEEDED") {
          return { ok: false, needs2FA: true };
        }
        const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
        return { ok: false, needs2FA: false, error: message };
      }
    });
  } catch (error) {
    await cleanupPending(userId);
    const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
    await ctx.reply(`Auth failed: ${message}`);
    return;
  }

  if (!signInResult.ok && !signInResult.needs2FA) {
    await cleanupPending(userId);
    await ctx.reply(`Auth failed: ${signInResult.error}`);
    return;
  }

  if (!signInResult.ok && signInResult.needs2FA) {
    const password = await askText(conversation, ctx, "2FA is enabled. Send your password:");

    type TwoFAResult = { ok: true } | { ok: false; error: string };

    let twoFAResult: TwoFAResult;
    try {
      twoFAResult = await conversation.external(async (): Promise<TwoFAResult> => {
        const clientKey = await getPendingClient(userId);
        const client = clientKey ? getRegisteredClient(clientKey) : undefined;
        if (!client) throw new Error("Auth client not found — restart /addsession");
        try {
          await signInWith2FA(client, password);
          return { ok: true };
        } catch (error) {
          const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
          return { ok: false, error: message };
        }
      });
    } catch (error) {
      await cleanupPending(userId);
      const message = error instanceof RPCError ? error.errorMessage : (error as Error).message;
      await ctx.reply(`2FA failed: ${message}`);
      return;
    }

    if (!twoFAResult.ok) {
      await cleanupPending(userId);
      await ctx.reply(`2FA failed: ${twoFAResult.error}`);
      return;
    }
  }

  // No more waitFor calls after this point — runs once, no further replay.
  try {
    const clientKey = await getPendingClient(userId);
    const client = clientKey ? getRegisteredClient(clientKey) : undefined;
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

    // Ownership transferred to pool — remove from registry and Redis but do not disconnect.
    await gramJsPool.addReadyClient(phone, client);
    await deletePendingClient(userId);
    if (clientKey) unregisterClient(clientKey);
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
