import { Composer } from "grammy";
import { BotContext } from "../index";
import { gramJsPool } from "../../gramjs/client";

export function registerRemoveSessionCommand(composer: Composer<BotContext>): void {
  composer.command("removesession", async (ctx) => {
    const phone = ctx.match?.trim();
    if (!phone) {
      await ctx.reply("Usage: /removesession <phone>");
      return;
    }

    try {
      const removed = await gramJsPool.removeSession(phone);
      if (!removed) {
        await ctx.reply("Session not found.");
        return;
      }

      await ctx.reply(`Session removed: ${phone}`);
    } catch (error) {
      console.error("Failed to remove session", error);
      await ctx.reply("Failed to remove session.");
    }
  });
}
