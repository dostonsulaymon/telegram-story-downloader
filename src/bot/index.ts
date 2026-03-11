import {
  Bot,
  Context,
  InlineKeyboard,
  InputFile,
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
import { gramJsPool } from "../gramjs/client";
import {
  DownloadType,
  fetchAllStories,
  fetchCurrentStory,
  fetchLastStory,
  StoryMedia,
} from "../gramjs/stories";
import { UserModel } from "../models/user.model";
import { DownloadModel } from "../models/download.model";

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

async function sendStoryMedia(ctx: BotContext, media: StoryMedia): Promise<void> {
  const filename = media.filename ?? `story_${Date.now()}`;
  const input = new InputFile(media.buffer, filename);

  if (media.kind === "video") {
    await ctx.replyWithVideo(input);
    return;
  }

  await ctx.replyWithPhoto(input);
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
        console.error("Failed to upsert user", error);
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
    await ctx.answerCallbackQuery();

    const match = ctx.match;
    const type = match[1] as DownloadType;
    const username = match[2];

    try {
      const { phone, client } = await gramJsPool.pickClient();

      let mediaItems: StoryMedia[] = [];
      if (type === "current") {
        const item = await fetchCurrentStory(client, username);
        if (item) mediaItems = [item];
      } else if (type === "last") {
        const item = await fetchLastStory(client, username);
        if (item) mediaItems = [item];
      } else {
        mediaItems = await fetchAllStories(client, username);
      }

      if (mediaItems.length === 0) {
        await ctx.reply("No stories found for this user.");
        return;
      }

      for (const media of mediaItems) {
        await sendStoryMedia(ctx, media);
      }

      if (ctx.from) {
        const user = await UserModel.findOne({ telegramId: ctx.from.id }).select("_id");
        if (user) {
          await DownloadModel.create({
            userId: user._id,
            targetUsername: username,
            type,
            sessionPhone: phone,
            mediaCount: mediaItems.length,
            downloadedAt: new Date(),
          });
        }
      }
    } catch (error) {
      console.error("Story download failed", error);
      await ctx.reply("Failed to download stories. Please try again later.");
    }
  });

  bot.catch((error) => {
    console.error("Bot error", error.error);
  });

  return bot;
}
