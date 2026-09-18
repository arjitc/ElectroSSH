'use strict';

// 'clipboard-write' copies text for the page through Electron's clipboard,
// which, unlike navigator.clipboard, works while the window isn't focused.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');

const written = [];
const app = loadMain({ clipboard: { writeText: (text) => written.push(text) } });
after(() => app.cleanup());

test('copies a string', async () => {
  assert.equal(await app.invoke('clipboard-write', '142.93.215.8'), true);
  assert.deepEqual(written.slice(-1), ['142.93.215.8']);
});

test('refuses anything that is not a string', async () => {
  const before = written.length;
  for (const value of [null, undefined, 42, ['x'], { toString: () => 'x' }]) {
    assert.equal(await app.invoke('clipboard-write', value), false, String(value));
  }
  assert.equal(written.length, before);
});

test('refuses absurdly large text', async () => {
  const before = written.length;
  assert.equal(await app.invoke('clipboard-write', 'x'.repeat(16 * 1024 * 1024 + 1)), false);
  assert.equal(written.length, before);
});
