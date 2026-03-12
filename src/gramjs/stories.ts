import { TelegramClient, Api } from "telegram";
import { readFile } from "node:fs/promises";
import { logger } from "../logger";

export type DownloadType = "current" | "last" | "all";

export type StoryMedia = {
  buffer: Buffer;
  kind: "photo" | "video";
  filename?: string;
  date: number;
  caption?: string;
};

// Story item metadata without the downloaded buffer — used by the worker to
// check cache before deciding whether to call downloadRawItem.
// Only media is stored (the sole field downloadRawItem needs), not the full ApiStoryItem.
export type RawStoryItem = {
  id: number;
  date: number;
  kind: "photo" | "video";
  filename: string;
  media: Api.TypeMessageMedia;
  caption?: string;
};

function extractItems(result: unknown): Api.StoryItem[] {
  const r = result as { className?: string; stories?: unknown[] | { stories?: unknown[] } };

  let arr: unknown[] | undefined;
  if (r?.className === "stories.PeerStories") {
    arr = (r.stories as { stories?: unknown[] } | undefined)?.stories;
  } else if (r?.className === "stories.Stories") {
    arr = r.stories as unknown[] | undefined;
  }

  logger.info(
    {
      className: r?.className ?? "unknown",
      arrType: Array.isArray(arr) ? "array" : typeof arr,
      length: Array.isArray(arr) ? arr.length : null,
    },
    "extractItems"
  );

  if (!Array.isArray(arr)) {
    logger.warn({ result }, "unexpected story response shape");
    return [];
  }

  const items = arr.filter(
    (item): item is Api.StoryItem =>
      (item as { className?: string }).className === "StoryItem"
  );

  logger.info(
    { total: arr.length, usable: items.length, skipped: arr.length - items.length },
    "story items extracted"
  );

  return items;
}

function toRawItem(story: Api.StoryItem): RawStoryItem | null {
  if (!story.media) return null;
  const kind = "photo" in story.media ? "photo" : "video";
  return {
    id: story.id,
    date: story.date,
    kind,
    filename: `story_${story.id}${kind === "video" ? ".mp4" : ".jpg"}`,
    media: story.media as Api.TypeMessageMedia,
    caption: story.caption ?? undefined,
  };
}

async function bufferFromDownload(downloaded: Buffer | string | Uint8Array): Promise<Buffer> {
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (typeof downloaded === "string") return readFile(downloaded);
  return Buffer.from(downloaded);
}

async function fetchStoryLists(
  client: TelegramClient,
  username: string
): Promise<{ active: Api.StoryItem[]; pinned: Api.StoryItem[] }> {
  // Always resolve the entity fresh per session. accessHash values are
  // session-specific — caching them across sessions causes PEER_ID_INVALID.
  logger.info({ username }, "resolving entity via MTProto");
  const entity = await client.getEntity(username);
  const peer = entity as unknown as Api.TypeInputPeer;

  const [activeResult, pinnedResult] = await Promise.all([
    client.invoke(new Api.stories.GetPeerStories({ peer })),
    client.invoke(
      new Api.stories.GetPinnedStories({ peer, offsetId: 0, limit: 100 })
    ),
  ]);

  logger.info({ username, className: (activeResult as { className?: string }).className }, "active stories response");
  logger.info({ username, className: (pinnedResult as { className?: string }).className }, "pinned stories response");

  return {
    active: extractItems(activeResult),
    pinned: extractItems(pinnedResult),
  };
}

// Returns story item metadata (no download) for the given type.
// The worker uses this to check cache before deciding to download.
export async function fetchRawItems(
  client: TelegramClient,
  username: string,
  type: DownloadType
): Promise<RawStoryItem[]> {
  const { active, pinned } = await fetchStoryLists(client, username);

  let apiItems: Api.StoryItem[];

  if (type === "current") {
    const sorted = active.sort((a, b) => b.date - a.date);
    apiItems = sorted.length > 0 ? [sorted[0]] : [];
  } else if (type === "last") {
    const sortedActive = active.sort((a, b) => b.date - a.date);
    if (sortedActive.length >= 2) {
      apiItems = [sortedActive[1]];
    } else {
      const sortedPinned = pinned.sort((a, b) => b.date - a.date);
      apiItems = sortedPinned.length > 0 ? [sortedPinned[0]] : sortedActive.length === 1 ? [sortedActive[0]] : [];
    }
  } else {
    const seen = new Set<number>();
    apiItems = [];
    for (const story of [...active, ...pinned]) {
      if (!seen.has(story.id)) {
        seen.add(story.id);
        apiItems.push(story);
      }
    }
    if (apiItems.length > 50) {
      logger.info({ username, total: apiItems.length }, "truncated story list to 50");
      apiItems = apiItems.slice(0, 50);
    }
  }

  return apiItems.flatMap((item) => {
    const raw = toRawItem(item);
    return raw ? [raw] : [];
  });
}

// Downloads the media buffer for a single raw story item.
export async function downloadRawItem(
  client: TelegramClient,
  item: RawStoryItem
): Promise<Buffer | null> {
  const downloaded = await client.downloadMedia(item.media);
  if (!downloaded) return null;
  return bufferFromDownload(downloaded);
}

// Re-fetches the full story list to get a fresh fileReference for a specific story.
// Used to recover from FILE_REFERENCE_EXPIRED errors — always hits Telegram, never cache.
export async function refreshRawItem(
  client: TelegramClient,
  username: string,
  storyId: number
): Promise<RawStoryItem | null> {
  const items = await fetchRawItems(client, username, "all");
  return items.find((i) => i.id === storyId) ?? null;
}

// --- Legacy helpers kept for any future direct callers ---

export async function fetchCurrentStory(
  client: TelegramClient,
  username: string
): Promise<StoryMedia | null> {
  const items = await fetchRawItems(client, username, "current");
  if (items.length === 0) return null;
  const buffer = await downloadRawItem(client, items[0]);
  if (!buffer) return null;
  return { buffer, kind: items[0].kind, filename: items[0].filename, date: items[0].date };
}

export async function fetchLastStory(
  client: TelegramClient,
  username: string
): Promise<StoryMedia | null> {
  const items = await fetchRawItems(client, username, "last");
  if (items.length === 0) return null;
  const buffer = await downloadRawItem(client, items[0]);
  if (!buffer) return null;
  return { buffer, kind: items[0].kind, filename: items[0].filename, date: items[0].date };
}

export async function fetchAllStories(
  client: TelegramClient,
  username: string
): Promise<StoryMedia[]> {
  const items = await fetchRawItems(client, username, "all");
  const results: StoryMedia[] = [];
  for (const item of items) {
    const buffer = await downloadRawItem(client, item);
    if (!buffer) continue;
    results.push({ buffer, kind: item.kind, filename: item.filename, date: item.date });
  }
  return results;
}
