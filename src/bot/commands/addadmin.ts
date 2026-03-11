import { Composer } from "grammy";
import { BotContext } from "../index";
import { AdminModel } from "../../models/admin.model";

export function registerAddAdminCommand(composer: Composer<BotContext>): void {
  composer.command("addadmin", async (ctx) => {
    const raw = ctx.match?.trim();
    const telegramId = Number(raw);

    if (!raw || !Number.isInteger(telegramId) || telegramId <= 0) {
      await ctx.reply("Usage: /addadmin <telegram_id>");
      return;
    }

    try {
      const existing = await AdminModel.findOne({ telegramId }).lean();
      if (existing) {
        await ctx.reply("User is already an admin.");
        return;
      }

      await AdminModel.create({
        telegramId,
        addedBy: ctx.from?.id ?? 0,
        addedAt: new Date(),
      });

      await ctx.reply(`Admin added: ${telegramId}`);
    } catch (error) {
      console.error("Failed to add admin", error);
      await ctx.reply("Failed to add admin.");
    }
  });
}
