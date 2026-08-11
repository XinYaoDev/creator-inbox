# Creator Inbox 📥

> **All your creator conversations in one self-hosted inbox.**
> 视频号 / 抖音 评论 + 私信聚合 · 素材库管理 · 发布辅助 —— 一个自托管的创作者工作台

Aggregate comments & DMs across WeChat Channels (视频号) and Douyin (抖音), manage your video asset library, and streamline publishing — all in one self-hosted tool. Built for content creators who want their **audience conversations and production assets in one place, under their own control**.

---

## ✨ Why Creator Inbox?

Creators today juggle: comments scattered across platforms, DMs buried in apps, assets spread across folders, publishing done by hand. Existing tools are either cloud SaaS (data leaves your hands, per-seat fees) or single-platform.

**Creator Inbox** gives you:

| Pain point | Solution |
|---|---|
| Comments & DMs scattered across platforms | Unified inbox with **platform adapters** (视频号 + 抖音 today, add more in ~100 lines) |
| Never knowing what needs a reply | **Pending-first triage** — unread comments/DMs float to top, marked done when handled |
| Assets lost in folders | **Media library** — NAS scan/upload, facet tags (主题/人物/场景), preview & search |
| Publishing is manual | Publish-assist workflows (pilot) |
| Data privacy | **100% self-hosted** — Docker one-liner, SQLite, no cloud dependency |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│              Creator Inbox                  │
│                                             │
│  ┌──────────┐   ┌───────────────────────┐   │
│  │  Web UI  │   │  Node API (zero-dep)  │   │
│  │  React   │◄─►│  node:http + SQLite   │   │
│  └──────────┘   │  + collector cron     │   │
│                 └──────────┬────────────┘   │
│                            │                │
│  ┌─────────────────────────▼─────────────┐  │
│  │  Platform Adapters (pluggable)        │  │
│  │  wechat (视频号)  ·  douyin (抖音)     │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
        ▲ self-hosted · Docker · SQLite · no cloud
```

- **Zero-dependency backend**: only Node.js built-ins (`node:http`, `node:sqlite`, global `fetch`) — no npm runtime deps, easy to audit and deploy.
- **Pluggable platform adapters**: each platform is one module. Adding a new platform = adding one adapter file.
- **SQLite persistence**: comments, DMs, sessions, videos, accounts all in one `.db` file. Backup = copy the file.
- **Optional Tauri desktop shell**: windowed app that connects to your NAS-hosted instance.

## 🚀 Quick Start

### Option A — Docker (recommended for NAS/home server)

```bash
docker build -t creator-inbox .
docker run -d -p 8877:8877 \
  -v /path/to/data:/app/data \
  -v /path/to/assets:/media \
  -e PORT=8877 \
  creator-inbox
```

Open `http://<host>:8877` — done.

### Option B — Local dev

```bash
# Backend (Node 22+, zero npm install needed for server)
node server/index.js            # listens on :8877

# Frontend (Vite + React + TS)
npm install
npm run dev                     # dev server with HMR
```

### Configure accounts

1. Open the **Settings** tab
2. Add a group (e.g. "My Channels") and accounts per platform
3. Paste the platform cookie (browser cookie for your creator account) — stored locally in SQLite
4. Hit **Refresh** — the collector pulls new videos, comments & DM sessions

> 🔒 Cookies are stored in your local DB only. This is a BYO-cookie tool: you own the data, you own the credentials.

## 🖼️ Features

### 📥 Unified Inbox (comments + DMs)
- Comments from all platform accounts, newest first, one view
- DM sessions with per-conversation context
- **Pending-first**: triage what needs a reply; mark done; filter by platform/account
- Search across comments & messages

### 🎬 Media Library
- NAS directory scan + upload
- **Facet tagging**: multiple tag dimensions (主题 / 人物 / 场景 / 精选) for fast retrieval
- Thumbnail generation & preview (via ffmpeg, included in Docker image)
- Video metadata extraction

### 🚀 Publish Assist (pilot)
- Publishing workflow scaffolding tied to your library — pick assets, prepare captions, queue for manual publish

## 📡 API (subset)

| Endpoint | Description |
|---|---|
| `GET /api/status` | Collection status & counts |
| `GET /api/videos` | Videos across accounts |
| `GET /api/comments` | Comments (filter by platform/account, pending) |
| `GET /api/sessions` / `GET /api/messages` | DM sessions & messages |
| `GET /api/library/files` | Media library files with facets |
| `POST /api/accounts/:id/cookie` | Update account cookie |

Full API documented in [`docs/API.md`](docs/API.md) *(in progress)*.

## 🗺️ Roadmap

- [x] Comments & DM aggregation (视频号 / 抖音)
- [x] Pending-first triage
- [x] Media library with facet tags (v1)
- [x] Docker + NAS deployment
- [x] Tauri desktop shell (v0.1)
- [ ] Publish API integration (scheduled uploads)
- [ ] More platform adapters (Bilibili, Xiaohongshu, YouTube)
- [ ] Comment sentiment / fan-relationship analytics
- [ ] Team mode (multi-operator inbox)

## 🧱 Tech Stack

- **Backend**: Node.js (zero runtime deps) + `node:sqlite` + `node:http`
- **Frontend**: React 18 + TypeScript + Vite
- **Desktop**: Tauri 2 (Rust shell, optional)
- **Data**: SQLite, single file
- **Deploy**: Docker (with ffmpeg for media thumbnails)

## 📄 License

MIT — use it, fork it, ship it.

---

## 中文简介

**Creator Inbox** 是一个面向内容创作者的**自托管聚合收件箱**:把视频号、抖音的**评论和私信**聚合到一个界面,按"待处理优先"梳理;同时管理**视频素材库**(NAS 扫描、分面标签、预览);并逐步支持**发布辅助**。零依赖 Node 后端 + SQLite,数据全在自己手里,Docker 一键部署,可选 Tauri 桌面壳。适合有多平台账号、在意数据隐私的独立创作者与小型工作室。

> 申请 Codex for Open Source 的说明:本仓库由一名独立开发者维护,工具源于真实的民宿短视频运营需求(多平台账号互动 + 素材生产),在迭代中持续重构为通用创作者工具。维护者将用 ChatGPT Pro + Codex 改进 PR review、issue triage、测试覆盖与文档,让开源版更快稳定。
