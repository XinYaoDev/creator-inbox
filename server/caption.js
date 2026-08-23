'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseLlmJson, visionConfig, isKimiK3 } = require('./llm.js');

const CAPTION_SYSTEM = [
  '你在给民宿创作者的图片素材库写检索用描述。看图输出 JSON：',
  '{"caption":"一句中文，30字内，说清内容+场景+构图/光线","keywords":["3到6个检索词"]}',
  '关键词偏名词和场景词（如 院子/夜景/俯拍/海鲜/餐桌/特写），不要形容词堆砌，不要重复 caption 原句。',
  '只输出 JSON。',
].join('\n');

const SKIP_LEAF = /^(?:\d{2}_)?(?:精选照片|人物照片|预览图)$/;
const LEADING_NUM = /^\d{2}_/;

function albumFromPath(filePath) {
  const parts = String(filePath || '').split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (/\.[a-z0-9]+$/i.test(last)) parts.pop();
  while (parts.length && SKIP_LEAF.test(parts[parts.length - 1])) parts.pop();
  const leaf = parts[parts.length - 1] || '';
  return leaf.replace(LEADING_NUM, '') || '';
}

function grams2(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function parseCaption(text) {
  const d = parseLlmJson(text);
  const caption = String(d.caption || '').trim().slice(0, 80);
  const raw = Array.isArray(d.keywords) ? d.keywords : String(d.keywords || '').split(/[,，、]/);
  const keywords = raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (!caption) throw new Error('描述为空');
  return { caption, keywords };
}

function scoreAsset(asset, q) {
  const query = String(q || '').trim();
  if (!query) return 0;
  let score = 0;
  const kws = String(asset.ai_keywords || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const kw of kws) {
    if (kw && query.includes(kw)) score += 3;
  }
  const a = grams2(asset.ai_caption || '');
  const b = grams2(query);
  let common = 0;
  for (const g of a) if (b.has(g)) common += 1;
  score += Math.min(6, common);
  const tags = String(asset.original_tags || '');
  const album = albumFromPath(asset.file_path);
  const hitMeta = (tags && (query.includes(tags) || tags.split(/[/,\s]+/).some((t) => t && query.includes(t))))
    || (album && (query.includes(album) || album.length >= 2 && query.includes(album)));
  if (hitMeta) score += 2;
  if (score > 0 && (asset.source === 'nas' || asset.source === 'upload')) score += 1;
  return score;
}

function imageMime(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

function shrinkForVision(filePath) {
  return new Promise((resolve) => {
    const dest = path.join(os.tmpdir(), `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    execFile(
      'ffmpeg',
      ['-y', '-i', filePath, '-vf', "scale='min(768,iw)':-2", '-q:v', '5', dest],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (e) => {
        if (e || !fs.existsSync(dest)) return resolve(null);
        resolve(dest);
      },
    );
  });
}

async function captionImage(filePath) {
  const { key, base, model } = visionConfig();
  if (!key) throw new Error('没有视觉模型 key');
  let src = filePath;
  let tmp = null;
  const stat = fs.statSync(filePath);
  if (stat.size > 180 * 1024) {
    tmp = await shrinkForVision(filePath);
    if (tmp) src = tmp;
  }
  try {
    const buf = fs.readFileSync(src);
    const payload = {
      model,
      messages: [
        { role: 'system', content: CAPTION_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${imageMime(buf)};base64,${buf.toString('base64')}` } },
            { type: 'text', text: '描述这张图。' },
          ],
        },
      ],
    };
    if (isKimiK3(model)) payload.reasoning_effort = 'low';
    else payload.temperature = 0.2;
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `视觉接口 HTTP ${r.status}`);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('视觉接口没有返回内容');
    return parseCaption(text);
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function createCaptioner({ db, log = console.log }) {
  const state = { running: false, cancel: false, done: 0, total: 0, errors: [], startedAt: 0, finishedAt: 0 };
  const now = () => Math.floor(Date.now() / 1000);

  function saveCaption(id, caption, keywords) {
    db.prepare('UPDATE media_assets SET ai_caption=?, ai_keywords=?, captioned_at=? WHERE id=?')
      .run(caption, keywords.join(','), now(), id);
  }

  async function captionRow(row) {
    const src = row.thumb_path && fs.existsSync(row.thumb_path) ? row.thumb_path : row.file_path;
    if (!src || !fs.existsSync(src)) throw new Error('找不到图');
    const { caption, keywords } = await captionImage(src);
    saveCaption(row.id, caption, keywords);
  }

  function enqueue(id) {
    const row = db.prepare('SELECT id, file_path, thumb_path, file_type FROM media_assets WHERE id=?').get(id);
    if (!row || row.file_type !== 'image') return;
    captionRow(row).catch((e) => log(`[caption] ${id}: ${String(e && e.message || e).slice(0, 160)}`));
  }

  function startBackfill() {
    if (state.running) return { ok: true, queued: 0, running: true };
    const todo = db.prepare(`SELECT id, file_path, thumb_path, file_type FROM media_assets
      WHERE file_type='image' AND (captioned_at IS NULL OR captioned_at=0)`).all();
    state.running = true;
    state.cancel = false;
    state.done = 0;
    state.total = todo.length;
    state.errors = [];
    state.startedAt = now();
    state.finishedAt = 0;
    (async () => {
      for (const row of todo) {
        if (state.cancel) break;
        try { await captionRow(row); }
        catch (e) { state.errors.push(`${row.id}: ${String(e && e.message || e).slice(0, 120)}`); }
        state.done += 1;
        await new Promise((r) => setTimeout(r, 500));
      }
      state.running = false;
      state.finishedAt = now();
      log(`[caption] backfill ${state.cancel ? 'stopped' : 'done'} ${state.done - state.errors.length}/${state.total}`);
    })();
    return { ok: true, queued: todo.length };
  }

  function stopBackfill() {
    if (!state.running) return { ok: true, stopped: false };
    state.cancel = true;
    return { ok: true, stopped: true, done: state.done, total: state.total };
  }

  function status() {
    return {
      running: state.running,
      done: state.done,
      total: state.total,
      errors: state.errors.slice(0, 20),
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
    };
  }

  return { enqueue, startBackfill, stopBackfill, status };
}

module.exports = {
  CAPTION_SYSTEM,
  albumFromPath,
  grams2,
  parseCaption,
  scoreAsset,
  captionImage,
  createCaptioner,
};
