import { Composer } from "grammy";
import { BotContext } from "../index";
import { SUPER_ADMIN_ID } from "../../config";
import { AdminModel } from "../../models/admin.model";

export function registerAdminsCommand(composer: Composer<BotContext>): void {
  composer.command("admins", async (ctx) => {
    try {
      const admins = await AdminModel.find({}).sort({ addedAt: 1 }).lean();
      const lines: string[] = [`SUPER_ADMIN: ${SUPER_ADMIN_ID}`];

      for (const admin of admins) {
        lines.push(`ADMIN: ${admin.telegramId} (addedBy: ${admin.addedBy})`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      console.error("Failed to list admins", error);
      await ctx.reply("Failed to list admins.");
    }
  });
}
