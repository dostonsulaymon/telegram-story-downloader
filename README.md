# story

A Telegram bot that downloads stories from Telegram accounts over MTProto and delivers them back to the requesting user as regular Telegram media.

Users interact with an ordinary Telegram bot: they send a `@username`, a `t.me/username` link, or a direct story link, and pick **Current**, **Last** or **All**. Behind the bot, a separate worker process fetches the stories through a pool of authenticated MTProto user sessions (GramJS), caches what it can, and streams the results back through the Bot API. The two halves communicate through a BullMQ job queue on Redis, so the user-facing bot stays responsive while downloads run elsewhere.

Written in TypeScript. Runs as two processes — `bot` and `worker` — backed by MongoDB and Redis.

---

## Disclaimer

**Read this before running the project.**

This software automates **Telegram user accounts** through the MTProto protocol. Adding a session with `/addsession` logs a real Telegram account into this bot, and every download is performed as that account. Automating user accounts in this way may conflict with the [Telegram Terms of Service](https://telegram.org/tos) and with the [Telegram API Terms of Service](https://core.telegram.org/api/terms). Accounts used this way can be limited, restricted, or permanently banned by Telegram.

This project is published **for educational purposes** — as a reference for MTProto session pooling, queue-backed job processing, and Telegram bot architecture.

You are solely responsible for how you use it. That includes compliance with Telegram's Terms of Service, with applicable law in your jurisdiction, and with any data protection or privacy legislation that applies to you. Only download content you have the right to access, and do not use this software to collect, redistribute, or archive other people's content without their consent.

The authors and contributors provide this software "as is", without warranty of any kind, and accept no liability for how it is used or for any consequences of using it — including account bans, data loss, or legal exposure. If you are not prepared to accept that risk, do not deploy this.

---

## Features

- **Three download modes** — the newest active story (*Current*), the previous one (*Last*), or the full active + pinned archive (*All*, capped at 50 stories per fetch).
- **Direct story links** — pasting `https://t.me/{username}/s/{storyId}` fetches that single story via a targeted `GetStoriesByID` call.
- **Flexible input parsing** — accepts `@username`, `username`, or `t.me/username` in any of those forms.
- **Paginated delivery** — *All* downloads are sent in pages of 10 with a "Load more" inline button; the button is bound to the requesting user and refuses taps from anyone else.
- **MTProto session pool** — multiple authenticated user accounts share the load, selected least-recently-used with concurrency, daily-cap, cooldown and FLOOD_WAIT guards.
- **Three-tier media resolution** — a permanent `file_id` cache in MongoDB, a Redis photo buffer cache, and a fresh MTProto download as the last resort.
- **`file_id` relay** — freshly downloaded media is uploaded once to a log channel to mint a reusable Bot API `file_id`, so repeat requests for the same story cost no bandwidth at all.
- **Per-user rate limiting** — enforced by an atomic Redis Lua script, so a crash can never leave a counter without a TTL.
- **Queue backpressure** — jobs are rejected with a friendly message once the queue exceeds 5000 waiting/delayed entries; jobs are given up to 3 attempts with exponential backoff.
- **Device fingerprinting** — each session gets a stable, realistic Android device profile derived deterministically from its phone number, and the same profile is used at auth time and on every reconnect.
- **Sanitised error messages** — MTProto and internal errors are mapped to safe human-readable strings; raw error codes, phone numbers and stack traces never reach users.
- **Admin command set** — session management, admin management, and live statistics, all gated behind an admin guard.
- **Graceful shutdown** — both processes handle `SIGINT`/`SIGTERM`, drain, disconnect every MTProto client, and close MongoDB cleanly.
- **Cross-process pool sync** — sessions added or removed in the bot process propagate to the worker over Redis pub/sub.

---

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Language | TypeScript | ^5.6.2 |
| Runtime | Node.js 20 (via `ts-node`) | ^10.9.2 |
| Bot API client | [grammy](https://grammy.dev) | ^1.20.1 |
| Multi-step dialogs | [@grammyjs/conversations](https://grammy.dev/plugins/conversations) | ^2.1.1 |
| MTProto client | [telegram](https://github.com/gram-js/gramjs) (GramJS) | ^2.26.10 |
| Job queue | [BullMQ](https://docs.bullmq.io) | ^5.70.4 |
| Queue / cache backend | Redis (via `ioredis`) | 7.x |
| Database | MongoDB with [mongoose](https://mongoosejs.com) | ^8.6.3 / 7.x |
| Config | dotenv | ^16.4.5 |
| Logging | pino + pino-pretty | ^10.3.1 / ^13.1.3 |

> **Note:** `ioredis` is currently pulled in as a transitive dependency of BullMQ rather than declared directly in `package.json`. Declaring it explicitly is on the to-do list.

---

## Architecture

### Two-process design

The project ships two entrypoints that are meant to run as separate processes:

| Process | Entrypoint | Responsibility |
|---|---|---|
| **bot** | `src/index.ts` | Everything user-facing: parses input, enforces rate limits, renders keyboards, runs admin commands, and enqueues jobs. It never downloads media. |
| **worker** | `src/worker.ts` | Consumes jobs from the queue, performs MTProto downloads, uploads and relays media, and edits the user's status message as it goes. |

Both processes connect to MongoDB and Redis on startup and both call `gramJsPool.loadActiveSessions()` — the bot needs the pool so `/sessions` and `/removesession` reflect live state, the worker needs it to pick a client per job. Because each process holds its own in-memory pool, changes are broadcast over a Redis pub/sub channel (`gramjs:pool`) so an `/addsession` in the bot process is picked up by the worker without a restart.

### Job flow

```
user sends @username
  └─ bot: checkRateLimit(userId)            Redis Lua, atomic
  └─ bot: reply with Current / Last / All keyboard
       └─ user taps a button
       └─ bot: edit message → "⏳ Queued..."
       └─ bot: addDownloadJob(...)          BullMQ "download" queue
            └─ worker: processJob()
               ├─ edit message → "⬇️ Downloading..."
               ├─ gramJsPool.pickClient()   one session for the whole job
               ├─ fetch story metadata      GetPeerStories / GetPinnedStories
               ├─ per item: 3-tier resolve → sendMedia()
               ├─ edit message → "✅ Done — N file(s) sent."
               └─ record a Download document in MongoDB
```

Job options: 3 attempts, exponential backoff from 5 s, a 5-minute lock duration (long video downloads), `stalledInterval` 30 s, `maxStalledCount` 2, keeping the last 1000 completed and 500 failed jobs. `addDownloadJob` refuses to enqueue once waiting + delayed jobs reach 5000, and the bot surfaces that as "Service is overloaded, try again later."

BullMQ requires dedicated Redis connections because it issues blocking commands, so both the `Queue` and the `Worker` call `redis.duplicate()` rather than sharing the general-purpose client.

### MTProto session pool

`GramJsPool` (`src/gramjs/client.ts`) keeps one connected `TelegramClient` per phone number, built from a `StringSession` stored in MongoDB. On startup, sessions with `status: "active"` are connected **sequentially with a random 1–2 second gap**, to avoid a burst of parallel auth handshakes that Telegram's abuse detection reacts badly to. A session that fails to connect is marked `banned` in the database.

`pickClient()` walks the candidate sessions and skips any that fail one of four checks:

1. **Overloaded** — in-flight jobs ≥ `SESSION_MAX_CONCURRENCY`.
2. **Daily cap** — the Redis counter `session:reqcount:{phone}` has reached `SESSION_DAILY_LIMIT` (24 h TTL, set on first increment).
3. **Flood-waited** — the key `session:floodwait:{phone}` exists. The worker sets it whenever Telegram answers `FLOOD_WAIT_X`, with a TTL of `X + 5` seconds.
4. **Cooling down** — less than `SESSION_COOLDOWN_MS` has passed since the session last finished a job.

Among the survivors it picks the **least recently used**, increments the in-flight counter and the daily counter atomically before returning, and stamps `lastUsed`. If nothing is eligible it throws `"All sessions are busy, please wait."`, which BullMQ treats as a retryable failure and the user sees as "Service is busy."

**One session per job is mandatory.** A `fileReference` returned by `GetPeerStories` or `GetStoriesByID` is bound to the MTProto session that obtained it; using another session to call `downloadMedia` with it fails with `FILE_REFERENCE_EXPIRED`. `processJob` therefore calls `pickClient()` exactly once and threads that client through every metadata fetch and every download in the job.

Two removal paths exist: `removeSession()` disconnects and hard-deletes the record (used by `/removesession`), while `evictSession()` disconnects and marks the record `banned` — triggered automatically when a job fails with `AUTH_KEY_UNREGISTERED`, meaning Telegram revoked the session.

Each session is given a device fingerprint by `getDeviceProfile(phone)` (`src/utils/deviceFingerprint.ts`): a deterministic hash of the phone number selects one of 15 real Android device profiles and one of 12 Telegram app versions. The same phone always yields the same profile, and — critically — both `createAuthClient()` during `/addsession` and `buildClient()` on every subsequent reconnect use it, so Telegram never sees one auth key arriving from two different "devices".

### Caching layers

For every story item the worker resolves media through three tiers, stopping at the first hit:

| Tier | Store | Key | Cost on a hit |
|---|---|---|---|
| 1 | MongoDB `fileidcaches` | `storyId` | None — the Bot API `file_id` is sent straight to the user. |
| 2 | Redis | `story:media:{storyId}` | No Telegram download, but still one log-channel upload to mint a `file_id`. |
| 3 | Telegram | — | Full MTProto download, then a log-channel upload. |

Tier 2 stores photos only; `setCachedStory` silently skips videos because their buffers are too large for Redis. Tier 3 downloads are subject to a timeout (120 s for photos, 300 s for videos) and are followed by a random jitter delay between `REQUEST_JITTER_MS_MIN` and `REQUEST_JITTER_MS_MAX`.

**The log channel relay** is what makes tier 1 possible. The Bot API only issues a `file_id` for media it has itself sent, so newly downloaded bytes are first uploaded to one of the channels in `LOG_CHANNEL_IDS` — chosen round-robin by `pickLogChannel()` — and the resulting `file_id` is persisted to MongoDB and then used to deliver the media to the user. Once any user has downloaded a given story, every later request for it is served from tier 1 with no bandwidth cost at all. The bot must be an administrator in each configured channel.

Pagination state for *All* downloads lives in Redis for 10 minutes: `pagination:{userId}:{username}` holds the ordered story ID list and `pagination:items:{userId}:{username}` holds per-story metadata. Pages after the first are served from that metadata, hitting Telegram only for the items that are not already in the buffer cache — and then with targeted per-ID fetches rather than a full list re-fetch. If the state expires between "Load more" taps the user is asked to start over.

### Rate limiting

`checkRateLimit(userId)` (`src/middleware/rateLimiter.ts`) runs a single Lua script on Redis that performs `EXISTS`, `SET NX EX` and `INCR` as one atomic operation against `ratelimit:{userId}`. Doing it in one script rather than two round-trips removes the window in which a crash between `INCR` and `EXPIRE` would leave a key with no TTL — and therefore a permanently rate-limited user. When the limit is exceeded the caller gets the key's remaining TTL back and the user is told exactly how many seconds to wait. The check runs on every download entry point: story links, keyboard callbacks, and "Load more" taps.

### Admin commands

Admin commands are routed through a filtered composer and guarded by `adminGuard` (`src/bot/middleware/adminGuard.ts`), which admits the user if their Telegram ID equals `SUPER_ADMIN_ID` or if a matching document exists in the `admins` collection. Everyone else gets "Admin access required."

| Command | What it does |
|---|---|
| `/addsession` | Starts a multi-step conversation: phone number → login code → 2FA password if the account has one. On success the `StringSession` is saved to MongoDB with `status: "active"`, the live client is handed to the pool, and an `add` event is published so the worker picks it up. Failures at any step clean up the pending client and Redis entry. |
| `/removesession <phone>` | Disconnects the client, removes it from the in-memory pool, deletes the record from MongoDB, and publishes a `remove` event. |
| `/sessions` | Lists every session in the database with its status and last-used timestamp. |
| `/addadmin <telegram_id>` | Inserts an admin document, recording who granted access. Rejects duplicates. |
| `/removeadmin <telegram_id>` | Deletes an admin document. `SUPER_ADMIN_ID` is explicitly protected and cannot be removed. |
| `/admins` | Lists the super admin and every stored admin along with who added them. |
| `/stats` | Queue counts (waiting / active / failed), session totals plus per-session in-flight job counts, the number of cached story buffers in Redis, and total users and downloads with a success/failure split. |

During `/addsession` the in-progress `TelegramClient` lives in an in-process `Map` keyed by a random UUID; Redis only stores `pending_auth:{userId} → clientKey` (10-minute TTL) so multiple bot instances agree on ownership. The client itself cannot be shared across processes — if the bot restarts mid-authentication, the user must start over.

The single non-admin command is `/start`, which explains the usage.

---

## Prerequisites

- **Node.js 20** or newer (the Docker image is `node:20-alpine`)
- **MongoDB 7** or compatible
- **Redis 7** or compatible
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- **Telegram API credentials** (`api_id` / `api_hash`) from [my.telegram.org](https://my.telegram.org)
- At least one **Telegram user account** you are willing to authenticate as an MTProto session — see the [Disclaimer](#disclaimer)
- One or more **Telegram channels** to use as the media relay, with the bot added as an administrator

Docker and Docker Compose are optional but are the easiest way to run everything.

---

## Setup & installation

### 1. Clone and install

```bash
git clone https://github.com/dostonsulaymon/story.git
cd story
npm install
```

### 2. Create the bot

Talk to [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, and copy the token it gives you into `BOT_TOKEN`.

### 3. Obtain Telegram API credentials

The MTProto side needs its own credentials, separate from the bot token:

1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone number.
2. Open **API development tools**.
3. Fill in an app title and short name (the platform and URL fields can be left at their defaults).
4. Submit the form. The page then shows an **`api_id`** (a number) and an **`api_hash`** (a 32-character hex string).
5. Put them in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

Treat the `api_hash` like a password — never commit it.

### 4. Set up the log channels

Create one or more private Telegram channels, add your bot as an administrator with permission to post, and collect their numeric IDs (they are negative and begin with `-100`). Put them in `LOG_CHANNEL_IDS` as a JSON array. These channels are where media is uploaded once so the bot can obtain a reusable `file_id`.

### 5. Configure the environment

```bash
cp .env.example .env
```

Fill in every required value. `SUPER_ADMIN_ID` must be **your own** Telegram user ID — it is the account that will be able to add sessions and other admins.

### 6. Start the services

Make sure MongoDB and Redis are running and reachable at `MONGO_URI` and `REDIS_URL`. Then start the bot process (see [Running locally](#running-locally)).

### 7. Add an MTProto session

The pool starts empty; without a session, every download fails with "No active GramJS sessions available".

1. Message your bot from the `SUPER_ADMIN_ID` account and send `/addsession`.
2. Send the phone number of the Telegram account to use, in international format (e.g. `+15551234567`).
3. Telegram sends a login code to that account. Send the code to the bot.
4. If the account has two-factor authentication enabled, the bot asks for the password next.
5. On success the bot replies "Session added and activated." The session string is stored in MongoDB and the client joins the pool immediately — in both the bot and the worker process.

Repeat for as many accounts as you want in the pool. `/sessions` shows what is registered; `/stats` shows what is actually connected and how loaded each session is.

---

## Configuration

Every variable read by the code, from `src/config.ts` (plus `LOG_LEVEL`, which `src/logger.ts` reads directly). Missing required variables cause the process to exit at startup with `Missing required env var: NAME`.

### Required

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram Bot API token from @BotFather. Used by the bot process and by the worker's `Api` client for sending media. |
| `MONGO_URI` | MongoDB connection string. Both processes connect on startup. |
| `REDIS_URL` | Redis connection URL. Backs BullMQ, the media and pagination caches, rate limiting, session counters and pub/sub. |
| `SUPER_ADMIN_ID` | Telegram user ID of the owner. Always passes `adminGuard` and cannot be removed by `/removeadmin`. Must be numeric. |
| `TELEGRAM_API_ID` | MTProto `api_id` from my.telegram.org. Must be numeric. |
| `TELEGRAM_API_HASH` | MTProto `api_hash` from my.telegram.org. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `APP_MODE` | `prod` | `dev` restricts the pool to `DEV_SESSION_PHONE` at both load and pick time, so production sessions are never touched locally. Any other value behaves as `prod`. |
| `DEV_SESSION_PHONE` | `""` | Phone number of the only session loaded and used when `APP_MODE=dev`. Ignored otherwise. |
| `WORKER_CONCURRENCY` | `10` | BullMQ worker concurrency — max jobs processed simultaneously by one worker process. |
| `SESSION_MAX_CONCURRENCY` | `5` | Max in-flight jobs a single MTProto session may be assigned before `pickClient` skips it. |
| `SESSION_DAILY_LIMIT` | `200` | Max times a session may be picked within a rolling 24-hour window, tracked in Redis. |
| `SESSION_COOLDOWN_MS` | `5000` | Minimum milliseconds since a session last *finished* a job before it can be picked again. |
| `REQUEST_JITTER_MS_MIN` | `200` | Lower bound of the random delay applied after each fresh MTProto download. |
| `REQUEST_JITTER_MS_MAX` | `800` | Upper bound of that delay. |
| `RATE_LIMIT_MAX` | `5` | Max download requests one user may make per rate-limit window. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Length of the rate-limit window, in seconds. Also the TTL of `ratelimit:{userId}`. |
| `CACHE_TTL_SECONDS` | `3600` | TTL of the Redis photo buffer cache (`story:media:{storyId}`). Videos are never cached there. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_CHANNEL_IDS` | `[]` | JSON array of channel IDs used round-robin for the media relay, e.g. `[-1001111111111,-1002222222222]`. Defaults to an empty list, which disables the relay — **always set this explicitly** if you want it. Invalid JSON throws at startup. |

**Sizing note.** Keep `WORKER_CONCURRENCY ≤ number_of_sessions × SESSION_MAX_CONCURRENCY`, otherwise jobs will repeatedly fail to acquire a session and burn their retries. The stock defaults are on the aggressive side: with a page size of 10 items fetched concurrently, one session at `SESSION_MAX_CONCURRENCY=5` can issue 50 simultaneous MTProto calls. `WORKER_CONCURRENCY=5` with `SESSION_MAX_CONCURRENCY=2` is a safer starting point.

---

## Running locally

The bot and the worker are **two separate processes** and both must be running for downloads to complete. Start MongoDB and Redis first.

```bash
# Terminal 1 — bot process (user-facing)
npm run bot        # or: npm run dev   (identical, ts-node src/index.ts)

# Terminal 2 — worker process (downloads)
npm run worker     # ts-node src/worker.ts
```

All available scripts:

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `ts-node src/index.ts` | Run the bot process from TypeScript sources. |
| `npm run bot` | `ts-node src/index.ts` | Alias of `dev`. |
| `npm run worker` | `ts-node src/worker.ts` | Run the worker process from TypeScript sources. |
| `npm run build` | `tsc -p tsconfig.json` | Compile `src/` to `dist/`. |
| `npm start` | `node dist/index.js` | Run the compiled bot process. Requires `npm run build` first. |

> There is no compiled-output script for the worker; after `npm run build` it can be started with `node dist/worker.js`.

A crude load-generator lives at `scripts/loadtest.ts`. It enqueues a batch of jobs and polls queue depth until they drain. It has no npm script; set `LOADTEST_TARGET_USERNAME` (defaults to `durov`) and run it with `npx ts-node scripts/loadtest.ts`. Point it only at an account you own.

---

## Docker

`docker-compose.yml` brings up four services on a shared network: `bot`, `worker`, `mongo` (with a named volume) and `redis` (append-only persistence, named volume). Both application services build from the same image and differ only in their command.

```bash
cp .env.example .env    # then fill it in
docker compose up --build
```

The compose file loads configuration from `.env` via `env_file`, so point `MONGO_URI` and `REDIS_URL` at the service names rather than localhost:

```
MONGO_URI=mongodb://mongo:27017/story_bot
REDIS_URL=redis://redis:6379
```

Useful commands:

```bash
docker compose up -d --build      # start detached
docker compose logs -f worker     # follow worker logs
docker compose up -d --scale worker=3   # run more workers
docker compose down               # stop (volumes are preserved)
```

The image installs full dependencies (`ts-node` and `typescript` are devDependencies and are required at runtime) and defines no `CMD` — the command comes from compose. Note that `depends_on` does not currently wait for health checks, so on a cold start the app containers may come up before MongoDB and Redis are ready and need to restart once.

---

## Project structure

```
src/
├── index.ts                    # Bot process entrypoint: Mongo, session pool, grammy bot, graceful shutdown
├── worker.ts                   # Worker process entrypoint: Mongo, session pool, BullMQ worker
├── config.ts                   # Every env var, with validation and defaults
├── redis.ts                    # Shared ioredis client, pool pub/sub, pending-auth helpers
├── logger.ts                   # Pino logger
│
├── bot/
│   ├── index.ts                # createBot(): middleware, input parsing, keyboards, callback handlers
│   ├── middleware/
│   │   └── adminGuard.ts       # SUPER_ADMIN_ID or admins collection check
│   └── commands/
│       ├── addsession.ts       # /addsession conversation: phone → code → 2FA
│       ├── removesession.ts    # /removesession
│       ├── sessions.ts         # /sessions
│       ├── addadmin.ts         # /addadmin
│       ├── removeadmin.ts      # /removeadmin
│       ├── admins.ts           # /admins
│       └── stats.ts            # /stats
│
├── gramjs/
│   ├── auth.ts                 # MTProto login flow + in-process client registry
│   ├── client.ts               # GramJsPool: lifecycle, pickClient(), eviction, cross-process sync
│   └── stories.ts              # Story metadata fetching and media downloads
│
├── queue/
│   ├── producer.ts             # BullMQ Queue: addDownloadJob(), getQueueStats(), backpressure
│   └── worker.ts               # BullMQ Worker: processJob(), 3-tier resolution, pagination, FLOOD_WAIT
│
├── cache/
│   ├── mediaCache.ts           # Redis photo buffer cache + pagination state
│   └── fileIdCache.ts          # MongoDB permanent file_id cache
│
├── models/
│   ├── user.model.ts           # users
│   ├── admin.model.ts          # admins
│   ├── session.model.ts        # sessions (phone, sessionString, status, lastUsed)
│   ├── download.model.ts       # downloads (audit log)
│   └── fileid.model.ts         # fileidcaches
│
├── middleware/
│   └── rateLimiter.ts          # Atomic per-user rate limit (Redis Lua)
│
├── telegram/
│   └── logChannels.ts          # Round-robin picker over LOG_CHANNEL_IDS
│
└── utils/
    ├── deviceFingerprint.ts    # Deterministic Android device profile per phone
    ├── userErrors.ts           # toUserMessage(): safe error strings
    └── sleep.ts                # sleep(), randomBetween()
```

`scripts/loadtest.ts` sits outside `src/` and is not part of the compiled output.

---

## Contributing

Contributions are welcome. Please open an issue to discuss anything substantial before sending a pull request.

- Fork the repository and branch from `main`.
- Keep changes focused — small, single-purpose pull requests get reviewed faster.
- The project is `strict`-mode TypeScript. Run `npm run build` before submitting; it must compile with no errors.
- Match the existing style: named exports, `async/await`, structured pino logging with an object first (`logger.info({ phone }, "message")`), and comments reserved for non-obvious reasoning.
- Never commit a `.env` file, a session string, a bot token, an `api_hash`, a phone number, or a real channel ID. Use placeholders in examples and update `.env.example` when you add a configuration option.
- If you change behaviour, update the relevant section of this README and of `CLAUDE.md`.
- Pull requests that add features designed to evade Telegram's anti-abuse systems, or to harvest content at scale, will not be accepted.

---

## License

Released under the [MIT License](LICENSE).

MIT is a permissive licence: you may use, copy, modify, merge, publish, distribute, sublicense and sell copies of this software, provided the copyright notice and permission notice are included. The software is provided "as is", without warranty of any kind — see the [Disclaimer](#disclaimer) for what that means in practice here.
