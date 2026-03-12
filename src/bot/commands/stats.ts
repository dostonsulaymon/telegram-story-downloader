import { Composer } from "grammy";
import { BotContext } from "../index";
import { UserModel } from "../../models/user.model";
import { DownloadModel } from "../../models/download.model";
import { SessionModel } from "../../models/session.model";
import { gramJsPool } from "../../gramjs/client";
import { getQueueStats } from "../../queue/producer";
import { getCacheCount } from "../../cache/mediaCache";
import { logger } from "../../logger";

export function registerStatsCommand(composer: Composer<BotContext>): void {
  composer.command("stats", async (ctx) => {
    try {
      const [
        queueStats,
        cacheCount,
        totalUsers,
        totalDownloads,
        failedDownloads,
        totalSessions,
        activeSessions,
      ] = await Promise.all([
        getQueueStats(),
        getCacheCount(),
        UserModel.countDocuments({}),
        DownloadModel.countDocuments({}),
        DownloadModel.countDocuments({ status: "failed" }),
        SessionModel.countDocuments({}),
        SessionModel.countDocuments({ status: "active" }),
      ]);

      const sessionLoads = gramJsPool.getSessionLoads();
      const sessionLoadLines = sessionLoads.length > 0
        ? sessionLoads.map((s) => `  ${s.phone}: ${s.activeJobs} active job(s)`).join("\n")
        : "  (no sessions in pool)";

      const lines = [
        "📊 Bot Statistics",
        "",
        "🔄 Queue",
        `  Waiting:  ${queueStats.waiting}`,
        `  Active:   ${queueStats.active}`,
        `  Failed:   ${queueStats.failed}`,
        "",
        "📱 Sessions",
        `  Total: ${totalSessions} | Active in pool: ${sessionLoads.length} / ${activeSessions} DB active`,
        sessionLoadLines,
        "",
        "💾 Cache",
        `  Cached stories: ${cacheCount}`,
        "",
        "🗄 Database",
        `  Users:     ${totalUsers}`,
        `  Downloads: ${totalDownloads} (success: ${totalDownloads - failedDownloads}, failed: ${failedDownloads})`,
      ];

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      logger.error({ err: error }, "failed to fetch stats");
      await ctx.reply("Failed to fetch stats.");
    }
  });
}
