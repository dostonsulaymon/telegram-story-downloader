> **Maintenance rule:** After every change to the codebase, update this file to reflect what was added, removed, or changed.

# Telegram Story Downloader Bot

A Telegram bot that downloads stories from public Telegram accounts using the MTProto API (GramJS) and delivers them to users via the Bot API (grammy). Built in TypeScript, runs as two separate processes: **bot** (handles user interaction) and **worker** (performs downloads).

---

## Tech Stack

| Layer | Library | Version |
|---|---|---|
| Bot API | grammy | ^1.20.1 |
| Bot conversations | @grammyjs/conversations | ^2.1.1 |
| MTProto client | telegram (GramJS) | ^2.26.10 |
| Job queue | bullmq | ^5.70.4 |
| Database | mongoose + MongoDB | ^8.6.3 |
| Cache / pub-sub | ioredis (via Redis) | transitive via bullmq |
| Logging | pino + pino-pretty | ^10.3.1 / ^13.1.3 |
| Runtime | ts-node | ^10.9.2 |
| Language | TypeScript | ^5.6.2 |

> **Note:** `ioredis` is only a transitive dependency pulled in by BullMQ. It should be added explicitly to `package.json` to avoid breakage on BullMQ upgrades.

---

## Commands

```bash
npm run dev       # Start bot process (ts-node src/index.ts)
npm run bot       # Alias for dev
npm run worker    # Start worker process (ts-node src/worker.ts)
npm run build     # Compile TypeScript to dist/
npm start         # Run compiled bot (node dist/index.js)
```

Bot and worker must run as separate processes (typically via docker-compose). Both connect to MongoDB and Redis on startup.

---

## Project Structure

```
src/
├── index.ts                    # Bot process entrypoint: connects Mongo, loads session pool, starts grammy bot
├── worker.ts                   # Worker process entrypoint: connects Mongo, loads session pool, starts BullMQ worker
├── config.ts                   # All env vars with validation and defaults
├── redis.ts                    # Shared ioredis instance + pub/sub helpers + pending-auth helpers
├── logger.ts                   # Pino logger (structured JSON, pretty in dev)
│
├── bot/
│   ├── index.ts                # createBot(): middleware chain, message handlers, callback query handlers
│   └── middleware/
│   │   └── adminGuard.ts       # Checks SUPER_ADMIN_ID or AdminModel before passing to admin commands
│   └── commands/
│       ├── addsession.ts       # /addsession: multi-step conversation to auth a new GramJS session
│       ├── removesession.ts    # /removesession: remove a session from pool and DB
│       ├── sessions.ts         # /sessions: list active sessions and their job loads
│       ├── addadmin.ts         # /addadmin: grant admin access to a user
│       ├── removeadmin.ts      # /removeadmin: revoke admin access
│       ├── admins.ts           # /admins: list current admins
│       └── stats.ts            # /stats: queue stats + session loads + cache count
│
├── gramjs/
│   ├── auth.ts                 # createAuthClient(phone), sendAuthCode, signInWithCode, signInWith2FA,
│   │                           #   extractSessionString, clientRegistry (in-process UUID→client map)
│   ├── client.ts               # GramJsPool class: session pool lifecycle, pickClient(), FLOOD_WAIT skip,
│   │                           #   daily cap, cooldown, cross-process pub/sub sync, touchLastUsed()
│   └── stories.ts              # fetchRawItems(), fetchSingleStory(), downloadRawItem(), refreshRawItem(),
│                               #   legacy fetchCurrentStory/fetchLastStory/fetchAllStories
│
├── queue/
│   ├── producer.ts             # BullMQ Queue: addDownloadJob(), getQueueStats(), DownloadJobPayload type
│   └── worker.ts               # BullMQ Worker: processJob(), 3-tier media resolution, pagination,
│                               #   FLOOD_WAIT handling, sendMedia(), fetchAndSend(), startWorker()
│
├── cache/
│   ├── mediaCache.ts           # Redis: story buffer cache (photos only), pagination state (IDs + item meta)
│   └── fileIdCache.ts          # MongoDB: permanent file_id cache (getFileId, setFileId)
│
├── models/
│   ├── user.model.ts           # Users collection: telegramId, username, firstName, lastSeen, createdAt
│   ├── admin.model.ts          # Admins collection: telegramId, addedBy, addedAt
│   ├── session.model.ts        # Sessions collection: phone, sessionString, status, lastUsed, addedAt
│   ├── download.model.ts       # Downloads collection: userId, targetUsername, type, sessionPhone,
│   │                           #   mediaCount, status, downloadedAt
│   └── fileid.model.ts         # FileIdCache collection: storyId, fileId, kind, cachedAt
│
├── middleware/
│   └── rateLimiter.ts          # Per-user rate limit via atomic Lua script (Redis INCR + TTL)
│
├── telegram/
│   └── logChannels.ts          # Round-robin picker across LOG_CHANNEL_IDS for media upload/relay
│
└── utils/
    ├── deviceFingerprint.ts    # 15 Android device profiles; getDeviceProfile(phone) — deterministic
    │                           #   djb2-style hash maps phone → stable (device, OS, appVersion) tuple
    ├── userErrors.ts           # toUserMessage(error): maps GramJS/MTProto errors to safe user strings
    └── sleep.ts                # sleep(ms), randomBetween(min, max)
```

---

## Architecture

### Two-process design

**Bot process** (`src/index.ts`) handles all Telegram Bot API interaction. It does not download media itself — it validates user input, checks rate limits, and enqueues a BullMQ job. It also manages the session pool for `/addsession` and `/removesession` commands.

**Worker process** (`src/worker.ts`) dequeues jobs, uses GramJS to fetch and download stories, and sends results back to the user via the Bot API. It runs independently and can be scaled separately.

Both processes maintain an **in-memory GramJS session pool** (`GramJsPool`). Changes made via bot commands are propagated to the worker via Redis pub/sub (`gramjs:pool` channel) so both stay in sync without requiring a shared process.

### Session pool (`src/gramjs/client.ts`)

`GramJsPool` holds one `TelegramClient` per phone number. `pickClient()` selects the best available session applying four skip conditions in order:
1. **Overloaded** — `activeJobs >= SESSION_MAX_CONCURRENCY`
2. **Daily cap** — `session:reqcount:{phone}` counter in Redis exceeds `SESSION_DAILY_LIMIT` (TTL resets after 24h)
3. **FLOOD_WAIT** — `session:floodwait:{phone}` key exists in Redis (set by worker on FLOOD_WAIT error, TTL = waitSeconds + 5)
4. **Cooldown** — `now - lastUsed < SESSION_COOLDOWN_MS` (lastUsed stamped at job *completion*, not pick time)

Among eligible sessions, `pickClient()` prefers the least-recently-used (LRU).

Sessions are loaded sequentially on startup with a 1–2 s random delay between connects to avoid Telegram abuse detection. A cross-process Redis pub/sub subscription keeps both bot and worker pools in sync when sessions are added or removed.

### Single session per job (fileReference binding)

A `fileReference` obtained from `GetPeerStories` or `GetStoriesByID` is cryptographically bound to the MTProto session that fetched it. Using a different session to call `downloadMedia` with that reference will fail with `FILE_REFERENCE_EXPIRED` or `FILE_REFERENCE_INVALID`. Therefore, `processJob` in `worker.ts` calls `pickClient()` once at the start of the job and uses that same `client` for all subsequent `fetchRawItems`, `fetchSingleStory`, and `downloadRawItem` calls.

### 3-tier media resolution (`src/queue/worker.ts` → `fetchMediaItem`)

For each story item, the worker tries three sources in order, stopping at the first hit:

1. **Permanent file_id cache (MongoDB)** — `FileIdCache` collection. If a Bot API `file_id` was previously stored for this `storyId`, send it directly with no download and no upload. Survives Redis restarts.
2. **Buffer cache (Redis)** — `story:media:{storyId}` key. Photos only (videos are too large). If the buffer is cached, upload it to a log channel to obtain a `file_id`, then relay to the user.
3. **Fresh MTProto download** — Call `downloadRawItem(client, item)`. Upload to a log channel, cache the resulting `file_id` in MongoDB, relay to the user. A random jitter delay (`REQUEST_JITTER_MS_MIN`–`REQUEST_JITTER_MS_MAX`) is applied after each tier-3 download.

Once a story is downloaded even once, all future sends use the fast tier-1 path.

### BullMQ job flow

```
User message/callback
  → Bot checks rate limit (Redis Lua)
  → Bot replies with status message ("⏳ Queued...")
  → addDownloadJob() → BullMQ queue
     → Worker picks up job
     → processJob() edits status message to "⬇️ Downloading..."
     → pickClient() selects a GramJS session
     → Fetch story metadata (MTProto)
     → For each item: 3-tier resolution → sendMedia()
     → Edit status message to "✅ Done."
     → Record download in MongoDB
```

Job options: 3 attempts, exponential backoff starting at 5 s, `lockDuration: 300000` (5 min, required for long video downloads), `stalledInterval: 30000`, `maxStalledCount: 2`.

### Paginated "all" downloads

Page 1 (offset=0): fetch full story list → store ordered ID array in `pagination:{userId}:{username}` (Redis, 10 min TTL) and item metadata in `pagination:items:{userId}:{username}` → process first `PAGE_SIZE` (10) items.

Pages 2+ (offset>0): read ID array and item metadata from Redis (no Telegram call). For any items not in the buffer cache, call `fetchSingleStory` individually (targeted `GetStoriesByID`) rather than re-fetching the full list. A "Load more" inline button is shown if more pages remain.

Caption numbering: `counter.value` starts at `offset` so captions read `11/24`, `12/24` across all pages. `total` is the full ID array length from Redis, falling back to `pageRawItems.length` if state is unavailable.

### Device fingerprinting

`getDeviceProfile(phone)` in `src/utils/deviceFingerprint.ts` uses a deterministic djb2-style hash of the phone number to select a stable Android device profile from 15 real device profiles (Samsung, Xiaomi, Redmi, POCO, OnePlus, Realme, Huawei) and one of 12 app versions. The same phone always gets the same profile across restarts.

**Critical:** `createAuthClient(phone)` in `src/gramjs/auth.ts` and `buildClient(sessionString, phone)` in `src/gramjs/client.ts` both call `getDeviceProfile(phone)` so the MTProto `initConnection` presented during auth exactly matches every subsequent reconnect. A mismatch here is a ban trigger.

### Error sanitization

`toUserMessage(error)` in `src/utils/userErrors.ts` pattern-matches known GramJS/MTProto error codes and returns safe human-readable strings. Raw error codes, phone numbers, and stack traces are never sent to users. All error sites in `worker.ts` and `addsession.ts` route through this function.

---

## Environment Variables

All defined in `src/config.ts`. Copy `.env.example` to `.env` and fill in required values.

### Required

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram Bot API token from @BotFather |
| `MONGO_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection URL |
| `SUPER_ADMIN_ID` | Telegram user ID of the owner; bypasses admin checks |
| `TELEGRAM_API_ID` | MTProto API ID from my.telegram.org |
| `TELEGRAM_API_HASH` | MTProto API hash from my.telegram.org |

### Optional with defaults

| Variable | Default | Description |
|---|---|---|
| `APP_MODE` | `prod` | `dev` restricts session pool to `DEV_SESSION_PHONE` only |
| `DEV_SESSION_PHONE` | `""` | Phone number of the sole session used when `APP_MODE=dev` |
| `WORKER_CONCURRENCY` | `10` | Max concurrent BullMQ jobs across the worker process |
| `SESSION_MAX_CONCURRENCY` | `5` | Max concurrent jobs a single GramJS session may handle |
| `SESSION_DAILY_LIMIT` | `200` | Max requests per session per 24-hour window |
| `SESSION_COOLDOWN_MS` | `5000` | Minimum idle time (ms) between consecutive jobs for a session |
| `REQUEST_JITTER_MS_MIN` | `200` | Minimum post-download jitter delay (ms) |
| `REQUEST_JITTER_MS_MAX` | `800` | Maximum post-download jitter delay (ms) |
| `RATE_LIMIT_MAX` | `5` | Max bot requests per user per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit sliding window duration |
| `CACHE_TTL_SECONDS` | `3600` | Redis buffer cache TTL for photos |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_CHANNEL_IDS` | `[...]` | JSON array of Telegram channel IDs for media relay (round-robin) |

### Sizing guidance

`WORKER_CONCURRENCY` should be ≤ `number_of_sessions × SESSION_MAX_CONCURRENCY`. A safe conservative pair is `WORKER_CONCURRENCY=5`, `SESSION_MAX_CONCURRENCY=2`.

---

## Known Constraints and Gotchas

### fileReference is session-bound
A `fileReference` embedded in a story's `media` object is cryptographically tied to the MTProto session that retrieved it. You cannot use session A's `fileReference` with session B. `processJob` enforces this by calling `pickClient()` exactly once and threading that client through all operations in the job.

### GramJS device fingerprint must match auth
`createAuthClient(phone)` must use the same device profile as `buildClient(sessionString, phone)` or Telegram will see the same auth key reconnecting from a different device, which is a ban trigger. Both currently call `getDeviceProfile(phone)`. Never replace one without updating the other.

### FLOOD_WAIT handling
When Telegram returns `FLOOD_WAIT_X`, the worker sets `session:floodwait:{phone}` in Redis with TTL of `X+5` seconds. `pickClient()` skips sessions with this key. Without this, BullMQ's exponential backoff (starting at 5 s) retries inside the FLOOD_WAIT window and burns all retry attempts.

### `lastUsed` is stamped at job completion
`pickClient()` sets `lastUsed` at pick time as a concurrency guard. `touchLastUsed()` is also called in the `finally` block of `processJob` to reset it at job *completion*. The `SESSION_COOLDOWN_MS` window is therefore measured from when the session last became idle, not from when it last started a job.

### Videos are not buffer-cached
`setCachedStory` in `src/cache/mediaCache.ts` silently skips videos (`mediaType === "video"`) because video buffers are too large for Redis. Videos always go through tier 3 (fresh download) unless a `file_id` is already in MongoDB.

### Session status values
`session.status` can be `"active"`, `"pending"`, or `"banned"`. `evictSession()` (called on `AUTH_KEY_UNREGISTERED`) sets status to `"banned"`. `removeSession()` hard-deletes the record. Only `"active"` sessions are loaded at startup.

### BullMQ requires dedicated Redis connections
The shared `redis` instance from `src/redis.ts` cannot be used by BullMQ. Queue and Worker both call `redis.duplicate()` to get a dedicated connection. This is required because BullMQ uses blocking Redis commands.

### Dev mode
When `APP_MODE=dev`, `loadActiveSessions()` only connects the session matching `DEV_SESSION_PHONE` — all other DB sessions are ignored. `pickClient()` restricts candidates to that session only. This prevents production sessions from being touched during local development.

### Pagination TTL is 10 minutes
`pagination:{userId}:{username}` and `pagination:items:{userId}:{username}` keys expire after 600 seconds. If a user takes more than 10 minutes between "Load more" taps, the pagination state is gone and they get `"❌ Session expired. Please start a new download."`.

### Auth client registry is in-process only
During `/addsession`, the `TelegramClient` is stored in `clientRegistry` (a `Map` in `src/gramjs/auth.ts`). Redis only stores `userId → clientKey` so multiple bot instances can agree on ownership. The client itself lives only in the bot process that created it. If the bot restarts mid-auth, the client is lost and the user must restart `/addsession`.

---

## MongoDB Collections

| Collection | Model | Purpose |
|---|---|---|
| `users` | `UserModel` | Auto-upserted on every interaction; tracks `lastSeen` |
| `admins` | `AdminModel` | Users granted admin access via `/addadmin` |
| `sessions` | `SessionModel` | GramJS MTProto sessions; `status`: active / pending / banned |
| `downloads` | `DownloadModel` | Audit log of every download job (success and final failure) |
| `fileidcaches` | `FileIdCacheModel` | Permanent `file_id` cache keyed by `storyId` |

---

## Redis Key Space

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `ratelimit:{userId}` | string (counter) | `RATE_LIMIT_WINDOW_SECONDS` | Per-user Bot API rate limit |
| `story:media:{storyId}` | string (base64) | `CACHE_TTL_SECONDS` (3600s) | Photo buffer cache (tier 2) |
| `pagination:{userId}:{username}` | string (JSON) | 600s | Ordered story ID array for "all" pagination |
| `pagination:items:{userId}:{username}` | string (JSON) | 600s | Story metadata array (id, caption, mediaType) |
| `session:reqcount:{phone}` | string (counter) | 86400s | Per-session 24h request count |
| `session:floodwait:{phone}` | string (`"1"`) | FLOOD_WAIT seconds + 5 | Session ban marker; pickClient skips if exists |
| `pending_auth:{userId}` | string (UUID) | 600s | clientKey for in-progress /addsession |
| `gramjs:pool` | pub/sub channel | — | Pool add/remove events between bot and worker |

---

## Admin Commands

All gated by `adminGuard` middleware. `SUPER_ADMIN_ID` always bypasses the check.

| Command | Description |
|---|---|
| `/addsession` | Multi-step conversation: phone → code → (optional 2FA) → adds GramJS session |
| `/removesession` | Remove a session from pool and delete from DB |
| `/sessions` | List all pool sessions with active job counts |
| `/addadmin <userId>` | Grant admin access |
| `/removeadmin <userId>` | Revoke admin access |
| `/admins` | List all admins |
| `/stats` | Queue stats (waiting/active/failed) + session loads + Redis cache count |

---

## Pending Tasks

- **Add `ioredis` explicitly to `package.json` dependencies.** It is currently only a transitive dependency via BullMQ. If BullMQ ever changes its internal dependency tree, imports from `ioredis` in `src/redis.ts` will break.
- **Docker health checks.** `docker-compose.yml` starts mongo and redis services but `depends_on` does not use `condition: service_healthy`. Bot and worker can start before Mongo/Redis are ready.
- **`SESSION_MAX_CONCURRENCY` default of 5 is too high.** With `Promise.allSettled` sending up to `PAGE_SIZE=10` downloads concurrently per job, one session at max concurrency sends 50 simultaneous MTProto calls. Recommended: lower to `2` and `WORKER_CONCURRENCY` to `5`.
