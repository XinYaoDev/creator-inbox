# 做笔记页 · 实现说明（交接用）

日期：2026-08-23  
仓库：`/Users/xinjiang/Documents/creator-inbox`（GitHub `XinYaoDev/creator-inbox`）  
生产：NAS Docker `wechat-inbox`，`http://192.168.31.126:8877`  
本文档描述**当前已上线的实现**，给另一位 AI 做评审 / 改需求用。不依赖本会话上下文。

---

## 0. 产品一句话

帮浙江宁海海边民宿写一条小红书图文：用几句现场事实起草客人口吻的正文，拆成 6 张图，每张图优先从素材库里挑实拍，不够再生成。

核心抽象：**图片是资产（素材库），笔记是引用（`data/notes/` 里的副本），描述由 Kimi 写，查询用人话。**

---

## 1. 页面在整个 App 里的位置

侧栏 Tab：收件箱 / **做笔记** / 素材库 / 发布 / 设置。

做笔记页组件：[`src/components/NoteTab.tsx`](../../src/components/NoteTab.tsx)  
选图弹层：[`src/components/PhotoPicker.tsx`](../../src/components/PhotoPicker.tsx)  
样式：[`src/style.css`](../../src/style.css)（墨纸风：纸 `#FAFAF7` / 墨 `#0A0A0A` / 线 `#E5E5E0` / 灰 `#8A8A85` / 黄 `#FBE122`，零圆角零阴影）

页内两个「房间」，同一组件切换，不换路由：

| room | 入口 | 干什么 |
|---|---|---|
| `write`（默认） | 打开做笔记 | 写一条笔记：素材 → 文案 → 镜头清单 → 配图 |
| `stock` | 工具条「囤参考」 | 贴小红书链接进参考堆；回填自己发过的赞藏评 |

工具条（write）：左「囤参考」，右「再做一条」（二次确认后清空）。  
草稿存在浏览器 `localStorage` 键 `note_draft`，刷新不丢。

---

## 2. 主路径（write）用户流程

左栏始终是文章。右栏三态互斥：还没拆镜头 / 镜头清单 / 六宫格配图。文案、镜头、配图环环相扣但互不自动冲掉。

```
今日素材
    │
    ▼ 主按钮「起草笔记」→ POST /api/notes/draft
标题 + 正文 + 话题（改标题正文不会重拆镜头）
    │
    ▼ 主按钮「拆镜头」→ POST /api/notes/storyboard
右栏出现镜头清单（只要 want，没有缩略图）。可改、换序、删、加（最多 6）。
「再写一版」只改文案。「重新拆镜头」才按当前正文再调 storyboard（已有图会二次确认）。
    │
    ▼ 主按钮「定这组镜头」→ shotsLocked=true，按 want 刷新 prompt
这时才出现六宫格。⋯「改镜头」回到清单，已放入的图按 id 挂着。
    │
    ▼ 主按钮「补齐 n 张图」→ 缺图的 slot 调 generate-one
    │
    ▼ 主按钮「复制全文」
```

主按钮（`primary`）：

1. 进行中：`stage`，disabled  
2. 无 seed：「起草笔记」，disabled  
3. 还没正文：「起草笔记」  
4. 有正文、无清单：「拆镜头」  
5. 有清单、未锁定：「定这组镜头」  
6. 已锁定、缺图：「补齐 n 张图」  
7. 满图：「复制全文」

`shotsLocked` 存在 `note_draft`。旧草稿若已有 `imageId` 视为已锁定。

次按钮：有正文时「再写一版」（不动镜头）。lint / fallback 提示不变。配图 `⋯` 里才有「再出这一组」。不在文案阶段放「先放一张」。

左边三栏：今日素材 / 标题 / 正文。标题可先手写方向，起草成功后会被模型标题覆盖（`if (r.title) setTopic`）。话题标签是 chip，点一下去掉；服务端最多 8 个，localStorage 读回最多 12 个。字数只在有正文时显示在标题行右侧。

未拆镜头时，右边一句提示，无宫格。拆完未锁定时是清单，不是格子。

---

## 3. 右侧：镜头清单 / 配图

### 3.1 六宫格

仅 `shotsLocked` 时渲染宫格（CSS `.note-board`）。格数等于已定镜头（1–6），不补空壳。服务端 `normalizeSlots` 最多 9 张，拆镜头时前端只收 6 张。

布局：`.note-layout` = `minmax(0,1.15fr) minmax(260px,0.85fr)`，800px 以下叠成一列。

每格：

- 有 `imageId`：缩略图，来源 `GET /api/notes/file?id=`（笔记目录副本，不是库原图）  
- 无图：浅底 + 角色名  
- 左上角小标签：封面 / 图2…  
- 点格：选中（再点取消）。选中或该格有 `error` 时，**格子下方**出现详情，不同时摊开 6 张大图。

### 3.2 选中后的详情（一个 slot）

从上到下：

1. 角色 + 一句摘要（error / want 前 28 字 /「已放图」）  
2. `want` 文本框：「这张要出什么」  
3. **推荐条**（`GET /api/library/suggest?q=<want 或 role>&limit=3`）  
   - 打开某格且有查询词就拉（**有图也会拉**，用来换图）  
   - 按 `slotId|query` 缓存；`want` 改了 500ms 后重拉  
   - **点推荐缩略图 → 立刻替换该格**（`POST /api/notes/from-library`）  
   - 「更多」打开 PhotoPicker，搜索框预填 want  
4. 主操作：放一张 / 换一张、用这张生、拿掉  
5. 次操作：出图提示词、再出几张、存进库  
6. 展开后的英文 `prompt`  
7. 生成变体小图（`variants[]`），点一张把 `imageId` 换成它  

### 3.3 Slot 数据

```ts
type Slot = {
  id: string          // 通常 s1…s6
  role: string        // 封面 / 图2…
  want: string        // 给人看的中文
  prompt: string      // 给模型的英文
  imageId?: string    // 当前展示图（笔记目录 id）
  photoId?: string    // 实拍底图 id；有它 = 这张来自库/上传，不是纯生成
  variants?: string[] // 同格多次生成的候选
  error?: string
}
```

语义：

- 从库放入或本机上传进库再放入：`imageId === photoId`  
- 「用这张生」（img2img）：生成结果写入 `imageId` / `variants`，**保留 `photoId`**（还能再拿原图生）  
- 纯 txt2img：只有 `imageId`，无 `photoId` → 可「存进库」  
- 「拿掉」：清 `imageId`、`photoId`、`variants`（仅当有 photoId 时按钮出现）

「重新拆镜头」按当前正文重出清单，不保留旧图。「改镜头」退回清单，图按 slot id 挂着。

---

## 4. 选图：素材库弹层 PhotoPicker

打开条件：找实拍 / 换实拍 / 更多（配图阶段）。

布局：左专辑列表（由 `file_path` **前端**推导，不打 tag），右缩略图。  
专辑规则（`albumOf`，与 `server/caption.js` 的 `albumFromPath` 对齐）：

- 去掉文件名  
- 丢掉叶子目录：`精选照片` / `人物照片` / `预览图`（可带 `NN_` 前缀）  
- 去掉当前叶的 `NN_` 前缀 → 专辑名（民宿经营、餐桌成品菜…）

行为：

- 顶上搜索框：有字则 `GET /api/library/suggest`（300ms 防抖），格子改显示搜索结果；点左侧专辑会清空搜索  
- 空搜索：按专辑滤本地已拉的 `GET /api/library/assets?type=image&limit=500&sort=time`  
- **点一张缩略图立即** `useAsset` → `POST /api/notes/from-library {id}`，成功后 `onPick(imageId)` 写入当前格并关弹层  
- `source=ai` 的图左上角 `AI` 角标  
- 底栏「从这台上传到库」：可多选；`POST /api/library/upload?filename=`（body 为原始字节）循环上传，然后只把**最后一张** from-library 放进格  
- 组件里仍有 `picked` state 和底部预览区（「放到这个图位」按钮），但点缩略图**不再** `setPicked`，预览区恒为「点一张就换上去。」这是死代码，评审时可删。

`from-library`：把库文件 **复制** 成 `data/notes/{新imageId}.jpg`（新 12 位 uuid 前缀），笔记只引用副本。库资产 id ≠ 笔记 `imageId`。推荐条点选走同一条路：`placeCandidate(slotId, 库id)`。

---

## 5. 出图

提供方优先级（`imageProvider()`，[`server/notes.js`](../../server/notes.js)）：

`NOTE_IMAGE_PROVIDER` 强制 > `HERMES_IMAGE_URL`（hermes）> FAL > SiliconFlow > OpenAI > pollinations 演示源。

生产 NAS `.env` 配了 Hermes：Mac LaunchAgent 桥 `scripts/hermes-image-bridge.py`，默认 `http://<Mac>:8879`。

| 动作 | 请求 | 行为 |
|---|---|---|
| 主按钮出图 | 缺图的 slot 各 `generate-one`，`n=1`，无 `imageId` | 纯 txt2img；失败写 `slot.error`，最后抛「封面、图3 没出成」 |
| 再出这一组 | 同上，但 target = **全部 slot** | 会覆盖已有图；**不保留 photoId 语义**（只改 `imageId`/`variants`） |
| 用这张生 | `generate-one` + `imageId = photoId \|\| imageId`，`n=1` | Hermes img2img；其它 provider 会 400「图生图目前只走本机 Hermes」 |
| 再出几张 / 这张重试 | 仅 `!photoId` 时显示；`n=3` | Hermes 服务端强制 `n=1`；结果进 `variants`，第一张当当前图 |

`generate-one` 服务端：`n` clamp 到 1–4，默认 3；provider 是 hermes 则一律 1。参考图从 `data/notes/{imageId}.jpg` 读，base64 放进桥 `POST {HERMES_IMAGE_URL}/generate`，`aspect_ratio: 'portrait'`，超时 240s，失败重试 1 次。结果太小（<800 bytes）当失败。

主路径出图**不会**把实拍当底（不传 `imageId`）。要 img2img 必须点「用这张生」。

生成文件只活在 `data/notes/`。好的生成图可「存进库」。

---

## 6. 素材库与「人话搜图」（做笔记的地基）

库不在笔记页里维护，但选图 / 推荐依赖它。

### 6.1 存储

SQLite `media_assets`（`server/library.js`）：

- `source`：`nas`（扫 MEDIA_ROOT）/ `upload` / `ai`（从笔记存回）  
- `file_path`、`thumb_path`、`file_type`、`shoot_time`  
- `ai_caption`、`ai_keywords`、`captioned_at`（Kimi 视觉描述）  
- 另有分面标签表（内容主体/场景/…/精选主题）。**图片几乎没打过标**；精选主题目前主要在视频上。做笔记选图 **不靠这套 tag**。

约 215 张图 + 874 条视频。描述回填曾跑过一部分后被用户叫停；已写上的 caption 仍在库里（大约一百张级）。可在素材库点「补描述」继续，跑着可「停下」。

### 6.2 自动描述

[`server/caption.js`](../../server/caption.js) + [`server/llm.js`](../../server/llm.js)：

- 看图用 **同一套 Kimi key / 同一套 k3**（`visionConfig()` = `llmConfig()`，默认模型 `k3` 或 `NOTE_LLM_MODEL`）  
- **不要**用 `moonshot-v1-8k-vision-preview` + `api.moonshot.cn`：NAS 的 `KIMI_API_KEY` 是 coding 端点，那边会 Invalid Authentication；且该视觉模型 2026-08-31 下线  
- 上传 / 扫描新图：异步 caption，失败不挡入库  
- 回填：`POST /api/library/caption-backfill`，串行，间隔 ≥500ms；`POST /api/library/caption-stop` 取消  

### 6.3 suggest 打分（无向量）

`GET /api/library/suggest?q=&limit=&type=image`  
内存扫全部 indexed 图片：

- keyword 是查询子串：+3 / 个  
- caption 与 q 的公共 2-gram：+1 / 个，上限 +6  
- `original_tags` 或专辑名命中：+2  
- 已有内容分后，`nas`/`upload` 再 +1（实拍排 AI 前）  
- 总分 0 丢弃；同分按 `shoot_time` 降序  

`GET /api/library/assets?q=` 的 LIKE 已扩到 `file_path / original_tags / ai_caption / ai_keywords`。  
`captioned=1` 只列已有描述。

### 6.4 生成图回库

`POST /api/library/save-note-image` `{imageId, caption?, keywords?}`  
把 `data/notes/{imageId}.jpg` 拷到 upload 目录 `ai_{imageId}.jpg`，`source=ai`。同路径幂等。

---

## 7. 文案引擎

### 7.1 口吻与套式

System 口吻 `VOICE`：刚住完的客人，不是老板。可写赶海/小青龙/白蟹/院子/客房/包吃住；禁欢迎预订、私信老板、性价比、家人们冲等。

套式 `STYLES`：提问互动 / 情绪出片 / 周末游记 / 探路攻略 / 纠正想象。  
`pickStyle(material, topic)` 用正则选套式，默认情绪出片。

### 7.2 起草 `composeDraft`（服务端，用户点一次「起草」就会跑完）

1. `pickStyle(material, topic)` 正则选套式，默认情绪出片  
2. `assets.exemplarsFor(style)` 取同套式高赞藏例文进 system；失败不影响起草  
3. `chatJson`（`llmConfig()`：KIMI / MOONSHOT / DEEPSEEK / OPENAI；生产 k3 + `reasoning_effort=low`，超时 180s）出 `{title,body,tags}`  
4. `runLint`：`TITLE_BANNED` / `BODY_BANNED` + `banned.txt` 附加词 + 再调一次 LLM 审（审失败只留正则）  
5. lint 不过：**服务端自动改最多两轮**（`rewriteUser`），`rewritten=true`  
6. 无 key 或抛错：`asDraft`/`fallbackDraft` 本地底稿，`fallback:true`；接口仍 `ok:true`  
7. `assets.recordMaterial` 追加 `data/assets/materials.jsonl`

UI「按这个改一版」是**额外**的一轮：`POST /api/notes/lint {rewrite:true}`，只改一次。

K3 超时 180s，其它模型 60s。标题禁：整栋/包吃住/首选/性价比/欢迎/8-18人。正文禁：欢迎预订/私信/微信/滴滴我/家人们冲/封神/天花板/全网最低/最便宜/性价比超高。

### 7.3 拆图

要模型返回 6 项 JSON：`role, want, prompt`。失败用 `fallbackStoryboard`（6 张固定中文 want + `buildImagePrompt`）。

---

## 8. 囤参考（stock）

不在写字桌上。

- 贴小红书 URL → `POST /api/assets/learn` → NAS 调 Mac Hermes 桥 `POST /xhs-note`（WebBridge 抓正文，localhost 需关 HTTP 代理）→ 存 `cases.jsonl`  
- 列表：最近 case（标题、套式、赞藏）  
- 回填：选一条自己存过的成稿，填赞/藏/评 → `POST /api/assets/backfill`  
- 起草时例文来自这些 case，不在写桌展示计数或「用这些写一条」

资产文件：`data/assets/materials.jsonl`、`notes.jsonl`、`cases.jsonl`、`banned.txt`。实现 [`server/assets.js`](../../server/assets.js)。

---

## 9. API 一览（做笔记相关）

### 笔记 `server/notes.js`

| 方法 | 路径 | 入参 | 出参要点 |
|---|---|---|---|
| GET | `/api/notes/status` | | `{llm, model, image}` |
| POST | `/api/notes/draft` | `{material, topic}` | `{title, body, tags, style, lint, rewritten, fallback}` |
| POST | `/api/notes/lint` | `{title, body, material, style, tags, rewrite?}` | `{lint, title, body, tags, rewritten}` |
| POST | `/api/notes/storyboard` | `{topic, body}` | `{slots[], fallback}` |
| POST | `/api/notes/generate-one` | `{prompt, want?, imageId?, n}` | `{imageIds[], provider}` |
| POST | `/api/notes/generate` | `{slots}` | 批量（UI 主路径已改走 generate-one） |
| POST | `/api/notes/from-library` | `{id}` 库资产 id | `{imageId}` |
| POST | `/api/notes/upload` | 原始图字节 ≤8MB | `{imageId}`（现主路径不直接用，改走库） |
| GET | `/api/notes/file?id=` | | 笔记目录图片 |

### 库（选图/推荐）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/library/assets` | `type, source, q, tag, sort, limit, captioned` |
| GET | `/api/library/suggest` | 人话打分检索 |
| POST | `/api/library/upload` | `?filename=` + raw body |
| POST | `/api/library/save-note-image` | 生成图入库 |
| POST | `/api/library/caption-backfill` / `caption-stop` | 补描述 / 停下 |
| GET | `/api/library/caption-status` | `{running, done, total, errors}` |
| GET | `/api/library/thumb?id=` / `file?id=` | 缩略图 / 原图 |

### 资产

见 `docs/API.md`：`/api/assets/summary|note|learn|backfill|case`。

鉴权：若设 `AUTH_TOKEN`，`Authorization: Bearer` 或 `?token=`（给 `<img>`）。

---

## 10. 文件地图

| 文件 | 职责 |
|---|---|
| `src/components/NoteTab.tsx` | 做笔记页全部 UI 与状态 |
| `src/components/PhotoPicker.tsx` | 选图弹层、专辑、搜索、点选即放入 |
| `src/LibraryTab.tsx` | 素材库（补描述、已描述筛选、扫描上传） |
| `src/style.css` | 含 `.note-board` / `.note-cell` / `.note-picker*` |
| `src/api.ts` | fetch + token |
| `server/notes.js` | 起草/审/拆图/出图/from-library |
| `server/llm.js` | `llmConfig` / `visionConfig` / `parseLlmJson` |
| `server/caption.js` | 视觉描述、suggest 打分、回填任务 |
| `server/library.js` | 库 CRUD、扫描、上传、suggest 路由 |
| `server/assets.js` | 三池 JSONL |
| `server/index.js` | 挂载；`readLibraryImage` / `readNoteImage` 互拷 |
| `scripts/hermes-image-bridge.py` | Mac 出图 + `/xhs-note` |
| `docs/specs/2026-08-23-image-loop-design.md` | 搜图/推荐/描述闭环的设计原文 |
| `server/tests/notes.test.js` | 起草/套式/lint/拆图兜底 |
| `server/tests/caption.test.js` | 描述解析、打分、visionConfig |

---

## 11. 环境变量（生产 NAS `/data/.env`）

已在用：`KIMI_API_KEY`、`NOTE_LLM_BASE_URL`（`https://api.kimi.com/coding/v1`）、`NOTE_LLM_MODEL`（`k3`）、`NOTE_IMAGE_PROVIDER` / `HERMES_IMAGE_URL` / `HERMES_IMAGE_TOKEN`。

可选：`LIB_VISION_MODEL`（覆盖看图模型，默认跟起草同一个 k3）。

部署：**不要**走容器内 `/api/update/apply`。本机 `npm run build` 后 rsync `server/*.js` + `dist/` 到 `ALIVE@192.168.31.126:/home/ALIVE/wechat-inbox/`，`docker restart wechat-inbox`。绑定：`server`→`/app`，`dist`→`/dist`，`data`→`/data`。

---

## 12. 近期产品决策（评审时别推翻除非有更好理由）

1. 图必须先入素材库，笔记只引用副本。  
2. 选图主路径：搜一句话 / 图位推荐；文件夹专辑是兜底。Tag（精选主题）对图片基本空转，不做主筛选。  
3. 优先级：实拍 > 实拍当底 img2img > 纯生成。封面/证明尽量实拍。  
4. 描述由 Kimi 写，入库不增加用户动作。  
5. 写桌保持干净：囤参考、资产计数、发布前四问不放在 write。  
6. 图组是六宫格，点一格再出细节，避免一张 3:4 大图撑爆右栏。  
7. 点推荐图或弹层缩略图 = 立即换到当前格，不再「先预览再确认」。

---

## 13. 已知缺口 / 可评审点

- 约一半存量图还没有 `ai_caption`，推荐和搜索覆盖不全。  
- 上传图落在扁平 `uploadDir`，不会按拍摄批次建专辑。  
- 宫格空壳（不足 6 张）的 `want` 改了写不回 `slots`。  
- PhotoPicker 底部预览/`picked` 是死代码。  
- `generate` 批量接口还在，UI 已不用。批量里会把 slot 的 `imageId`/`photoId` 当 img2img 底，和主路径 generate-one 行为不一致。  
- 「再出这一组」会重出已有实拍格，且不走 img2img。  
- 没有「最近用过 / 已发布勿重复」沉淀。  
- Hermes 桥必须 Mac 在线；文案模型在 NAS 出站调 Kimi。  
- 做笔记草稿只在本机 `localStorage` 键 `note_draft`：含 `shotsLocked`。换浏览器会丢文案；图文件在 NAS `data/notes/`。  
- 推荐条无结果时整条不渲染（没有「没有合适的」空态），只能靠「放一张」。  
- suggest 是 keyword⊂query 和 caption 2-gram，**不是**语义向量；短 want（如「封面」）经常匹配弱。

---

## 14. 端到端手测清单

1. 硬刷新做笔记。空桌：左「今天发生了什么」+ 起草笔记；右无宫格。  
2. 写两句素材 → 起草 → 左边变成文章。  
3. 拆镜头 → 右是 6 行清单，无格子；改一行、换序后点「定这组镜头」。  
4. 才出宫格；点封面 → 下有推荐。点一张推荐换上。  
5. 换一张 → 弹层点任意缩略图 → 格子立刻换，弹层关。  
6. 用这张生（需 Hermes）→ 图变、photoId 还在。  
7. 对只有生成图的格「存进库」→ 素材库来源「AI 生成」能看到。  
8. 复制全文 → 剪贴板有标题+正文+#。  
9. 囤参考贴一条有效小红书（Mac 桥开着）→ 进堆。  
10. 再做一条 → 3 秒内再点「确定清空？」才真清；否则按钮自己收回。清空后 `note_draft` 删除。

---

## 15. 给评审 AI 的阅读顺序

1. 本文档（产品 + 流程 + 已知缺口）  
2. `src/components/NoteTab.tsx`（页面状态机，约 820 行）  
3. `src/components/PhotoPicker.tsx`  
4. `server/notes.js`（起草 / lint / 拆图 / 出图）  
5. `server/caption.js` + `server/llm.js`（描述和检索）  
6. `docs/API.md` 笔记/库/资产三节  
7. 若要改搜图策略：`docs/specs/2026-08-23-image-loop-design.md`（M1–M4 设计原文；其中「默认视觉模型 moonshot-v1-8k-vision-preview」**已被推翻**，以本文 + `visionConfig()` 为准）

不要改：图先入库存引用、写桌不放资产计数、点缩略图立即放入、宫格而不是六张大卡、视觉模型继续走 k3 coding 端点。
