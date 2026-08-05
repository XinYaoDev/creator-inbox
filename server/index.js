// 视频号聚合收件箱 demo —— 零依赖 Node 服务
// HTTP 静态托管 + API + 定时采集器（node:sqlite / node:http / global fetch）
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8877);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inbox.db');
const COOKIE_FILE = process.env.COOKIE_FILE || '/run/secrets/cookie';
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'dist');
// cookie 挂载为只读，更新时落到数据目录的 override 文件
const COOKIE_OVERRIDE = path.join(path.dirname(DB_PATH), 'cookie.override');

const BASE = 'https://channels.weixin.qq.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const COMMON = {
  _log_finder_uin: '',
  _log_finder_id: 'v2_060000231003b20faec8c4ea8911c0d1c603ec35b077cc8c2950945db6825f2e3f6aefdcc82a@finder',
  rawKeyBuff: '',
  pluginSessionId: null,
  scene: 7,
  reqScene: 7,
};
const CGI = '/micro/interaction/cgi-bin/mmfinderassistant-bin';

// ---------- cookie ----------
function readCookie() {
  for (const f of [COOKIE_OVERRIDE, COOKIE_FILE]) {
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) return s;
    } catch { /* ignore */ }
  }
  return '';
}

function writeCookie(cookie) {
  try {
    fs.writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
    try { fs.unlinkSync(COOKIE_OVERRIDE); } catch { /* ignore */ }
    return COOKIE_FILE;
  } catch {
    fs.mkdirSync(path.dirname(COOKIE_OVERRIDE), { recursive: true });
    fs.writeFileSync(COOKIE_OVERRIDE, cookie, { mode: 0o600 });
    return COOKIE_OVERRIDE;
  }
}

// ---------- 数据库 ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS videos(
  objectId TEXT PRIMARY KEY,
  title TEXT,
  thumbUrl TEXT,
  createTime INTEGER,
  commentCount INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments(
  commentId TEXT PRIMARY KEY,
  exportId TEXT,
  nickname TEXT,
  content TEXT,
  headUrl TEXT,
  createTime INTEGER,
  likeCount INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_time ON comments(createTime DESC);
CREATE TABLE IF NOT EXISTS dm_sessions(
  sessionId TEXT PRIMARY KEY,
  username TEXT,
  nickname TEXT,
  headImgUrl TEXT,
  sessionType INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dm_messages(
  svrMsgId TEXT PRIMARY KEY,
  sessionId TEXT,
  fromUsername TEXT,
  toUsername TEXT,
  content TEXT,
  ts INTEGER,
  msgType INTEGER
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

// 迁移：comments 需要 rootCommentId 表达楼中楼父子关系；旧数据无此列则加列并重采
{
  const cols = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (!cols.includes('rootCommentId')) {
    db.exec("ALTER TABLE comments ADD COLUMN rootCommentId TEXT DEFAULT ''");
    db.exec('DELETE FROM comments');
  }
}

const upVideo = db.prepare(`INSERT INTO videos(objectId,title,thumbUrl,createTime,commentCount)
  VALUES(?,?,?,?,?)
  ON CONFLICT(objectId) DO UPDATE SET title=excluded.title, thumbUrl=excluded.thumbUrl,
    createTime=excluded.createTime, commentCount=excluded.commentCount`);
const upComment = db.prepare(`INSERT INTO comments(commentId,exportId,nickname,content,headUrl,createTime,likeCount,rootCommentId)
  VALUES(?,?,?,?,?,?,?,?)
  ON CONFLICT(commentId) DO UPDATE SET nickname=excluded.nickname, content=excluded.content,
    headUrl=excluded.headUrl, createTime=excluded.createTime, likeCount=excluded.likeCount,
    rootCommentId=excluded.rootCommentId`);
const upSession = db.prepare(`INSERT INTO dm_sessions(sessionId,username,nickname,headImgUrl,sessionType)
  VALUES(?,?,?,?,?)
  ON CONFLICT(sessionId) DO UPDATE SET username=excluded.username, nickname=excluded.nickname,
    headImgUrl=excluded.headImgUrl, sessionType=excluded.sessionType`);
const upMessage = db.prepare(`INSERT INTO dm_messages(svrMsgId,sessionId,fromUsername,toUsername,content,ts,msgType)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(svrMsgId) DO NOTHING`);

// ---------- 上游 API ----------
async function api(p, extra) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: readCookie(), 'User-Agent': UA },
    body: JSON.stringify({ timestamp: String(Date.now()), ...COMMON, ...extra }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`上游返回非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
}

let cookieValid = null; // null=未采集过
function checkErr(r, stage) {
  if (r.errCode !== 0) {
    cookieValid = false;
    throw new Error(`${stage} errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
}

// ---------- 采集 ----------
function saveVideo(v) {
  const d = v.desc || {};
  upVideo.run(
    String(v.objectId || ''),
    String(d.description || '').trim(),
    String((d.media && d.media[0] && d.media[0].thumbUrl) || ''),
    Number(v.createTime) || 0,
    Number(v.commentCount) || 0,
  );
}

function saveComment(exportId, c, rootCommentId = '') {
  const id = String(c.commentId || '');
  if (!id) return;
  upComment.run(
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

function saveSession(s) {
  if (!s.sessionId) return;
  upSession.run(
    String(s.sessionId),
    String(s.username || ''),
    String(s.nickname || ''),
    String(s.headImgUrl || ''),
    Number(s.sessionType) || 1,
  );
}

function saveMessage(m) {
  const id = String(m.svrMsgId || '');
  if (!id || !m.sessionId) return;
  const content = (m.textMsg && m.textMsg.content) || m.rawContent ||
    (Number(m.msgType) === 1 ? '' : `[非文本消息 type=${m.msgType}]`);
  upMessage.run(
    id,
    String(m.sessionId),
    String(m.fromUsername || ''),
    String(m.toUsername || ''),
    String(content),
    Number(m.ts) || 0,
    Number(m.msgType) || 0,
  );
}

async function collectVideos(result) {
  let lastBuff = '';
  const seen = new Set();
  for (let page = 0; page < 50; page++) {
    const r = await api(`${CGI}/post/post_list`, {
      pageSize: 10, onlyUnread: false, needAllCommentCount: true,
      userpageType: 13, forMcn: false, lastBuff,
    });
    checkErr(r, 'post_list');
    const d = r.data || {};
    const list = d.list || [];
    for (const v of list) { if (v.objectId) { saveVideo(v); result.videos++; } }
    lastBuff = d.lastBuff || '';
    if (!lastBuff || !list.length || seen.has(lastBuff)) break;
    seen.add(lastBuff);
  }
}

async function collectCommentsForVideo(objectId, result) {
  let buff = '';
  const seen = new Set();
  for (let page = 0; page < 30; page++) {
    const r = await api(`${CGI}/comment/comment_list`, {
      lastBuff: buff, exportId: String(objectId), commentSelection: false, forMcn: false,
    });
    checkErr(r, 'comment_list');
    const d = r.data || {};
    const list = d.comment || [];
    for (const c of list) {
      saveComment(objectId, c); result.comments++;
      for (const l2 of c.levelTwoComment || []) saveComment(objectId, l2, c.commentId);
    }
    buff = d.lastBuff || '';
    if (!buff || !list.length || seen.has(buff)) break;
    seen.add(buff);
  }
}

async function collectComments(result) {
  const vids = db.prepare('SELECT objectId FROM videos WHERE commentCount > 0').all();
  for (const { objectId } of vids) await collectCommentsForVideo(objectId, result);
}

async function collectDM(result) {
  // 1. 全局私信 feed（sessionId 置空即返回跨会话最新消息），顺带收集会话 ID
  const sessionIds = new Set();
  let cookie = '';
  const seenCk = new Set();
  for (let page = 0; page < 5; page++) {
    const r = await api(`${CGI}/private-msg/get-history-msg`, { sessionId: '', cookie });
    checkErr(r, 'dm_feed');
    const d = r.data || {};
    for (const m of d.msg || []) {
      if (m.sessionId) sessionIds.add(String(m.sessionId));
      saveMessage(m); result.messages++;
    }
    cookie = d.cookie || '';
    if (!d.isContinue || !cookie || seenCk.has(cookie)) break;
    seenCk.add(cookie);
  }
  // 2. 批量取会话资料（sessionId 必须传数组，传单个字符串只会得到空 extInfo）
  const sids = [...sessionIds];
  for (let i = 0; i < sids.length; i += 20) {
    const r = await api(`${CGI}/private-msg/get-session-info`, { sessionId: sids.slice(i, i + 20) });
    checkErr(r, 'dm_session_info');
    for (const s of r.data?.sessionInfo || []) { if (s.sessionId) { saveSession(s); result.sessions++; } }
  }
  // 3. 每个会话补一页历史
  for (const sid of sids) {
    const r = await api(`${CGI}/private-msg/get-history-msg`, { sessionId: sid, cookie: '' });
    checkErr(r, 'dm_history');
    for (const m of r.data?.msg || []) { saveMessage(m); result.messages++; }
  }
}

let collecting = false;
async function collectAll(trigger = 'auto') {
  if (collecting) return { skipped: true, msg: '上一次采集尚未结束' };
  collecting = true;
  const startedAt = Math.floor(Date.now() / 1000);
  const result = { trigger, videos: 0, comments: 0, sessions: 0, messages: 0, errors: [] };
  let ok = true;
  try {
    await collectVideos(result);
    await collectComments(result);
    await collectDM(result);
    if (cookieValid !== false) cookieValid = true;
  } catch (e) {
    ok = false;
    result.errors.push(String(e && e.message || e));
  }
  result.ok = ok;
  result.elapsedSec = Math.floor(Date.now() / 1000) - startedAt;
  db.prepare('INSERT INTO collect_log(ts,result) VALUES(?,?)').run(startedAt, JSON.stringify(result));
  collecting = false;
  console.log(`[collect] ${trigger} ok=${ok} cookieValid=${cookieValid}`, JSON.stringify(result));
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

// ---------- 头像/图片代理（防盗链 + SSRF 白名单 + SQLite 缓存） ----------
const AVATAR_HOSTS = new Set(['wx.qlogo.cn', 'finder.video.qq.com']);
const AVATAR_TTL = 86400;

function avatarHostAllowed(host) {
  return AVATAR_HOSTS.has(host) || host.endsWith('.qlogo.cn') || host.endsWith('.finder.video.qq.com');
}

async function handleAvatar(req, res, u) {
  const url = u.searchParams.get('url') || '';
  let host;
  try { host = new URL(url).hostname; } catch { return sendJson(res, 400, { error: 'bad url' }); }
  if (!avatarHostAllowed(host)) return sendJson(res, 403, { error: 'host not allowed' });
  const now = Math.floor(Date.now() / 1000);
  const cached = db.prepare('SELECT contentType, data, ts FROM avatar_cache WHERE url = ?').get(url);
  if (cached && now - cached.ts < AVATAR_TTL) {
    res.writeHead(200, { 'Content-Type': cached.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.end(cached.data);
  }
  try {
    const r = await fetch(url, {
      headers: { Referer: 'https://channels.weixin.qq.com/', 'User-Agent': UA },
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

async function replyToComment(commentId, content) {
  const c = db.prepare('SELECT * FROM comments WHERE commentId = ?').get(commentId);
  if (!c) throw new Error('评论不存在或未采集');
  // 字段结构来自官方 interaction 微前端：replyCommentId=被回复评论，rootCommentId=一级评论，comment=被回复评论对象
  const r = await api(`${CGI}/comment/create_comment`, {
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
    cookieValid = false;
    throw new Error(`create_comment errCode=${r.errCode} errMsg=${r.errMsg || ''} baseResp=${JSON.stringify(r.data?.baseResp || {})}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) {
    throw new Error(`create_comment baseResp.errcode=${baseResp.errcode}（-4300=需要手机验证）`);
  }
  // 局部重采该视频评论
  const rr = { comments: 0 };
  await collectCommentsForVideo(c.exportId, rr);
  return { upstream: r, recollected: rr.comments };
}

let selfUsername = null;
async function getSelfUsername() {
  if (selfUsername) return selfUsername;
  const r = await api(`${CGI}/private-msg/get-finder-username`, {});
  if (r.errCode === 0 && r.data?.finderUsername) {
    selfUsername = String(r.data.finderUsername);
    return selfUsername;
  }
  // 兜底：从已采集消息里推自己的 v2_ ID
  const row = db.prepare("SELECT toUsername AS u FROM dm_messages WHERE toUsername LIKE 'v2_%@finder' LIMIT 1").get();
  if (row) { selfUsername = row.u; return selfUsername; }
  throw new Error(`get-finder-username 失败: ${JSON.stringify(r).slice(0, 200)}`);
}

async function sendDM(sessionId, content) {
  const s = db.prepare('SELECT * FROM dm_sessions WHERE sessionId = ?').get(sessionId);
  if (!s) throw new Error('会话不存在或未采集');
  const from = await getSelfUsername();
  const r = await api(`${CGI}/private-msg/send-private-msg`, {
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
    cookieValid = false;
    throw new Error(`send-private-msg errCode=${r.errCode} errMsg=${r.errMsg || ''}`);
  }
  const baseResp = r.data?.baseResp;
  if (baseResp && baseResp.errcode) throw new Error(`send-private-msg baseResp.errcode=${baseResp.errcode}`);
  // 局部重采该会话消息
  const hm = await api(`${CGI}/private-msg/get-history-msg`, { sessionId, cookie: '' });
  checkErr(hm, 'dm_history');
  for (const m of hm.data?.msg || []) saveMessage(m);
  return { upstream: r };
}

const routes = {
  'GET /api/status': (req, res) => {
    const { lastCollect, lastResult } = lastCollectInfo();
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    sendJson(res, 200, {
      lastCollect,
      cookieValid,
      collecting,
      lastError: lastResult && !lastResult.ok ? (lastResult.errors || []).join('; ') : null,
      counts: {
        videos: count('videos'),
        comments: count('comments'),
        sessions: count('dm_sessions'),
        messages: count('dm_messages'),
      },
    });
  },
  'GET /api/comments': (req, res, u) => {
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 500);
    const list = db.prepare(`
      SELECT c.commentId, c.exportId, c.nickname, c.content, c.headUrl, c.createTime, c.likeCount,
             v.title AS videoTitle, v.thumbUrl AS videoThumb
      FROM comments c LEFT JOIN videos v ON v.objectId = c.exportId
      ORDER BY c.createTime DESC LIMIT ?`).all(limit);
    sendJson(res, 200, { list });
  },
  'GET /api/avatar': handleAvatar,
  'GET /api/videos/with-comments': (req, res) => {
    // 视频卡片按「最新一条评论时间」倒序；评论按时间正序，楼中楼挂在 root 下
    const videos = db.prepare(`
      SELECT v.objectId, v.title, v.thumbUrl, v.createTime, v.commentCount,
             MAX(c.createTime) AS latestCommentTs
      FROM videos v JOIN comments c ON c.exportId = v.objectId
      GROUP BY v.objectId ORDER BY latestCommentTs DESC`).all();
    const stmt = db.prepare('SELECT * FROM comments WHERE exportId = ? ORDER BY createTime ASC');
    const list = videos.map((v) => {
      const all = stmt.all(v.objectId);
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
      SELECT s.sessionId, s.username, s.nickname, s.headImgUrl, s.sessionType,
        (SELECT content FROM dm_messages m WHERE m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastContent,
        (SELECT ts FROM dm_messages m WHERE m.sessionId = s.sessionId ORDER BY ts DESC LIMIT 1) AS lastTs,
        (SELECT COUNT(*) FROM dm_messages m WHERE m.sessionId = s.sessionId) AS msgCount
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
    const cookie = String(body.cookie || '').trim();
    if (!cookie.includes('=')) return sendJson(res, 400, { ok: false, msg: 'cookie 格式不正确' });
    const where = writeCookie(cookie);
    cookieValid = null;
    sendJson(res, 200, { ok: true, savedTo: where });
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
      const m = pathname.match(/^\/api\/dm\/sessions\/([^/]+)\/messages$/) ;
      if (req.method === 'GET' && m) {
        const sid = decodeURIComponent(m[1]);
        const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 1000);
        const rows = db.prepare(
          'SELECT * FROM dm_messages WHERE sessionId = ? ORDER BY ts DESC LIMIT ?').all(sid, limit);
        rows.reverse();
        return sendJson(res, 200, { list: rows });
      }
      const mReply = pathname.match(/^\/api\/comments\/([^/]+)\/reply$/);
      if (req.method === 'POST' && mReply) {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return sendJson(res, 400, { ok: false, error: '内容为空' });
        try {
          const r = await enqueueWrite(() => replyToComment(decodeURIComponent(mReply[1]), content));
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
  console.log(`[wechat-inbox] listening on :${PORT}, db=${DB_PATH}, static=${STATIC_DIR}`);
  collectAll('startup');
  setInterval(() => { collectAll('interval').catch(console.error); }, 5 * 60 * 1000);
});
