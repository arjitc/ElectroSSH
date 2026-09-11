'use strict';

// Per-host keepalive is normalised by main.js when hosts are saved and read:
// 5 seconds by default, 0 disables, 3600 at most. (renderer.js keeps an
// identical copy of normalizeKeepalive for display.)

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');

const app = loadMain();
after(() => app.cleanup());

async function saveWithKeepalive(keepalive) {
  const name = `host-${Math.random().toString(16).slice(2)}`;
  const store = await app.invoke('save-host', { name, host: '10.0.0.1', port: 22, username: 'u', keepalive });
  return store.hosts.find((h) => h.name === name).keepalive;
}

const cases = [
  [undefined, 5, 'missing'],
  ['', 5, 'empty string'],
  [null, 5, 'null'],
  [0, 0, '0 (disabled)'],
  ['0', 0, '"0" from a form field'],
  [5, 5, 'default'],
  ['30', 30, 'numeric string'],
  ['abc', 5, 'non-numeric'],
  [-3, 5, 'negative'],
  [12.7, 12, 'fraction (floors)'],
  [99999, 3600, 'above the maximum'],
  [true, 5, 'boolean']
];

for (const [input, expected, label] of cases) {
  test(`keepalive ${label} -> ${expected}`, async () => {
    assert.equal(await saveWithKeepalive(input), expected);
  });
}

test('hosts saved before keepalive existed read back with the 5s default', async () => {
  app.writeStore('saved_hosts.json', {
    groups: [{ id: 'default', name: 'Default' }],
    hosts: [{ id: 'old', name: 'legacy', host: '10.0.0.9', port: 22, username: 'root', groupId: 'default' }]
  });
  const { hosts } = await app.invoke('get-hosts');
  assert.equal(hosts.find((h) => h.id === 'old').keepalive, 5);
});
