import mongoose from "mongoose";
import { createBot } from "./bot";
import { MONGO_URI, SUPER_ADMIN_ID } from "./config";
import { gramJsPool } from "./gramjs/client";

async function bootstrap(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB connected");
  console.log(`SUPER_ADMIN_ID loaded: ${SUPER_ADMIN_ID}`);

  await gramJsPool.loadActiveSessions();
  console.log(`Loaded active GramJS sessions: ${gramJsPool.getActiveCount()}`);

  const bot = createBot();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    try {
      bot.stop();
      await gramJsPool.shutdown();
      await mongoose.disconnect();
      console.log("Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("Shutdown failed", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.log("Bot started");
  await bot.start();
}

bootstrap().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
