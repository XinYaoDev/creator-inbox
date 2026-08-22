// 纯逻辑单测：node --test server/tests/
// 用临时 DB 路径 require 服务端模块（不会启动服务/采集，见 index.js 的 require.main 守卫）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-')), 'test.db');

const {
  dyParseTime, pick, isAuthError, avatarHostAllowed, accountCond, pendingCommentCond, wxExtractUuid,
} = require('../index.js');

test('dyParseTime: 秒级时间戳直接透传', () => {
  assert.strictEqual(dyParseTime(1722700000), 1722700000);
  assert.strictEqual(dyParseTime('1722700000'), 1722700000);
});

test('dyParseTime: 中文日期字符串', () => {
  const expected = Math.floor(new Date(2026, 7, 4, 9, 20).getTime() / 1000);
  assert.strictEqual(dyParseTime('发布于2026年08月04日 09:20'), expected);
});

test('dyParseTime: 无效输入返回 0', () => {
  assert.strictEqual(dyParseTime(''), 0);
  assert.strictEqual(dyParseTime(null), 0);
  assert.strictEqual(dyParseTime('随便一段文字'), 0);
});

test('pick: 多候选路径取第一个非空字符串', () => {
  const obj = { a: { b: '' }, c: { d: 'hit' }, e: ['arr-val'] };
  assert.strictEqual(pick(obj, ['a.b', 'c.d']), 'hit');
  assert.strictEqual(pick(obj, ['x.y', 'e']), 'arr-val'); // 数组取首个字符串
  assert.strictEqual(pick(obj, ['x.y', 'a.b']), '');
  assert.strictEqual(pick(null, ['a']), '');
});

test('isAuthError: 只认鉴权类错误，限流不算', () => {
  assert.strictEqual(isAuthError('请求过于频繁，请稍后再试'), false);
  assert.strictEqual(isAuthError(''), false);
  assert.strictEqual(isAuthError(null), false);
  assert.strictEqual(isAuthError('登录已失效，请重新登录'), true);
  assert.strictEqual(isAuthError('未登录或登录态已过期'), true);
  assert.strictEqual(isAuthError('Forbidden'), true);
});

test('avatarHostAllowed: 白名单精确匹配 + 后缀，拒绝形似域名', () => {
  assert.strictEqual(avatarHostAllowed('wx.qlogo.cn'), true);
  assert.strictEqual(avatarHostAllowed('a.b.douyinpic.com'), true);
  assert.strictEqual(avatarHostAllowed('douyinpic.com'), true);
  assert.strictEqual(avatarHostAllowed('evil.com'), false);
  assert.strictEqual(avatarHostAllowed('evildouyinpic.com'), false);
  assert.strictEqual(avatarHostAllowed('douyinpic.com.evil.com'), false);
});

test('accountCond: null 不筛选，空数组强制无结果，其余拼 IN', () => {
  const args = [];
  assert.strictEqual(accountCond('c.accountId', null, args), '1=1');
  assert.strictEqual(accountCond('c.accountId', [], args), '1=0');
  assert.strictEqual(accountCond('c.accountId', [1, 2], args), 'c.accountId IN (?,?)');
  assert.deepStrictEqual(args, [1, 2]);
});

test('pendingCommentCond: 以 isAuthor 快照判定，不再实时比对昵称', () => {
  const sql = pendingCommentCond('c');
  assert.match(sql, /COALESCE\(c\.isAuthor, 0\) = 0/);
  assert.match(sql, /r\.rootCommentId = c\.commentId AND COALESCE\(r\.isAuthor, 0\) = 1/);
  assert.match(sql, /handled_marks/);
  assert.doesNotMatch(sql, /nickname <>/);
});

test('wxExtractUuid: 从 qrcode 路径和 uuid 赋值两种写法提取', () => {
  assert.strictEqual(wxExtractUuid('/connect/qrcode/04124wyz3UVDFa1h"'), '04124wyz3UVDFa1h');
  assert.strictEqual(wxExtractUuid("uuid: 'AbCdef1234'"), 'AbCdef1234');
  assert.strictEqual(wxExtractUuid('nope'), '');
});
