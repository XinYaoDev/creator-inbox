'use strict';

const test = require('node:test');
const assert = require('node:assert');
const notes = require('../notes.js');

test('parseLlmJson: 去掉 markdown 围栏', () => {
  const v = notes.parseLlmJson('```json\n{"body":"hi","tags":["a"]}\n```');
  assert.strictEqual(v.body, 'hi');
  assert.deepStrictEqual(v.tags, ['a']);
});

test('parseLlmJson: 前有废话也能切到 JSON', () => {
  const v = notes.parseLlmJson('好的，这是结果：\n{"body":"x"}');
  assert.strictEqual(v.body, 'x');
});

test('fallbackDraft: 无选题也有正文和话题', () => {
  const d = notes.fallbackDraft('');
  assert.ok(d.body.includes('宁海'));
  assert.ok(d.tags.length >= 2);
  assert.ok(d.title);
});

test('fallbackDraft: 素材第一句会写进正文', () => {
  const d = notes.fallbackDraft('', '退潮后来的，挖到三只蛏子。下雨打牌。');
  assert.ok(d.body.includes('挖到三只蛏子'));
  assert.ok(d.title.includes('蛏子') || d.title.includes('退潮'));
});

test('pickStyle: 按素材选套式', () => {
  assert.equal(notes.pickStyle('泥里那些小管管是什么，挖了挖没东西', ''), '提问互动');
  assert.equal(notes.pickStyle('第一站进不去，保安指路', ''), '探路攻略');
  assert.equal(notes.pickStyle('以为赶海是夹大螃蟹，原来像种地', ''), '纠正想象');
  assert.equal(notes.pickStyle('我们两天两晚，周末从杭州出发', ''), '周末游记');
  assert.equal(notes.pickStyle('终于躺着看海，被窝是干的', ''), '情绪出片');
});

test('lintRegex: 标题房源体、正文导流', () => {
  assert.ok(notes.lintRegex('宁海长街 8-18人整栋包吃住', '赶海回来吃饭').includes('标题像房源'));
  assert.ok(notes.lintRegex('赶海回来桌上有菜', '欢迎预订，私信老板').includes('正文有推销或导流'));
  assert.deepStrictEqual(notes.lintRegex('赶海回来桌上已经有菜了', '院子里有人择菜'), []);
});

test('lintRegex: 附加禁词命中推销', () => {
  assert.ok(notes.lintRegex('赶海回来桌上有菜', '家人们冲冲冲', ['冲冲冲']).includes('正文有推销或导流'));
  assert.deepStrictEqual(notes.lintRegex('赶海回来桌上已经有菜了', '院子里有人择菜', ['冲冲冲']), []);
});

test('fallbackStoryboard: 六张且封面在前', () => {
  const slots = notes.fallbackStoryboard('赶海', '正文');
  assert.strictEqual(slots.length, 6);
  assert.strictEqual(slots[0].role, '封面');
  assert.ok(slots[0].prompt.includes('3:4'));
});

test('normalizeSlots: 缺 prompt 时用 want 补', () => {
  const slots = notes.normalizeSlots([{ role: '封面', want: '院子黄昏' }]);
  assert.strictEqual(slots[0].want, '院子黄昏');
  assert.ok(slots[0].prompt.includes('院子黄昏'));
});

test('buildImagePrompt: 禁止海报字', () => {
  const p = notes.buildImagePrompt('客房');
  assert.match(p, /no text/);
  assert.match(p, /客房/);
});

test('llmConfig: Kimi Code 优先于 DeepSeek，默认 k3', () => {
  const keep = {
    NOTE_LLM_KEY: process.env.NOTE_LLM_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    NOTE_LLM_BASE_URL: process.env.NOTE_LLM_BASE_URL,
    NOTE_LLM_MODEL: process.env.NOTE_LLM_MODEL,
  };
  try {
    delete process.env.NOTE_LLM_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.NOTE_LLM_BASE_URL;
    delete process.env.NOTE_LLM_MODEL;
    process.env.KIMI_API_KEY = 'kimi-test';
    process.env.DEEPSEEK_API_KEY = 'deepseek-test';
    const c = notes.llmConfig();
    assert.equal(c.model, 'k3');
    assert.equal(c.base, 'https://api.kimi.com/coding/v1');
    assert.equal(c.key, 'kimi-test');
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('imageProvider: HERMES_IMAGE_URL 优先于演示源', () => {
  const keep = {
    NOTE_IMAGE_PROVIDER: process.env.NOTE_IMAGE_PROVIDER,
    HERMES_IMAGE_URL: process.env.HERMES_IMAGE_URL,
    FAL_KEY: process.env.FAL_KEY,
    SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  };
  try {
    delete process.env.NOTE_IMAGE_PROVIDER;
    delete process.env.FAL_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.HERMES_IMAGE_URL = 'http://127.0.0.1:8879';
    assert.equal(notes.imageProvider(), 'hermes');
    process.env.NOTE_IMAGE_PROVIDER = 'pollinations';
    assert.equal(notes.imageProvider(), 'pollinations');
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('generateImageBuffer: hermes 空返回后重试一次', async () => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const jpeg = Buffer.alloc(1200, 0xff);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'empty_response' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-hermes-'));
  const keep = {
    NOTE_IMAGE_PROVIDER: process.env.NOTE_IMAGE_PROVIDER,
    HERMES_IMAGE_URL: process.env.HERMES_IMAGE_URL,
    HERMES_IMAGE_TOKEN: process.env.HERMES_IMAGE_TOKEN,
  };
  try {
    process.env.NOTE_IMAGE_PROVIDER = 'hermes';
    process.env.HERMES_IMAGE_URL = `http://127.0.0.1:${port}`;
    process.env.HERMES_IMAGE_TOKEN = 'test-token';
    const id = await notes.generateImageBuffer('portrait of a wet courtyard', dir);
    const file = path.join(dir, `${id}.jpg`);
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).size, jpeg.length);
    assert.equal(hits, 2);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('generateImageBuffer: 有底图时发给桥 image 字段', async () => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const jpeg = Buffer.alloc(1200, 0xff);
  let sawImage = false;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      sawImage = Boolean(body.image) && body.image.length > 10;
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(jpeg);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-ref-'));
  const keep = {
    NOTE_IMAGE_PROVIDER: process.env.NOTE_IMAGE_PROVIDER,
    HERMES_IMAGE_URL: process.env.HERMES_IMAGE_URL,
    HERMES_IMAGE_TOKEN: process.env.HERMES_IMAGE_TOKEN,
  };
  try {
    process.env.NOTE_IMAGE_PROVIDER = 'hermes';
    process.env.HERMES_IMAGE_URL = `http://127.0.0.1:${port}`;
    process.env.HERMES_IMAGE_TOKEN = 'test-token';
    fs.writeFileSync(path.join(dir, 'ref1.jpg'), Buffer.alloc(200, 0x11));
    const id = await notes.generateImageBuffer('keep the courtyard', dir, 'ref1');
    assert.ok(fs.existsSync(path.join(dir, `${id}.jpg`)));
    assert.equal(sawImage, true);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
