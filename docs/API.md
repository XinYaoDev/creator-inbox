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
| GET | `/api/library/suggest` | `q` 人话检索；`exclude` / `used` 为逗号分隔的库 id（排除 / 降权已用过的） |
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

## Growth workspace (`/api/growth`)

SQLite `growth_records` stores typed records; `growth_messages`, `growth_events`, and `growth_runs` persist messages, audit events and deduplication. Existing source tables are not replaced. JSON errors use a non-2xx status and `{error}`. Resource mutation requires an administrator except conversation/lead/task handling by operators. Viewer tokens are read-only and cannot export CSV. Legacy APIs remain administrator-only when team tokens are enabled.

| Method | Path | Contract |
|---|---|---|
| GET | `/state` | Access role, actual stats, agents, knowledge metadata (no bodies), rules, tasks, cards, workflows, latest 100 workflow runs; no secrets. Use knowledge list/detail for full bodies. |
| GET | `/conversations` | `q`, `status`, `channel`, `kind`, `page`; 50 records/page |
| GET | `/conversations/:id` | Conversation, latest 200 messages, lead, latest 100 audit events, latest 50 card suggestions, internal `salesSummary` and latest 30 `salesTimeline` entries |
| GET | `/conversations/:id/messages` | Older messages; `beforeTs` and `beforeSeq` from earliest loaded message; at most 200 |
| PATCH | `/conversations/:id` | `status:open/ai/human/resolved`, `owner`, `agentId`, `read`, `tags` |
| POST | `/conversations/:id/reply` | `{content,requestId}`; idempotent; local sandbox or existing WeChat transport only |
| POST | `/conversations/:id/note` | `{content}`, internal only |
| POST | `/conversations/:id/incoming` | `{content}`, sandbox only, processes extraction/rules/workflows/AI |
| POST | `/conversations/:id/suggest` | Reply text, source, refs, handoff reason; does not send |
| POST | `/conversations/:id/task` | `{title,owner?,dueAt?}` seconds; creates persistent follow-up |
| POST | `/conversations/:id/sales-reset` | Operator/admin: `{expectedVersion}`; refuses AI-active conversations or stale version (409), resets only demand memory and preserves chat/turn history |
| POST | `/conversations/:id/cards/:suggestionId/adopt` | Operator/admin: return saved card text for draft only; no send; stale/expired/opt-out fails 409 |
| POST | `/conversations/:id/cards/:suggestionId/dismiss` | Operator/admin: persist dismissed status; no send |
| POST | `/sandbox` | `{name,content,agentId?}`; explicitly local test conversation |
| GET | `/leads` / `/leads.csv` | Persisted CRM records / UTF-8 CSV with formula escaping |
| PATCH | `/leads/:id` | Name, phone, wechat, notes, owner, tags, intent; stage `new/qualified/scheduled/won/lost` |
| PATCH | `/tasks/:id` | Status `pending/done/cancelled` |
| POST | `/knowledge/search` | `{query,agentId?,categories?}`; enabled/unarchived knowledge only. Agent ID enforces saved ID/category scope; `{list,mode,warning,expandedTerms}`. Exact semantic scan + lexical evidence, conservative abstention on weak ambiguous hits; similarity is not correctness. |
| POST | `/preview` | `{agentId,message,agent?}`; optional unsaved agent override, no customer writes |
| POST / PATCH | `/knowledge`, `/agent`, `/rule`, `/member`, `/card`, `/workflow` (+ `/:id` for PATCH) | Validated creation/update; disable instead of deleting |
| POST | `/workflow/start` | `{workflowId,conversationId,requestId}`; runs saved version and records each step |
| GET | `/runs` | Latest 100 rule executions |
| GET | `/reports` / `/reports.csv` | Shanghai `from`/`to` inclusive, at most 366 days; `channel`, current `owner`, `includeSandbox=1`; real period metrics, response times, daily/channel data, stage events and separate current snapshots. Viewer CSV denied |
| POST | `/sync` / `/tick` | Import source messages / process due silence rules and workflow waits |

Agent configuration includes persona, brand, instructions, style, knowledge IDs, channel scope, weekly Shanghai schedule, welcome, information extraction, contact prompt, keyword screening (any/all + exclusions), sensitive words and handoff. Social platforms use reviewed drafts; explicitly enabled website channels support automatic reception. Saved workspace model settings choose API credentials or the opt-in local Hermes Codex adapter.

Workflow schema: `{name,enabled,trigger,channel,cancelOnReply,nodes}`. Triggers: incoming, high_intent, manual. Nodes: `{id,type,value,next,otherwise,field,operator,minutes,position:{x,y}}`. Types: condition/tag/assign/task/note/reply/wait/handoff/end. Updates accept `expectedVersion` (409 on conflict); saved versions are immutable per running snapshot. Conditions use text/intent/phone/wechat/channel/tag and contains/equals/exists. Branch edges must point to valid nodes; cycles are rejected. The first node is the entry; empty next ends execution. Running records snapshot node configuration. Step action and checkpoint are saved in one SQLite savepoint. Waits resume on the 30-second service tick, including after restart, and stop on opt-out, resolution, disable, or configured reply cancellation. No arbitrary JavaScript or URL tool execution is permitted.

Cards support `trigger:manual/incoming/high_intent`, `channel`, `keywords`, `excludeKeywords`, `matchMode:any/all`, `cooldownMinutes:1..43200`, and `dailyLimit:1..20` per customer per rolling 24 hours. Triggered suggestions snapshot content/config, deduplicate message IDs and pending suggestions, expire after 24 hours, and are invalidated by card changes/disable or ended/opt-out conversations. Initial source imports never trigger marketing. Adoption is explicitly only a draft, not native card delivery.

Delivery states: received, internal, local, imported, sending, sent, failed, unknown. A server restart converts interrupted sending states to unknown; the operator must inspect the original platform before retrying. `sent` means the adapter accepted the send, not that a customer read it. Unknown/failed sends are not silently retried or used as successful AI context.

Web channel adds `queued` (durably waiting for the visitor) and `delivered` (acknowledged by the visitor client, **not** a read receipt). Role `workflow` is counted separately from human and AI in reports and CSV. Workflow nodes now include `reply`, restricted to an explicit `web` or `sandbox` channel. Web reply requires channel `workflowReply:true`; AI and workflow reception modes are mutually exclusive. Workflow replies and checkpoints share one transaction. Human takeover, opt-out, completion and channel disable block sends. Graph validation rejects unreachable nodes in addition to cycles; manual runs must match the workflow channel.

### Website visitor channel

Admin-only `GET/PATCH /api/growth/web-channel`: `{id,title,intro,enabled,autoReply,workflowReply,agentId,origins,dailyLimit}`. IDs are generated by the server; they are public identifiers, not credentials. One site per workspace, isolated from every other workspace. Allowed origins must be exact HTTPS origins (HTTP loopback allowed). Daily accepted-message budget is 10–10000, resetting at Beijing midnight. Public page: `/chat/:siteId`; frame-ancestors CSP permits only self and explicitly configured origins.

Public endpoints use `/api/webchat/:siteId`, require `X-Webchat-Client: 1`, and never use team cookies. Cross-origin clients must match an allowed origin. All endpoints reject disabled sites. Visitor tokens never go into URLs.

| Method | Path | Contract |
|---|---|---|
| GET | `/config` | Public display title, intro, privacy notice; no internal configuration or keys |
| POST | `/session` | `{token,name?}`; token is client-generated cryptographic 32 bytes encoded as 64 hex chars. Stores only hash, creates one private conversation, retry idempotent, expires in 7 days |
| GET | `/messages?after=0` | Visitor bearer token required. Up to 100 messages in insertion order; `sequence` pagination, `hasMore`, customer-visible status only; no notes/CRM/internal events |
| POST | `/messages` | `{content,requestId}`; 1–2000 chars, idempotent per visitor; same request ID with different content fails 409. Enqueues real web reception, not sandbox injection |
| POST | `/ack` | `{sequence}`; marks only this visitor's queued replies delivered |
| POST | `/contact` | `{name?,phone?,wechat?,consent:true}`; explicit consent and one valid contact required; consent timestamp persisted |
| POST | `/handoff` | Stops pending automation and marks human reception; no fabricated external notification |

Message rate limits, session creation limits, token expiry and daily site quotas are enforced server-side. Production still needs HTTPS, team authentication, gateway-level abuse protection and operator privacy/retention policies. No public deployment was performed.

### Accounts and workspace isolation (`/api/team`)

Password sessions use HttpOnly / SameSite=Strict cookies (12-hour expiry); production HTTPS should enable `SESSION_COOKIE_SECURE=1`. Mutating cookie requests must include `X-Requested-With: LaikeAI`. Foreign origins and cross-site writes are rejected. Once any password account exists anonymous access closes. Existing server/team tokens remain supported. Explicit invalid bearer credentials never fall through to session/anonymous access.

| Method | Path | Contract |
|---|---|---|
| GET | `/status` | Public service identifier, demo flag, whether accounts exist; no user list |
| POST | `/login` | `{username,password}`; generic invalid-credential error; bounded source/account attempt limits |
| POST | `/logout` | Revokes current session and clears cookie |
| GET | `/state` | Identity and allowed spaces; scoped member list and last 100 account audit entries only for admins |
| POST | `/password` | Session only: `{currentPassword,password}`; revokes all user's sessions |
| POST | `/users` | Scoped admin: `{username,name,role,password}`; first member must be admin; initial unauthenticated bootstrap is loopback-only |
| PATCH | `/users/:id` | Scoped admin: name/role/active/password; last active admin protected; revokes target's sessions |
| POST | `/workspaces` | Server admin token only: `{name}`; creates independent workspace |
| PATCH | `/workspace` | Scoped admin renames current workspace `{name}` |

`X-Workspace-ID` selects a workspace only for server administrators. Ordinary accounts cannot override membership. Growth tables are namespaced with a server-derived hash (default space keeps legacy names); workflows, messages, idempotency keys, knowledge and credentials do not cross spaces. Legacy account/media/publishing APIs and source sync are restricted to default-space administrators. Passwords use scrypt with random salts; session secrets are stored only as hashes. The API never returns password hashes or session secrets in JSON.

### Model settings (`/api/growth/model`, admin only)

`provider: "api" | "hermes-codex"` selects the connection. GET also returns `hermesAvailable` and `connectionConfigured`; the latter is separate from `keyConfigured`. Hermes requires server `HERMES_CODEX_ENABLED=1`, a local Hermes runtime and the default workspace; all other spaces are rejected. `GET /model/hermes` returns only safe availability/model metadata, never login tokens. Selecting Hermes does not erase an existing encrypted API key and never silently falls back to it. Hermes permits independent local embeddings but not API embeddings. Existing login is read-only; no refresh or auth-store mutation, no agent tools, fixed official destination, bounded two-request concurrency.

GET returns base, model, embeddingModel, embeddingsEnabled, embeddingProvider (`disabled/local/api`), embeddingMinScore (0.3–0.95; local default 0.4, API default 0.3), keyConfigured, keyHint (last four characters), keySource, keyError, updated. PATCH accepts those non-secret settings plus `key` (non-empty replaces, empty preserves), `clearKey` (suppresses environment fallback), or `useEnvironment` (default workspace only). Legacy embeddingsEnabled maps to API/disabled when embeddingProvider is omitted. Never submit secrets in URLs. Keys are AES-256-GCM encrypted with workspace ID as authenticated additional data; retain `.model-encryption-key` beside database backups. Settings apply to subsequent calls without restart.

POST `/model/test` sends only a short test instruction to the saved model. A non-empty real model response is required for success. Returns safe model/latency/token-usage metadata, not provider body or credentials. May incur API charges. Non-default workspaces do not inherit server environment credentials. Arbitrary gateway hosts require `GROWTH_LLM_ALLOWED_HOSTS`; redirects are rejected.

Default-space notes drafting, lint/rewrite, storyboards and image captions also resolve this saved model configuration. `/api/notes/status` exposes `modelSource:"workspace"`. Clearing the key does not silently reactivate Kimi/other legacy credentials. Notes requests use per-request async context, generic factual prompts and the default agent's brand; model inputs/errors never expose saved keys. Image generation remains an independently configured service and is not automatically sent to a public demo provider when unconfigured.

### Knowledge lifecycle (`/api/growth/knowledge`)

| Method | Path | Contract |
|---|---|---|
| POST | `/import-preview` | `{format:txt/md/csv/json,content,filename,category}`; validates entire batch and flags duplicates, no writes |
| POST | `/import` | Same payload; atomic import, replay dedup, all imported entries disabled pending review; 700 KB / 200 entries |
| PATCH | `/:id` | Supports `expectedVersion`; stale edits fail 409. `archived:true` also disables; `archived:false` restores without enabling |
| GET | `/:id/versions` | Version snapshots with editor and timestamp |
| POST | `/:id/restore` | `{revisionId,expectedVersion}`; creates a new, disabled version without deleting history |
| GET | `/index` | Ready/total/pending chunks, provider/model/dimensions/minScore, building flag, persisted `job`; local engine phase/progress, no private text |
| POST | `/index` | Compatibility single-batch operation: explicitly embeds up to 32 pending chunks. Local first build may download pinned assets; API mode may incur charges. |
| POST | `/index-jobs` | Admin: `{action:start/resume/pause}`; returns 202 + status immediately. A persisted background job continues across page navigation, pauses after its current batch, and requires explicit resume after a service interruption. Completed content is reused. |
| GET | `/list` | `q,category,status=active/enabled/disabled/archived,page,limit`; page size default 50, max 100; returns `{list,total,page,limit}`. Searches full bodies without sending all bodies to the client. |
| GET | `/:id` | Full knowledge body and current version for editing. |
| POST | `/batch` | Admin: `{action:enable/disable/archive/restore,items:[{id,expectedVersion}]}`; 1–100 unique entries, all checked before any write. Stale versions return 409; archive/restore leave items disabled. Every change creates a version. |

Embeddings are chunked and persist per workspace. Content/model/endpoint changes invalidate affected index entries. Query vectors are bounded in-memory caches. Agent knowledge scopes, disable/archive and concurrent updates are checked before use. Provider failure falls back explicitly to lexical matching. UI and `/state.stats.knowledgeIndex` expose ready/pending counts. Text-layer PDF extraction runs locally in the browser (PDF.js, 10 MB / 80 pages, bundled CMaps/fonts) and submits reviewed JSON entries through the same import API, never the original PDF. OCR and public-page crawling are implemented as described below; native platform media cards remain unimplemented.

Local embeddings use pinned `Xenova/bge-small-zh-v1.5`, q8 ONNX, CLS pooling and L2 normalization, 512 dimensions in a CPU worker. Local chunks use sentence-aware windows (flush at 80 characters, max 160; long sentences split with 20-character overlap), identified by `sentence-chunks-v3`; upgrading requires rebuilding enabled documents once. API chunks remain 1800/200. Model weights can be shared on disk; vectors and bounded query caches remain per workspace. Normal queries only read cached assets; only explicit index creation permits model download. Knowledge/query texts never leave the local worker in local mode; subsequent GPT generation still receives the relevant text. Generation-tracked document/chunk caches, normalized Float32 vectors and IDF-weighted lexical postings eliminate per-query full-body tokenization and per-chunk database reads. Exact scans yield every 512 chunks. Similarity strength is preserved when combining lexical hits; explicit hyphenated identifiers restrict matching, while compact product codes still permit generic policy documents. Small, inspectable business-language expansions are reported in `expandedTerms`. Semantic-only hits below threshold + 0.01, or below threshold + 0.03 with a top-two gap under 0.01, abstain rather than present weak matches. These heuristics need business-specific calibration. Hits expose `match`, `similarity`, `chunkIndex` and knowledge version. Failed/config-changed/dimension-mismatched queries fall back visibly. Changing configuration during index creation rejects stale results (409). This is an exact local scan, not a large-scale ANN service.

### Multi-turn sales reception

Agent fields: `salesEnabled` (false by default; also requires `collectEnabled`), `salesScenario` (`general`, `hospitality`, `retail`, `services`, `education`, `software`, `experience`), `salesGoal`, `salesRequired`, `salesQuestions`, `salesObjections`, `salesMaxTurns` (2–30, default 12). Allowed fields, labels, default questions, required fields and industry boundaries are shared in `shared/sales-scenarios.json`. Templates do not enable agents or change channels, brand or knowledge scope; applying a template is unsaved until Save. Agent `knowledgeIds` accepts up to 500 IDs; `knowledgeCategories` accepts up to 50 categories. If both are selected, their intersection applies. New enabled documents in selected categories are included automatically. Sales generation uses the saved GPT connection, not a separate key.

Objection resolution includes a `kind` and cannot resolve unrelated concerns; legacy untyped resolution is accepted only for a single outstanding concern. Customer specification/date preferences do not imply a request to guarantee availability. Up to eight evidence documents may include prior citations from the last six AI replies, but each retained citation is revalidated against current version, enabled state and agent scope. Team-only references include a bounded source excerpt for continuity; no stale/withdrawn source is reused as current evidence.

`conversation.salesState` stores version, phase, turns, `originalRequest`, `facts:{field:{value,evidence,messageId,at}}`, declined/asked fields, objections/resolution quotes, noContact, paused, lastQuestion, nextAction and optional explicit confirmation. New facts must be substrings of verbatim current-customer evidence; customer corrections replace that field. Refused/known/previously asked fields are not repeatedly solicited. Pauses stop sales questions; explicit resumption preserves context. Ordinary acknowledgments do not imply booking/payment consent. Model prose is not allowed to add extra sales questions; the server adds at most one configured missing-field question.

Explicit exclusions use `constraints:[{field,value,evidence,messageId,at}]` (at most 12), distinct from positive facts and refusal to disclose information. The model must emit them even during handoff; the server verifies the allowed field, current verbatim evidence and a negative prefix. A negative fact is also accepted as an exclusion for compatibility. Excluding an additional service does not replace the whole demand; withdrawing an exact earlier value clears it without inventing a replacement. A subsequent explicit positive choice supersedes that same exclusion. Constraints appear in the team demand panel and handoff summary, not in visitor API metadata. Natural-language extraction still depends on model quality and requires business evaluation.

Memory and `salesTurn` history commit with an actual AI reply, not previews/suggestions. Concurrent new messages, manual takeover, knowledge/config changes and memory-version changes discard obsolete results. Confirmed next steps switch to human and create one deduplicated follow-up, without changing CRM deal stage. Human reply, visitor handoff, completion and model failures synchronize the current memory phase. Reset preserves historical messages/turns and starts a fresh request context using `resetAfterSequence`; older messages are excluded from new model context, while noContact remains honored. These data, source quotes and retrieval metadata are team-only; visitor responses whitelist customer-visible fields.

Report response time is the first successful reply after a burst of incoming messages, attributed by reply timestamp; welcomes, notes, failed and unknown sends are excluded. No samples returns null. Current owner and captured-contact snapshots are explicitly not historical staff attribution or first-capture events. Stage events begin at `trackingSince`, without invented backfill. CSV exports include applied filters, period metrics, trends, channel table, stage events, current snapshots and definitions with formula escaping.

### OCR, website collection and visual workflow additions

OCR runs locally with bundled Tesseract/PDF.js resources: PNG/JPEG/WebP or PDF, 10 MB, 80 PDF pages, up to 20 OCR pages per run, cancellable and ten-minute bounded. Reviewed JSON import entries retain `sourceMeta:{kind:"ocr"|"pdf",filename,page,confidence?}`. Original files are never sent to the server/model. Source confidence is not measured accuracy.

Admin-only website endpoints under `/api/growth/knowledge/web`:

| Method | Path | Contract |
|---|---|---|
| GET / POST | `/` | List recent jobs / start `{url,category,maxPages:1..5}`, returning 202 |
| GET | `/:id` | Persisted status, per-page results, editable extracted items and original provenance |
| POST | `/:id/cancel` | Abort active requests; cancellation does not import knowledge |
| POST | `/:id/import` | `{items:[{key,title,body,category}],update:boolean}`; keys must belong to this job. Atomic dedup/update with expected source versions; new/updated items disabled |

Jobs persist as queued/running/completed/failed/cancelled/interrupted. Restart interrupts unfinished crawls; completed review results remain available. Public URL/port/DNS checks, pinned public addresses, revalidated same-origin redirects, robots/noindex, 2 MB/page and 90-second job bounds apply. Only HTML is processed; no cookie/login/JavaScript scraping. One running job per workspace, three globally, and bounded per-space start frequency.

`POST /api/growth/workflow-runs/:id/cancel` stops an active run. Workflow version and node positions are persisted; active runs retain their starting graph. Read-only execution traces are actual engine steps, not visual simulations.

Team conversation messages now include saved `model` and `refs:[{id,title,version}]`. These are the supplied knowledge sources, not sentence-level proof; visitor APIs deliberately omit them. Optional model `assessment` requires a finite confidence of at least 0.7 and a verbatim 4–200-character customer quote. Valid results update advisory intent/tags and record reason/evidence/model/time, without inferring contact details or changing deal stage. Explicit manual intent correction clears the current AI assessment. Turning off agent information extraction suppresses automatic extraction and semantic assessment. Keyword fallback still exists; semantic assessment is not a complete autonomous sales-stage engine.
