const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');

test('workflow accessibility text stays anchored inside its content scroller', () => {
  const css = readFileSync(resolve(__dirname, '../../src/growth.css'), 'utf8');
  const dom = new JSDOM(`<style>${css}</style><div class="g-content"><div class="g-workflow-studio"><span class="g-sr-only">编辑历史 0</span></div></div>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const scroller = getComputedStyle(document.querySelector('.g-content'));
    const text = getComputedStyle(document.querySelector('.g-sr-only'));
    assert.equal(scroller.position, 'relative');
    assert.equal(scroller.overflow, 'auto');
    assert.equal(text.position, 'absolute');
    assert.equal(text.top, '0px');
    assert.equal(text.left, '0px');
    assert.equal(text.clipPath, 'inset(50%)');
    assert.notEqual(text.display, 'none');
    assert.notEqual(text.visibility, 'hidden');
  } finally { dom.window.close(); }
});
