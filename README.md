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
│  │  Web UI  │   │  Node API + HTML parser  │   │
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

- **Node backend**: native HTTP/SQLite plus Readability, jsdom and URL/robots validation for public-page knowledge collection. Runtime dependencies are installed in Docker.
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
  -e AUTH_TOKEN=change-me \
  creator-inbox
```

Open `http://<host>:8877` — done.

**Environment variables** / 环境变量:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8877` | HTTP listen port |
| `DB_PATH` | `./data/inbox.db` | SQLite file path (created with `chmod 600`) |
| `AUTH_TOKEN` | *(empty = no auth)* | Access token. When set, all `/api/*` requests require `Authorization: Bearer <token>` — the web UI prompts for it once and remembers it. **Strongly recommended on NAS / LAN deployments.** |
| `MEDIA_ROOT` | *(empty)* | NAS media directory for the library scan |
| `THUMB_DIR` | `./data/thumbs` | Generated thumbnails |

### Option B — Local dev

```bash
# Backend / build (Node 22.13+ / 24; see .nvmrc)
node server/index.js            # listens on :8877

# Frontend (Vite + React + TS)
npm install
npm run dev                     # dev server with HMR

# Tests (pure-logic unit tests, zero deps)
npm test
```

### Configure accounts

1. Open the **Settings** tab
2. Add a group (e.g. "My Channels") and accounts per platform
3. Paste the platform cookie (browser cookie for your creator account) — stored locally in SQLite
4. Hit **Refresh** — the collector pulls new videos, comments & DM sessions

> 🔒 Cookies are stored in your local DB only (file created `chmod 600`). This is a BYO-cookie tool: you own the data, you own the credentials. Set `AUTH_TOKEN` to password-protect the API & UI on shared networks.

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
- [x] Tauri desktop shell (v0.2, configurable server URL)
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

## 🔒 Security

Cookies live in SQLite. Set `AUTH_TOKEN` on any shared network. See [SECURITY.md](SECURITY.md).

## 📄 License

MIT — use it, fork it, ship it.

---

## 中文简介

## 增长工作台改造清单（2026-10-18）

目标：以实际登录的来鼓 Pro 为功能参照，保留原有创作工具，逐项实现有持久化、有异常处理、可验证的增长工作台。不是来鼓官方客户端，不复制其私有代码或宣称获得其平台授权。

取证：来鼓 Pro 对话、顾客、AI 员工页面；https://laigu.com/；https://www.chatwoot.com/use-cases/automation-routing；https://developers.intercom.com/docs/guides/fin-agent-api 。

| 编号 | 功能与验收条件 | 状态 |
| --- | --- | --- |
| F01 | 统一接待：导入现有私信/评论，来源可追溯，搜索/渠道/状态筛选，分页，未回复/未分配/人工/AI/完成 | 本地实现并测试；评论回复串与历史时间保留，消息可向前分页 |
| F02 | 会话操作：回复、内部备注、接管/移交、完成/重开；失败不显示成功；幂等发送 | 本地闭环与并发测试通过；崩溃后未确认发送标为未知；视频号真实外发待账号联调 |
| F03 | 顾客：姓名/电话/微信/意向/标签/负责人/阶段，跟进记录、待办、CSV 导出 | 已实现；浏览器验证自动留资和阶段持久化；CSV 防公式注入 |
| F04 | 知识库：创建/编辑/停用、批量导入、分类、检索测试、回答引用、版本与归档 | OCR、公开网页采集和版本管理已验收；本地中文向量、句子分片、后台索引/暂停续建、分页和批量审核、分类范围已实现；规模与真实流程见最新专项记录；API 向量仍仅适配测试 |
| F05 | AI 员工：角色/品牌/话术/限制、渠道范围、上班时间、知识范围、保存和独立预览 | 已实现与浏览器验证；北京时间排班，含跨午夜班次 |
| F06 | AI 接待：真实模型调用、知识约束、信息提取、转人工原因、无依据兜底、接管后不自动回复 | 网页自动接待已通过真实 Hermes → Codex / GPT 调用：知识回答、引用版本、语义意向依据、缺失资料转人工及接管停止均已验收 |
| F07 | 技能：欢迎语、筛选/获线/服务、信息收集、敏感词检查；逐项控制是否启用 | 可配置多轮接待及六类行业模板：专属字段、原话档案、纠正、顾虑分项处理、暂停/恢复、拒绝留资、有效引用延续和人工交接；不是覆盖全部行业的技能矩阵 |
| F08 | 自动化：触发器、条件、分配/打标/跟进动作；执行记录与去重；沉默提醒有停止边界 | 已实现；进线/高意向/沉默触发；已完成/退订取消任务；沉默仅提醒，不自动外发 |
| F09 | 报表：真实会话量、留资、阶段、渠道、每日趋势、首响与筛选，不填造假的增长数字 | 日期/渠道/当前负责人筛选，测试数据开关，平均/中位/P95 首响与 CSV 已实现并浏览器验证；期间阶段事件与当前快照分开统计，不伪造历史漏斗 |
| F10 | 内容与素材：保留笔记/图片/素材库/发布功能，工作台统一入口 | 默认空间文案、审稿、分镜与图片描述共用 GPT 模型设置，不回退 Kimi；品牌背景来自默认员工，不再固定民宿故事；外部生图/发布未联调 |
| F11 | 渠道：现有视频号/抖音适配器复用；网页咨询；小红书/企微等需平台正式授权 | 网页渠道已实现并双端浏览器验收：独立页/嵌入、私有会话、消息回执、人工接管、自愿留资、刷新续聊。社交平台仍只有原视频号采集/回复与抖音评论适配器 |
| F12 | 多坐席：负责人目录、分配记录；独立账号登录、角色权限、组织隔离 | 密码账户、三角色、会话退出/失效、成员管理、工作空间数据与模型密钥隔离已实现；旧平台账号和创作模块仅归属默认空间；无 SSO / 企业身份目录 |
| F13 | 营销卡片：编辑/预览/规则；真实平台卡片格式和发送需平台接口 | 已实现渠道/关键词/高意向触发、排除词、频控、持久化建议、采用/忽略与停用/过期保护；采用仅填入文字草稿供人工发送；未接入平台原生卡片 |
| F14 | 工作流画布：条件分支、等待、工具节点、调试和恢复 | 可视化拖动/端口连线、节点表单、撤销重做、模板、版本冲突和执行轨迹；真实浏览器完成条件分支及重启后一分钟跟进；无任意外部工具 |
| F15 | 桌面：Tauri、内置后端、启动诊断、签名更新、回滚和数据恢复 | 0.6.0 内置 Node / 后端 / 离线检索模型 / 动态网页渲染器；签名更新、故障回滚、完整备份恢复；正式安装与独立原生客户端真实验收，见最新报告 |
| F16 | 模型设置：独立页面、GPT 密钥/模型/接口、连接测试、空间隔离、密钥保护 | API 密钥加密与空间隔离；可选管理员显式启用的本机 Hermes → Codex，默认空间限定、只读凭据；gpt-6.1-sol 真实连接与业务接待通过 |
| F17 | 超大资料与持续来源 | 512 MiB / 200000 条分块导入、断点续传、重启续入、分页复核与默认停用；153.5 MiB / 130319 条真实语料验收；公开 HTML / JSON / PDF、有限深度与周期变更审核 |
| F18 | 本地商品、报价、订单与预约 | 管理员业务台、人民币金额、库存预留/扣减、报价接受转单、时段容量、改期/取消、CRM 关联、幂等/版本/审计；桌面真实流程验收，不执行支付 |
| F19 | 大规模磁盘检索与 AI 只读业务查询 | 超过 5000 条启用知识切换持久倒排与分页精确扫描；130319 条真实语料全部向量化，300374 个 512 维向量；真实 HTTP 压力检索与原生全库扫描；AI 查询可选启用、引用当前版本，无法写入业务 |

测试约束：只对隔离数据库写测试客户；不向真实顾客发测试消息；不在来鼓后台继续保存/启用设置。查看通用模板时来鼓自动创建了一个关闭且无渠道的“小洽 - 精准获客”，未启用。

### 本地验收与运行

当前默认前端为「来客 AI」，原工作台保留在 `/?legacy=1`。新增业务表使用 `growth_` 前缀，团队/会话/模型配置使用 `team_` 前缀，不覆盖原表。默认工作空间兼容旧数据，其余空间使用服务端派生的独立表名。

```sh
npm run build
npm test
npm run preview:growth
```

预览监听 `127.0.0.1:18877`，使用独立数据库，禁止自动采集且不继承环境模型密钥。**在模型设置中保存的本空间密钥会被使用，真实 API 调用可能产生费用。** 默认创建独立临时目录；要复用验收数据：

```sh
GROWTH_PREVIEW_DIR=/Users/xinjiang/Documents/creator-inbox/data/growth-acceptance npm run preview:growth
```

正式桌面已安装到 `/Users/xinjiang/Applications/Laike AI.app`（构建产物另存于 `/Users/xinjiang/wechat-inbox-app/src-tauri/target/release/bundle/macos/Laike AI.app`），采用单独标识 `com.yuejing.laike`，不覆盖旧 Creator Inbox 设置。0.5.0 已内置 Node、业务后端和离线知识模型，不必保持终端运行；每次启动使用仅本机可访问的随机端口与启动票据，不固定为 18877。数据独立保存在 `~/Library/Application Support/com.yuejing.laike/data`。⌘ , 打开维护面板，可安装签名 `.laike-update`、回滚程序、导出安全诊断、创建或恢复完整数据备份。恢复前会再自动保存一份可选的完整备份；备份含加密设置所需的本机密钥，不能公开分享。本线程 `启动来客AI.command` 已改为打开已安装的桌面应用；原预览入口保留为 `启动开发预览.command`，18877 仅用于开发预览，不是正式客户端依赖。

生产运行使用正常的 `node --env-file=.env server/index.js`，不要使用预览脚本。模型配置为 `OPENAI_API_KEY`（或独立 `GROWTH_LLM_KEY`）、`GROWTH_LLM_MODEL`（默认 `gpt-6-astra`）、`GROWTH_LLM_BASE_URL`（默认官方 OpenAI），可由工作空间模型设置覆盖。默认空间的文案、分镜、审稿及图片描述也使用该配置，清空后不回退 Kimi，也不自动读取其他工具的 `.env`。原始通用库函数的兼容接口保留，不改写用户的旧环境文件。实现参考 [OpenAI 文本生成指南](https://developers.openai.com/api/docs/guides/text)，当前使用 Chat Completions；图片描述需要模型支持图片输入。无密钥时保留事实底稿，不伪称模型生成。图片生成服务仍独立配置；未配置时不自动发送到公开演示生图服务。

推荐在「渠道与团队」创建管理员和成员账户。密码使用随机盐与 scrypt 派生，登录会话只在数据库保存哈希，Cookie 为 HttpOnly / SameSite=Strict，12 小时到期。退出、改密、停用、角色变化会注销相应旧会话；最后一名管理员不能停用或降级。首次本机创建管理员后关闭匿名访问。HTTPS 部署设置 `SESSION_COOKIE_SECURE=1`，并妥善配置反向代理。

服务器管理员令牌使用 `AUTH_TOKEN`，可以创建和切换独立空间。普通账户只能访问所属空间；即使提交其他空间标识或记录 ID 也不能越权。默认空间保留旧版渠道和创作接口，其余空间不导入旧平台资料。兼容 `GROWTH_TEAM_TOKENS` JSON 配置（token 至少 24 字符，name、role: operator/viewer、可选 memberId），这些旧令牌只属于默认空间。工作空间隔离经过单元和真实 HTTP 越权测试，但未经独立渗透测试，不应据此宣称达到商业多租户安全认证。

### 模型设置与知识库

- 本机 Hermes 连接默认关闭；管理员设置 `HERMES_CODEX_ENABLED=1` 后，在默认空间选择「本机 Hermes → Codex」、检测当前模型、保存并测试。只读复用已有登录，不复制令牌、不刷新登录、不启动 Agent 工具；登录过期需在 Hermes 重新登录。此模式占用对应账号额度，没有云端向量接口，但可搭配独立的本地中文向量模型。本机双击启动脚本已经显式启用此选项。
- Hermes 适配器使用设备现有的 Codex Responses 连接，仅接受完整完成事件；不是新 SIWC OAuth 注册实现。官方资料：[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。支持范围随 Hermes/服务协议变化，升级后需重新验收。
- 网页采集只处理公开 HTML，遵守 robots/noindex，不使用登录态，不执行脚本；最多当前页及四个同源链接。DNS/重定向均校验公网地址，拒绝本机/内网。若本机代理返回虚拟 DNS，仅用固定 Cloudflare DNS 解析公开域名；正文和完整 URL 不发送给 DNS 服务。采集结果必须校对并确认导入；新建/更新默认停用。暂不支持登录页面、JS 渲染页、PDF URL 与无限深度爬取。
- 打开侧栏「模型设置」，填写 OpenAI API 密钥、GPT 模型 ID、基础接口地址，保存即生效。密钥留空保留原值；清除后不回退环境密钥。其他空间不会继承默认空间的环境密钥。
- 密钥加密存于 SQLite，主加密文件位于数据目录 `.model-encryption-key`（权限 600）。**数据库与此文件必须一起备份**。完整 API 密钥不会回传给页面或写入浏览器存储。服务器管理员或拿到两个备份文件的人仍能解密；这不是硬件密钥托管。
- 连接测试仅向已保存模型发送简短测试消息，可能计费，不发送顾客资料。兼容网关需在 `GROWTH_LLM_ALLOWED_HOSTS` 允许主机；接口禁止重定向及携带 URL 凭据。生产环境仍需网络出口控制。
- 知识导入支持 UTF-8 TXT/MD/CSV/JSON，单次 700 KB、最多 200 条；先预览再保存，重复条目跳过，新增默认停用。归档不删除版本，恢复默认停用；版本号冲突返回 409。
- PDF 在浏览器本地使用 PDF.js 提取文字，最大 10 MB / 80 页；解析器、字符映射和字体随应用提供，不依赖外部 CDN。原 PDF 不上传，只有审核后的文本进入导入接口。扫描页与图片支持本地 Tesseract OCR（简体中文/英文）；单次最多 OCR 20 页，可取消，十分钟超时。加密文件需先解密；错字、数字、复杂表格仍需人工校对。
- 在模型设置独立选择「本地中文向量」「API 向量」或关闭。Hermes 可搭配本地向量，不需要新密钥。本地模式使用固定版本 BGE small 中文模型（512 维、q8），首次建立索引下载约 23 MB 公共文件，知识及查询在本机编码；缓存后查询不联网下载。权重缓存可通过 `GROWTH_EMBEDDING_CACHE` 指定；见 [模型来源、许可与限制](docs/LOCAL-EMBEDDINGS-NOTICE.md)。GPT 接待本身仍会将当轮对话与命中知识发送至已配置的 GPT 服务，不是完全离线聊天。
- 知识库索引每批最多 32 个片段，后台任务持续执行；离开页面不影响任务，可在本批后暂停。服务中断后由用户明确续建，仅处理缺失片段。索引按内容、片段和模型版本失效；停用、归档、员工知识范围即时生效。语义相似度与关键词证据融合排序，显示命中方式、相似度、口语概念扩展及引用版本；弱且难以区分的纯语义候选不返回。相似度不是答案正确率，门槛需要使用实际业务校准。失败明确回退关键词，不伪装语义命中。只有选择 API 向量时才将相应文本发往配置接口并可能计费。参考 [OpenAI Embeddings 接口](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。
- AI 员工可启用「多轮销售接待」（需同时开启信息提取），配置目标、必需字段、逐字段追问、异议规范和 2–30 轮上限。仅保存顾客当轮原话支持的需求；不重复追问已知、已问或拒绝字段。客户确认后转人工并创建一条跟进待办，不自动预约或成交。接待右栏可查看档案、原话、轨迹和交接摘要；先人工接管才能重置档案，旧聊天和轨迹不删除。

### 已执行的验收

0.6.0 本轮完成 **191 项业务自动检查和 5 项桌面检查**，并已实际更新正式客户端。新增四区知识库布局、就地版本侧栏、沙箱动态网页与真实持续复查；130319 条语料全部生成 300374 个真实向量，并在隔离原生客户端完整扫描和命中。压力复验结果、数据保留校验及性能边界见 [动态网页、全量向量与布局验收](docs/acceptance-dynamic-full-vectors-2026-10-18.md)。

以下 107/114 项记录为较早轮次。[OCR、网页与流程验收](docs/acceptance-2026-10-18.md) 为 125 项，[多轮销售与本地向量验收](docs/acceptance-sales-vector-2026-10-18.md) 为 141 项，[多行业与规模验收](docs/acceptance-industry-scale-2026-10-18.md) 为 162 项，并包含六行业 48 次真实 GPT 调用。最新 [本地能力收口验收](docs/acceptance-local-completion-2026-10-18.md) 为 179 项业务自动回归及 5 项桌面套件，包含 13 万条真实语料倒排、真实 BGE 磁盘扫描、只读业务 GPT、原生订单预约与大库备份恢复；[大文件与持续来源报告](docs/acceptance-large-sources-2026-10-18.md) 单列真实上传续传、入库重启、公开网页实际定时同步和 PDF。不同性质的验收不互相替代。

- `npm run build`：TypeScript 检查与前端生产构建通过。
- `npm test`：107 项测试通过，含账户/空间越权、跨站请求、注销、密码重置、密钥加密/隔离、导入/版本恢复、向量检索/缓存失效、知识更新竞态、报表口径、卡片频控/失效等；没有向真实客户发送测试消息。向量与连接测试使用模拟模型服务，未消耗真实模型额度。
- `npm audit`：当前依赖审计无已知漏洞；构建工具升级至 Vite 7.3.7。这不等于完成渗透测试或所有应用安全审计。
- 浏览器：只读账号禁用所有业务写入；CSV 导入去重与版本历史、PDF 提取/预览/停用保存、报表测试数据开关与无样本显示均通过。
- 浏览器：模型设置保存后刷新仍保留，卡片规则实际触发并可采用为未发送草稿；均使用隔离验收数据，无真实密钥或顾客外发。
- 浏览器：新增知识 → 检索 → 保存启用流程 → 测试咨询 → 自动留资/打标/待办 → 采用知识回复 → 修改为已预约，整条链路通过。
- 服务重启：知识、流程、会话、客户阶段和任务保留；桌面版读取到同样的真实验收记录。
- 原内容创作页：无模型模式起草与本地草稿恢复通过。未验证真实付费生图或发布。

### 2026-10-18 全流程复查与样式改进

本轮使用新建的隔离数据库、合成账号及本地模拟模型端点；没有修改主工作空间密钥，也没有向真实客户发送消息。

- 接待闭环：切换顾客保留各自的内存草稿；异步建议不会串到另一段会话；卡片和 AI 建议不覆盖现有草稿。相同草稿重试复用请求标识，内部备注也支持去重。页面重载前提示未发送草稿，重载后不持久保存敏感草稿。
- AI 接管：交回 AI 会处理尚未回复的消息，但不会重复回答人工已处理的消息。欢迎语不算业务问题已回答；模型故障保留顾客消息并转人工。
- 生命周期：退订后的后续消息不会重新进入待回复；已退订或完成会话不能复活跟进任务；停用负责人不再接收新分配；无效测试会话不会留下空记录；错误的流程渠道被明确拒绝。
- 本地 HTTP 全链路测试覆盖保存加密模型设置、连接测试、向量建索引、知识检索、欢迎语和业务回复、人工接管/交回、卡片采用不外发、自动任务、客户阶段、报表以及模型失败和退订。模拟结果不代表真实 GPT 服务质量或外部平台可用。
- 评论页不再沿用私信详情；接待默认滚到最新消息，同时保留用户向上阅读历史的位置。旧创作的离线底稿仅保留输入素材，不再插入固定民宿故事和未经提供的话题。
- 视觉与可用性：提高辅助文字对比度和字号，统一表单间距、按钮与状态标签；侧栏固定底部设置入口、内部独立滚动；窄屏使用单列会话与返回入口，顾客档案可主动展开。已检查 1280 像素主浏览器、桌面客户端，以及 960/390 像素隔离容器的导航和会话列表；尚未进行真实手机设备测试或完整无障碍认证。
- 界面更新：构建生成 `build.json`，已打开页面检测到新构建后提示用户主动载入；不会强制刷新未保存编辑。浏览器实测更新提示与载入成功；不存在的静态资源返回 404，不再伪装成 HTML 成功响应。现有桌面客户端已重新载入本轮界面。
- 接待请求增加输出 token 上限，参数依据 [OpenAI Chat Completions 官方参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)；仍需用用户实际可用的模型 ID 和密钥进行真实连接验收。

复查后 TypeScript、生产构建、107 项测试与完整 `npm audit` 均通过。未修改原有 `docs/specs/2026-08-23-note-tab-handoff.md` 的用户编辑和 Markdown 行末空格。

### 未完成项与上线边界

本版本是可运行、可测试的本地业务实现，**不是来鼓全部商业能力等价产品**。本地清单、容量和逐项证据见 [收口清单](docs/remaining-local-completion.md) 与 [动态网页及全量向量验收](docs/acceptance-dynamic-full-vectors-2026-10-18.md)。13 万条已经全部向量化，但原问题命中不等于语义泛化或生产 SLA；中英专项回归不等于所有语言和行业质量认证；全量精确扫描不是 ANN，超大库查询不是即时响应承诺。公开来源提供独立沙箱 JavaScript 渲染，不绕过登录、robots、验证码与反爬，超出资源/时间预算的页面会明确失败。社交平台授权/原生卡片/自动外发、外部 CRM / 库存 / 支付、SSO、模型/生图额度及公网部署、可信发布渠道、生产安全审计仍需相应账户或环境。桌面已内置后端，本地库存订单和业务统计可独立使用，但不冒充平台交易或收款流水。

### 2026-10-18 继续补齐：真实网页渠道、工作流接待与统一 GPT

对照 [来鼓增长获客 Agent](https://laigu.com/agent/growth) 的接待、留资和交接能力补齐本地链路。官网旧「智能任务指南」链接已失效，新的飞书帮助入口要求登录；不将搜索摘要当成完整功能规格。

- 渠道与团队 → 网页咨询：配置标题、开场说明、接待员工、人工/AI/工作流模式、每日消息上限、嵌入来源；生成独立链接及 iframe 代码。默认关闭，不自动暴露公网服务。
- 访客随机 256 位凭据只授予单一会话访问权，数据库仅存哈希，7 天到期；不使用团队 Cookie。请求来源检查、iframe 来源限制、会话/消息限流、北京时间每日配额、幂等进线；备注、客户档案和内部事件不返回访客。
- 网页消息持久化，客服发出后标为等待访客接收，收到客户端回执才标为已接收（不是已读）。支持断线重试、服务重启后续聊、分页取回历史、自愿留资及人工接管。回复明确区分知识库、模型、人工和工作流。
- 工作流「发送回复」仅用于明确选择的网页/测试渠道；网页必须选择工作流接待，不能同时开启 AI。内容与执行检查点同一数据库事务提交，不因重启重复发送。人工接管、退订、停用渠道阻止发送；孤立节点和错渠道运行直接报错。等待时间由真实服务定时器检查，不通过修改测试时钟来冒充浏览器联调。
- 内容创作、审稿、分镜、图片描述统一读取已保存的 GPT 配置，并传入默认员工品牌背景。实际密钥仍为空，因此只验证配置传递和失败/离线边界，没有声称真实 GPT 已调用成功。
- 实际浏览器验收使用独立本地服务和合成访客：访客提问 → 知识库回复 → 转人工 → 自愿留资 → 工作台人工回复 → 刷新续聊 → 退订；页面不是沙箱进线表单，消息通过公开访客端接口和数据库来回传递。未对外部客户发送消息。
- 浏览器实际创建「发送回复 → 等待 1 分钟 → 发送回复」流程，切换工作流接待后由新网页访客触发；首条回复和一分钟后的后续回复都出现在访客页面，执行记录为 3 步已完成。新增真实 HTTP 测试还重启了服务进程，验证会话凭据、历史回复与回执能恢复，访客凭据不能访问团队接口。
- 该轮历史检查：114 项测试通过，TypeScript 与生产构建通过，生产依赖审计 0 个已知漏洞。该轮模型断言使用可控响应检查参数和配置隔离；后续真实 GPT 和向量验收见上方最新记录。保留了既有无关编辑；未提交或推送 Git 变更。

正式上线前，必须部署 HTTPS、配置管理员认证与反向代理、说明业务隐私规则，并对公开入口增加网关级限流/监控。当前只在本机验收，未宣称完成互联网安全审计或公网部署。

**Creator Inbox** 是一个面向内容创作者的**自托管聚合收件箱**:把视频号、抖音的**评论和私信**聚合到一个界面,按"待处理优先"梳理;同时管理**视频素材库**(NAS 扫描、分面标签、预览);并逐步支持**发布辅助**。Node 后端 + SQLite,数据全在自己手里,Docker 一键部署,可选 Tauri 桌面壳。适合有多平台账号、在意数据隐私的独立创作者与小型工作室。

> 申请 Codex for Open Source 的说明:本仓库由一名独立开发者维护,工具源于真实的民宿短视频运营需求(多平台账号互动 + 素材生产),在迭代中持续重构为通用创作者工具。维护者将用 ChatGPT Pro + Codex 改进 PR review、issue triage、测试覆盖与文档,让开源版更快稳定。

### 2026-10-18 多行业与规模知识增强

- AI 员工增加住宿、零售、上门服务、成人课程、企业软件、体验活动六个模板，另保留通用接待。模板只替换接待目标、字段和追问，必须保存后才生效，不改品牌、知识范围、渠道或启用状态。行业边界不等于库存、排期或外部执行能力。
- 知识范围支持按分类限定，自动包含该分类后续启用资料；与逐条选择同时使用时取交集。逐条范围上限 500，页面搜索仅展示前 50 条，避免渲染数千个复选框。
- 知识列表每页 50 条，正文按页读取；批量启用、停用、归档、恢复有选中范围确认和版本冲突检查，恢复默认停用。单次文件导入仍限制 700 KB / 200 条，可分批导入，不宣称一次无限量导入。
- 索引任务持久化进度，后台分批执行、暂停、失败重试和服务中断后手动续建；模型配置改变时拒绝旧任务结果。本地句子分片升级后须重新建立待处理索引，不改原文或历史版本。
- 精确向量扫描复用归一化缓存，配合关键词倒排索引、行业口语概念扩展、编号匹配及低置信拒答；每 512 片段让出执行时间。不把这些优化称为 ANN，也不承诺百万级容量或生产 SLA。
- 多轮接待保留经过当前版本、启用状态和员工范围复核的历史引用，避免暂停/恢复后误撤回先前正确介绍；解决价格顾虑不会清空其他未解决顾虑。
- 明确排除的项目单独存入补充限制，不再覆盖原有核心需求；同轮交接也保留排除项、顾客原话与摘要。明确撤回原值或后续重新选择同一项目分别处理，不凭猜测替换需求。
- 专项证据与局限见 [多行业与规模验收](docs/acceptance-industry-scale-2026-10-18.md)。验收数据为隔离合成资料，未导入主空间；原有主数据先备份，未启用真实平台自动外发。
