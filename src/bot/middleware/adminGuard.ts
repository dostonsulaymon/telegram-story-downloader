import { MiddlewareFn } from "grammy";
import { SUPER_ADMIN_ID } from "../../config";
import { AdminModel } from "../../models/admin.model";
import { BotContext } from "../index";

export const adminGuard: MiddlewareFn<BotContext> = async (ctx, next) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (telegramId === SUPER_ADMIN_ID) {
    await next();
    return;
  }

  try {
    const isAdmin = await AdminModel.exists({ telegramId });
    if (!isAdmin) {
      await ctx.reply("Admin access required.");
      return;
    }

    await next();
  } catch (error) {
    console.error("Admin guard failure", error);
    await ctx.reply("Authorization check failed.");
  }
};
