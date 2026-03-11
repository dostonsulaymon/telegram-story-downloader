import { TelegramClient, Api } from "telegram";
import { readFile } from "node:fs/promises";

export type DownloadType = "current" | "last" | "all";

export type StoryMedia = {
  buffer: Buffer;
  kind: "photo" | "video";
  filename?: string;
  date: number;
};

function extractItems(result: unknown): Api.StoryItem[] {
  const r = result as { stories?: { stories?: unknown[] } };
  const arr = r?.stories?.stories;

  console.log(
    `[stories] extractItems: stories.stories type=${Array.isArray(arr) ? "array" : typeof arr} ` +
    `length=${Array.isArray(arr) ? arr.length : "n/a"}`
  );

  if (!Array.isArray(arr)) {
    console.log("[stories] unexpected shape — raw dump:", JSON.stringify(result));
    return [];
  }

  const items = arr.filter(
    (item): item is Api.StoryItem =>
      (item as { className?: string }).className === "StoryItem"
  );

  console.log(
    `[stories] total=${arr.length} usable StoryItems=${items.length} ` +
    `skipped/deleted=${arr.length - items.length}`
  );

  return items;
}

async function downloadStoryMedia(
  client: TelegramClient,
  story: Api.StoryItem
): Promise<StoryMedia | null> {
  if (!story.media) return null;

  const kind = "photo" in story.media ? "photo" : "video";
  const downloaded = await client.downloadMedia(story.media as Api.TypeMessageMedia);
  if (!downloaded) return null;

  let buffer: Buffer;
  if (Buffer.isBuffer(downloaded)) {
    buffer = downloaded;
  } else if (typeof downloaded === "string") {
    buffer = await readFile(downloaded);
  } else {
    buffer = Buffer.from(downloaded);
  }

  return {
    buffer,
    kind,
    filename: `story_${story.date}${kind === "video" ? ".mp4" : ".jpg"}`,
    date: story.date,
  };
}

async function fetchStoryLists(
  client: TelegramClient,
  username: string
): Promise<{ active: Api.StoryItem[]; pinned: Api.StoryItem[] }> {
  const entity = await client.getEntity(username);

  const [activeResult, pinnedResult] = await Promise.all([
    client.invoke(new Api.stories.GetPeerStories({ peer: entity as unknown as Api.TypeInputPeer })),
    client.invoke(
      new Api.stories.GetPinnedStories({ peer: entity as unknown as Api.TypeInputPeer, offsetId: 0, limit: 100 })
    ),
  ]);

  console.log(`[stories] active raw className=${(activeResult as { className?: string }).className}`);
  console.log(`[stories] pinned raw className=${(pinnedResult as { className?: string }).className}`);

  return {
    active: extractItems(activeResult),
    pinned: extractItems(pinnedResult),
  };
}

export async function fetchCurrentStory(
  client: TelegramClient,
  username: string
): Promise<StoryMedia | null> {
  const { active } = await fetchStoryLists(client, username);
  if (active.length === 0) return null;

  const [newest] = active.sort((a, b) => b.date - a.date);
  return downloadStoryMedia(client, newest);
}

export async function fetchLastStory(
  client: TelegramClient,
  username: string
): Promise<StoryMedia | null> {
  const { active } = await fetchStoryLists(client, username);
  if (active.length === 0) return null;

  const sorted = active.sort((a, b) => a.date - b.date);
  return downloadStoryMedia(client, sorted[sorted.length - 1]);
}

export async function fetchAllStories(
  client: TelegramClient,
  username: string
): Promise<StoryMedia[]> {
  const { active, pinned } = await fetchStoryLists(client, username);

  const seen = new Set<number>();
  const combined: Api.StoryItem[] = [];
  for (const story of [...active, ...pinned]) {
    if (!seen.has(story.id)) {
      seen.add(story.id);
      combined.push(story);
    }
  }

  const results: StoryMedia[] = [];
  for (const story of combined) {
    const media = await downloadStoryMedia(client, story);
    if (media) results.push(media);
  }
  return results;
}
