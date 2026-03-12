import { Queue } from "bullmq";
import { redis } from "../redis";

export type DownloadJobPayload = {
  userId: string;
  chatId: number;
  targetUsername: string;
  type: "current" | "last" | "all";
  queuedMessageId: number;
  offset?: number;
};

const MAX_QUEUE_SIZE = 5000;

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
  lockDuration: 300000,
} as const;

// BullMQ requires a dedicated connection — duplicate() clones the shared
// instance's config without sharing the underlying socket.
const queue = new Queue<DownloadJobPayload>("download", {
  connection: redis.duplicate(),
  defaultJobOptions: JOB_OPTIONS,
});

export async function addDownloadJob(payload: DownloadJobPayload): Promise<void> {
  const { waiting, delayed } = await queue.getJobCounts("waiting", "delayed");
  if (waiting + delayed >= MAX_QUEUE_SIZE) {
    throw new Error("Queue is full");
  }
  await queue.add("download", payload, JOB_OPTIONS);
}

export async function getQueueStats(): Promise<{ waiting: number; active: number; failed: number }> {
  const counts = await queue.getJobCounts("waiting", "active", "failed");
  return { waiting: counts.waiting, active: counts.active, failed: counts.failed };
}
