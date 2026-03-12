import mongoose from "mongoose";
import { MONGO_URI } from "./config";
import { gramJsPool } from "./gramjs/client";
import { startWorker, stopWorker } from "./queue/worker";
import { logger } from "./logger";

async function bootstrap(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  logger.info("MongoDB connected");

  // Worker process needs the pool loaded so it can pick a client for each job.
  await gramJsPool.loadActiveSessions();
  logger.info({ count: gramJsPool.getActiveCount() }, "loaded active GramJS sessions");

  startWorker();
  logger.info("BullMQ worker started");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "received signal, shutting down");
    try {
      await stopWorker();
      await gramJsPool.shutdown();
      await mongoose.disconnect();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

bootstrap().catch((error) => {
  logger.error({ err: error }, "fatal startup error");
  process.exit(1);
});
