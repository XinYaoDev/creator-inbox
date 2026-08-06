// 聚合收件箱 demo —— 零依赖 Node 服务
// HTTP 静态托管 + API + 定时采集器（node:sqlite / node:http / global fetch）
// 平台抽象：videos/comments/dm_sessions/dm_messages 均带 platform 维度，
// 每个平台一个采集适配器（wechat=视频号，douyin=抖音），新平台只需再加一个适配器。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const nodeCrypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8877);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inbox.db');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'dist');
const DATA_DIR = path.dirname(DB_PATH);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

// ---------- 平台配置（cookie 挂载为只读，更新时落到数据目录的 override 文件） ----------
const PLATFORMS = {
  wechat: {
    name: '视频号',
    cookieFile: process.env.COOKIE_FILE || '/run/secrets/cookie',
    cookieOverride: path.join(DATA_DIR, 'cookie.override'),
    cookieValid: null, // null=未采集过
  },
  douyin: {
    name: '抖音',
    cookieFile: process.env.DY_COOKIE_FILE || '/run/secrets/dy-cookie',
    cookieOverride: path.join(DATA_DIR, 'dy-cookie.override'),
    cookieValid: null,
  },
};

function readCookie(platform) {
  const p = PLATFORMS[platform];
  for (const f of [p.cookieOverride, p.cookieFile]) {
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) return s;
    } catch { /* ignore */ }
  }
  return '';
}

function writeCookie(platform, cookie) {
  const p = PLATFORMS[platform];
  try {
    fs.writeFileSync(p.cookieFile, cookie, { mode: 0o600 });
    try { fs.unlinkSync(p.cookieOverride); } catch { /* ignore */ }
    return p.cookieFile;
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(p.cookieOverride, cookie, { mode: 0o600 });
    return p.cookieOverride;
  }
}

// ---------- 数据库 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS videos(
  platform TEXT NOT NULL DEFAULT 'wechat',
  objectId TEXT NOT NULL,
  title TEXT,
  thumbUrl TEXT,
  createTime INTEGER,
  commentCount INTEGER DEFAULT 0,
  PRIMARY KEY(platform, objectId)
);
CREATE TABLE IF NOT EXISTS comments(
  platform TEXT NOT NULL DEFAULT 'wechat',
  commentId TEXT NOT NULL,
  exportId TEXT,
  nickname TEXT,
  content TEXT,
  headUrl TEXT,
  createTime INTEGER,
  likeCount INTEGER DEFAULT 0,
  rootCommentId TEXT DEFAULT '',
  PRIMARY KEY(platform, commentId)
);
CREATE INDEX IF NOT EXISTS idx_comments_time ON comments(createTime DESC);
CREATE TABLE IF NOT EXISTS dm_sessions(
  platform TEXT NOT NULL DEFAULT 'wechat',
  sessionId TEXT NOT NULL,
  username TEXT,
  nickname TEXT,
  headImgUrl TEXT,
  sessionType INTEGER DEFAULT 1,
  PRIMARY KEY(platform, sessionId)
);
CREATE TABLE IF NOT EXISTS dm_messages(
  platform TEXT NOT NULL DEFAULT 'wechat',
  svrMsgId TEXT NOT NULL,
  sessionId TEXT,
  fromUsername TEXT,
  toUsername TEXT,
  content TEXT,
  ts INTEGER,
  msgType INTEGER,
  PRIMARY KEY(platform, svrMsgId)
);
CREATE INDEX IF NOT EXISTS idx_dm_ts ON dm_messages(sessionId, ts);
CREATE TABLE IF NOT EXISTS collect_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  result TEXT
);
CREATE TABLE IF NOT EXISTS avatar_cache(
  url TEXT PRIMARY KEY,
  contentType TEXT,
  data BLOB,
  ts INTEGER
);
CREATE TABLE IF NOT EXISTS sent_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  type TEXT,
  target TEXT,
  content TEXT,
  upstream TEXT
);
`);

// 迁移：旧库四张表无 platform 列（单列主键）→ 重建为 (platform, id) 复合主键并搬迁数据
{
  const migrate = (table, keyCol, otherCols) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length || cols.includes('platform')) return;
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    const oldCols = db.prepare(`PRAGMA table_info(${table}_old)`).all().map((c) => c.name);
    const keep = otherCols.filter((c) => oldCols.includes(c));
    db.exec(`CREATE TABLE ${table}(
      platform TEXT NOT NULL DEFAULT 'wechat',
      ${keyCol} TEXT NOT NULL,
      ${keep.map((c) => `${c} ${{
        createTime: 'INTEGER', commentCount: 'INTEGER DEFAULT 0', likeCount: 'INTEGER DEFAULT 0',
        sessionType: 'INTEGER DEFAULT 1', ts: 'INTEGER', msgType: 'INTEGER',
        rootCommentId: "TEXT DEFAULT ''",
      }[c] || 'TEXT'}`).join(',\n      ')},
      PRIMARY KEY(platform, ${keyCol})
    )`);
    db.prepare(`INSERT INTO ${table}(platform,${keyCol},${keep.join(',')})
      SELECT 'wechat',${keyCol},${keep.join(',')} FROM ${table}_old`).run();
    db.exec(`DROP TABLE ${table}_old`);
    console.log(`[migrate] ${table} → platform 维度，搬迁 ${keep.length} 列`);
  };
  migrate('videos', 'objectId', ['title', 'thumbUrl', 'createTime', 'commentCount']);
  migrate('comments', 'commentId', ['exportId', 'nickname', 'content', 'headUrl', 'createTime', 'likeCount', 'rootCommentId']);
  migrate('dm_sessions', 'sessionId', ['username', 'nickname', 'headImgUrl', 'sessionType']);
  migrate('dm_messages', 'svrMsgId', ['sessionId', 'fromUsername', 'toUsername', 'content', 'ts', 'msgType']);
  // 老库 comments 可能没有 rootCommentId（楼中楼）——上面的 keep 过滤已兼容，但无此列的老数据楼中楼丢失，重采修复
}

const upVideo = db.prepare(`INSERT INTO videos(platform,objectId,title,thumbUrl,createTime,commentCount)
  VALUES(?,?,?,?,?,?)
  ON CONFLICT(platform,objectId) DO UPDATE SET title=excluded.title, thumbUrl=excluded.thumbUrl,
    createTime=excluded.createTime, commentCount=excluded.commentCount`);
const upComment = db.prepare(`INSERT INTO comments(platform,commentId,exportId,nickname,content,headUrl,createTime,likeCount,rootCommentId)
  VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(platform,commentId) DO UPDATE SET nickname=excluded.nickname, content=excluded.content,
    headUrl=excluded.headUrl, createTime=excluded.createTime, likeCount=excluded.likeCount,
    rootCommentId=excluded.rootCommentId`);
const upSession = db.prepare(`INSERT INTO dm_sessions(platform,sessionId,username,nickname,headImgUrl,sessionType)
  VALUES(?,?,?,?,?,?)
  ON CONFLICT(platform,sessionId) DO UPDATE SET username=excluded.username, nickname=excluded.nickname,
    headImgUrl=excluded.headImgUrl, sessionType=excluded.sessionType`);
const upMessage = db.prepare(`INSERT INTO dm_messages(platform,svrMsgId,sessionId,fromUsername,toUsername,content,ts,msgType)
  VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(platform,svrMsgId) DO NOTHING`);

// ---------- 视频号（wechat）适配器 ----------
const WX_BASE = 'https://channels.weixin.qq.com';
const WX_COMMON = {
  _log_finder_uin: '',
  _log_finder_id: 'v2_060000231003b20faec8c4ea8911c0d1c603ec35b077cc8c2950945db6825f2e3f6aefdcc82a@finder',
  rawKeyBuff: '',
  pluginSessionId: null,
  scene: 7,
  reqScene: 7,
};
const CGI = '/micro/interaction/cgi-bin/mmfinderassistant-bin';

async function wxApi(p, extra) {
  const res = await fetch(WX_BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: readCookie('wechat'), 'User-Agent': UA },
    body: JSON.stringify({ timestamp: String(Date.now()), ...WX_COMMON, ...extra }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`上游返回非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
}

function wxCheck(r, stage) {
  if (r.errCode !== 0) {
    PLATFORMS.wechat.cookieValid = false;
    throw new Error(`${stage} errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
}

function wxSaveVideo(v) {
  const d = v.desc || {};
  upVideo.run(
    'wechat',
    String(v.objectId || ''),
    String(d.description || '').trim(),
    String((d.media && d.media[0] && d.media[0].thumbUrl) || ''),
    Number(v.createTime) || 0,
    Number(v.commentCount) || 0,
  );
}

function wxSaveComment(exportId, c, rootCommentId = '') {
  const id = String(c.commentId || '');
  if (!id) return;
  upComment.run(
    'wechat',
    id,
    String(exportId),
    String(c.commentNickname || ''),
    String(c.commentContent || ''),
    String(c.commentHeadurl || ''),
    Number(c.commentCreatetime) || 0,
    Number(c.commentLikeCount) || 0,
    String(rootCommentId || ''),
  );
}

function wxSaveSession(s) {
  if (!s.sessionId) return;
  upSession.run(
    'wechat',
    String(s.sessionId),
    String(s.username || ''),
    String(s.nickname || ''),
    String(s.headImgUrl || ''),
    Number(s.sessionType) || 1,
  );
}

function wxSaveMessage(m) {
  const id = String(m.svrMsgId || '');
  if (!id || !m.sessionId) return;
  const content = (m.textMsg && m.textMsg.content) || m.rawContent ||
    (Number(m.msgType) === 1 ? '' : `[非文本消息 type=${m.msgType}]`);
  upMessage.run(
    'wechat',
    id,
    String(m.sessionId),
    String(m.fromUsername || ''),
    String(m.toUsername || ''),
    String(content),
    Number(m.ts) || 0,
    Number(m.msgType) || 0,
  );
}

async function wxCollectVideos(result) {
  let lastBuff = '';
  const seen = new Set();
  for (let page = 0; page < 50; page++) {
    const r = await wxApi(`${CGI}/post/post_list`, {
      pageSize: 10, onlyUnread: false, needAllCommentCount: true,
      userpageType: 13, forMcn: false, lastBuff,
    });
    wxCheck(r, 'post_list');
    const d = r.data || {};
    const list = d.list || [];
    for (const v of list) { if (v.objectId) { wxSaveVideo(v); result.videos++; } }
    lastBuff = d.lastBuff || '';
    if (!lastBuff || !list.length || seen.has(lastBuff)) break;
    seen.add(lastBuff);
  }
}

async function wxCollectCommentsForVideo(objectId, result) {
  let buff = '';
  const seen = new Set();
  for (let page = 0; page < 30; page++) {
    const r = await wxApi(`${CGI}/comment/comment_list`, {
      lastBuff: buff, exportId: String(objectId), commentSelection: false, forMcn: false,
    });
    wxCheck(r, 'comment_list');
    const d = r.data || {};
    const list = d.comment || [];
    for (const c of list) {
      wxSaveComment(objectId, c); result.comments++;
      for (const l2 of c.levelTwoComment || []) wxSaveComment(objectId, l2, c.commentId);
    }
    buff = d.lastBuff || '';
    if (!buff || !list.length || seen.has(buff)) break;
    seen.add(buff);
  }
}

async function wxCollectComments(result) {
  const vids = db.prepare("SELECT objectId FROM videos WHERE platform='wechat' AND commentCount > 0").all();
  for (const { objectId } of vids) await wxCollectCommentsForVideo(objectId, result);
}

async function wxCollectDM(result) {
  // 1. 全局私信 feed（sessionId 置空即返回跨会话最新消息），顺带收集会话 ID
  const sessionIds = new Set();
  let cookie = '';
  const seenCk = new Set();
  for (let page = 0; page < 5; page++) {
    const r = await wxApi(`${CGI}/private-msg/get-history-msg`, { sessionId: '', cookie });
    wxCheck(r, 'dm_feed');
    const d = r.data || {};
    for (const m of d.msg || []) {
      if (m.sessionId) sessionIds.add(String(m.sessionId));
      wxSaveMessage(m); result.messages++;
    }
    cookie = d.cookie || '';
    if (!d.isContinue || !cookie || seenCk.has(cookie)) break;
    seenCk.add(cookie);
  }
  // 2. 批量取会话资料（sessionId 必须传数组，传单个字符串只会得到空 extInfo）
  const sids = [...sessionIds];
  for (let i = 0; i < sids.length; i += 20) {
    const r = await wxApi(`${CGI}/private-msg/get-session-info`, { sessionId: sids.slice(i, i + 20) });
    wxCheck(r, 'dm_session_info');
    for (const s of r.data?.sessionInfo || []) { if (s.sessionId) { wxSaveSession(s); result.sessions++; } }
  }
  // 3. 每个会话补一页历史
  for (const sid of sids) {
    const r = await wxApi(`${CGI}/private-msg/get-history-msg`, { sessionId: sid, cookie: '' });
    wxCheck(r, 'dm_history');
    for (const m of r.data?.msg || []) { wxSaveMessage(m); result.messages++; }
  }
}

async function wxCollect(result) {
  await wxCollectVideos(result);
  await wxCollectComments(result);
  await wxCollectDM(result);
}

// ---------- 抖音（douyin）适配器 ----------
// 侦察结论（见会话记录）：creator.douyin.com 后台读接口不强制 a_bogus 签名，cookie 即可重放。
// 视频列表 GET /aweme/v1/creator/item/list/；评论 GET /web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/
const DY_BASE = 'https://creator.douyin.com';
const DY_COMMENT_API = '/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/';

async function dyApi(p) {
  const res = await fetch(DY_BASE + p, {
    headers: {
      Cookie: readCookie('douyin'),
      'User-Agent': UA,
      Referer: 'https://creator.douyin.com/creator-micro/interactive/comment',
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    PLATFORMS.douyin.cookieValid = false;
    throw new Error(`抖音上游返回非 JSON (HTTP ${res.status})，cookie 可能已失效: ${text.slice(0, 120)}`);
  }
  if (r.status_code !== 0) {
    PLATFORMS.douyin.cookieValid = false;
    throw new Error(`抖音接口 status_code=${r.status_code} status_msg=${r.status_msg || r.status_message || ''}`);
  }
  return r;
}

// 从对象里按多个候选路径取第一个非空字符串（抖音字段命名不稳定，实测后收敛）
function pick(obj, paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) v = v == null ? undefined : v[k];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0]) return v[0];
  }
  return '';
}

// item/list 的 create_time 是「发布于2026年08月04日 09:20」字符串，评论的 create_time 是秒级时间戳
function dyParseTime(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const m = String(v || '').match(/(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/);
  if (m) return Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000);
  return 0;
}

function dyVideoId(it) {
  return String(it.item_id_plain || '').trim() || String(it.item_id || '').trim();
}

function dySaveVideo(it) {
  const id = dyVideoId(it);
  if (!id) return;
  upVideo.run(
    'douyin',
    id,
    String(it.title || it.desc || '').trim(),
    pick(it, ['cover_image_url', 'video_cover', 'cover', 'item_cover', 'cover_url', 'poster']),
    dyParseTime(it.create_time),
    Number(it.comment_count) || 0,
  );
}

function dySaveComment(awemeId, c, rootCommentId = '') {
  const id = String(c.cid || '');
  if (!id) return;
  const u = c.user || {};
  upComment.run(
    'douyin',
    id,
    String(awemeId),
    String(u.nickname || ''),
    String(c.text || ''),
    pick(u, ['avatar_thumb.url_list', 'avatar_larger.url_list', 'avatar_url', 'avatar']),
    Number(c.create_time) || 0,
    Number(c.digg_count) || 0,
    String(rootCommentId || ''),
  );
}

async function dyCollectVideos(result) {
  let cursor = '';
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const r = await dyApi(`/aweme/v1/creator/item/list/?cursor=${encodeURIComponent(cursor)}&aid=2906`);
    const list = r.item_info_list || [];
    for (const it of list) { if (dyVideoId(it)) { dySaveVideo(it); result.videos++; } }
    if (!r.has_more || !list.length) break;
    cursor = String(r.cursor ?? '');
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
}

async function dyCollectCommentsForVideo(awemeId, result) {
  let cursor = 0;
  for (let page = 0; page < 30; page++) {
    const r = await dyApi(`${DY_COMMENT_API}?aweme_id=${encodeURIComponent(awemeId)}&cursor=${cursor}&count=20&aid=2906`);
    const list = r.comments || [];
    for (const c of list) {
      dySaveComment(awemeId, c); result.comments++;
      for (const l2 of c.reply_comment || []) { dySaveComment(awemeId, l2, c.cid); result.comments++; }
    }
    if (!r.has_more || !list.length) break;
    cursor = Number(r.cursor) || cursor + list.length;
  }
}

async function dyCollectComments(result) {
  const vids = db.prepare("SELECT objectId FROM videos WHERE platform='douyin' AND commentCount > 0").all();
  for (const { objectId } of vids) await dyCollectCommentsForVideo(objectId, result);
}

async function dyCollect(result) {
  await dyCollectVideos(result);
  await dyCollectComments(result);
  // 私信：抖音走 imapi.douyin.com IM 体系（需 IM token + 自定义头），逆向成本高，第二批再接入
}

// ---------- 采集调度 ----------
const COLLECTORS = { wechat: wxCollect, douyin: dyCollect };

let collecting = false;
async function collectAll(trigger = 'auto') {
  if (collecting) return { skipped: true, msg: '上一次采集尚未结束' };
  collecting = true;
  const startedAt = Math.floor(Date.now() / 1000);
  const result = { trigger, platforms: {}, errors: [] };
  for (const [name, collect] of Object.entries(COLLECTORS)) {
    const r = { videos: 0, comments: 0, sessions: 0, messages: 0 };
    if (!readCookie(name)) {
      r.skipped = '无 cookie，未采集';
      result.platforms[name] = r;
      continue;
    }
    try {
      await collect(r);
      if (PLATFORMS[name].cookieValid !== false) PLATFORMS[name].cookieValid = true;
      r.ok = true;
    } catch (e) {
      r.ok = false;
      r.error = String(e && e.message || e);
      result.errors.push(`[${PLATFORMS[name].name}] ${r.error}`);
    }
    result.platforms[name] = r;
  }
  result.ok = result.errors.length === 0;
  result.elapsedSec = Math.floor(Date.now() / 1000) - startedAt;
  db.prepare('INSERT INTO collect_log(ts,result) VALUES(?,?)').run(startedAt, JSON.stringify(result));
  collecting = false;
  console.log(`[collect] ${trigger} ok=${result.ok}`, JSON.stringify(result));
  return result;
}

// ---------- 视频号视频上传（存草稿） ----------
// 协议来自 finder-helper-web bundle 逆向：helper_upload_params 取凭证 →
// finderassistance*.video.qq.com 四步分片上传（applyuploaddfs/uploadpartdfs/completepartuploaddfs）→ post_draft
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CDN_CHUNK = 8 * 1024 * 1024;
let wxUploadParamsCache = null;
let wxCdnHosts = [];

async function wxUploadParams(force = false) {
  if (wxUploadParamsCache && !force) return wxUploadParamsCache;
  const r = await wxApi('/cgi-bin/mmfinderassistant-bin/helper/helper_upload_params', {});
  if (r.errCode !== 0) {
    PLATFORMS.wechat.cookieValid = false;
    throw new Error(`helper_upload_params errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  wxUploadParamsCache = r.data;
  try {
    const a = await wxApi('/cgi-bin/mmfinderassistant-bin/auth/auth_data', {});
    const hosts = a?.data?.envInfo?.cdnHostList;
    if (Array.isArray(hosts) && hosts.length) wxCdnHosts = hosts;
  } catch { /* 用默认 host */ }
  if (!wxCdnHosts.length) wxCdnHosts = ['finderassistancea.video.qq.com'];
  return wxUploadParamsCache;
}

function cdnUploadHeaders(params, fileName, fileSize, taskId, fileTypeKey, md5) {
  return {
    Authorization: params.authKey,
    'X-Arguments':
      `apptype=${params.appType}&filetype=${params[fileTypeKey]}` +
      `&weixinnum=${params.uin}&filekey=${encodeURIComponent(fileName)}` +
      `&filesize=${fileSize}&taskid=${taskId}&scene=${params.scene || 0}`,
    'Content-MD5': md5 || 'null',
    'User-Agent': UA,
  };
}

async function wxCdnUpload(filePath, fileName, params, fileTypeKey) {
  const size = fs.statSync(filePath).size;
  const taskId = crypto.randomUUID();
  const chunkCount = Math.max(1, Math.ceil(size / CDN_CHUNK));
  const host = () => `https://${wxCdnHosts[Math.floor(Math.random() * wxCdnHosts.length)]}`;
  // 1. 初始化拿 UploadID
  const initRes = await fetch(`${host()}/applyuploaddfs`, {
    method: 'PUT',
    headers: { ...cdnUploadHeaders(params, fileName, size, taskId, fileTypeKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BlockSum: chunkCount,
      BlockPartLength: Array.from({ length: chunkCount }, (_, i) => Math.min((i + 1) * CDN_CHUNK, size)),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const initData = await initRes.json();
  const uploadId = initData.UploadID || initData.data?.UploadID;
  if (!uploadId) throw new Error(`applyuploaddfs 无 UploadID: ${JSON.stringify(initData).slice(0, 200)}`);
  // 2. 逐片上传（QuickUpload=2 全程 Normal，不依赖秒传）
  const fd = fs.openSync(filePath, 'r');
  let transFlag = 0;
  const partInfo = [];
  try {
    for (let i = 0; i < chunkCount; i++) {
      const len = Math.min(CDN_CHUNK, size - i * CDN_CHUNK);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, i * CDN_CHUNK);
      const res = await fetch(
        `${host()}/uploadpartdfs?PartNumber=${i + 1}&UploadID=${encodeURIComponent(uploadId)}&QuickUpload=2`,
        {
          method: 'PUT',
          headers: {
            ...cdnUploadHeaders(params, fileName, size, taskId, fileTypeKey,
              nodeCrypto.createHash('md5').update(chunk).digest('hex')),
            'Content-Type': 'application/octet-stream',
          },
          body: chunk,
          signal: AbortSignal.timeout(180000),
        });
      const d = await res.json();
      const errno = d['X-Errno'] ?? d.data?.['X-Errno'];
      if (errno !== 0) throw new Error(`uploadpartdfs 第${i + 1}/${chunkCount}片 X-Errno=${errno}: ${JSON.stringify(d).slice(0, 200)}`);
      if (d.TransFlag != null) transFlag = d.TransFlag;
      partInfo.push({ PartNumber: i + 1, ETag: d.ETag ?? d.data?.ETag });
    }
  } finally {
    fs.closeSync(fd);
  }
  // 3. 完成
  const finRes = await fetch(`${host()}/completepartuploaddfs?UploadID=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: { ...cdnUploadHeaders(params, fileName, size, taskId, fileTypeKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ TransFlag: transFlag, PartInfo: partInfo }),
    signal: AbortSignal.timeout(30000),
  });
  const finData = await finRes.json();
  const downloadURL = finData.DownloadURL || finData.data?.DownloadURL;
  if (!downloadURL) throw new Error(`completepartuploaddfs 无 DownloadURL: ${JSON.stringify(finData).slice(0, 200)}`);
  return {
    url: downloadURL.replace('http://wxapp.tc.qq.com', 'https://finder.video.qq.com'),
    taskId,
    fileSize: size,
  };
}

async function wxCreateVideoDraft({ videoPath, coverPath, description, width, height, duration }) {
  const params = await wxUploadParams();
  const video = await wxCdnUpload(videoPath, path.basename(videoPath), params, 'videoFileType');
  let coverUrl = '';
  if (coverPath && fs.existsSync(coverPath)) {
    const cover = await wxCdnUpload(coverPath, path.basename(coverPath), params, 'pictureFileType');
    coverUrl = cover.url;
  }
  const clientid = crypto.randomUUID();
  const postReq = {
    objectType: 0,
    isFullPost: 1,
    handleFlag: 2,
    videoClipTaskId: '',
    longitude: 0, latitude: 0, feedLongitude: 0, feedLatitude: 0,
    originalFlag: 0, topics: [],
    objectDesc: {
      mpTitle: '',
      description: String(description || ''),
      extReading: { link: '', title: '' },
      mediaType: 4,
      location: {}, topic: { finderTopicInfo: '' }, event: {}, mentionedUser: [],
      media: [{
        url: video.url,
        fileSize: video.fileSize,
        thumbUrl: coverUrl,
        fullThumbUrl: coverUrl,
        mediaType: 4,
        videoPlayLen: Math.round(Number(duration) || 0),
        width: Number(width) || 0,
        height: Number(height) || 0,
        md5sum: video.taskId,
        ...(coverUrl ? { coverUrl, fullCoverUrl: coverUrl } : {}),
      }],
    },
    clientId: clientid,
    clientid,
  };
  const r = await wxApi('/cgi-bin/mmfinderassistant-bin/post/post_draft', { postReq, objectId: null });
  logSent('upload_draft', path.basename(videoPath), String(description || ''), r);
  if (r.errCode !== 0) {
    PLATFORMS.wechat.cookieValid = false;
    throw new Error(`post_draft errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) throw new Error(`post_draft baseResp.errcode=${baseResp.errcode}`);
  return { objectId: r.data?.objectId || '' };
}

// 上传串行队列（避免并发打 CDN）
let uploadChain = Promise.resolve();
function enqueueUpload(fn) {
  const job = uploadChain.then(fn);
  uploadChain = job.catch(() => { /* 不阻塞后续任务 */ });
  return job;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function lastCollectInfo() {
  const row = db.prepare('SELECT ts, result FROM collect_log ORDER BY id DESC LIMIT 1').get();
  if (!row) return { lastCollect: null, lastResult: null };
  let r = null;
  try { r = JSON.parse(row.result); } catch { /* ignore */ }
  return { lastCollect: row.ts, lastResult: r };
}

// ---------- 头像/图片代理（防盗链 + SSRF 白名单 + SQLite 缓存） ----------
const AVATAR_HOST_SUFFIXES = ['.qlogo.cn', '.finder.video.qq.com', '.douyinpic.com', '.douyincdn.com', '.douyinstatic.com'];
const AVATAR_HOSTS = new Set(['wx.qlogo.cn', 'finder.video.qq.com', 'douyinpic.com', 'douyincdn.com']);
const AVATAR_TTL = 86400;

function avatarHostAllowed(host) {
  return AVATAR_HOSTS.has(host) || AVATAR_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

async function handleAvatar(req, res, u) {
  const url = u.searchParams.get('url') || '';
  let host;
  try { host = new URL(url).hostname; } catch { return sendJson(res, 400, { error: 'bad url' }); }
  if (!avatarHostAllowed(host)) return sendJson(res, 403, { error: 'host not allowed' });
  const referer = host.includes('douyin') ? 'https://www.douyin.com/' : 'https://channels.weixin.qq.com/';
  const now = Math.floor(Date.now() / 1000);
  const cached = db.prepare('SELECT contentType, data, ts FROM avatar_cache WHERE url = ?').get(url);
  if (cached && now - cached.ts < AVATAR_TTL) {
    res.writeHead(200, { 'Content-Type': cached.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.end(cached.data);
  }
  try {
    const r = await fetch(url, {
      headers: { Referer: referer, 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    db.prepare(`INSERT INTO avatar_cache(url,contentType,data,ts) VALUES(?,?,?,?)
      ON CONFLICT(url) DO UPDATE SET contentType=excluded.contentType, data=excluded.data, ts=excluded.ts`)
      .run(url, ct, buf, now);
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
    res.end(buf);
  } catch (e) {
    if (cached) { // 上游挂了但有过期缓存，兜底返回
      res.writeHead(200, { 'Content-Type': cached.contentType || 'image/jpeg' });
      return res.end(cached.data);
    }
    sendJson(res, 502, { error: String(e && e.message || e) });
  }
}

// ---------- 人工写操作（串行队列，间隔 >= 8s 模拟人工） ----------
let writeQueue = Promise.resolve();
let lastWriteAt = 0;
function enqueueWrite(fn) {
  const job = writeQueue.then(async () => {
    const wait = 8000 - (Date.now() - lastWriteAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastWriteAt = Date.now();
    return fn();
  });
  writeQueue = job.catch(() => { /* 不阻塞后续任务 */ });
  return job;
}

function logSent(type, target, content, upstream) {
  db.prepare('INSERT INTO sent_log(ts,type,target,content,upstream) VALUES(?,?,?,?,?)')
    .run(Math.floor(Date.now() / 1000), type, target, content, JSON.stringify(upstream).slice(0, 2000));
}

async function replyToComment(platform, commentId, content) {
  if (platform !== 'wechat') throw new Error(`${PLATFORMS[platform]?.name || platform} 回复暂未接入`);
  const c = db.prepare("SELECT * FROM comments WHERE platform='wechat' AND commentId = ?").get(commentId);
  if (!c) throw new Error('评论不存在或未采集');
  // 字段结构来自官方 interaction 微前端：replyCommentId=被回复评论，rootCommentId=一级评论，comment=被回复评论对象
  const r = await wxApi(`${CGI}/comment/create_comment`, {
    exportId: c.exportId,
    replyCommentId: commentId,
    rootCommentId: c.rootCommentId || commentId,
    content,
    clientId: crypto.randomUUID(),
    comment: {
      commentId: c.commentId,
      commentNickname: c.nickname,
      commentContent: c.content,
      commentHeadurl: c.headUrl,
      commentCreatetime: String(c.createTime),
      commentLikeCount: c.likeCount,
    },
  });
  logSent('comment_reply', commentId, content, r);
  if (r.errCode !== 0) {
    PLATFORMS.wechat.cookieValid = false;
    throw new Error(`create_comment errCode=${r.errCode} errMsg=${r.errMsg || ''} baseResp=${JSON.stringify(r.data?.baseResp || {})}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) {
    throw new Error(`create_comment baseResp.errcode=${baseResp.errcode}（-4300=需要手机验证）`);
  }
  // 局部重采该视频评论
  const rr = { comments: 0 };
  await wxCollectCommentsForVideo(c.exportId, rr);
  return { upstream: r, recollected: rr.comments };
}

let selfUsername = null;
async function getSelfUsername() {
  if (selfUsername) return selfUsername;
  const r = await wxApi(`${CGI}/private-msg/get-finder-username`, {});
  if (r.errCode === 0 && r.data?.finderUsername) {
    selfUsername = String(r.data.finderUsername);
    return selfUsername;
  }
  // 兜底：从已采集消息里推自己的 v2_ ID
  const row = db.prepare("SELECT toUsername AS u FROM dm_messages WHERE platform='wechat' AND toUsername LIKE 'v2_%@finder' LIMIT 1").get();
  if (row) { selfUsername = row.u; return selfUsername; }
  throw new Error(`get-finder-username 失败: ${JSON.stringify(r).slice(0, 200)}`);
}

async function sendDM(sessionId, content) {
  const s = db.prepare("SELECT * FROM dm_sessions WHERE platform='wechat' AND sessionId = ?").get(sessionId);
  if (!s) throw new Error('会话不存在或未采集');
  const from = await getSelfUsername();
  const r = await wxApi(`${CGI}/private-msg/send-private-msg`, {
    msgPack: {
      sessionId,
      fromUsername: from,
      toUsername: s.username,
      msgType: 1, // BYP_TEXT
      textMsg: { content },
      cliMsgId: crypto.randomUUID(),
    },
  });
  logSent('dm_send', sessionId, content, r);
  if (r.errCode !== 0) {
    PLATFORMS.wechat.cookieValid = false;
    throw new Error(`send-private-msg errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) throw new Error(`send-private-msg baseResp.errcode=${baseResp.errcode}`);
  // 局部重采该会话消息
  const hm = await wxApi(`${CGI}/private-msg/get-history-msg`, { sessionId, cookie: '' });
  wxCheck(hm, 'dm_history');
  for (const m of hm.data?.msg || []) wxSaveMessage(m);
  return { upstream: r };
}

const routes = {
  'GET /api/status': (req, res) => {
    const { lastCollect, lastResult } = lastCollectInfo();
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const countBy = (t, p) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE platform=?`).get(p).n;
    const platforms = {};
    for (const [name, p] of Object.entries(PLATFORMS)) {
      platforms[name] = {
        name: p.name,
        cookieValid: p.cookieValid,
        hasCookie: Boolean(readCookie(name)),
      };
    }
    sendJson(res, 200, {
      lastCollect,
      collecting,
      platforms,
      lastError: lastResult && !lastResult.ok ? (lastResult.errors || []).join('; ') : null,
      counts: {
        videos: count('videos'),
        comments: count('comments'),
        sessions: count('dm_sessions'),
        messages: count('dm_messages'),
        byPlatform: {
          wechat: { videos: countBy('videos', 'wechat'), comments: countBy('comments', 'wechat') },
          douyin: { videos: countBy('videos', 'douyin'), comments: countBy('comments', 'douyin') },
        },
      },
    });
  },
  'GET /api/comments': (req, res, u) => {
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
    const platform = u.searchParams.get('platform') || '';
    const where = platform ? 'WHERE c.platform = ?' : '';
    const args = platform ? [platform, limit] : [limit];
    const list = db.prepare(`
      SELECT c.platform, c.commentId, c.exportId, c.nickname, c.content, c.headUrl, c.createTime, c.likeCount,
             v.title AS videoTitle, v.thumbUrl AS videoThumb
      FROM comments c LEFT JOIN videos v ON v.platform = c.platform AND v.objectId = c.exportId
      ${where} ORDER BY c.createTime DESC LIMIT ?`).all(...args);
    sendJson(res, 200, { list });
  },
  'GET /api/avatar': handleAvatar,
  // 视频列表（master-detail 左栏）：按「最新评论时间」倒序，可筛平台/只看有评论
  'GET /api/videos': (req, res, u) => {
    const platform = u.searchParams.get('platform') || '';
    const hasComments = u.searchParams.get('hasComments') === '1';
    const conds = [];
    const args = [];
    if (platform) { conds.push('v.platform = ?'); args.push(platform); }
    if (hasComments) conds.push('(SELECT COUNT(*) FROM comments c WHERE c.platform = v.platform AND c.exportId = v.objectId) > 0');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const sort = u.searchParams.get('sort') === 'time' ? 'time' : 'comment';
    const orderBy = sort === 'time'
      ? 'v.createTime DESC'
      : 'COALESCE(latestCommentTs, 0) DESC, v.createTime DESC';
    const list = db.prepare(`
      SELECT v.platform, v.objectId, v.title, v.thumbUrl, v.createTime, v.commentCount,
        (SELECT MAX(c.createTime) FROM comments c WHERE c.platform = v.platform AND c.exportId = v.objectId) AS latestCommentTs,
        (SELECT COUNT(*) FROM comments c WHERE c.platform = v.platform AND c.exportId = v.objectId) AS collectedComments
      FROM videos v ${where}
      ORDER BY ${orderBy}
      LIMIT 500`).all(...args);
    sendJson(res, 200, { list });
  },
  // 单个视频的评论树（master-detail 右栏）
  'GET /api/video/comments': (req, res, u) => {
    const platform = u.searchParams.get('platform') || 'wechat';
    const objectId = u.searchParams.get('objectId') || '';
    const all = db.prepare('SELECT * FROM comments WHERE platform = ? AND exportId = ? ORDER BY createTime ASC')
      .all(platform, objectId);
    const tops = all.filter((c) => !c.rootCommentId);
    const topIds = new Set(tops.map((c) => c.commentId));
    const byRoot = {};
    const orphans = [];
    for (const c of all) {
      if (!c.rootCommentId) continue;
      if (topIds.has(c.rootCommentId)) (byRoot[c.rootCommentId] = byRoot[c.rootCommentId] || []).push(c);
      else orphans.push(c);
    }
    sendJson(res, 200, {
      list: [
        ...tops.map((c) => ({ ...c, replies: byRoot[c.commentId] || [] })),
        ...orphans.map((c) => ({ ...c, replies: [] })),
      ],
    });
  },
  'GET /api/videos/with-comments': (req, res, u) => {
    // 视频卡片按「最新一条评论时间」倒序；评论按时间正序，楼中楼挂在 root 下
    const platform = u.searchParams.get('platform') || '';
    const where = platform ? 'WHERE v.platform = ?' : '';
    const videos = db.prepare(`
      SELECT v.platform, v.objectId, v.title, v.thumbUrl, v.createTime, v.commentCount,
             MAX(c.createTime) AS latestCommentTs
      FROM videos v JOIN comments c ON c.platform = v.platform AND c.exportId = v.objectId
      ${where} GROUP BY v.platform, v.objectId ORDER BY latestCommentTs DESC`)
      .all(...(platform ? [platform] : []));
    const stmt = db.prepare('SELECT * FROM comments WHERE platform = ? AND exportId = ? ORDER BY createTime ASC');
    const list = videos.map((v) => {
      const all = stmt.all(v.platform, v.objectId);
      const tops = all.filter((c) => !c.rootCommentId);
      const topIds = new Set(tops.map((c) => c.commentId));
      const byRoot = {};
      const orphans = [];
      for (const c of all) {
        if (!c.rootCommentId) continue;
        if (topIds.has(c.rootCommentId)) (byRoot[c.rootCommentId] = byRoot[c.rootCommentId] || []).push(c);
        else orphans.push(c); // root 评论已不可见，楼中楼降级为顶级展示
      }
      return {
        ...v,
        comments: [
          ...tops.map((c) => ({ ...c, replies: byRoot[c.commentId] || [] })),
          ...orphans.map((c) => ({ ...c, replies: [] })),
        ],
      };
    });
    sendJson(res, 200, { list });
  },
  'GET /api/dm/sessions': (req, res) => {
    const list = db.prepare(`
      SELECT s.platform, s.sessionId, s.username, s.nickname, s.headImgUrl, s.sessionType,
        (SELECT content FROM dm_messages m WHERE m.platform = s.platform AND m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastContent,
        (SELECT ts FROM dm_messages m WHERE m.platform = s.platform AND m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastTs,
        (SELECT COUNT(*) FROM dm_messages m WHERE m.platform = s.platform AND m.sessionId = s.sessionId) AS msgCount
      FROM dm_sessions s ORDER BY lastTs DESC`).all();
    for (const s of list) s.unread = 0; // demo 不做真未读
    sendJson(res, 200, { list });
  },
  'POST /api/collect': async (req, res) => {
    const r = await collectAll('manual');
    sendJson(res, 200, r);
  },
  'POST /api/cookie': async (req, res) => {
    const body = await readBody(req);
    const platform = String(body.platform || 'wechat');
    if (!PLATFORMS[platform]) return sendJson(res, 400, { ok: false, msg: `未知平台 ${platform}` });
    const cookie = String(body.cookie || '').trim();
    if (!cookie.includes('=')) return sendJson(res, 400, { ok: false, msg: 'cookie 格式不正确' });
    const where = writeCookie(platform, cookie);
    PLATFORMS[platform].cookieValid = null;
    sendJson(res, 200, { ok: true, platform, savedTo: where });
  },
};

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(STATIC_DIR, p));
  if (!file.startsWith(path.normalize(STATIC_DIR))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname;
    if (pathname.startsWith('/api/')) {
      const key = `${req.method} ${pathname}`;
      if (routes[key]) return await routes[key](req, res, u);
      // 上传文件（原始字节流，非 multipart）：?kind=video|cover&filename=xx.mp4
      if (req.method === 'POST' && pathname === '/api/upload/file') {
        const kind = u.searchParams.get('kind') === 'cover' ? 'cover' : 'video';
        const rawName = u.searchParams.get('filename') || (kind === 'cover' ? 'cover.jpg' : 'video.mp4');
        const safeName = path.basename(rawName).replace(/[^\w.一-龥-]+/g, '_').slice(-80);
        const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
        const dest = path.join(UPLOAD_DIR, id);
        try {
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(dest);
            req.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
            req.on('error', reject);
          });
        } catch (e) {
          try { fs.unlinkSync(dest); } catch { /* ignore */ }
          return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
        }
        const size = fs.statSync(dest).size;
        if (!size) {
          fs.unlinkSync(dest);
          return sendJson(res, 400, { ok: false, error: '空文件' });
        }
        return sendJson(res, 200, { ok: true, id, fileSize: size });
      }
      if (req.method === 'POST' && pathname === '/api/upload/draft') {
        const body = await readBody(req);
        const cleanId = (s) => path.basename(String(s || ''));
        const videoId = cleanId(body.videoId);
        const coverId = cleanId(body.coverId);
        if (!videoId) return sendJson(res, 400, { ok: false, error: '缺少 videoId' });
        const videoPath = path.join(UPLOAD_DIR, videoId);
        if (!videoPath.startsWith(UPLOAD_DIR) || !fs.existsSync(videoPath)) {
          return sendJson(res, 400, { ok: false, error: '视频文件不存在，请先上传' });
        }
        const coverPath = coverId ? path.join(UPLOAD_DIR, coverId) : '';
        try {
          const r = await enqueueUpload(() => wxCreateVideoDraft({
            videoPath,
            coverPath: coverPath.startsWith(UPLOAD_DIR) ? coverPath : '',
            description: body.description,
            width: body.width,
            height: body.height,
            duration: body.duration,
          }));
          return sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
        }
      }
      const m = pathname.match(/^\/api\/dm\/sessions\/([^/]+)\/messages$/) ;
      if (req.method === 'GET' && m) {
        const sid = decodeURIComponent(m[1]);
        const platform = u.searchParams.get('platform') || 'wechat';
        const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 1000);
        const rows = db.prepare(
          'SELECT * FROM dm_messages WHERE platform = ? AND sessionId = ? ORDER BY ts DESC LIMIT ?').all(platform, sid, limit);
        rows.reverse();
        return sendJson(res, 200, { list: rows });
      }
      const mReply = pathname.match(/^\/api\/comments\/([^/]+)\/reply$/);
      if (req.method === 'POST' && mReply) {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        const platform = String(body.platform || 'wechat');
        if (!content) return sendJson(res, 400, { ok: false, error: '内容为空' });
        try {
          const r = await enqueueWrite(() => replyToComment(platform, decodeURIComponent(mReply[1]), content));
          return sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
        }
      }
      const mSend = pathname.match(/^\/api\/dm\/sessions\/([^/]+)\/send$/);
      if (req.method === 'POST' && mSend) {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return sendJson(res, 400, { ok: false, error: '内容为空' });
        try {
          const r = await enqueueWrite(() => sendDM(decodeURIComponent(mSend[1]), content));
          return sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
        }
      }
      return sendJson(res, 404, { error: 'unknown api' });
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error('[http]', e);
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  // 上传大文件耗时长，放宽请求超时
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  console.log(`[inbox] listening on :${PORT}, db=${DB_PATH}, static=${STATIC_DIR}`);
  collectAll('startup');
  setInterval(() => { collectAll('interval').catch(console.error); }, 5 * 60 * 1000);
});
