import { Worker, Job } from "bullmq";
import { Api, InputFile, InlineKeyboard } from "grammy";
import pino from "pino";
import { BOT_TOKEN, WORKER_CONCURRENCY, SUPER_ADMIN_ID } from "../config";
import { redis } from "../redis";
import { gramJsPool } from "../gramjs/client";
import { fetchRawItems, downloadRawItem, RawStoryItem, StoryMedia } from "../gramjs/stories";
import {
  getCachedStory,
  setCachedStory,
  setPaginationState,
  getPaginationState,
  clearPaginationState,
  setPaginationItems,
  getPaginationItems,
  PaginationItemMeta,
} from "../cache/mediaCache";
import { getFileId, setFileId } from "../cache/fileIdCache";
import { pickLogChannel } from "../telegram/logChannels";
import { UserModel } from "../models/user.model";
import { DownloadModel } from "../models/download.model";
import { DownloadJobPayload } from "./producer";
import { logger } from "../logger";

const api = new Api(BOT_TOKEN);
const PAGE_SIZE = 10;
const PHOTO_DOWNLOAD_TIMEOUT_MS = 120_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 300_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}

function formatStoryDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildCaption(index: number, total: number, date: number, originalCaption?: string): string {
  const header = `${index + 1}/${total} · ${formatStoryDate(date)}`;
  return originalCaption ? `${header}\n${originalCaption}` : header;
}

// Three-tier resolution for a single story item:
//   1. Permanent file_id cache  — instant, no download, no upload
//   2. Buffer cache (photos)    — no Telegram download, but still needs log channel upload
//   3. Fresh download            — full MTProto download + log channel upload
// Returns null if the item could not be retrieved so the caller can skip it
// without failing the batch.
async function fetchMediaItem(
  item: RawStoryItem,
  client: Parameters<typeof downloadRawItem>[0],
  jobLog: pino.Logger<never>
): Promise<StoryMedia | null> {
  // Tier 1: permanent file_id cache — no buffer needed at all.
  const fileIdEntry = await getFileId(item.id);
  if (fileIdEntry) {
    jobLog.info({ storyId: item.id }, "file_id cache hit");
    return { fileId: fileIdEntry.fileId, buffer: Buffer.alloc(0), kind: fileIdEntry.kind, filename: item.filename, date: item.date, caption: item.caption };
  }

  // Tier 2: Redis buffer cache (photos only — videos are skipped by setCachedStory).
  const buffer = await getCachedStory(item.id);
  if (buffer) {
    jobLog.info({ storyId: item.id }, "buffer cache hit");
    return { buffer, kind: item.kind, filename: item.filename, date: item.date, caption: item.caption };
  }

  // Tier 3: download from Telegram via the job's MTProto session.
  // Using the same session that fetched story metadata guarantees the
  // fileReference is valid — fileReferences are tied to the session that obtained them.
  const timeoutMs = item.kind === "video" ? VIDEO_DOWNLOAD_TIMEOUT_MS : PHOTO_DOWNLOAD_TIMEOUT_MS;
  const downloaded = await withTimeout(
    downloadRawItem(client, item),
    timeoutMs,
    `Download timeout after ${timeoutMs / 1000}s`
  );
  if (!downloaded) return null;
  await setCachedStory(item.id, downloaded, item.kind);
  jobLog.info({ storyId: item.id }, "downloaded from Telegram");
  return { buffer: downloaded, kind: item.kind, filename: item.filename, date: item.date, caption: item.caption };
}

// Fetches and sends a single story item immediately when ready.
// index is the item's 0-based position in pageRawItems; total is pageRawItems.length.
async function fetchAndSend(
  item: RawStoryItem,
  index: number,
  total: number,
  chatId: number,
  client: Parameters<typeof downloadRawItem>[0],
  jobLog: pino.Logger<never>
): Promise<void> {
  const media = await fetchMediaItem(item, client, jobLog);
  if (!media) {
    jobLog.warn({ storyId: item.id }, "all resolution tiers failed, skipping item");
    return;
  }

  const caption = buildCaption(index, total, item.date, media.caption);

  if (media.fileId) {
    jobLog.info({ storyId: item.id, kind: media.kind }, "sending via cached file_id");
    if (media.kind === "video") {
      await api.sendVideo(chatId, media.fileId, { caption, parse_mode: "HTML" });
    } else {
      await api.sendPhoto(chatId, media.fileId, { caption, parse_mode: "HTML" });
    }
    return;
  }

  // No cached file_id — upload buffer to log channel to obtain a stable file_id.
  jobLog.info({ storyId: item.id, kind: media.kind }, "no file_id — uploading to log channel");
  const filename = media.filename ?? `story_${Date.now()}`;
  const inputFile = new InputFile(media.buffer, filename);
  const logChannelId = pickLogChannel();

  if (media.kind === "video") {
    const sent = await api.sendVideo(logChannelId, inputFile, { caption, parse_mode: "HTML" });
    const fileId = sent.video?.file_id;
    if (fileId) {
      await setFileId(item.id, fileId, "video");
      jobLog.info({ storyId: item.id, logChannelId }, "uploaded to log channel, sending to user via file_id");
      await api.sendVideo(chatId, fileId, { caption, parse_mode: "HTML" });
    }
  } else {
    const sent = await api.sendPhoto(logChannelId, inputFile, { caption, parse_mode: "HTML" });
    const fileId = sent.photo?.[sent.photo.length - 1]?.file_id;
    if (fileId) {
      await setFileId(item.id, fileId, "photo");
      jobLog.info({ storyId: item.id, logChannelId }, "uploaded to log channel, sending to user via file_id");
      await api.sendPhoto(chatId, fileId, { caption, parse_mode: "HTML" });
    }
  }
}

async function processJob(job: Job<DownloadJobPayload>): Promise<void> {
  const { userId, chatId, targetUsername, type, queuedMessageId } = job.data;
  const offset = job.data.offset ?? 0;
  const log = logger.child({ jobId: job.id, userId, username: targetUsername });

  log.info({ type, offset }, "job started");

  // Only update the status message on the first attempt. On retries the message
  // already shows the previous failure text; overwriting it with "⬇️ Downloading..."
  // would be misleading and the edit may fail if the user deleted the message.
  if (job.attemptsMade === 0) {
    log.info({ chatId, queuedMessageId }, "editing message to downloading");
    await api.editMessageText(chatId, queuedMessageId, "⬇️ Downloading...");
  }

  // A single session is used for all operations in this job — fetchRawItems and
  // all downloadRawItem calls. This is required because fileReferences obtained
  // during the metadata fetch are only valid for the same session.
  // pickClient throws "All sessions are busy, please wait." when all sessions are
  // at max concurrency — BullMQ will retry the job automatically on throw.
  const { phone, client } = await gramJsPool.pickClient();
  const jobLog = log.child({ phone });

  try {
    // --- Determine which raw items to process for this job ---
    let pageRawItems: RawStoryItem[];
    let totalStoryCount = 0;

    if (type === "all") {
      let storyIds: number[];

      if (offset === 0) {
        // First page: fetch fresh list, store both ID order and item metadata,
        // then process only the first PAGE_SIZE items.
        const allItems = await fetchRawItems(client, targetUsername, "all");
        storyIds = allItems.map((i) => i.id);
        await setPaginationState(userId, targetUsername, storyIds);
        await setPaginationItems(
          userId,
          targetUsername,
          allItems.map((i): PaginationItemMeta => ({
            id: i.id,
            caption: i.caption,
            mediaType: i.kind,
          }))
        );
        pageRawItems = allItems.slice(0, PAGE_SIZE);
      } else {
        // Subsequent pages: use cached metadata so we avoid re-fetching the full
        // story list from Telegram. Only fetch from Telegram if any items in this
        // page slice are not already in the media cache.
        const allMeta = await getPaginationItems(userId, targetUsername);
        const ids = await getPaginationState(userId, targetUsername);

        if (!allMeta || allMeta.length === 0 || !ids || ids.length === 0) {
          await api.editMessageText(
            chatId,
            queuedMessageId,
            "❌ Session expired. Please start a new download."
          );
          return;
        }

        storyIds = ids;
        const metaSlice = allMeta.slice(offset, offset + PAGE_SIZE);

        // Check the media cache for every item in this page simultaneously.
        // Items already cached need no Telegram call — only cache misses do.
        const cacheChecks = await Promise.all(
          metaSlice.map(async (meta) => ({
            meta,
            buffer: await getCachedStory(meta.id),
          }))
        );

        const uncachedIds = new Set(
          cacheChecks.filter((r) => !r.buffer).map((r) => r.meta.id)
        );

        // Fetch from Telegram only when at least one item is not yet cached.
        // If all items are cached this entire block is skipped — zero Telegram calls.
        const freshItemMap = new Map<number, RawStoryItem>();
        if (uncachedIds.size > 0) {
          jobLog.info({ uncachedCount: uncachedIds.size }, "cache misses in page — fetching from Telegram");
          const freshItems = await fetchRawItems(client, targetUsername, "all");
          for (const item of freshItems) {
            if (uncachedIds.has(item.id)) freshItemMap.set(item.id, item);
          }
        }

        // Build pageRawItems from cached metadata. For items that are already in
        // the media cache the `media` field is a placeholder — the download loop
        // checks the cache first and never calls downloadRawItem for those items.
        // For cache-miss items we supply the real media ref from the fresh fetch.
        pageRawItems = metaSlice.map((meta) => {
          const fresh = freshItemMap.get(meta.id);
          return {
            id: meta.id,
            date: fresh?.date ?? 0,
            kind: meta.mediaType,
            filename: `story_${meta.id}${meta.mediaType === "video" ? ".mp4" : ".jpg"}`,
            media: (fresh?.media ?? {}) as unknown as RawStoryItem["media"],
            caption: meta.caption,
          };
        });
      }

      totalStoryCount = storyIds.length;
    } else {
      pageRawItems = await fetchRawItems(client, targetUsername, type);
    }

    if (pageRawItems.length === 0) {
      await api.editMessageText(chatId, queuedMessageId, "✅ Done — no stories found.");
      if (type === "all") await clearPaginationState(userId, targetUsername);
      return;
    }

    // --- Fetch and send each item concurrently, out of order ---
    // Each item is sent immediately when ready. One failure doesn't block others.
    // index is the item's stable position in pageRawItems, used for the caption header.
    const total = pageRawItems.length;
    const settlements = await Promise.allSettled(
      pageRawItems.map((item, index) =>
        fetchAndSend(item, index, total, chatId, client, jobLog)
      )
    );

    const successCount = settlements.filter((s) => s.status === "fulfilled").length;

    if (successCount === 0) {
      await api.editMessageText(chatId, queuedMessageId, "✅ Done — no stories found.");
      if (type === "all") await clearPaginationState(userId, targetUsername);
      return;
    }

    // --- Status message + pagination follow-up for "all" ---
    if (type === "all") {
      const nextOffset = offset + PAGE_SIZE;
      const remaining = totalStoryCount - nextOffset;

      if (remaining > 0) {
        await api.editMessageText(chatId, queuedMessageId, `✅ ${successCount} file(s) sent.`);
        await api.sendMessage(chatId, `📄 ${remaining} more stor${remaining === 1 ? "y" : "ies"} available.`, {
          reply_markup: new InlineKeyboard().text(
            `Load more (${remaining} remaining)`,
            `more:${userId}:${nextOffset}:${targetUsername}`
          ),
        });
      } else {
        await clearPaginationState(userId, targetUsername);
        await api.editMessageText(chatId, queuedMessageId, `✅ Done — ${successCount} file(s) sent.`);
      }
    } else {
      await api.editMessageText(chatId, queuedMessageId, `✅ Done — ${successCount} file(s) sent.`);
    }

    // --- Record successful download ---
    const user = await UserModel.findOne({ telegramId: Number(userId) }).select("_id");
    if (user) {
      await DownloadModel.create({
        userId: user._id,
        targetUsername,
        type,
        sessionPhone: phone,
        mediaCount: successCount,
        status: "success",
        downloadedAt: new Date(),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jobLog.error({ attempt: job.attemptsMade, err: error }, "job failed");

    if (message.includes("AUTH_KEY_UNREGISTERED")) {
      await gramJsPool.evictSession(phone);
      await api
        .sendMessage(
          SUPER_ADMIN_ID,
          `⚠️ Session ${phone} was revoked by Telegram and has been removed from the pool.`
        )
        .catch(() => {});
    }

    await api.editMessageText(chatId, queuedMessageId, `❌ Failed: ${message}`).catch(() => {});

    // Only write a failed download record on the final attempt to avoid
    // polluting the DB with entries for transient failures that later succeed.
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;
    if (isFinalAttempt) {
      const user = await UserModel.findOne({ telegramId: Number(userId) }).select("_id").catch(() => null);
      if (user) {
        await DownloadModel.create({
          userId: user._id,
          targetUsername,
          type,
          sessionPhone: phone,
          mediaCount: 0,
          status: "failed",
          downloadedAt: new Date(),
        }).catch(() => {});
      }
    }

    throw error;
  } finally {
    gramJsPool.decrementSessionLoad(phone);
  }
}

let _worker: Worker<DownloadJobPayload> | null = null;

export function startWorker(): Worker<DownloadJobPayload> {
  // BullMQ Worker requires a dedicated connection — duplicate() clones the shared
  // instance's config without sharing the underlying socket.
  _worker = new Worker<DownloadJobPayload>("download", processJob, {
    connection: redis.duplicate(),
    concurrency: WORKER_CONCURRENCY,
    stalledInterval: 30000,
    maxStalledCount: 2,
  });

  _worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "job completed");
  });

  _worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, err: error }, "job failed permanently");

    if (!job) return;
    const isPermanentFailure = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (isPermanentFailure) {
      const { chatId, queuedMessageId } = job.data;
      const message = error instanceof Error ? error.message : String(error);
      api.editMessageText(chatId, queuedMessageId, `❌ Failed: ${message}`).catch(() => {});
    }
  });

  return _worker;
}

export async function stopWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}
