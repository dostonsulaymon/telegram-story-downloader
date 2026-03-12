import mongoose from "mongoose";
import { addDownloadJob, getQueueStats } from "../src/queue/producer";
import { MONGO_URI } from "../src/config";

const CONCURRENT_USERS = 50;
const TARGET_USERNAME = "REDACTED_USERNAME";
const BASE_USER_ID = 1_000_000;
const BASE_CHAT_ID = 1_000_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 5 * 60 * 1_000; // 5 minutes

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB connected");

  console.log(`\nFiring ${CONCURRENT_USERS} jobs simultaneously for @${TARGET_USERNAME}...\n`);

  const start = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT_USERS }, (_, i) =>
      addDownloadJob({
        userId: String(BASE_USER_ID + i),
        chatId: BASE_CHAT_ID + i,
        targetUsername: TARGET_USERNAME,
        type: "all",
        queuedMessageId: BASE_CHAT_ID + i,
        offset: 0,
      })
    )
  );

  const elapsed = Date.now() - start;
  const enqueued = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected").length;

  console.log(`Enqueue results (${elapsed}ms total):`);
  console.log(`  ✅ Enqueued : ${enqueued}`);
  console.log(`  ❌ Rejected : ${rejected}`);

  if (rejected > 0) {
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    const unique = [...new Set(reasons)];
    console.log(`  Rejection reasons: ${unique.join(", ")}`);
  }

  console.log("\nPolling queue stats (every 5s, up to 5 minutes)...\n");

  const pollStart = Date.now();
  let iterations = 0;

  while (Date.now() - pollStart < MAX_POLL_DURATION_MS) {
    const stats = await getQueueStats();
    iterations++;
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    console.log(
      `[t+${String(elapsed).padStart(3, " ")}s] waiting=${stats.waiting}  active=${stats.active}  failed=${stats.failed}`
    );

    if (stats.waiting === 0 && stats.active === 0) {
      console.log("\nAll jobs processed — polling complete.");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (iterations > 0 && Date.now() - pollStart >= MAX_POLL_DURATION_MS) {
    console.log("\n5-minute timeout reached — stopping poll.");
  }

  await mongoose.disconnect();
  console.log("MongoDB disconnected");
  process.exit(0);
}

main().catch((error) => {
  console.error("Load test failed:", error);
  process.exit(1);
});
