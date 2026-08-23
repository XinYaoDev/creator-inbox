// 小红书图文笔记：选题 → 分享正文 → 拆图 → 生一组 / 单张重出
// 文案走 OpenAI 兼容接口（默认 Kimi / DeepSeek）；出图优先本机 Hermes 桥，否则 FAL / SiliconFlow / OpenAI / 演示源
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VOICE = `你在帮一家浙江宁海海边民宿写小红书。口吻是刚住完的客人在分享，不是老板在推销。
可以写赶海、小青龙、白蟹、院子、客房、包吃住的烟火气。不要写「欢迎预订」「私信老板」「性价比超高」「家人们冲」。
不要表情包堆砌，话题标签单独给，不要写进正文。`;

const STYLES = ['提问互动', '情绪出片', '周末游记', '探路攻略', '纠正想象'];

const STYLE_HINT = {
  提问互动: '标题只问现场看见的一个东西。正文一两句就停，不要补清单。',
  情绪出片: '标题是谁+正在干什么+心情。店名、人数、包吃住如需出现，放正文最后一行。',
  周末游记: '从自己出发（够不够、第几天）。发现 → 我们几个人 → 可核对事实 → 明确不推荐或失败。',
  探路攻略: '先写走错/踩雷，再写找对的地方。收获写成具体生物或一身泥，不要「宝藏点」。',
  纠正想象: '用一个比喻纠正流行误解。短。不要攻略腔。',
};

const FEW_SHOTS = {
  提问互动: '例：标题「第一次赶海，这些小管管是什么呀」正文「感觉很好奇，但是挖了挖也没东西呀」',
  情绪出片: '例：标题「在汕尾和朋友躺在床上就能看海太幸福了」正文写天气、一直想拍、室内热到能穿背心，店名放最后一行。',
  周末游记: '例：标题「从杭州出发，一个周末就完全够了」开头「到了才发现浙江也有蓝蓝的海」，再写我们4个人、哪片沙滩不推荐、约好看日出却没看成。',
  探路攻略: '例：第一站施工进不去，保安大叔指路。收获：小螃蟹、跳跳鱼（看你技术）、快乐和一身泥巴。',
  纠正想象: '例：标题「第一次赶海，原来是这样的」正文「赶海相当于种地，和短视频里夹大螃蟹不是一回事。」',
};

const TITLE_BANNED = /整栋|包吃住|首选|性价比|欢迎|8\s*[–\-至到]\s*18\s*人|8到18人/;
const BODY_BANNED = /欢迎预订|私信|微信|滴滴我|家人们冲|封神|天花板|全网最低|最便宜|性价比超高/;

function pickStyle(material, topic) {
  const t = `${material || ''} ${topic || ''}`;
  if (/不认识|是什么|小管|奇怪的|这是什么|挖了挖/.test(t)) return '提问互动';
  if (/踩雷|进不去|走错|保安|第一站|探路/.test(t)) return '探路攻略';
  if (/原来|以为|不像|短视频|夹大螃蟹|种地|纠正/.test(t)) return '纠正想象';
  if (/两天|两晚|周末|行程|第一天|第二天|人均/.test(t)) return '周末游记';
  if (/幸福|终于|躺|看海|出片|被窝|择菜/.test(t)) return '情绪出片';
  return '情绪出片';
}

function lintRegex(title, body, extraWords) {
  const fail = [];
  if (TITLE_BANNED.test(String(title || ''))) fail.push('标题像房源');
  if (BODY_BANNED.test(String(body || ''))) fail.push('正文有推销或导流');
  if (Array.isArray(extraWords) && extraWords.length) {
    const all = `${title || ''}\n${body || ''}`;
    if (extraWords.some((w) => w && all.includes(w))) fail.push('正文有推销或导流');
  }
  return [...new Set(fail)];
}

function asDraft(parsed, topic, material) {
  const fb = fallbackDraft(topic, material);
  if (!parsed || typeof parsed !== 'object') return fb;
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 8) : fb.tags;
  return {
    title: String(parsed.title || parsed.topic || topic || '').trim() || fb.title,
    body: String(parsed.body || '').trim() || fb.body,
    tags: tags.length ? tags : fb.tags,
  };
}

function draftSystem(style, exemplars) {
  const s = STYLE_HINT[style] || STYLE_HINT.情绪出片;
  const shot = (Array.isArray(exemplars) && exemplars.length)
    ? exemplars.join('\n')
    : (FEW_SHOTS[style] || FEW_SHOTS.情绪出片);
  return `${VOICE}

套式：${style}。${s}
${shot}

硬约束：
1. 标题是人话：发生了什么 / 看见了什么 / 心情如何。禁止出现：整栋、包吃住、首选、性价比、欢迎、8-18人。
2. 正文必须用上素材里至少一条可核对的事实，不许编潮汐、房价、房量。
3. 必须有一个只有在场才写得出的细节（从素材里挑，素材没有就写感官，不要编人名和具体数字）。
4. 人数、包吃住、店名如需出现，放正文中段或最后一行，不要进标题。
5. 不要微信、私信、欢迎预订。

只返回 JSON：{"title":"标题","body":"正文，分段，240字以内","tags":["话题1","话题2"]}`;
}

function draftUser(topic, material, style) {
  const lines = [`套式：${style}`];
  if (material) lines.push(`今日素材（只能用这里的事实，不许编新的）：\n${material}`);
  if (topic) lines.push(`选题或标题方向：${topic}`);
  if (!material && !topic) lines.push('素材为空，写一条住客视角的赶海回来吃饭。');
  lines.push('按套式写一条可直接发的小红书分享。');
  return lines.join('\n');
}

function lintSystem() {
  return `你在审一条小红书图文草稿。对照四条：真诚（删掉店名还像住客）、主旨（标题和正文同一句承诺）、获得感（看完能判断几个人去合不合适，或能带走一个现场事实）、不推销。
只返回 JSON：{"ok":true或false,"fail":["不通过的原因，短"]}`;
}

function lintUser(draft, material) {
  return `素材：\n${material || '（无）'}\n标题：${draft.title}\n正文：\n${draft.body}`;
}

function rewriteUser(draft, material, fail) {
  return `不过关：${fail.join('；')}\n素材：\n${material || '（无）'}\n原标题：${draft.title}\n原文：\n${draft.body}\n按不过关的点改一版，仍用同一套式，事实只从素材来。`;
}

async function runLint(draft, material, extraWords) {
  const fail = lintRegex(draft.title, draft.body, extraWords);
  try {
    const llm = await chatJson(lintSystem(), lintUser(draft, material));
    if (llm && llm.ok === false && Array.isArray(llm.fail)) {
      for (const f of llm.fail) {
        const s = String(f || '').trim();
        if (s) fail.push(s);
      }
    }
  } catch {
    // 模型审不了就只靠规则
  }
  return { ok: fail.length === 0, fail: [...new Set(fail)].slice(0, 6) };
}

async function composeDraft(topic, material, assets) {
  const style = pickStyle(material, topic);
  let exemplars = [];
  let extra = [];
  try {
    exemplars = assets ? assets.exemplarsFor(style) : [];
    extra = assets ? assets.extraBanned() : [];
  } catch { /* 资产层坏了不影响起草 */ }
  let parsed = null;
  let draftError;
  try {
    parsed = await chatJson(draftSystem(style, exemplars), draftUser(topic, material, style));
  } catch (e) {
    parsed = null;
    draftError = String(e.message || e);
  }
  let draft = { ...asDraft(parsed, topic, material), style };
  let rewritten = false;
  let lint = await runLint(draft, material, extra);
  for (let i = 0; i < 2 && !lint.ok; i++) {
    rewritten = true;
    try {
      const next = await chatJson(draftSystem(style, exemplars), rewriteUser(draft, material, lint.fail));
      draft = { ...asDraft(next, draft.title, material), style };
    } catch {
      break;
    }
    lint = await runLint(draft, material, extra);
  }
  return { ...draft, style, lint, rewritten, exemplarUsed: exemplars.length, fallback: !parsed, error: parsed ? undefined : draftError };
}

function loadDotEnv(file, allow) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    if (allow && !allow.has(k)) continue;
    if (process.env[k]) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

const NOTE_ENV_KEYS = new Set([
  'NOTE_LLM_KEY', 'NOTE_LLM_BASE_URL', 'NOTE_LLM_MODEL',
  'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
  'NOTE_IMAGE_KEY', 'NOTE_IMAGE_PROVIDER', 'NOTE_IMAGE_MODEL', 'FAL_KEY', 'SILICONFLOW_API_KEY',
  'HERMES_IMAGE_URL', 'HERMES_IMAGE_TOKEN',
]);

function parseLlmJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = (fenced ? fenced[1] : raw).trim();
  const start = s.search(/[\[{]/);
  if (start < 0) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(start));
}

function fallbackDraft(topic, material) {
  const fact = String(material || '').trim().split(/[。\n！？]/).map((s) => s.trim()).find(Boolean) || '';
  const t = String(topic || '').trim() || fact || '赶海回来桌上已经有菜了';
  const extra = fact ? `${fact}。\n\n` : '';
  return {
    title: t,
    body: `来宁海之前没想过，原来赶海回来还能直接开饭。\n\n${extra}客房不大，但被窝是干的，院子里有人择菜。晚饭是刚上来的小青龙，壳一剥就甜。\n\n没有那种「度假区」的劲儿，更像借住在村里。走的时候袋子里还装着没吃完的白蟹。`,
    tags: ['宁海民宿', '赶海', '小青龙', '海边生活'],
  };
}

function fallbackStoryboard(topic, body) {
  const seed = String(topic || body || '海边民宿').slice(0, 40);
  const wants = [
    { role: '封面', want: `住客视角的封面：${seed}，有人、有烟火气，不要海报字` },
    { role: '图2', want: '客房或院子一角，午后自然光，像随手拍的' },
    { role: '图3', want: '晚饭：小青龙或海鲜上桌，桌面真实，不要广告摆盘' },
    { role: '图4', want: '赶海或海边小路，有泥、有水、有人弯腰' },
    { role: '图5', want: '包吃住的厨房或院子择菜，生活感' },
    { role: '图6', want: '离开前的一个细节：门口、袋子、傍晚院子' },
  ];
  return wants.map((w, i) => ({
    id: `s${i + 1}`,
    role: w.role,
    want: w.want,
    prompt: buildImagePrompt(w.want),
  }));
}

function buildImagePrompt(want) {
  const w = String(want || '').trim() || 'Chinese coastal homestay, candid guest photo';
  return [
    'Photorealistic candid photo, Xiaohongshu lifestyle snapshot,',
    'Ninghai Zhejiang seaside village homestay, natural light, real textures,',
    w,
    ', no text, no watermark, no logo, no poster layout, 3:4 portrait',
  ].join(' ');
}

function isKimiK3(model) {
  return /^(k3|kimi-k3)\b/i.test(String(model || ''));
}

function llmConfig() {
  const baseOverride = (process.env.NOTE_LLM_BASE_URL || '').replace(/\/$/, '');
  const modelOverride = process.env.NOTE_LLM_MODEL || '';
  if (process.env.NOTE_LLM_KEY) {
    return {
      key: process.env.NOTE_LLM_KEY,
      base: baseOverride || 'https://api.kimi.com/coding/v1',
      model: modelOverride || 'k3',
    };
  }
  if (process.env.KIMI_API_KEY) {
    return {
      key: process.env.KIMI_API_KEY,
      base: baseOverride || 'https://api.kimi.com/coding/v1',
      model: modelOverride || 'k3',
    };
  }
  if (process.env.MOONSHOT_API_KEY) {
    return {
      key: process.env.MOONSHOT_API_KEY,
      base: baseOverride || 'https://api.moonshot.cn/v1',
      model: modelOverride || 'kimi-k3',
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      key: process.env.DEEPSEEK_API_KEY,
      base: baseOverride || 'https://api.deepseek.com/v1',
      model: modelOverride || 'deepseek-chat',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      key: process.env.OPENAI_API_KEY,
      base: baseOverride || 'https://api.openai.com/v1',
      model: modelOverride || 'gpt-4o-mini',
    };
  }
  return { key: '', base: '', model: '' };
}

async function chatJson(system, user) {
  const { key, base, model } = llmConfig();
  if (!key) return null;
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (isKimiK3(model)) payload.reasoning_effort = 'low';
  else payload.temperature = 0.7;
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(isKimiK3(model) ? 180000 : 60000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `文案接口 HTTP ${r.status}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('文案接口没有返回内容');
  return parseLlmJson(text);
}

function imageProvider() {
  if (process.env.NOTE_IMAGE_PROVIDER) return process.env.NOTE_IMAGE_PROVIDER;
  if (process.env.HERMES_IMAGE_URL) return 'hermes';
  if (process.env.FAL_KEY) return 'fal';
  if (process.env.SILICONFLOW_API_KEY) return 'siliconflow';
  if (process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY) return 'openai';
  return 'pollinations';
}

async function generateViaHermes(prompt, dest) {
  const base = (process.env.HERMES_IMAGE_URL || '').replace(/\/$/, '');
  const token = process.env.HERMES_IMAGE_TOKEN || '';
  if (!base) throw new Error('未配置 HERMES_IMAGE_URL（本机 Hermes 出图桥）');
  if (!token) throw new Error('未配置 HERMES_IMAGE_TOKEN');
  let last = 'Hermes 出图失败';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, aspect_ratio: 'portrait' }),
      signal: AbortSignal.timeout(240000),
    });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 800) {
        last = '出图结果太小，不像一张图';
        continue;
      }
      fs.writeFileSync(dest, buf);
      return;
    }
    const data = await r.json().catch(() => ({}));
    last = data.error || `Hermes 出图 HTTP ${r.status}`;
    if (r.status === 401) throw new Error(last);
  }
  throw new Error(last);
}

async function fetchToFile(url, dest, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`拉图 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 800) throw new Error('出图结果太小，不像一张图');
  fs.writeFileSync(dest, buf);
}

async function generateImageBuffer(prompt, noteDir) {
  const id = crypto.randomUUID().slice(0, 12);
  const dest = path.join(noteDir, `${id}.jpg`);
  const p = imageProvider();
  if (p === 'hermes') {
    await generateViaHermes(prompt, dest);
  } else if (p === 'fal') {
    const key = process.env.FAL_KEY || process.env.NOTE_IMAGE_KEY;
    if (!key) throw new Error('未配置 FAL_KEY');
    const r = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_size: 'portrait_4_3', num_images: 1 }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || `FAL HTTP ${r.status}`);
    const url = data.images?.[0]?.url;
    if (!url) throw new Error('FAL 未返回图片地址');
    await fetchToFile(url, dest);
  } else if (p === 'siliconflow') {
    const key = process.env.SILICONFLOW_API_KEY || process.env.NOTE_IMAGE_KEY;
    if (!key) throw new Error('未配置 SILICONFLOW_API_KEY');
    const r = await fetch('https://api.siliconflow.cn/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.NOTE_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
        prompt,
        image_size: '768x1024',
        num_inference_steps: 8,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error?.message || `SiliconFlow HTTP ${r.status}`);
    const url = data.images?.[0]?.url || data.data?.[0]?.url;
    if (!url) throw new Error('SiliconFlow 未返回图片地址');
    await fetchToFile(url, dest);
  } else if (p === 'openai') {
    const key = process.env.OPENAI_API_KEY || process.env.NOTE_IMAGE_KEY;
    if (!key) throw new Error('未配置 OPENAI_API_KEY');
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'dall-e-3', prompt, size: '1024x1792', n: 1, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `OpenAI HTTP ${r.status}`);
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI 未返回图片');
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
  } else {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=1024&nologo=true&model=flux`;
    await fetchToFile(url, dest);
  }
  return id;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return out;
}

function normalizeSlots(raw) {
  const list = Array.isArray(raw) ? raw : raw?.slots;
  if (!Array.isArray(list) || !list.length) throw new Error('拆图结果为空');
  return list.slice(0, 9).map((s, i) => {
    const want = String(s.want || s.detail || s.title || '').trim();
    const role = String(s.role || (i === 0 ? '封面' : `图${i + 1}`)).trim();
    return {
      id: String(s.id || `s${i + 1}`),
      role,
      want,
      prompt: String(s.prompt || '').trim() || buildImagePrompt(want || role),
    };
  });
}

module.exports = function createNotes({ sendJson, readBody, noteDir, log = console.log, assets = null }) {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  loadDotEnv(path.join(noteDir, '..', '.env'));
  loadDotEnv(path.join(os.homedir(), '.hermes', '.env'), NOTE_ENV_KEYS);
  fs.mkdirSync(noteDir, { recursive: true });

  return async function handle(req, res, u) {
    const p = u.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/api/notes/status') {
      const llm = llmConfig();
      return sendJson(res, 200, {
        llm: Boolean(llm.key),
        model: llm.model || '',
        image: imageProvider(),
      });
    }

    if (method === 'GET' && p === '/api/notes/file') {
      const id = String(u.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(noteDir, `${id}.jpg`);
      if (!id || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(file));
    }

    if (method === 'POST' && p === '/api/notes/draft') {
      const body = await readBody(req);
      const topic = String(body.topic || '').trim();
      const material = String(body.material || '').trim();
      if (!topic && !material) return sendJson(res, 400, { ok: false, error: '先写今日素材或选题' });
      try {
        const draft = await composeDraft(topic, material, assets);
        if (assets) {
          if (draft.exemplarUsed) log(`[notes] draft 用了 ${draft.exemplarUsed} 条资产例文（${draft.style}）`);
          try { assets.recordMaterial({ material, topic, style: draft.style }); } catch { /* 记录失败不影响返回 */ }
        }
        return sendJson(res, 200, {
          ok: true,
          title: draft.title,
          body: draft.body,
          tags: draft.tags,
          style: draft.style,
          lint: draft.lint,
          rewritten: Boolean(draft.rewritten),
          fallback: Boolean(draft.fallback),
          error: draft.error,
        });
      } catch (e) {
        log(`[notes] draft ${e.message}`);
        const fb = fallbackDraft(topic, material);
        const style = pickStyle(material, topic);
        if (assets) {
          try { assets.recordMaterial({ material, topic, style }); } catch { /* 记录失败不影响返回 */ }
        }
        let extra = [];
        try { extra = assets ? assets.extraBanned() : []; } catch { extra = []; }
        const fail = lintRegex(fb.title, fb.body, extra);
        return sendJson(res, 200, {
          ok: true,
          fallback: true,
          error: String(e.message || e),
          ...fb,
          style,
          lint: { ok: fail.length === 0, fail },
        });
      }
    }

    if (method === 'POST' && p === '/api/notes/lint') {
      const body = await readBody(req);
      const title = String(body.title || body.topic || '').trim();
      const copy = String(body.body || '').trim();
      const material = String(body.material || '').trim();
      if (!copy) return sendJson(res, 400, { ok: false, error: '先有正文' });
      let extra = [];
      try { extra = assets ? assets.extraBanned() : []; } catch { extra = []; }
      try {
        const draft = { title, body: copy, tags: Array.isArray(body.tags) ? body.tags : [] };
        let lint = await runLint(draft, material, extra);
        let next = draft;
        let rewritten = false;
        if (!lint.ok && body.rewrite) {
          const style = String(body.style || pickStyle(material, title));
          let exemplars = [];
          try { exemplars = assets ? assets.exemplarsFor(style) : []; } catch { exemplars = []; }
          const parsed = await chatJson(draftSystem(style, exemplars), rewriteUser(draft, material, lint.fail));
          next = asDraft(parsed, title, material);
          lint = await runLint(next, material, extra);
          rewritten = true;
        }
        return sendJson(res, 200, {
          ok: true,
          lint,
          rewritten,
          title: next.title,
          body: next.body,
          tags: next.tags,
        });
      } catch (e) {
        log(`[notes] lint ${e.message}`);
        const fail = lintRegex(title, copy, extra);
        return sendJson(res, 200, { ok: true, lint: { ok: fail.length === 0, fail }, title, body: copy });
      }
    }

    if (method === 'POST' && p === '/api/notes/storyboard') {
      const body = await readBody(req);
      const topic = String(body.topic || '').trim();
      const copy = String(body.body || '').trim();
      if (!copy) return sendJson(res, 400, { ok: false, error: '先定分享正文' });
      try {
        const parsed = await chatJson(
          `${VOICE}\n只返回 JSON 数组。每项：{"role":"封面或图2…","want":"这张要拍到什么，中文，具体可改","prompt":"英文出图提示词，写实，不要字"}。6 张，第一张是封面。`,
          `选题：${topic}\n正文：\n${copy}\n按这条分享拆成一组小红书图，每张一个场景，不要重复。`,
        );
        const slots = parsed ? normalizeSlots(parsed) : fallbackStoryboard(topic, copy);
        return sendJson(res, 200, { ok: true, fallback: !parsed, slots });
      } catch (e) {
        log(`[notes] storyboard ${e.message}`);
        return sendJson(res, 200, { ok: true, fallback: true, error: String(e.message || e), slots: fallbackStoryboard(topic, copy) });
      }
    }

    if (method === 'POST' && p === '/api/notes/generate') {
      const body = await readBody(req);
      const slots = Array.isArray(body.slots) ? body.slots : [];
      if (!slots.length) return sendJson(res, 400, { ok: false, error: '还没有图组' });
      try {
        const results = await mapPool(slots.slice(0, 9), 3, async (s) => {
          const prompt = String(s.prompt || '').trim() || buildImagePrompt(s.want);
          const imageId = await generateImageBuffer(prompt, noteDir);
          return { id: s.id, imageId };
        });
        return sendJson(res, 200, { ok: true, results, provider: imageProvider() });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (method === 'POST' && p === '/api/notes/generate-one') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim();
      const want = Math.min(4, Math.max(1, Number(body.n) || 3));
      const n = imageProvider() === 'hermes' ? 1 : want;
      if (!prompt) return sendJson(res, 400, { ok: false, error: '这张还没有提示词' });
      try {
        const ids = [];
        for (let i = 0; i < n; i++) ids.push(await generateImageBuffer(prompt, noteDir));
        return sendJson(res, 200, { ok: true, imageIds: ids, provider: imageProvider() });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    return sendJson(res, 404, { error: 'unknown notes api' });
  };
};

module.exports.parseLlmJson = parseLlmJson;
module.exports.buildImagePrompt = buildImagePrompt;
module.exports.fallbackDraft = fallbackDraft;
module.exports.fallbackStoryboard = fallbackStoryboard;
module.exports.normalizeSlots = normalizeSlots;
module.exports.llmConfig = llmConfig;
module.exports.imageProvider = imageProvider;
module.exports.generateImageBuffer = generateImageBuffer;
module.exports.pickStyle = pickStyle;
module.exports.lintRegex = lintRegex;
module.exports.asDraft = asDraft;
module.exports.STYLES = STYLES;
