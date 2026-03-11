import { Composer } from "grammy";
import { BotContext } from "../index";
import { UserModel } from "../../models/user.model";
import { DownloadModel } from "../../models/download.model";
import { SessionModel } from "../../models/session.model";

export function registerStatsCommand(composer: Composer<BotContext>): void {
  composer.command("stats", async (ctx) => {
    try {
      const [totalUsers, totalDownloads, activeSessions] = await Promise.all([
        UserModel.countDocuments({}),
        DownloadModel.countDocuments({}),
        SessionModel.countDocuments({ status: "active" }),
      ]);

      await ctx.reply(
        [
          `Total users: ${totalUsers}`,
          `Total downloads: ${totalDownloads}`,
          `Active sessions: ${activeSessions}`,
        ].join("\n")
      );
    } catch (error) {
      console.error("Failed to fetch stats", error);
      await ctx.reply("Failed to fetch stats.");
    }
  });
}
