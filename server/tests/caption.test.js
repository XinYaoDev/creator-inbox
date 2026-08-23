'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCaption, scoreAsset, albumFromPath, grams2 } = require('../caption.js');
const { visionConfig } = require('../llm.js');

test('parseCaption: 围栏 JSON', () => {
  const v = parseCaption('```json\n{"caption":"院子夜景暖灯俯拍","keywords":["院子","夜景","俯拍"]}\n```');
  assert.equal(v.caption, '院子夜景暖灯俯拍');
  assert.deepStrictEqual(v.keywords, ['院子', '夜景', '俯拍']);
});

test('parseCaption: 缺 caption 抛错', () => {
  assert.throws(() => parseCaption('{"keywords":["院子"]}'));
});

test('grams2: 双字滑窗', () => {
  assert.deepStrictEqual([...grams2('院子夜')], ['院子', '子夜']);
});

test('albumFromPath: 去掉精选照片壳和序号', () => {
  assert.equal(albumFromPath('/media/02_餐桌成品菜/03_精选照片/a.jpg'), '餐桌成品菜');
  assert.equal(albumFromPath('/media/01_预览图/02_民宿经营/x.jpg'), '民宿经营');
});

test('scoreAsset: 关键词命中 + 实拍加权', () => {
  const photo = {
    ai_caption: '傍晚民宿院子，暖灯串，长桌俯拍',
    ai_keywords: '院子,夜景,俯拍,餐桌',
    original_tags: '',
    file_path: '/m/02_餐桌成品菜/03_精选照片/a.jpg',
    source: 'nas',
    shoot_time: 1,
  };
  const ai = { ...photo, source: 'ai' };
  const q = '院子晚上俯拍的餐桌';
  assert.ok(scoreAsset(photo, q) > scoreAsset(ai, q));
  assert.ok(scoreAsset(photo, q) >= 4);
  assert.equal(scoreAsset(photo, '完全不相关的词xyz'), 0);
});

test('scoreAsset: 专辑名命中', () => {
  const a = {
    ai_caption: '',
    ai_keywords: '',
    original_tags: '',
    file_path: '/m/02_餐桌成品菜/03_精选照片/a.jpg',
    source: 'nas',
  };
  assert.ok(scoreAsset(a, '来一张餐桌成品菜特写') >= 2);
});

test('visionConfig: 跟起草同一套 Kimi k3', () => {
  const keep = {
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    NOTE_LLM_KEY: process.env.NOTE_LLM_KEY,
    NOTE_LLM_BASE_URL: process.env.NOTE_LLM_BASE_URL,
    NOTE_LLM_MODEL: process.env.NOTE_LLM_MODEL,
    LIB_VISION_MODEL: process.env.LIB_VISION_MODEL,
  };
  try {
    delete process.env.NOTE_LLM_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.NOTE_LLM_BASE_URL;
    delete process.env.NOTE_LLM_MODEL;
    delete process.env.LIB_VISION_MODEL;
    process.env.KIMI_API_KEY = 'kimi-test';
    const c = visionConfig();
    assert.equal(c.key, 'kimi-test');
    assert.equal(c.base, 'https://api.kimi.com/coding/v1');
    assert.equal(c.model, 'k3');
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
