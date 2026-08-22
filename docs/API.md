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
| DELETE | `/api/accounts/:id` | Remove account |
| DELETE | `/api/groups/:id` | Remove group |

## Comments

| Method | Path | Description |
|---|---|---|
| GET | `/api/comments` | Comments. Query: `platform`, `accountId`, `pending` (1/0), `limit`, `offset` |
| GET | `/api/video/comments` | Comments for a video. Query: `platform`, `accountId`, `objectId` |
| POST | `/api/handled` | Mark comment(s) handled: `{platform, accountId, commentIds[]}` or `{allPending: true}` |
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
| GET | `/api/library/files` | Media files with facet tags, query by facets/type |
| POST | `/api/library/scan` | Scan configured NAS/media directory |
| POST | `/api/upload/file` | Upload a media file (multipart) |
| POST | `/api/upload/draft` | Upload/create a publishing draft |
| DELETE | `/api/library/files/:id` | Remove file (varies) |

> Detailed library API is under active development; check `server/library.js` for the current surface.

## Data Model (SQLite)

Core tables: `account_groups`, `accounts`, `videos`, `comments`, `dm_sessions`, `dm_messages`, plus library metadata tables.

- Composite PKs keyed by `(platform, accountId, objectId/commentId/sessionId)` — platform-agnostic by design.
- `comments.pending` / triage state drives the "待处理" inbox view.
