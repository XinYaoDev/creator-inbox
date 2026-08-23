# Creator Inbox — API Reference

Base URL: `http://<host>:8877`

All responses are JSON.

## Authentication

If `AUTH_TOKEN` is unset, `/api/*` is open (fine on localhost). **On NAS / LAN, set `AUTH_TOKEN`.** Then every `/api/*` request must present the token as either:

- `Authorization: Bearer <token>` (the web UI does this after you paste it once; stored in `localStorage`)
- `?token=<token>` query param — for `<img>` / `<video>` src that cannot send headers

Missing/wrong token → `401`. Static UI assets are still served without auth so the token prompt can load.

## Status & Overview

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Collection status: `collecting`, `lastCollect`, `lastError`, counts (videos/comments/sessions/messages/pending), per-platform counts, account states |

## Accounts & Groups

| Method | Path | Description |
|---|---|---|
| GET | `/api/accounts` | List accounts with platform, label, cookie validity, last error, online state |
| POST | `/api/groups` | Create account group `{name}` |
| POST | `/api/accounts` | Create account `{groupId, platform, label, cookie?}` |
| POST | `/api/accounts/:id/cookie` | Update account cookie `{cookie}` |
| DELETE | `/api/accounts/:id` | Remove account and cascade its videos/comments/DMs |
| DELETE | `/api/groups/:id` | Remove group |

## Comments

| Method | Path | Description |
|---|---|---|
| GET | `/api/comments` | Comments. Query: `platform`, `accountId`, `pending` (1/0), `limit`, `offset` |
| GET | `/api/video/comments` | Comments for a video. Query: `platform`, `accountId`, `objectId` |
| POST | `/api/handled` | Mark handled: `{platform, accountId, kind: 'comment'\|'session'\|'video', targetId, done}`. `kind=video` marks remaining pending comments on that video (used when leaving it unread). |
| POST | `/api/comments/:commentId/reply` | Reply to a comment `{content}` (platform-dependent support) |
| GET | `/api/search` | Search comments & messages. Query: `q` |

## Videos

| Method | Path | Description |
|---|---|---|
| GET | `/api/videos` | Videos across accounts. Query: `platform`, `accountId`, `limit`, `offset` |

## DM Sessions & Messages

| Method | Path | Description |
|---|---|---|
| GET | `/api/dm/sessions` | DM sessions. Query: `platform`, `accountId` |
| GET | `/api/dm/sessions/:sessionId/messages` | Messages in a session |
| POST | `/api/dm/sessions/:sessionId/send` | Send a DM `{content}` (platform-dependent support) |

## Collection & Login

| Method | Path | Description |
|---|---|---|
| POST | `/api/collect` | Trigger collection asynchronously (front-end polls `/api/status`) |
| POST | `/api/login/start` | Start WeChat QR login. Returns `sessionId`, `qrDataUrl` (base64, if the server could fetch the image), `qrDirectUrl` (WeChat CDN, for the user's browser to load) |
| GET | `/api/login/qr` | Same QR as a binary image (fallback if `qrDataUrl` was empty) |
| GET | `/api/login/status` | Login flow status |
| POST | `/api/login/choose` | Choose/confirm a logged-in account |
| POST | `/api/login/cancel` | Cancel login flow |

## Media Library

Library routes are delegated to `server/library.js` (prefix `/api/library/`).

| Method | Path | Description |
|---|---|---|
| GET | `/api/library/assets` | List assets (`type`, `source` nas/upload/ai, `q` path/tags/caption, `tag`, `sort`, `limit`) |
| GET | `/api/library/suggest` | `q` 人话检索图片，按 caption/关键词/专辑打分，实拍优先 |
| POST | `/api/library/caption-backfill` | 给未描述的图片补 Kimi 视觉描述 |
| GET | `/api/library/caption-status` | `{running, done, total, errors}` |
| POST | `/api/library/save-note-image` | `{imageId, caption?, keywords?}` 把笔记生成图存进库 `source=ai` |
| POST | `/api/library/scan` | Scan configured NAS/media directory |
| GET | `/api/library/scan/status` | Scan progress |
| POST | `/api/library/upload` | Raw image/video body + `?filename=` |

> Detailed library API is under active development; check `server/library.js` for the current surface.

## Xiaohongshu notes (draft)

One note at a time: material → copy (style + lint) → storyboard → generate. Images are stored under `data/notes/`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/notes/status` | Whether LLM key is set, and which image provider will be used (`hermes` / `fal` / `pollinations` / …) |
| POST | `/api/notes/draft` | `{material, topic}` → `{title, body, tags, style, lint, rewritten}` guest-voice copy. Picks a style, then regex+LLM lint; rewrites up to twice. |
| POST | `/api/notes/lint` | `{title, body, material, style, rewrite?}` → `{lint, title, body}`. `rewrite:true` asks the model to fix fails. |
| POST | `/api/notes/storyboard` | `{topic, body}` → `{slots: [{id, role, want, prompt}]}` |
| POST | `/api/notes/generate` | `{slots}` → `{results: [{id, imageId}]}` |
| POST | `/api/notes/generate-one` | `{prompt, want?, imageId?, n}` → `{imageIds}`. `imageId` is a previously uploaded/generated file used as img2img reference (Hermes only) |
| POST | `/api/notes/upload` | Raw image body (jpeg/png/webp, ≤8MB) → `{imageId}` stored under `data/notes/` |
| POST | `/api/notes/from-library` | `{id}` library image asset → copy into `data/notes/`, `{imageId}` |
| GET | `/api/notes/file?id=` | Stored image (generated or uploaded) |

Drafting records today's material into `data/assets/materials.jsonl` and, when enough cases exist, uses them as few-shot examples instead of the built-in ones.

## Note assets

Stored as JSONL under `data/assets/` (`materials.jsonl`, `notes.jsonl`, `cases.jsonl`) plus optional `banned.txt` (one extra banned word per line). Learning a Xiaohongshu URL goes through the Mac Hermes bridge (`POST /xhs-note`), which uses the local Kimi WebBridge session — NAS cannot fetch Xiaohongshu itself.

| Method | Path | Description |
|---|---|---|
| GET | `/api/assets/summary` | Counts plus last 5 saved notes (for backfill) and last 5 reference cases |
| POST | `/api/assets/note` | Save a finished draft `{title, body, tags, style, material, url?}`. Same title+body as the previous row is a no-op |
| POST | `/api/assets/backfill` | `{id, likes, favorites, comments, shares}` → writes `stats` on that draft |
| POST | `/api/assets/learn` | `{url}` Xiaohongshu note link → fetch via Mac bridge, store as a case |
| POST | `/api/assets/case` | Manual case when the bridge is down (`title` / `excerpt` / counts) |

## App update (payload, not the Mac .app)

Compares local `package.json` version with GitHub Releases, and `git fetch` vs upstream. Apply pulls code, `npm install && npm run build`, restarts Node. Refuses inside Docker. Leaves `data/` untouched.

| Method | Path | Description |
|---|---|---|
| GET | `/api/update/check` | `{available, current, latest, reason, docker}` |
| GET | `/api/update/status` | Same plus `stage`, `log`, `error` |
| POST | `/api/update/apply` | Start update (async). Poll status until the server restarts |

## Data Model (SQLite)

Core tables: `account_groups`, `accounts`, `videos`, `comments`, `dm_sessions`, `dm_messages`, plus library metadata tables.

- Composite PKs keyed by `(platform, accountId, objectId/commentId/sessionId)` — platform-agnostic by design.
- `comments.pending` / triage state drives the "待处理" inbox view.
