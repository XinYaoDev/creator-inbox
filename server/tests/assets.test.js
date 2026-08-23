'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const createAssets = require('../assets.js');
const notes = require('../notes.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
}

function make(dir) {
  return createAssets({
    sendJson(res, code, obj) {
      res.statusCode = code;
      res.body = obj;
    },
    readBody: async (req) => req.body || {},
    assetDir: dir,
    guessStyle: notes.pickStyle,
  });
}

test('三池：记素材、存成稿去重、summary 计数', () => {
  const dir = tmpDir();
  try {
    const a = make(dir);
    a.recordMaterial({ material: '退潮挖到蛏子', topic: '', style: '情绪出片' });
    const first = a.saveNote({ title: '赶海回来桌上有菜', body: '院子里有人择菜', style: '情绪出片', tags: ['赶海'] });
    const dup = a.saveNote({ title: '赶海回来桌上有菜', body: '院子里有人择菜', style: '情绪出片' });
    assert.ok(first.id);
    assert.equal(dup.id, first.id);
    assert.equal(dup.dedup, true);
    const s = a.summary();
    assert.equal(s.materials, 1);
    assert.equal(s.notes, 1);
    assert.equal(s.cases, 0);
    assert.equal(s.recentNotes[0].id, first.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill 写入 stats', () => {
  const dir = tmpDir();
  try {
    const a = make(dir);
    const { id } = a.saveNote({ title: '第一次看泥里小洞', body: '挖了没有东西', style: '提问互动' });
    const rec = a.backfill({ id, likes: 88, favorites: 12, comments: 3, shares: 1 });
    assert.equal(rec.stats.likes, 88);
    assert.equal(rec.stats.favorites, 12);
    const s = a.summary();
    assert.equal(s.recentNotes[0].stats.likes, 88);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extraBanned 读 banned.txt，忽略空行和注释', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'banned.txt'), '冲冲冲\n# 备注\n\n私信老板\n');
    const a = make(dir);
    assert.deepEqual(a.extraBanned(), ['冲冲冲', '私信老板']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exemplarsFor: 同套式按赞+藏取前 2，再加自己最好的 1 条', () => {
  const dir = tmpDir();
  try {
    const a = make(dir);
    const cases = [
      { noteId: 'c1', title: '低赞', excerpt: '一般', style: '提问互动', likes: 10, favorites: 1 },
      { noteId: 'c2', title: '第一次赶海这些小管管是什么呀', excerpt: '挖了挖也没东西', style: '提问互动', likes: 900, favorites: 200 },
      { noteId: 'c3', title: '泥里那些洞是什么', excerpt: '好奇挖了没有', style: '提问互动', likes: 400, favorites: 80 },
      { noteId: 'c4', title: '躺着看海', excerpt: '被窝是干的', style: '情绪出片', likes: 9999, favorites: 999 },
    ];
    for (const c of cases) {
      fs.appendFileSync(path.join(dir, 'cases.jsonl'), `${JSON.stringify(c)}\n`);
    }
    const weak = a.saveNote({ title: '自己弱的', body: '一般', style: '提问互动' });
    a.backfill({ id: weak.id, likes: 2, favorites: 0, comments: 0, shares: 0 });
    const strong = a.saveNote({ title: '自己好的提问', body: '第一次看泥里那些小洞', style: '提问互动' });
    a.backfill({ id: strong.id, likes: 50, favorites: 20, comments: 4, shares: 0 });
    const shots = a.exemplarsFor('提问互动');
    assert.equal(shots.length, 3);
    assert.match(shots[0], /小管管/);
    assert.match(shots[1], /泥里那些洞/);
    assert.match(shots[2], /自己好的提问/);
    assert.ok(!shots.some((s) => s.includes('低赞') || s.includes('躺着看海') || s.includes('自己弱的')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('learn: 经本地假桥写入 case', async () => {
  const dir = tmpDir();
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/xhs-note') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        note: {
          id: '69f8b65b0000000035032684',
          title: '第一次赶海，这些小管管是什么呀',
          desc: '感觉很好奇，但是挖了挖也没东西呀',
          nick: '住客甲',
          liked: 1200,
          collected: 800,
          comment: 40,
          share: 10,
          time: 1700000000000,
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const keep = {
    HERMES_IMAGE_URL: process.env.HERMES_IMAGE_URL,
    HERMES_IMAGE_TOKEN: process.env.HERMES_IMAGE_TOKEN,
  };
  try {
    process.env.HERMES_IMAGE_URL = `http://127.0.0.1:${port}`;
    process.env.HERMES_IMAGE_TOKEN = 'test-token';
    const a = make(dir);
    const { case: c, updated } = await a.learn('https://www.xiaohongshu.com/explore/69f8b65b0000000035032684');
    assert.equal(updated, false);
    assert.equal(c.noteId, '69f8b65b0000000035032684');
    assert.match(c.title, /小管管/);
    assert.equal(c.likes, 1200);
    assert.equal(c.favorites, 800);
    assert.equal(c.style, '提问互动');
    const again = await a.learn('https://www.xiaohongshu.com/explore/69f8b65b0000000035032684');
    assert.equal(again.updated, true);
    assert.equal(a.summary().cases, 1);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(keep)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('handle: summary / 非法链接 / 手动补录', async () => {
  const dir = tmpDir();
  try {
    const a = make(dir);
    a.recordMaterial({ material: '下雨打牌', topic: '', style: '情绪出片' });
    const res = {};
    await a.handle({ method: 'GET' }, res, { pathname: '/api/assets/summary' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.materials, 1);

    const bad = {};
    await a.handle(
      { method: 'POST', body: { url: 'https://example.com/x' } },
      bad,
      { pathname: '/api/assets/learn' },
    );
    assert.equal(bad.statusCode, 400);

    const manual = {};
    await a.handle(
      { method: 'POST', body: { title: '第一次赶海原来是这样的', excerpt: '赶海相当于种地', likes: 300, favorites: 90 } },
      manual,
      { pathname: '/api/assets/case' },
    );
    assert.equal(manual.statusCode, 200);
    assert.equal(manual.body.ok, true);
    assert.equal(manual.body.case.style, '纠正想象');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
