import { Composer } from "grammy";
import { BotContext } from "../index";
import { SessionModel } from "../../models/session.model";
import { logger } from "../../logger";

export function registerSessionsCommand(composer: Composer<BotContext>): void {
  composer.command("sessions", async (ctx) => {
    try {
      const sessions = await SessionModel.find({}).sort({ addedAt: 1 }).lean();
      if (sessions.length === 0) {
        await ctx.reply("No sessions configured.");
        return;
      }

      const lines = sessions.map((session, index) => {
        const lastUsed = session.lastUsed ? new Date(session.lastUsed).toISOString() : "never";
        return `${index + 1}. ${session.phone} | ${session.status} | lastUsed: ${lastUsed}`;
      });

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      logger.error({ err: error }, "failed to list sessions");
      await ctx.reply("Failed to list sessions.");
    }
  });
}
