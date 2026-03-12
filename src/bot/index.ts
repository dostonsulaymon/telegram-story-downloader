import {
  Bot,
  Context,
  InlineKeyboard,
  session,
  SessionFlavor,
} from "grammy";
import {
  conversations,
  createConversation,
  ConversationFlavor,
} from "@grammyjs/conversations";
import { BOT_TOKEN } from "../config";
import { adminGuard } from "./middleware/adminGuard";
import { registerAddSessionCommand, addSessionConversation } from "./commands/addsession";
import { registerRemoveSessionCommand } from "./commands/removesession";
import { registerSessionsCommand } from "./commands/sessions";
import { registerAddAdminCommand } from "./commands/addadmin";
import { registerRemoveAdminCommand } from "./commands/removeadmin";
import { registerAdminsCommand } from "./commands/admins";
import { registerStatsCommand } from "./commands/stats";
import { DownloadType } from "../gramjs/stories";
import { addDownloadJob } from "../queue/producer";
import { UserModel } from "../models/user.model";
import { checkRateLimit } from "../middleware/rateLimiter";
import { logger } from "../logger";

export type InternalContext = Context & SessionFlavor<Record<string, unknown>>;
export type BotContext = ConversationFlavor<InternalContext>;

function normalizeUsername(input: string): string | null {
  const text = input.trim();
  const direct = text.match(/^@?([A-Za-z0-9_]{5,32})$/);
  if (direct) return direct[1];

  const link = text.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
  if (link) return link[1];

  return null;
}

function keyboardFor(username: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Current", `story:current:${username}`)
    .text("Last", `story:last:${username}`)
    .text("All", `story:all:${username}`);
}

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(BOT_TOKEN);

  bot.use(session({ initial: () => ({}) }));
  bot.use(conversations());
  bot.use(createConversation(addSessionConversation, { id: "addSessionConversation" }));

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const username = ctx.from.username ?? null;
      const firstName = ctx.from.first_name ?? null;

      try {
        await UserModel.findOneAndUpdate(
          { telegramId: ctx.from.id },
          {
            $set: {
              username,
              firstName,
              lastSeen: new Date(),
            },
            $setOnInsert: {
              telegramId: ctx.from.id,
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (error) {
        logger.error({ err: error }, "failed to upsert user");
      }
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Send @username or t.me/username to download stories.\nThen choose Current, Last, or All."
    );
  });

  const adminCommands = new Set([
    "/addsession",
    "/removesession",
    "/sessions",
    "/addadmin",
    "/removeadmin",
    "/admins",
    "/stats",
  ]);
  const adminRouter = bot.filter((ctx) => {
    const text = ctx.message?.text;
    if (!text) return false;
    const command = text.split(/\s+/)[0]?.split("@")[0];
    return command ? adminCommands.has(command) : false;
  });
  adminRouter.use(adminGuard);
  registerAddSessionCommand(adminRouter);
  registerRemoveSessionCommand(adminRouter);
  registerSessionsCommand(adminRouter);
  registerAddAdminCommand(adminRouter);
  registerRemoveAdminCommand(adminRouter);
  registerAdminsCommand(adminRouter);
  registerStatsCommand(adminRouter);

  // Handles direct story links: https://t.me/{username}/s/{storyId}
  // Must be registered before the general text handler so story links are
  // not passed to normalizeUsername (which would fail to parse them).
  const STORY_LINK_RE = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})\/s\/(\d+)\/?$/i;

  bot.on("message:text", async (ctx, next) => {
    const match = ctx.message.text.match(STORY_LINK_RE);
    if (!match) return next();

    const username = match[1];
    const storyId = Number(match[2]);
    const userId = String(ctx.from!.id);

    const rateCheck = await checkRateLimit(userId);
    if (!rateCheck.allowed) {
      await ctx.reply(`⚠️ Too many requests, try again in ${rateCheck.retryAfter} seconds.`);
      return;
    }

    const statusMsg = await ctx.reply(`⏳ Fetching story #${storyId} from @${username}...`);

    try {
      await addDownloadJob({
        userId,
        chatId: ctx.chat.id,
        targetUsername: username,
        type: "single",
        queuedMessageId: statusMsg.message_id,
        storyId,
      });
    } catch {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⚠️ Service is overloaded, try again later.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      return;
    }

    const username = normalizeUsername(text);
    if (!username) {
      await ctx.reply("Invalid input. Send @username or t.me/username.");
      return;
    }

    await ctx.reply(`Choose what to download for @${username}:`, {
      reply_markup: keyboardFor(username),
    });
  });

  bot.callbackQuery(/^story:(current|last|all):([A-Za-z0-9_]{5,32})$/, async (ctx) => {
    logger.info({ data: ctx.callbackQuery.data, from: ctx.from.id }, "story callback received");
    await ctx.answerCallbackQuery();

    const type = ctx.match[1] as DownloadType;
    const username = ctx.match[2];
    const userId = String(ctx.from.id);

    const rateCheck = await checkRateLimit(userId);
    if (!rateCheck.allowed) {
      await ctx.reply(`⚠️ Too many requests, try again in ${rateCheck.retryAfter} seconds.`);
      return;
    }

    // Edit the original keyboard message in-place: remove buttons, update text.
    // The worker will continue editing this same message for status updates.
    await ctx.editMessageText(
      `⏳ Queued: fetching ${type} stories for @${username}...`,
      { reply_markup: new InlineKeyboard() }
    );

    const queuedMessageId = ctx.callbackQuery.message!.message_id;

    try {
      await addDownloadJob({
        userId,
        chatId: ctx.chat!.id,
        targetUsername: username,
        type,
        queuedMessageId,
        offset: 0,
      });
    } catch {
      await ctx.editMessageText("⚠️ Service is overloaded, try again later.");
    }
  });

  // Handles "Load more" buttons sent by the worker for paginated "all" downloads.
  // Callback data format: more:{userId}:{offset}:{username}
  bot.callbackQuery(/^more:(\d+):(\d+):([A-Za-z0-9_]{5,32})$/, async (ctx) => {
    const embeddedUserId = ctx.match[1];
    const offset = Number(ctx.match[2]);
    const username = ctx.match[3];
    const userId = String(ctx.from.id);

    if (userId !== embeddedUserId) {
      await ctx.answerCallbackQuery({ text: "⚠️ This button is not for you." });
      return;
    }

    await ctx.answerCallbackQuery();

    const rateCheck = await checkRateLimit(userId);
    if (!rateCheck.allowed) {
      await ctx.reply(`⚠️ Too many requests, try again in ${rateCheck.retryAfter} seconds.`);
      return;
    }

    // Replace the "Load more" button with a status message the worker will update.
    await ctx.editMessageText("⏳ Loading more stories...", { reply_markup: new InlineKeyboard() });

    const queuedMessageId = ctx.callbackQuery.message!.message_id;

    try {
      await addDownloadJob({
        userId,
        chatId: ctx.chat!.id,
        targetUsername: username,
        type: "all",
        queuedMessageId,
        offset,
      });
    } catch {
      await ctx.editMessageText("⚠️ Service is overloaded, try again later.");
    }
  });

  bot.catch((error) => {
    logger.error({ err: error.error }, "bot error");
  });

  return bot;
}
