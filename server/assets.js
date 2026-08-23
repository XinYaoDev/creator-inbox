// 笔记资产层：沉淀素材 / 成稿 / 参考案例，供起草接口做动态例文与附加禁词
// 存储用 JSONL（追加为主，backfill 才整文件重写），参考案例经 Mac 桥 + WebBridge 抓小红书
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function writeJsonl(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '');
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// 小红书链接里的 note id：/explore/<id> 或 /discovery/item/<id>
function noteIdFromUrl(url) {
  const m = String(url || '').match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
  return m ? m[1] : '';
}

function excerptOf(text, len = 80) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

module.exports = function createAssets({ sendJson, readBody, assetDir, guessStyle, log = console.log }) {
  fs.mkdirSync(assetDir, { recursive: true });
  const MATERIALS = path.join(assetDir, 'materials.jsonl');
  const NOTES = path.join(assetDir, 'notes.jsonl');
  const CASES = path.join(assetDir, 'cases.jsonl');
  const BANNED = path.join(assetDir, 'banned.txt');

  function recordMaterial({ material, topic, style }) {
    if (!material && !topic) return;
    try {
      appendJsonl(MATERIALS, { ts: Date.now(), material: String(material || ''), topic: String(topic || ''), style: String(style || '') });
    } catch (e) {
      log(`[assets] recordMaterial ${e.message}`);
    }
  }

  function saveNote({ title, body, tags, style, material, url }) {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t && !b) return null;
    const rows = readJsonl(NOTES);
    const last = rows[rows.length - 1];
    if (last && last.title === t && last.body === b) return { id: last.id, dedup: true };
    const rec = {
      id: crypto.randomUUID().slice(0, 8),
      ts: Date.now(),
      title: t,
      body: b,
      tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 8) : [],
      style: String(style || ''),
      material: String(material || ''),
    };
    if (url) rec.url = String(url);
    appendJsonl(NOTES, rec);
    return { id: rec.id, dedup: false };
  }

  function backfill({ id, likes, favorites, comments, shares }) {
    const rows = readJsonl(NOTES);
    const rec = rows.find((r) => r.id === id);
    if (!rec) return null;
    rec.stats = {
      likes: num(likes),
      favorites: num(favorites),
      comments: num(comments),
      shares: num(shares),
      at: Date.now(),
    };
    writeJsonl(NOTES, rows);
    return rec;
  }

  function normalizeCase({ url, note }) {
    const n = note || {};
    const noteId = String(n.id || '').trim() || noteIdFromUrl(url) || crypto.randomUUID().slice(0, 8);
    const title = String(n.title || '').trim();
    const excerpt = excerptOf(n.desc || n.excerpt, 160);
    return {
      noteId,
      url: String(url || ''),
      title,
      author: String(n.nick || n.author || '').trim(),
      excerpt,
      style: guessStyle ? guessStyle(`${title} ${excerpt}`, '') : '',
      likes: num(n.liked ?? n.likes),
      favorites: num(n.collected ?? n.favorites),
      comments: num(n.comment ?? n.comments),
      shares: num(n.share ?? n.shares),
      publishedAt: num(n.time ?? n.publishedAt) || undefined,
      ip: String(n.ip || '') || undefined,
      collectedAt: Date.now(),
    };
  }

  function upsertCase(c) {
    const rows = readJsonl(CASES);
    const i = rows.findIndex((r) => r.noteId === c.noteId);
    if (i >= 0) {
      rows[i] = { ...rows[i], ...c };
      writeJsonl(CASES, rows);
      return { case: rows[i], updated: true };
    }
    appendJsonl(CASES, c);
    return { case: c, updated: false };
  }

  async function learn(url) {
    const base = (process.env.HERMES_IMAGE_URL || '').replace(/\/$/, '');
    const token = process.env.HERMES_IMAGE_TOKEN || '';
    if (!base) throw new Error('未配置 HERMES_IMAGE_URL（Mac 桥）');
    if (!token) throw new Error('未配置 HERMES_IMAGE_TOKEN');
    const r = await fetch(`${base}/xhs-note`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `Mac 桥 HTTP ${r.status}`);
    if (!data.note || (!data.note.title && !data.note.desc)) throw new Error('没抓到笔记内容，链接可能失效');
    return upsertCase(normalizeCase({ url, note: data.note }));
  }

  // 同套式的参考例文：cases 按赞+藏取前 2，加自己回填过且表现最好的成稿 1 条
  function exemplarsFor(style) {
    const out = [];
    const cases = readJsonl(CASES)
      .filter((c) => c.style === style && (c.title || c.excerpt))
      .sort((a, b) => (num(b.likes) + num(b.favorites)) - (num(a.likes) + num(a.favorites)))
      .slice(0, 2);
    for (const c of cases) {
      out.push(`例：标题「${c.title}」正文「${excerptOf(c.excerpt, 80)}」（赞${num(c.likes)} 藏${num(c.favorites)}）`);
    }
    const mine = readJsonl(NOTES)
      .filter((r) => r.style === style && r.stats && (num(r.stats.likes) + num(r.stats.favorites)) > 0)
      .sort((a, b) => (num(b.stats.likes) + num(b.stats.favorites)) - (num(a.stats.likes) + num(a.stats.favorites)))[0];
    if (mine) {
      out.push(`例（自己发过、数据好）：标题「${mine.title}」正文「${excerptOf(mine.body, 80)}」（赞${num(mine.stats.likes)} 藏${num(mine.stats.favorites)}）`);
    }
    return out;
  }

  function extraBanned() {
    if (!fs.existsSync(BANNED)) return [];
    return fs.readFileSync(BANNED, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }

  function summary() {
    const materials = readJsonl(MATERIALS);
    const notes = readJsonl(NOTES);
    const cases = readJsonl(CASES);
    return {
      materials: materials.length,
      notes: notes.length,
      cases: cases.length,
      banned: extraBanned().length,
      recentNotes: notes.slice(-5).reverse().map((r) => ({
        id: r.id, ts: r.ts, title: r.title, style: r.style, stats: r.stats,
      })),
      recentCases: cases.slice(-5).reverse().map((c) => ({
        noteId: c.noteId, title: c.title, style: c.style, likes: c.likes, favorites: c.favorites,
      })),
    };
  }

  async function handle(req, res, u) {
    const p = u.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/api/assets/summary') {
      return sendJson(res, 200, { ok: true, ...summary() });
    }

    if (method === 'POST' && p === '/api/assets/note') {
      const body = await readBody(req);
      const saved = saveNote(body);
      if (!saved) return sendJson(res, 400, { ok: false, error: '标题和正文都为空' });
      return sendJson(res, 200, { ok: true, ...saved });
    }

    if (method === 'POST' && p === '/api/assets/backfill') {
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: '缺成稿 id' });
      const rec = backfill(body);
      if (!rec) return sendJson(res, 404, { ok: false, error: '没找到这条成稿' });
      return sendJson(res, 200, { ok: true, id: rec.id, stats: rec.stats });
    }

    if (method === 'POST' && p === '/api/assets/learn') {
      const body = await readBody(req);
      const url = String(body.url || '').trim();
      if (!/^https?:\/\/([^/]+\.)?xiaohongshu\.com\//.test(url)) {
        return sendJson(res, 400, { ok: false, error: '要一条小红书笔记链接' });
      }
      try {
        const { case: c, updated } = await learn(url);
        return sendJson(res, 200, { ok: true, updated, case: c });
      } catch (e) {
        log(`[assets] learn ${e.message}`);
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (method === 'POST' && p === '/api/assets/case') {
      const body = await readBody(req);
      if (!String(body.title || '').trim() && !String(body.excerpt || '').trim()) {
        return sendJson(res, 400, { ok: false, error: '至少给标题或摘录' });
      }
      const c = normalizeCase({ url: body.url, note: body });
      if (body.style && typeof body.style === 'string') c.style = body.style;
      const { case: saved, updated } = upsertCase(c);
      return sendJson(res, 200, { ok: true, updated, case: saved });
    }

    return sendJson(res, 404, { error: 'unknown assets api' });
  }

  return { handle, recordMaterial, saveNote, backfill, learn, exemplarsFor, extraBanned, summary };
};
