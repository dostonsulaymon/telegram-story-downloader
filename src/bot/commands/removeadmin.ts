import { Composer } from "grammy";
import { BotContext } from "../index";
import { SUPER_ADMIN_ID } from "../../config";
import { AdminModel } from "../../models/admin.model";
import { logger } from "../../logger";

export function registerRemoveAdminCommand(composer: Composer<BotContext>): void {
  composer.command("removeadmin", async (ctx) => {
    const raw = ctx.match?.trim();
    const telegramId = Number(raw);

    if (!raw || !Number.isInteger(telegramId) || telegramId <= 0) {
      await ctx.reply("Usage: /removeadmin <telegram_id>");
      return;
    }

    if (telegramId === SUPER_ADMIN_ID) {
      await ctx.reply("SUPER_ADMIN_ID cannot be removed.");
      return;
    }

    try {
      const result = await AdminModel.deleteOne({ telegramId });
      if (result.deletedCount === 0) {
        await ctx.reply("Admin not found.");
        return;
      }

      await ctx.reply(`Admin removed: ${telegramId}`);
    } catch (error) {
      logger.error({ err: error }, "failed to remove admin");
      await ctx.reply("Failed to remove admin.");
    }
  });
}
