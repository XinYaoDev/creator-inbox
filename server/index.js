// 聚合收件箱 —— 零依赖 Node 服务
// HTTP 静态托管 + API + 定时采集器（node:sqlite / node:http / global fetch）
// 模型：分组(account_groups) → 账号(accounts: 分组+平台+cookie) → 数据带 (platform, accountId) 维度
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

// ---------- 平台静态元数据（账号的 cookie/状态存 DB，不再按平台单份文件） ----------
const PLATFORMS = {
  wechat: { name: '视频号' },
  douyin: { name: '抖音' },
};

// ---------- 数据库 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS account_groups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupId INTEGER,
  platform TEXT NOT NULL,
  label TEXT,
  cookie TEXT DEFAULT '',
  cookieValid INTEGER,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS videos(
  platform TEXT NOT NULL,
  accountId INTEGER NOT NULL DEFAULT 0,
  objectId TEXT NOT NULL,
  title TEXT,
  thumbUrl TEXT,
  createTime INTEGER,
  commentCount INTEGER DEFAULT 0,
  PRIMARY KEY(platform, accountId, objectId)
);
CREATE TABLE IF NOT EXISTS comments(
  platform TEXT NOT NULL,
  accountId INTEGER NOT NULL DEFAULT 0,
  commentId TEXT NOT NULL,
  exportId TEXT,
  nickname TEXT,
  content TEXT,
  headUrl TEXT,
  createTime INTEGER,
  likeCount INTEGER DEFAULT 0,
  rootCommentId TEXT DEFAULT '',
  PRIMARY KEY(platform, accountId, commentId)
);
CREATE INDEX IF NOT EXISTS idx_comments_time ON comments(createTime DESC);
CREATE TABLE IF NOT EXISTS dm_sessions(
  platform TEXT NOT NULL,
  accountId INTEGER NOT NULL DEFAULT 0,
  sessionId TEXT NOT NULL,
  username TEXT,
  nickname TEXT,
  headImgUrl TEXT,
  sessionType INTEGER DEFAULT 1,
  PRIMARY KEY(platform, accountId, sessionId)
);
CREATE TABLE IF NOT EXISTS dm_messages(
  platform TEXT NOT NULL,
  accountId INTEGER NOT NULL DEFAULT 0,
  svrMsgId TEXT NOT NULL,
  sessionId TEXT,
  fromUsername TEXT,
  toUsername TEXT,
  content TEXT,
  ts INTEGER,
  msgType INTEGER,
  PRIMARY KEY(platform, accountId, svrMsgId)
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

// ---------- 迁移 ----------
// 1. 老 cookie 文件（.sph-cookie 挂载/override、.dy-cookie 挂载/override）→ accounts 表
function readLegacyCookie(files) {
  for (const f of files) {
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) return s;
    } catch { /* ignore */ }
  }
  return '';
}
{
  const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (!n) {
    const now = Math.floor(Date.now() / 1000);
    const gid = Number(
      db.prepare('INSERT INTO account_groups(name,createdAt) VALUES(?,?)').run('默认', now).lastInsertRowid);
    const insAcc = db.prepare(
      'INSERT INTO accounts(groupId,platform,label,cookie,createdAt) VALUES(?,?,?,?,?)');
    const wxCookie = readLegacyCookie([
      path.join(DATA_DIR, 'cookie.override'),
      process.env.COOKIE_FILE || '/run/secrets/cookie',
    ]);
    const dyCookie = readLegacyCookie([
      path.join(DATA_DIR, 'dy-cookie.override'),
      process.env.DY_COOKIE_FILE || '/run/secrets/dy-cookie',
    ]);
    insAcc.run(gid, 'wechat', '岳井民宿', wxCookie, now);
    insAcc.run(gid, 'douyin', '抖音主号', dyCookie, now);
    console.log(`[migrate] 初始化分组/账号，视频号 cookie ${wxCookie ? '已入库' : '缺失'}，抖音 cookie ${dyCookie ? '已入库' : '缺失'}`);
  }
}
// 2. 四张实体表无 accountId → 重建为 (platform, accountId, id) 复合主键
{
  const wxAccId = db.prepare("SELECT id FROM accounts WHERE platform='wechat' ORDER BY id LIMIT 1").get()?.id || 0;
  const dyAccId = db.prepare("SELECT id FROM accounts WHERE platform='douyin' ORDER BY id LIMIT 1").get()?.id || 0;
  const colTypes = {
    title: 'TEXT', thumbUrl: 'TEXT', createTime: 'INTEGER', commentCount: 'INTEGER DEFAULT 0',
    exportId: 'TEXT', nickname: 'TEXT', content: 'TEXT', headUrl: 'TEXT', likeCount: 'INTEGER DEFAULT 0',
    rootCommentId: "TEXT DEFAULT ''", username: 'TEXT', headImgUrl: 'TEXT', sessionType: 'INTEGER DEFAULT 1',
    fromUsername: 'TEXT', toUsername: 'TEXT', ts: 'INTEGER', msgType: 'INTEGER',
  };
  const migrate = (table, keyCol, otherCols) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length || cols.includes('accountId')) return;
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    const oldCols = db.prepare(`PRAGMA table_info(${table}_old)`).all().map((c) => c.name);
    const keep = otherCols.filter((c) => oldCols.includes(c));
    db.exec(`CREATE TABLE ${table}(
      platform TEXT NOT NULL,
      accountId INTEGER NOT NULL DEFAULT 0,
      ${keyCol} TEXT NOT NULL,
      ${keep.map((c) => `${c} ${colTypes[c] || 'TEXT'}`).join(',\n      ')},
      PRIMARY KEY(platform, accountId, ${keyCol})
    )`);
    db.prepare(`INSERT INTO ${table}(platform,accountId,${keyCol},${keep.join(',')})
      SELECT platform, CASE platform WHEN 'wechat' THEN ${wxAccId} WHEN 'douyin' THEN ${dyAccId} ELSE 0 END,
        ${keyCol},${keep.join(',')} FROM ${table}_old`).run();
    db.exec(`DROP TABLE ${table}_old`);
    console.log(`[migrate] ${table} → accountId 维度（wechat→账号${wxAccId} douyin→账号${dyAccId}）`);
  };
  migrate('videos', 'objectId', ['title', 'thumbUrl', 'createTime', 'commentCount']);
  migrate('comments', 'commentId', ['exportId', 'nickname', 'content', 'headUrl', 'createTime', 'likeCount', 'rootCommentId']);
  migrate('dm_sessions', 'sessionId', ['username', 'nickname', 'headImgUrl', 'sessionType']);
  migrate('dm_messages', 'svrMsgId', ['sessionId', 'fromUsername', 'toUsername', 'content', 'ts', 'msgType']);
}

// ---------- 账号 ----------
// 资料列（头像/昵称/粉丝数）增量迁移
{
  const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!cols.includes('nickname')) {
    db.exec("ALTER TABLE accounts ADD COLUMN nickname TEXT DEFAULT ''");
    db.exec("ALTER TABLE accounts ADD COLUMN headImgUrl TEXT DEFAULT ''");
    db.exec('ALTER TABLE accounts ADD COLUMN followers INTEGER');
  }
}

function listAccounts() {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all();
}
function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}
function setCookieValid(accountId, valid) {
  db.prepare('UPDATE accounts SET cookieValid = ? WHERE id = ?')
    .run(valid == null ? null : valid ? 1 : 0, accountId);
}
function saveAccountProfile(accountId, { nickname, headImgUrl, followers }) {
  db.prepare('UPDATE accounts SET nickname = ?, headImgUrl = ?, followers = ? WHERE id = ?')
    .run(String(nickname || ''), String(headImgUrl || ''), followers == null ? null : Number(followers), accountId);
}

const upVideo = db.prepare(`INSERT INTO videos(platform,accountId,objectId,title,thumbUrl,createTime,commentCount)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(platform,accountId,objectId) DO UPDATE SET title=excluded.title, thumbUrl=excluded.thumbUrl,
    createTime=excluded.createTime, commentCount=excluded.commentCount`);
const upComment = db.prepare(`INSERT INTO comments(platform,accountId,commentId,exportId,nickname,content,headUrl,createTime,likeCount,rootCommentId)
  VALUES(?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(platform,accountId,commentId) DO UPDATE SET nickname=excluded.nickname, content=excluded.content,
    headUrl=excluded.headUrl, createTime=excluded.createTime, likeCount=excluded.likeCount,
    rootCommentId=excluded.rootCommentId`);
const upSession = db.prepare(`INSERT INTO dm_sessions(platform,accountId,sessionId,username,nickname,headImgUrl,sessionType)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(platform,accountId,sessionId) DO UPDATE SET username=excluded.username, nickname=excluded.nickname,
    headImgUrl=excluded.headImgUrl, sessionType=excluded.sessionType`);
const upMessage = db.prepare(`INSERT INTO dm_messages(platform,accountId,svrMsgId,sessionId,fromUsername,toUsername,content,ts,msgType)
  VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(platform,accountId,svrMsgId) DO NOTHING`);

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

async function wxApi(acc, p, extra) {
  const res = await fetch(WX_BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: acc.cookie, 'User-Agent': UA },
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

function wxCheck(acc, r, stage) {
  if (r.errCode !== 0) {
    setCookieValid(acc.id, false);
    throw new Error(`${stage} errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
}

function wxSaveVideo(acc, v) {
  const d = v.desc || {};
  upVideo.run(
    'wechat', acc.id,
    String(v.objectId || ''),
    String(d.description || '').trim(),
    String((d.media && d.media[0] && d.media[0].thumbUrl) || ''),
    Number(v.createTime) || 0,
    Number(v.commentCount) || 0,
  );
}

function wxSaveComment(acc, exportId, c, rootCommentId = '') {
  const id = String(c.commentId || '');
  if (!id) return;
  upComment.run(
    'wechat', acc.id,
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

function wxSaveSession(acc, s) {
  if (!s.sessionId) return;
  upSession.run(
    'wechat', acc.id,
    String(s.sessionId),
    String(s.username || ''),
    String(s.nickname || ''),
    String(s.headImgUrl || ''),
    Number(s.sessionType) || 1,
  );
}

function wxSaveMessage(acc, m) {
  const id = String(m.svrMsgId || '');
  if (!id || !m.sessionId) return;
  const content = (m.textMsg && m.textMsg.content) || m.rawContent ||
    (Number(m.msgType) === 1 ? '' : `[非文本消息 type=${m.msgType}]`);
  upMessage.run(
    'wechat', acc.id,
    id,
    String(m.sessionId),
    String(m.fromUsername || ''),
    String(m.toUsername || ''),
    String(content),
    Number(m.ts) || 0,
    Number(m.msgType) || 0,
  );
}

async function wxCollectVideos(acc, result) {
  let lastBuff = '';
  const seen = new Set();
  for (let page = 0; page < 50; page++) {
    const r = await wxApi(acc, `${CGI}/post/post_list`, {
      pageSize: 10, onlyUnread: false, needAllCommentCount: true,
      userpageType: 13, forMcn: false, lastBuff,
    });
    wxCheck(acc, r, 'post_list');
    const d = r.data || {};
    const list = d.list || [];
    for (const v of list) { if (v.objectId) { wxSaveVideo(acc, v); result.videos++; } }
    lastBuff = d.lastBuff || '';
    if (!lastBuff || !list.length || seen.has(lastBuff)) break;
    seen.add(lastBuff);
  }
}

async function wxCollectCommentsForVideo(acc, objectId, result) {
  let buff = '';
  const seen = new Set();
  for (let page = 0; page < 30; page++) {
    const r = await wxApi(acc, `${CGI}/comment/comment_list`, {
      lastBuff: buff, exportId: String(objectId), commentSelection: false, forMcn: false,
    });
    wxCheck(acc, r, 'comment_list');
    const d = r.data || {};
    const list = d.comment || [];
    for (const c of list) {
      wxSaveComment(acc, objectId, c); result.comments++;
      for (const l2 of c.levelTwoComment || []) wxSaveComment(acc, objectId, l2, c.commentId);
    }
    buff = d.lastBuff || '';
    if (!buff || !list.length || seen.has(buff)) break;
    seen.add(buff);
  }
}

async function wxCollectComments(acc, result) {
  const vids = db.prepare("SELECT objectId FROM videos WHERE platform='wechat' AND accountId=? AND commentCount > 0")
    .all(acc.id);
  for (const { objectId } of vids) await wxCollectCommentsForVideo(acc, objectId, result);
}

async function wxCollectDM(acc, result) {
  // 1. 全局私信 feed（sessionId 置空即返回跨会话最新消息），顺带收集会话 ID
  const sessionIds = new Set();
  let cookie = '';
  const seenCk = new Set();
  for (let page = 0; page < 5; page++) {
    const r = await wxApi(acc, `${CGI}/private-msg/get-history-msg`, { sessionId: '', cookie });
    wxCheck(acc, r, 'dm_feed');
    const d = r.data || {};
    for (const m of d.msg || []) {
      if (m.sessionId) sessionIds.add(String(m.sessionId));
      wxSaveMessage(acc, m); result.messages++;
    }
    cookie = d.cookie || '';
    if (!d.isContinue || !cookie || seenCk.has(cookie)) break;
    seenCk.add(cookie);
  }
  // 2. 批量取会话资料（sessionId 必须传数组，传单个字符串只会得到空 extInfo）
  const sids = [...sessionIds];
  for (let i = 0; i < sids.length; i += 20) {
    const r = await wxApi(acc, `${CGI}/private-msg/get-session-info`, { sessionId: sids.slice(i, i + 20) });
    wxCheck(acc, r, 'dm_session_info');
    for (const s of r.data?.sessionInfo || []) { if (s.sessionId) { wxSaveSession(acc, s); result.sessions++; } }
  }
  // 3. 每个会话补一页历史
  for (const sid of sids) {
    const r = await wxApi(acc, `${CGI}/private-msg/get-history-msg`, { sessionId: sid, cookie: '' });
    wxCheck(acc, r, 'dm_history');
    for (const m of r.data?.msg || []) { wxSaveMessage(acc, m); result.messages++; }
  }
}

async function wxFetchProfile(acc) {
  const r = await wxApi(acc, '/cgi-bin/mmfinderassistant-bin/auth/auth_data', {});
  const f = r.data?.finderUser;
  if (r.errCode === 0 && f) {
    saveAccountProfile(acc.id, { nickname: f.nickname, headImgUrl: f.headImgUrl, followers: f.fansCount });
  }
}

async function wxCollect(acc, result) {
  await wxCollectVideos(acc, result);
  await wxCollectComments(acc, result);
  await wxCollectDM(acc, result);
  try { await wxFetchProfile(acc); } catch { /* 资料抓取失败不影响采集 */ }
}

// ---------- 抖音（douyin）适配器 ----------
// 侦察结论：creator.douyin.com 后台读接口不强制 a_bogus 签名，cookie 即可重放。
const DY_BASE = 'https://creator.douyin.com';
const DY_COMMENT_API = '/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/';

async function dyApi(acc, p) {
  const res = await fetch(DY_BASE + p, {
    headers: {
      Cookie: acc.cookie,
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
    setCookieValid(acc.id, false);
    throw new Error(`抖音上游返回非 JSON (HTTP ${res.status})，cookie 可能已失效: ${text.slice(0, 120)}`);
  }
  if (r.status_code != null && r.status_code !== 0) {
    setCookieValid(acc.id, false);
    throw new Error(`抖音接口 status_code=${r.status_code} status_msg=${r.status_msg || r.status_message || ''}`);
  }
  return r;
}

// 从对象里按多个候选路径取第一个非空字符串（抖音字段命名不稳定）
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

function dySaveVideo(acc, it) {
  const id = dyVideoId(it);
  if (!id) return;
  upVideo.run(
    'douyin', acc.id,
    id,
    String(it.title || it.desc || '').trim(),
    pick(it, ['cover_image_url', 'video_cover', 'cover', 'item_cover', 'cover_url', 'poster']),
    dyParseTime(it.create_time),
    Number(it.comment_count) || 0,
  );
}

function dySaveComment(acc, awemeId, c, rootCommentId = '') {
  const id = String(c.cid || '');
  if (!id) return;
  const u = c.user || {};
  upComment.run(
    'douyin', acc.id,
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

async function dyCollectVideos(acc, result) {
  let cursor = '';
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const r = await dyApi(acc, `/aweme/v1/creator/item/list/?cursor=${encodeURIComponent(cursor)}&aid=2906`);
    const list = r.item_info_list || [];
    for (const it of list) { if (dyVideoId(it)) { dySaveVideo(acc, it); result.videos++; } }
    if (!r.has_more || !list.length) break;
    cursor = String(r.cursor ?? '');
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
}

async function dyCollectCommentsForVideo(acc, awemeId, result) {
  let cursor = 0;
  for (let page = 0; page < 30; page++) {
    const r = await dyApi(acc, `${DY_COMMENT_API}?aweme_id=${encodeURIComponent(awemeId)}&cursor=${cursor}&count=20&aid=2906`);
    const list = r.comments || [];
    for (const c of list) {
      dySaveComment(acc, awemeId, c); result.comments++;
      for (const l2 of c.reply_comment || []) { dySaveComment(acc, awemeId, l2, c.cid); result.comments++; }
    }
    if (!r.has_more || !list.length) break;
    cursor = Number(r.cursor) || cursor + list.length;
  }
}

async function dyCollectComments(acc, result) {
  const vids = db.prepare("SELECT objectId FROM videos WHERE platform='douyin' AND accountId=? AND commentCount > 0")
    .all(acc.id);
  for (const { objectId } of vids) await dyCollectCommentsForVideo(acc, objectId, result);
}

async function dyFetchProfile(acc) {
  const r = await dyApi(acc, '/aweme/v1/creator/user/info/?aid=2906');
  const u = r.douyin_user_verify_info || {};
  if (u.nick_name) {
    saveAccountProfile(acc.id, { nickname: u.nick_name, headImgUrl: u.avatar_url, followers: u.follower_count });
  }
}

async function dyCollect(acc, result) {
  await dyCollectVideos(acc, result);
  await dyCollectComments(acc, result);
  try { await dyFetchProfile(acc); } catch { /* 资料抓取失败不影响采集 */ }
  // 私信：抖音走 imapi.douyin.com IM 体系（需 IM token + 自定义头），逆向成本高，第二批再接入
}

// ---------- 采集调度（遍历账号，同平台间隔 2.5s 防风控） ----------
const COLLECTORS = { wechat: wxCollect, douyin: dyCollect };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let collecting = false;
async function collectAll(trigger = 'auto') {
  if (collecting) return { skipped: true, msg: '上一次采集尚未结束' };
  collecting = true;
  const startedAt = Math.floor(Date.now() / 1000);
  const result = { trigger, accounts: {}, errors: [] };
  let first = true;
  for (const acc of listAccounts()) {
    const r = { videos: 0, comments: 0, sessions: 0, messages: 0 };
    const key = `${acc.id}:${acc.platform}:${acc.label || ''}`;
    if (!acc.cookie) {
      r.skipped = '无 cookie，未采集';
      result.accounts[key] = r;
      continue;
    }
    const collect = COLLECTORS[acc.platform];
    if (!collect) {
      r.skipped = `平台 ${acc.platform} 无适配器`;
      result.accounts[key] = r;
      continue;
    }
    if (!first) await sleep(2500);
    first = false;
    try {
      await collect(acc, r);
      setCookieValid(acc.id, true);
      r.ok = true;
    } catch (e) {
      r.ok = false;
      r.error = String(e && e.message || e);
      result.errors.push(`[${PLATFORMS[acc.platform]?.name || acc.platform}·${acc.label || acc.id}] ${r.error}`);
    }
    result.accounts[key] = r;
  }
  result.ok = result.errors.length === 0;
  result.elapsedSec = Math.floor(Date.now() / 1000) - startedAt;
  db.prepare('INSERT INTO collect_log(ts,result) VALUES(?,?)').run(startedAt, JSON.stringify(result));
  collecting = false;
  console.log(`[collect] ${trigger} ok=${result.ok}`, JSON.stringify(result));
  return result;
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

// 分组筛选 → 账号 id 列表；返回 null 表示不筛选
function accountIdsForGroup(groupId) {
  if (!groupId) return null;
  return db.prepare('SELECT id FROM accounts WHERE groupId = ?').all(Number(groupId)).map((r) => r.id);
}
// 拼 accountId IN (...) 条件；ids 为空数组时强制无结果
function accountCond(col, ids, args) {
  if (ids === null) return '1=1';
  if (!ids.length) return '1=0';
  args.push(...ids);
  return `${col} IN (${ids.map(() => '?').join(',')})`;
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
  const acc = getAccount(c.accountId);
  if (!acc || !acc.cookie) throw new Error('该评论所属账号无 cookie');
  // 字段结构来自官方 interaction 微前端：replyCommentId=被回复评论，rootCommentId=一级评论，comment=被回复评论对象
  const r = await wxApi(acc, `${CGI}/comment/create_comment`, {
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
    setCookieValid(acc.id, false);
    throw new Error(`create_comment errCode=${r.errCode} errMsg=${r.errMsg || ''} baseResp=${JSON.stringify(r.data?.baseResp || {})}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) {
    throw new Error(`create_comment baseResp.errcode=${baseResp.errcode}（-4300=需要手机验证）`);
  }
  // 局部重采该视频评论
  const rr = { comments: 0 };
  await wxCollectCommentsForVideo(acc, c.exportId, rr);
  return { upstream: r, recollected: rr.comments };
}

const selfUsernameByAcc = new Map();
async function getSelfUsername(acc) {
  if (selfUsernameByAcc.has(acc.id)) return selfUsernameByAcc.get(acc.id);
  const r = await wxApi(acc, `${CGI}/private-msg/get-finder-username`, {});
  if (r.errCode === 0 && r.data?.finderUsername) {
    const u = String(r.data.finderUsername);
    selfUsernameByAcc.set(acc.id, u);
    return u;
  }
  // 兜底：从已采集消息里推自己的 v2_ ID
  const row = db.prepare("SELECT toUsername AS u FROM dm_messages WHERE platform='wechat' AND accountId=? AND toUsername LIKE 'v2_%@finder' LIMIT 1")
    .get(acc.id);
  if (row) { selfUsernameByAcc.set(acc.id, row.u); return row.u; }
  throw new Error(`get-finder-username 失败: ${JSON.stringify(r).slice(0, 200)}`);
}

async function sendDM(sessionId, accountId, content) {
  const s = db.prepare("SELECT * FROM dm_sessions WHERE platform='wechat' AND sessionId = ? AND accountId = ?")
    .get(sessionId, accountId);
  if (!s) throw new Error('会话不存在或未采集');
  const acc = getAccount(s.accountId);
  if (!acc || !acc.cookie) throw new Error('该会话所属账号无 cookie');
  const from = await getSelfUsername(acc);
  const r = await wxApi(acc, `${CGI}/private-msg/send-private-msg`, {
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
    setCookieValid(acc.id, false);
    throw new Error(`send-private-msg errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) throw new Error(`send-private-msg baseResp.errcode=${baseResp.errcode}`);
  // 局部重采该会话消息
  const hm = await wxApi(acc, `${CGI}/private-msg/get-history-msg`, { sessionId, cookie: '' });
  wxCheck(acc, hm, 'dm_history');
  for (const m of hm.data?.msg || []) wxSaveMessage(acc, m);
  return { upstream: r };
}

// ---------- 视频号视频上传（存草稿） ----------
// 协议来自 finder-helper-web bundle 逆向：helper_upload_params 取凭证 →
// finderassistance*.video.qq.com 四步分片上传（applyuploaddfs/uploadpartdfs/completepartuploaddfs）→ post_draft
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CDN_CHUNK = 8 * 1024 * 1024;
const wxUploadParamsCache = new Map(); // accountId → params
let wxCdnHosts = [];

async function wxUploadParams(acc, force = false) {
  if (!force && wxUploadParamsCache.has(acc.id)) return wxUploadParamsCache.get(acc.id);
  const r = await wxApi(acc, '/cgi-bin/mmfinderassistant-bin/helper/helper_upload_params', {});
  if (r.errCode !== 0) {
    setCookieValid(acc.id, false);
    throw new Error(`helper_upload_params errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  wxUploadParamsCache.set(acc.id, r.data);
  if (!wxCdnHosts.length) {
    try {
      const a = await wxApi(acc, '/cgi-bin/mmfinderassistant-bin/auth/auth_data', {});
      const hosts = a?.data?.envInfo?.cdnHostList;
      if (Array.isArray(hosts) && hosts.length) wxCdnHosts = hosts;
    } catch { /* 用默认 host */ }
    if (!wxCdnHosts.length) wxCdnHosts = ['finderassistancea.video.qq.com'];
  }
  return r.data;
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

async function wxCreateVideoDraft(acc, { videoPath, coverPath, description, width, height, duration }) {
  const params = await wxUploadParams(acc);
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
  const r = await wxApi(acc, '/cgi-bin/mmfinderassistant-bin/post/post_draft', { postReq, objectId: null });
  logSent('upload_draft', `${acc.label || acc.id}:${path.basename(videoPath)}`, String(description || ''), r);
  if (r.errCode !== 0) {
    setCookieValid(acc.id, false);
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

// ---------- 视频号扫码登录（qrconnect OAuth 复现，已实测全链路） ----------
const WX_LOGIN_APPID = 'wx20d84d087938fd46';
const loginSessions = new Map(); // sessionId → session

function loginCleanup() {
  const now = Date.now();
  for (const [id, s] of loginSessions) {
    if (now - s.createdAt > 15 * 60 * 1000) loginSessions.delete(id);
  }
}

function jarHarvest(s, res) {
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) s.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const jarHeader = (s) => [...s.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function wxLoginCgi(s, p, body) {
  const res = await fetch(`https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Cookie: jarHeader(s) },
    body: JSON.stringify({ timestamp: String(Date.now()), ...body }),
    signal: AbortSignal.timeout(20000),
  });
  jarHarvest(s, res);
  return res.json();
}

async function wxLoginStart(accountId) {
  loginCleanup();
  const pageUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${WX_LOGIN_APPID}&scope=snsapi_login` +
    `&redirect_uri=${encodeURIComponent('https://channels.weixin.qq.com/platform/oauth-callback.html?dark=0')}` +
    `&state=undefined&login_type=jssdk&self_redirect=true&styletype=&sizetype=&bgcolor=&rst=&ts=${Date.now()}` +
    `&style=black&stylelite=1&color_scheme=light`;
  const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  const uuid = html.match(/\/connect\/qrcode\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!uuid) throw new Error('未能从 qrconnect 页面提取 uuid');
  const s = {
    id: crypto.randomUUID(), accountId, uuid,
    status: 'waiting', // waiting|scanned|confirmed|choose|done|expired|cancelled|error
    jar: new Map(), finderList: null, error: '', qrImg: null, qrType: 'image/png', createdAt: Date.now(),
  };
  loginSessions.set(s.id, s);
  wxLoginPoll(s).catch((e) => {
    if (!['done', 'cancelled'].includes(s.status)) {
      s.status = 'error';
      s.error = String(e && e.message || e);
    }
  });
  return { sessionId: s.id };
}

async function wxLoginPoll(s) {
  let last = '';
  for (let round = 0; round < 90; round++) {
    if (s.status === 'cancelled') return;
    let text;
    try {
      const url = `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${s.uuid}${last ? `&last=${last}` : ''}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' },
        signal: AbortSignal.timeout(45000),
      });
      text = await res.text();
    } catch { continue; } // 网络抖动直接续轮
    const errcode = text.match(/wx_errcode=(\d+)/)?.[1];
    const code = text.match(/wx_code='([^']*)'/)?.[1];
    if (errcode === '405' && code) {
      s.status = 'confirmed';
      await wxLoginExchange(s, code);
      return;
    }
    if (errcode === '402') { s.status = 'expired'; return; }
    if (errcode === '403') { s.status = 'cancelled'; return; }
    if (errcode === '404') { s.status = 'scanned'; if (code) last = code; }
    // 408/其他 → 继续长轮询
  }
  s.status = 'expired';
}

async function wxLoginExchange(s, code) {
  const r1 = await wxLoginCgi(s, '/auth/auth_with_oauth', { oauthCode: code });
  if (r1.errCode !== 0) { s.status = 'error'; s.error = `auth_with_oauth errCode=${r1.errCode}`; return; }
  const r2 = await wxLoginCgi(s, '/auth/auth_finder_list', {});
  if (r2.errCode !== 0) { s.status = 'error'; s.error = `auth_finder_list errCode=${r2.errCode}`; return; }
  const list = (r2.data?.finderList || [])
    .filter((f) => f.finderUsername)
    .map((f) => ({ finderUsername: String(f.finderUsername), nickname: String(f.nickname || ''), headImgUrl: String(f.headImgUrl || '') }));
  if (!list.length) { s.status = 'error'; s.error = '该微信下没有可登录的视频号'; return; }
  if (list.length === 1) { await wxLoginChoose(s, list[0].finderUsername); return; }
  s.finderList = list;
  s.status = 'choose';
}

async function wxLoginChoose(s, finderUsername) {
  const r = await wxLoginCgi(s, '/auth/login_finder', { finderUsername });
  if (r.errCode !== 0) { s.status = 'error'; s.error = `login_finder errCode=${r.errCode}`; return; }
  const acc = getAccount(s.accountId);
  if (acc) {
    db.prepare('UPDATE accounts SET cookie = ?, cookieValid = 1 WHERE id = ?').run(jarHeader(s), acc.id);
    wxUploadParamsCache.delete(acc.id); // 上传凭证按新 cookie 重取
    // 顺手抓资料
    try {
      const r2 = await wxLoginCgi(s, '/auth/auth_data', {});
      const f = r2.data?.finderUser;
      if (f) saveAccountProfile(acc.id, { nickname: f.nickname, headImgUrl: f.headImgUrl, followers: f.fansCount });
    } catch { /* 非关键 */ }
  }
  s.status = 'done';
}

// ---------- 路由 ----------
const routes = {
  'GET /api/status': (req, res) => {
    const { lastCollect, lastResult } = lastCollectInfo();
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const accounts = listAccounts();
    // 平台聚合状态：任一账号失效即失效；全有效才有效；都没采过为未知
    const platforms = {};
    for (const [pname, p] of Object.entries(PLATFORMS)) {
      const accs = accounts.filter((a) => a.platform === pname);
      const withCookie = accs.filter((a) => a.cookie);
      let cookieValid = null;
      if (withCookie.length) {
        const valids = withCookie.map((a) => a.cookieValid);
        cookieValid = valids.every((v) => v === 1) ? true : valids.some((v) => v === 0) ? false : null;
      }
      platforms[pname] = {
        name: p.name,
        cookieValid,
        hasCookie: withCookie.length > 0,
        accountCount: accs.length,
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
          wechat: {
            videos: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE platform='wechat'").get().n,
            comments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE platform='wechat'").get().n,
          },
          douyin: {
            videos: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE platform='douyin'").get().n,
            comments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE platform='douyin'").get().n,
          },
        },
      },
    });
  },
  // 分组 + 账号树
  'GET /api/accounts': (req, res) => {
    const groups = db.prepare('SELECT * FROM account_groups ORDER BY id').all();
    const accounts = listAccounts().map((a) => ({
      id: a.id,
      groupId: a.groupId,
      platform: a.platform,
      platformName: PLATFORMS[a.platform]?.name || a.platform,
      label: a.label || '',
      nickname: a.nickname || '',
      headImgUrl: a.headImgUrl || '',
      followers: a.followers == null ? null : a.followers,
      hasCookie: Boolean(a.cookie),
      cookieValid: a.cookieValid == null ? null : a.cookieValid === 1,
    }));
    sendJson(res, 200, { groups, accounts });
  },
  'POST /api/groups': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, error: '分组名为空' });
    const r = db.prepare('INSERT INTO account_groups(name,createdAt) VALUES(?,?)')
      .run(name, Math.floor(Date.now() / 1000));
    sendJson(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  },
  'POST /api/accounts': async (req, res) => {
    const body = await readBody(req);
    const groupId = Number(body.groupId) || null;
    const platform = String(body.platform || '');
    const label = String(body.label || '').trim();
    if (!PLATFORMS[platform]) return sendJson(res, 400, { ok: false, error: `未知平台 ${platform}` });
    if (!groupId || !db.prepare('SELECT id FROM account_groups WHERE id=?').get(groupId)) {
      return sendJson(res, 400, { ok: false, error: '分组不存在' });
    }
    const r = db.prepare('INSERT INTO accounts(groupId,platform,label,createdAt) VALUES(?,?,?,?)')
      .run(groupId, platform, label, Math.floor(Date.now() / 1000));
    sendJson(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  },
  'GET /api/comments': (req, res, u) => {
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
    const platform = u.searchParams.get('platform') || '';
    const ids = accountIdsForGroup(u.searchParams.get('groupId'));
    const args = [];
    const conds = [accountCond('c.accountId', ids, args)];
    if (platform) { conds.push('c.platform = ?'); args.push(platform); }
    args.push(limit);
    const list = db.prepare(`
      SELECT c.platform, c.accountId, c.commentId, c.exportId, c.nickname, c.content, c.headUrl, c.createTime, c.likeCount,
             v.title AS videoTitle, v.thumbUrl AS videoThumb
      FROM comments c LEFT JOIN videos v ON v.platform = c.platform AND v.accountId = c.accountId AND v.objectId = c.exportId
      WHERE ${conds.join(' AND ')} ORDER BY c.createTime DESC LIMIT ?`).all(...args);
    sendJson(res, 200, { list });
  },
  'GET /api/avatar': handleAvatar,
  // 视频列表（master-detail 左栏）：可筛平台/分组/只看有评论，两种排序
  'GET /api/videos': (req, res, u) => {
    const platform = u.searchParams.get('platform') || '';
    const hasComments = u.searchParams.get('hasComments') === '1';
    const ids = accountIdsForGroup(u.searchParams.get('groupId'));
    const args = [];
    const conds = [accountCond('v.accountId', ids, args)];
    if (platform) { conds.push('v.platform = ?'); args.push(platform); }
    if (hasComments) {
      conds.push('(SELECT COUNT(*) FROM comments c WHERE c.platform = v.platform AND c.accountId = v.accountId AND c.exportId = v.objectId) > 0');
    }
    const sort = u.searchParams.get('sort') === 'time' ? 'time' : 'comment';
    const orderBy = sort === 'time'
      ? 'v.createTime DESC'
      : 'COALESCE(latestCommentTs, 0) DESC, v.createTime DESC';
    const list = db.prepare(`
      SELECT v.platform, v.accountId, v.objectId, v.title, v.thumbUrl, v.createTime, v.commentCount,
        (SELECT MAX(c.createTime) FROM comments c WHERE c.platform = v.platform AND c.accountId = v.accountId AND c.exportId = v.objectId) AS latestCommentTs,
        (SELECT COUNT(*) FROM comments c WHERE c.platform = v.platform AND c.accountId = v.accountId AND c.exportId = v.objectId) AS collectedComments
      FROM videos v WHERE ${conds.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT 500`).all(...args);
    sendJson(res, 200, { list });
  },
  // 单个视频的评论树（master-detail 右栏）
  'GET /api/video/comments': (req, res, u) => {
    const platform = u.searchParams.get('platform') || 'wechat';
    const accountId = Number(u.searchParams.get('accountId')) || 0;
    const objectId = u.searchParams.get('objectId') || '';
    const all = db.prepare('SELECT * FROM comments WHERE platform = ? AND accountId = ? AND exportId = ? ORDER BY createTime ASC')
      .all(platform, accountId, objectId);
    const tops = all.filter((c) => !c.rootCommentId);
    const topIds = new Set(tops.map((c) => c.commentId));
    const byRoot = {};
    const orphans = [];
    for (const c of all) {
      if (!c.rootCommentId) continue;
      if (topIds.has(c.rootCommentId)) (byRoot[c.rootCommentId] = byRoot[c.rootCommentId] || []).push(c);
      else orphans.push(c); // root 评论已不可见，楼中楼降级为顶级展示
    }
    sendJson(res, 200, {
      list: [
        ...tops.map((c) => ({ ...c, replies: byRoot[c.commentId] || [] })),
        ...orphans.map((c) => ({ ...c, replies: [] })),
      ],
    });
  },
  'GET /api/dm/sessions': (req, res, u) => {
    const ids = accountIdsForGroup(u.searchParams.get('groupId'));
    const args = [];
    const cond = accountCond('s.accountId', ids, args);
    const list = db.prepare(`
      SELECT s.platform, s.accountId, s.sessionId, s.username, s.nickname, s.headImgUrl, s.sessionType,
        (SELECT content FROM dm_messages m WHERE m.platform = s.platform AND m.accountId = s.accountId AND m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastContent,
        (SELECT ts FROM dm_messages m WHERE m.platform = s.platform AND m.accountId = s.accountId AND m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastTs,
        (SELECT COUNT(*) FROM dm_messages m WHERE m.platform = s.platform AND m.accountId = s.accountId AND m.sessionId = s.sessionId) AS msgCount
      FROM dm_sessions s WHERE ${cond} ORDER BY lastTs DESC`).all(...args);
    for (const s of list) s.unread = 0; // demo 不做真未读
    sendJson(res, 200, { list });
  },
  'POST /api/collect': async (req, res) => {
    const r = await collectAll('manual');
    sendJson(res, 200, r);
  },
  // ---------- 扫码登录 ----------
  'POST /api/login/start': async (req, res) => {
    const body = await readBody(req);
    const acc = getAccount(Number(body.accountId));
    if (!acc) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    if (acc.platform !== 'wechat') {
      return sendJson(res, 400, { ok: false, error: `${PLATFORMS[acc.platform]?.name || acc.platform} 扫码登录暂未接入，请粘贴 Cookie` });
    }
    try {
      const r = await wxLoginStart(acc.id);
      sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String(e && e.message || e) });
    }
  },
  'GET /api/login/qr': async (req, res, u) => {
    const s = loginSessions.get(String(u.searchParams.get('sessionId') || ''));
    if (!s) return sendJson(res, 404, { error: '登录会话不存在或已过期' });
    try {
      if (!s.qrImg) {
        const r = await fetch(`https://open.weixin.qq.com/connect/qrcode/${s.uuid}`, {
          headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`二维码拉取 HTTP ${r.status}`);
        s.qrType = (r.headers.get('content-type') || 'image/png').split(';')[0];
        s.qrImg = Buffer.from(await r.arrayBuffer());
      }
      res.writeHead(200, { 'Content-Type': s.qrType, 'Cache-Control': 'no-store' });
      res.end(s.qrImg);
    } catch (e) {
      sendJson(res, 502, { error: String(e && e.message || e) });
    }
  },
  'GET /api/login/status': (req, res, u) => {
    const s = loginSessions.get(String(u.searchParams.get('sessionId') || ''));
    if (!s) return sendJson(res, 404, { ok: false, error: '登录会话不存在或已过期' });
    sendJson(res, 200, { ok: true, status: s.status, error: s.error, finderList: s.finderList });
  },
  'POST /api/login/choose': async (req, res) => {
    const body = await readBody(req);
    const s = loginSessions.get(String(body.sessionId || ''));
    if (!s) return sendJson(res, 404, { ok: false, error: '登录会话不存在或已过期' });
    if (s.status !== 'choose') return sendJson(res, 400, { ok: false, error: `当前状态 ${s.status} 不能选号` });
    const fu = String(body.finderUsername || '');
    if (!s.finderList?.some((f) => f.finderUsername === fu)) {
      return sendJson(res, 400, { ok: false, error: 'finderUsername 不在候选列表' });
    }
    await wxLoginChoose(s, fu);
    sendJson(res, 200, { ok: s.status === 'done', status: s.status, error: s.error });
  },
  'POST /api/login/cancel': async (req, res) => {
    const body = await readBody(req);
    const s = loginSessions.get(String(body.sessionId || ''));
    if (s) {
      s.status = 'cancelled';
      loginSessions.delete(s.id);
    }
    sendJson(res, 200, { ok: true });
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
      // 存草稿：body.accountId 单账号 或 body.groupId 整组（视频号账号逐个执行）
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
        let targets = [];
        if (body.groupId) {
          targets = listAccounts().filter((a) => a.groupId === Number(body.groupId));
        } else if (body.accountId) {
          const a = getAccount(Number(body.accountId));
          if (a) targets = [a];
        }
        if (!targets.length) return sendJson(res, 400, { ok: false, error: '没有目标账号' });
        const results = [];
        for (const acc of targets) {
          if (acc.platform !== 'wechat') {
            results.push({ accountId: acc.id, label: acc.label, platform: acc.platform, ok: false, error: `${PLATFORMS[acc.platform]?.name || acc.platform} 上传暂未接入` });
            continue;
          }
          if (!acc.cookie) {
            results.push({ accountId: acc.id, label: acc.label, platform: acc.platform, ok: false, error: '无 cookie' });
            continue;
          }
          try {
            const r = await enqueueUpload(() => wxCreateVideoDraft(acc, {
              videoPath,
              coverPath: coverPath.startsWith(UPLOAD_DIR) ? coverPath : '',
              description: body.description,
              width: body.width,
              height: body.height,
              duration: body.duration,
            }));
            results.push({ accountId: acc.id, label: acc.label, platform: acc.platform, ok: true, ...r });
          } catch (e) {
            results.push({ accountId: acc.id, label: acc.label, platform: acc.platform, ok: false, error: String(e && e.message || e) });
          }
        }
        return sendJson(res, 200, { ok: results.every((r) => r.ok), results });
      }
      // 账号 cookie 更新/删除
      const mAccCookie = pathname.match(/^\/api\/accounts\/(\d+)\/cookie$/);
      if (req.method === 'POST' && mAccCookie) {
        const acc = getAccount(Number(mAccCookie[1]));
        if (!acc) return sendJson(res, 404, { ok: false, error: '账号不存在' });
        const body = await readBody(req);
        const cookie = String(body.cookie || '').trim();
        if (!cookie.includes('=')) return sendJson(res, 400, { ok: false, error: 'cookie 格式不正确' });
        db.prepare('UPDATE accounts SET cookie = ?, cookieValid = NULL WHERE id = ?').run(cookie, acc.id);
        return sendJson(res, 200, { ok: true });
      }
      const mAcc = pathname.match(/^\/api\/accounts\/(\d+)$/);
      if (req.method === 'DELETE' && mAcc) {
        const id = Number(mAcc[1]);
        db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
      }
      const mGrp = pathname.match(/^\/api\/groups\/(\d+)$/);
      if (req.method === 'DELETE' && mGrp) {
        const id = Number(mGrp[1]);
        const n = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE groupId = ?').get(id).n;
        if (n) return sendJson(res, 400, { ok: false, error: '分组下还有账号，先删账号' });
        db.prepare('DELETE FROM account_groups WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
      }
      const m = pathname.match(/^\/api\/dm\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && m) {
        const sid = decodeURIComponent(m[1]);
        const platform = u.searchParams.get('platform') || 'wechat';
        const accountId = Number(u.searchParams.get('accountId')) || 0;
        const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 1000);
        const rows = db.prepare(
          'SELECT * FROM dm_messages WHERE platform = ? AND accountId = ? AND sessionId = ? ORDER BY ts DESC LIMIT ?')
          .all(platform, accountId, sid, limit);
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
        const accountId = Number(body.accountId) || 0;
        if (!content) return sendJson(res, 400, { ok: false, error: '内容为空' });
        try {
          const r = await enqueueWrite(() => sendDM(decodeURIComponent(mSend[1]), accountId, content));
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
