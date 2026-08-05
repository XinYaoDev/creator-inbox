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
`);

const upVideo = db.prepare(`INSERT INTO videos(objectId,title,thumbUrl,createTime,commentCount)
  VALUES(?,?,?,?,?)
  ON CONFLICT(objectId) DO UPDATE SET title=excluded.title, thumbUrl=excluded.thumbUrl,
    createTime=excluded.createTime, commentCount=excluded.commentCount`);
const upComment = db.prepare(`INSERT INTO comments(commentId,exportId,nickname,content,headUrl,createTime,likeCount)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(commentId) DO UPDATE SET nickname=excluded.nickname, content=excluded.content,
    headUrl=excluded.headUrl, createTime=excluded.createTime, likeCount=excluded.likeCount`);
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

function saveComment(exportId, c) {
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

async function collectComments(result) {
  const vids = db.prepare('SELECT objectId FROM videos WHERE commentCount > 0').all();
  for (const { objectId } of vids) {
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
        for (const l2 of c.levelTwoComment || []) saveComment(objectId, l2);
      }
      buff = d.lastBuff || '';
      if (!buff || !list.length || seen.has(buff)) break;
      seen.add(buff);
    }
  }
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
