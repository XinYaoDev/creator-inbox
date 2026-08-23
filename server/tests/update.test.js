'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseVer, cmpVer, readPkgVersion } = require('../update.js');

test('parseVer: 去掉 v 前缀', () => {
  assert.deepStrictEqual(parseVer('v0.2.0'), [0, 2, 0]);
  assert.deepStrictEqual(parseVer('0.3.1'), [0, 3, 1]);
  assert.strictEqual(parseVer('nope'), null);
});

test('cmpVer: 比较 GitHub tag 与本地版本', () => {
  assert.ok(cmpVer('v0.3.0', '0.2.0') > 0);
  assert.ok(cmpVer('0.2.0', 'v0.2.0') === 0);
  assert.ok(cmpVer('0.2.0', '0.2.1') < 0);
});

test('readPkgVersion: 读仓库 package.json', () => {
  const v = readPkgVersion(path.join(__dirname, '..', '..'));
  assert.match(v, /^\d+\.\d+\.\d+$/);
});
