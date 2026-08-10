// server/library.js —— 素材库模块（V1）
// 数据模型：media_assets / taxonomy_nodes / asset_annotations
// 素材来源：nas（扫描 MEDIA_ROOT 存量）| upload（web 上传）
// 依赖：ffprobe/ffmpeg（镜像已装），路径由 createLibrary 注入
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

const LIB_SCAN_DIRS = ['00_Inbox', '01_Master', '02_Proxies', '90_Review'];
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const FACETS = ['内容主体', '场景', '行为', '镜头', '氛围', '内容用途', '精选主题'];
const PRESET_TAGS = {
  '内容主体': ['白蟹', '小青龙', '海鲜', '房间', '鱼塘', '客人', '外景'],
  '场景': ['餐厅', '厨房', '院子', '海边', '房间', '菜场'],
  '行为': ['做饭', '摆盘', '吃饭', '赶海', '钓鱼', '打扫'],
  '镜头': ['特写', '中景', '全景', '俯拍', '跟拍'],
  '氛围': ['温馨', '热闹', '自然', '安静', '烟火气'],
  '内容用途': ['Hook', '展示', '转场', '证明', '封面'],
};
const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

module.exports = function createLibrary({ db, sendJson, readBody, mediaRoot, thumbDir, uploadDir, log = console.log }) {
  fs.mkdirSync(thumbDir, { recursive: true });
  if (uploadDir) fs.mkdirSync(uploadDir, { recursive: true });

  // ---------- schema ----------
  db.exec(`
CREATE TABLE IF NOT EXISTS media_assets(
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'nas',
  file_path TEXT NOT NULL UNIQUE,
  file_type TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  fps REAL DEFAULT 0,
  orientation TEXT DEFAULT '',
  shoot_time INTEGER DEFAULT 0,
  original_tags TEXT DEFAULT '',
  thumb_path TEXT DEFAULT '',
  status TEXT DEFAULT 'indexed',
  createdAt INTEGER,
  updatedAt INTEGER
);
CREATE TABLE IF NOT EXISTS taxonomy_nodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facet TEXT NOT NULL,
  label TEXT NOT NULL,
  createdAt INTEGER,
  UNIQUE(facet, label)
);
CREATE TABLE IF NOT EXISTS asset_annotations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  taxonomy_id INTEGER NOT NULL,
  source TEXT DEFAULT 'MANUAL',
  confidence REAL DEFAULT 1.0,
  createdAt INTEGER,
  UNIQUE(asset_id, taxonomy_id)
);
CREATE INDEX IF NOT EXISTS idx_assets_shoot ON media_assets(shoot_time DESC);
CREATE INDEX IF NOT EXISTS idx_ann_asset ON asset_annotations(asset_id);
`);
  // 预置分面标签（幂等）
  const insTax = db.prepare('INSERT OR IGNORE INTO taxonomy_nodes(facet,label,createdAt) VALUES(?,?,?)');
  for (const [facet, labels] of Object.entries(PRESET_TAGS)) {
    for (const label of labels) insTax.run(facet, label, Math.floor(Date.now() / 1000));
  }

  const now = () => Math.floor(Date.now() / 1000);
  const assetId = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
  const isVideo = (ext) => VIDEO_EXTS.has(ext.toLowerCase());
  const isImage = (ext) => IMAGE_EXTS.has(ext.toLowerCase());

  // ---------- 元数据 / 缩略图 ----------
  function probeMedia(filePath) {
    return new Promise((resolve) => {
      execFile('ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          try {
            const d = JSON.parse(stdout);
            const v = (d.streams || []).find((s) => s.codec_type === 'video');
            const dur = Number(d.format && d.format.duration || v && v.duration || 0);
            let fps = 0;
            if (v && v.r_frame_rate) {
              const [a, b] = String(v.r_frame_rate).split('/').map(Number);
              if (a && b) fps = +(a / b).toFixed(2);
            }
            return resolve({
              duration: Math.round(dur) || 0,
              width: v ? Number(v.width) || 0 : 0,
              height: v ? Number(v.height) || 0 : 0,
              fps,
            });
          } catch { return resolve(null); }
        });
    });
  }

  function genThumb(filePath, outPath, video) {
    return new Promise((resolve) => {
      const args = video
        ? ['-y', '-ss', '0.5', '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', 4, outPath]
        : ['-y', '-i', filePath, '-vf', 'scale=480:-2', '-q:v', 4, outPath];
      execFile('ffmpeg', args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (e) => resolve(!e));
    });
  }

  function inferShootTime(filePath, stat) {
    const base = path.basename(filePath);
    // VID20260220043607 / IMG_20260220_043607 / 2026-07-29_xxx
    const m = base.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})[_-]?(\d{2})?[-_]?(\d{2})?/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3], h = +(m[4] || 0), mi = +(m[5] || 0);
      const t = Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
      if (Number.isFinite(t) && t > 0 && t < now() + 86400 * 30) return t;
    }
    return Math.floor(stat.mtimeMs / 1000);
  }

  // 目录路径里去掉序号前缀与通用词，作为原始标签线索
  function dirTags(filePath, root) {
    const rel = path.relative(root, path.dirname(filePath));
    return rel.split(path.sep)
      .map((s) => s.replace(/^\d{2}_/, '').trim())
      .filter((s) => s && !/^(原始长视频|Proxies|Master|Inbox)$/.test(s))
      .slice(-2)
      .join('/');
  }

  // ---------- 扫描（异步长任务，单飞） ----------
  const scanState = { running: false, total: 0, done: 0, errors: [], startedAt: 0, finishedAt: 0, triggeredBy: '' };

  function walkMedia(root, out) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(root, e.name);
      if (e.isDirectory()) walkMedia(full, out);
      else {
        const ext = path.extname(e.name).toLowerCase();
        if (isVideo(ext) || isImage(ext)) out.push(full);
      }
    }
  }

  async function indexOne(filePath, source, root) {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath);
    const video = isVideo(ext);
    const id = assetId(filePath);
    const thumbPath = path.join(thumbDir, `${id}.jpg`);
    const meta = video ? await probeMedia(filePath) : null;
    const okThumb = await genThumb(filePath, thumbPath, video);
    const rec = {
      id,
      source,
      file_path: filePath,
      file_type: video ? 'video' : 'image',
      file_size: stat.size,
      duration: meta ? meta.duration : 0,
      width: meta ? meta.width : 0,
      height: meta ? meta.height : 0,
      fps: meta ? meta.fps : 0,
      orientation: meta && meta.height > meta.width ? '竖' : '横',
      shoot_time: inferShootTime(filePath, stat),
      original_tags: root ? dirTags(filePath, root) : '',
      thumb_path: okThumb ? thumbPath : '',
      status: 'indexed',
      updatedAt: now(),
    };
    db.prepare(`INSERT INTO media_assets(id,source,file_path,file_type,file_size,duration,width,height,fps,orientation,shoot_time,original_tags,thumb_path,status,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size=excluded.file_size, duration=excluded.duration, width=excluded.width,
        height=excluded.height, fps=excluded.fps, orientation=excluded.orientation,
        shoot_time=excluded.shoot_time, thumb_path=excluded.thumb_path, updatedAt=excluded.updatedAt`)
      .run(rec.id, rec.source, rec.file_path, rec.file_type, rec.file_size, rec.duration, rec.width,
        rec.height, rec.fps, rec.orientation, rec.shoot_time, rec.original_tags, rec.thumb_path,
        rec.status, now(), rec.updatedAt);
  }

  async function startScan(trigger) {
    if (scanState.running) return { started: false, msg: '扫描进行中' };
    if (!mediaRoot || !fs.existsSync(mediaRoot)) return { started: false, msg: `MEDIA_ROOT 不存在: ${mediaRoot || '(未配置)'}` };
    scanState.running = true;
    scanState.errors = [];
    scanState.startedAt = now();
    scanState.triggeredBy = trigger;
    scanState.done = 0;
    const files = [];
    for (const d of LIB_SCAN_DIRS) {
      const p = path.join(mediaRoot, d);
      if (fs.existsSync(p)) walkMedia(p, files);
    }
    scanState.total = files.length;
    // 增量：已在库的跳过
    const known = new Set(db.prepare('SELECT file_path FROM media_assets').all().map((r) => r.file_path));
    const todo = files.filter((f) => !known.has(f));
    log(`[library] scan trigger=${trigger} total=${files.length} new=${todo.length}`);
    (async () => {
      for (const f of todo) {
        try { await indexOne(f, 'nas', mediaRoot); }
        catch (e) { scanState.errors.push(`${path.basename(f)}: ${String(e && e.message || e).slice(0, 120)}`); }
        scanState.done++;
      }
      scanState.running = false;
      scanState.finishedAt = now();
      log(`[library] scan done ok=${files.length - scanState.errors.length}/${files.length} errors=${scanState.errors.length}`);
    })();
    return { started: true, total: files.length, new: todo.length };
  }

  function scanStatus() {
    return {
      running: scanState.running,
      total: scanState.total,
      done: scanState.done,
      errors: scanState.errors.slice(0, 20),
      startedAt: scanState.startedAt,
      finishedAt: scanState.finishedAt,
      triggeredBy: scanState.triggeredBy,
    };
  }

  // ---------- 查询 ----------
  function listAssets(u) {
    const limit = Math.min(Number(u.searchParams.get('limit')) || 60, 300);
    const offset = Number(u.searchParams.get('offset')) || 0;
    const args = [];
    const conds = [];
    const type = u.searchParams.get('type');
    const source = u.searchParams.get('source');
    const q = (u.searchParams.get('q') || '').trim();
    const tags = u.searchParams.getAll('tag');
    if (type === 'video' || type === 'image') { conds.push('m.file_type = ?'); args.push(type); }
    if (source === 'nas' || source === 'upload') { conds.push('m.source = ?'); args.push(source); }
    if (q) { conds.push('(m.file_path LIKE ? OR m.original_tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    for (const t of tags) {
      const idx = t.indexOf(':');
      if (idx > 0) {
        const facet = t.slice(0, idx), label = t.slice(idx + 1);
        conds.push('EXISTS (SELECT 1 FROM asset_annotations a JOIN taxonomy_nodes tn ON tn.id = a.taxonomy_id WHERE a.asset_id = m.id AND tn.facet = ? AND tn.label = ?)');
        args.push(facet, label);
      } else {
        conds.push('EXISTS (SELECT 1 FROM asset_annotations a JOIN taxonomy_nodes tn ON tn.id = a.taxonomy_id WHERE a.asset_id = m.id AND tn.label = ?)');
        args.push(t);
      }
    }
    const sort = u.searchParams.get('sort') || 'time';
    const orderBy = sort === 'duration' ? 'm.duration DESC' : sort === 'name' ? 'm.file_path ASC' : 'm.shoot_time DESC';
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM media_assets m ${where}`).get(...args).n;
    const list = db.prepare(`SELECT m.*,
        (SELECT GROUP_CONCAT(tn.facet || ':' || tn.label, '|') FROM asset_annotations a JOIN taxonomy_nodes tn ON tn.id = a.taxonomy_id WHERE a.asset_id = m.id) AS tagStr
      FROM media_assets m ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
      .map((r) => ({ ...r, tags: r.tagStr ? r.tagStr.split('|') : [] }));
    return { list, total };
  }

  function assetDetail(id) {
    const m = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id);
    if (!m) return null;
    const tags = db.prepare(`SELECT tn.id, tn.facet, tn.label FROM asset_annotations a
      JOIN taxonomy_nodes tn ON tn.id = a.taxonomy_id WHERE a.asset_id = ? ORDER BY tn.facet`).all(id);
    return { ...m, tags };
  }

  function taxonomyTree() {
    return {
      facets: FACETS.map((f) => ({
        name: f,
        tags: db.prepare(`SELECT tn.id, tn.label,
            (SELECT COUNT(*) FROM asset_annotations a WHERE a.taxonomy_id = tn.id) AS count
          FROM taxonomy_nodes tn WHERE tn.facet = ? ORDER BY tn.id`).all(f),
      })),
    };
  }

  function addTagToAsset(assetId2, facet, label) {
    if (!facet || !label) return { ok: false, error: 'facet 和 label 必填' };
    if (!FACETS.includes(facet)) return { ok: false, error: `未知维度 ${facet}` };
    const t = now();
    db.prepare('INSERT OR IGNORE INTO taxonomy_nodes(facet,label,createdAt) VALUES(?,?,?)').run(facet, String(label).trim(), t);
    const tn = db.prepare('SELECT id FROM taxonomy_nodes WHERE facet = ? AND label = ?').get(facet, String(label).trim());
    if (!tn) return { ok: false, error: '标签创建失败' };
    const r = db.prepare('INSERT OR IGNORE INTO asset_annotations(asset_id,taxonomy_id,source,confidence,createdAt) VALUES(?,?,?,?,?)')
      .run(assetId2, tn.id, 'MANUAL', 1.0, t);
    return { ok: true, taxonomyId: Number(tn.id), inserted: Number(r.changes) > 0 };
  }

  // ---------- 安全路径（防目录穿越） ----------
  function isSafePath(p) {
    const resolved = path.resolve(p);
    const roots = [mediaRoot, uploadDir].filter(Boolean);
    return roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
  }

  function serveFile(req, res, filePath) {
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: 'file not found' });
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (start >= stat.size || end < start) return sendJson(res, 416, { error: 'range not satisfiable' });
          res.writeHead(206, {
            'Content-Type': mime, 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
            'Cache-Control': 'public, max-age=3600',
          });
          return fs.createReadStream(filePath, { start, end }).pipe(res);
        }
      }
      res.writeHead(200, {
        'Content-Type': mime, 'Accept-Ranges': 'bytes',
        'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ---------- 上传（原始字节流，非 multipart） ----------
  async function handleUpload(req, res, u) {
    const rawName = u.searchParams.get('filename') || 'upload.bin';
    const safeName = path.basename(rawName).replace(/[^\w.一-龥-]+/g, '_').slice(-80);
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    const dest = path.join(uploadDir, id);
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      const size = fs.statSync(dest).size;
      if (!size) { fs.unlinkSync(dest); return sendJson(res, 400, { ok: false, error: '空文件' }); }
      const ext = path.extname(safeName).toLowerCase();
      const video = isVideo(ext);
      const asset = { id: assetId(dest) };
      const rec = {
        id: asset.id, source: 'upload', file_path: dest, file_type: video ? 'video' : 'image',
        file_size: size, duration: 0, width: 0, height: 0, fps: 0, orientation: '',
        shoot_time: now(), original_tags: '', thumb_path: '',
      };
      const meta = video ? await probeMedia(dest) : null;
      if (meta) {
        rec.duration = meta.duration; rec.width = meta.width; rec.height = meta.height;
        rec.fps = meta.fps; rec.orientation = meta.height > meta.width ? '竖' : '横';
      }
      const okThumb = await genThumb(dest, path.join(thumbDir, `${rec.id}.jpg`), video);
      rec.thumb_path = okThumb ? path.join(thumbDir, `${rec.id}.jpg`) : '';
      db.prepare(`INSERT INTO media_assets(id,source,file_path,file_type,file_size,duration,width,height,fps,orientation,shoot_time,original_tags,thumb_path,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rec.id, rec.source, rec.file_path, rec.file_type, rec.file_size, rec.duration, rec.width,
          rec.height, rec.fps, rec.orientation, rec.shoot_time, rec.original_tags, rec.thumb_path,
          'indexed', now(), now());
      return sendJson(res, 200, { ok: true, asset: { id: rec.id, file_type: rec.file_type, file_size: size } });
    } catch (e) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  }

  // ---------- 路由 ----------
  return async function handle(req, res, u) {
    const p = u.pathname;
    const method = req.method;
    let m;

    if (method === 'POST' && p === '/api/library/scan') {
      const r = await startScan('manual');
      return sendJson(res, 200, r);
    }
    if (method === 'GET' && p === '/api/library/scan/status') return sendJson(res, 200, scanStatus());

    if (method === 'GET' && p === '/api/library/assets') return sendJson(res, 200, listAssets(u));

    if ((m = p.match(/^\/api\/library\/assets\/([^/]+)$/))) {
      if (method === 'GET') {
        const d = assetDetail(m[1]);
        return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: '素材不存在' });
      }
    }
    if ((m = p.match(/^\/api\/library\/assets\/([^/]+)\/tags$/))) {
      if (method === 'POST') {
        const body = await readBody(req);
        const r = addTagToAsset(m[1], String(body.facet || '').trim(), String(body.label || '').trim());
        return sendJson(res, r.ok ? 200 : 400, r);
      }
    }
    if ((m = p.match(/^\/api\/library\/assets\/([^/]+)\/tags\/(\d+)$/))) {
      if (method === 'DELETE') {
        db.prepare('DELETE FROM asset_annotations WHERE asset_id = ? AND taxonomy_id = ?').run(m[1], Number(m[2]));
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === '/api/library/taxonomy') {
      if (method === 'GET') return sendJson(res, 200, taxonomyTree());
      if (method === 'POST') {
        const body = await readBody(req);
        const facet = String(body.facet || '').trim();
        const label = String(body.label || '').trim();
        if (!FACETS.includes(facet) || !label) return sendJson(res, 400, { ok: false, error: 'facet 非法或 label 为空' });
        db.prepare('INSERT OR IGNORE INTO taxonomy_nodes(facet,label,createdAt) VALUES(?,?,?)').run(facet, label, now());
        const tn = db.prepare('SELECT id FROM taxonomy_nodes WHERE facet = ? AND label = ?').get(facet, label);
        return sendJson(res, 200, { ok: true, id: Number(tn.id) });
      }
    }

    if (method === 'POST' && p === '/api/library/upload') return handleUpload(req, res, u);

    if (method === 'GET' && p === '/api/library/file') {
      const id = u.searchParams.get('id') || '';
      const asset = db.prepare('SELECT file_path FROM media_assets WHERE id = ?').get(id);
      if (!asset || !isSafePath(asset.file_path)) return sendJson(res, 404, { error: '素材不存在' });
      return serveFile(req, res, asset.file_path);
    }
    if (method === 'GET' && p === '/api/library/thumb') {
      const id = u.searchParams.get('id') || '';
      const asset = db.prepare('SELECT thumb_path FROM media_assets WHERE id = ?').get(id);
      if (!asset || !asset.thumb_path || !fs.existsSync(asset.thumb_path)) return sendJson(res, 404, { error: '无缩略图' });
      return serveFile(req, res, asset.thumb_path);
    }

    return sendJson(res, 404, { error: 'unknown library api' });
  };
};
