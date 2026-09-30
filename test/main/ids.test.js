'use strict';

// New hosts and keys get random ids (UUIDv4), not timestamps. Two saved in the
// same millisecond, as an import would do, used to share an id, and editing
// or deleting one then hit the other. Ids saved before this are timestamps and
// must keep working.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain } = require('../helpers/main-harness');

const app = loadMain();
after(() => app.cleanup());

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COUNT = 20;

test('hosts saved at the same moment each get their own id', async () => {
  const names = Array.from({ length: COUNT }, (_, i) => `batch-${i}`);
  await Promise.all(names.map((name) =>
    app.invoke('save-host', { name, host: '203.0.113.40', port: 22, username: 'deploy', groupId: 'default' })));
  const { hosts } = await app.invoke('get-hosts');
  const ids = hosts.filter((h) => names.includes(h.name)).map((h) => h.id);
  assert.equal(ids.length, COUNT);
  assert.equal(new Set(ids).size, COUNT, `ids: ${ids}`);
  ids.forEach((id) => assert.match(id, UUID_V4));

  // Deleting one takes only that one
  const store = await app.invoke('delete-host', ids[0]);
  assert.equal(store.hosts.filter((h) => names.includes(h.name)).length, COUNT - 1);
});

test('keys added at the same moment each get their own id', async () => {
  const paths = Array.from({ length: COUNT }, (_, i) => path.join(app.userData, `id_test_${i}`));
  paths.forEach((p) => fs.writeFileSync(p, 'not a real key'));
  await Promise.all(paths.map((privateKeyPath, i) => app.invoke('add-ssh-key', { privateKeyPath, name: `key ${i}` })));
  const { keys } = await app.invoke('list-ssh-keys');
  const ids = keys.filter((k) => paths.includes(k.privateKeyPath)).map((k) => k.id);
  assert.equal(ids.length, COUNT);
  assert.equal(new Set(ids).size, COUNT, `ids: ${ids}`);
  ids.forEach((id) => assert.match(id, UUID_V4));

  const after = await app.invoke('delete-ssh-key', ids[0]);
  assert.equal(after.keys.filter((k) => paths.includes(k.privateKeyPath)).length, COUNT - 1);
});

test('a host saved with a timestamp id still edits and deletes', async () => {
  app.writeStore('saved_hosts.json', {
    groups: [{ id: 'default', name: 'Default' }],
    hosts: [
      { id: '1726000000000', name: 'old', host: '203.0.113.50', port: 22, username: 'root', groupId: 'default' },
      { id: '1726000000001', name: 'older', host: '203.0.113.51', port: 22, username: 'root', groupId: 'default' }
    ]
  });
  let store = await app.invoke('save-host', { id: '1726000000000', name: 'renamed', host: '203.0.113.50', port: 22, username: 'root' });
  assert.deepEqual(store.hosts.map((h) => [h.id, h.name]), [['1726000000000', 'renamed'], ['1726000000001', 'older']]);
  store = await app.invoke('delete-host', '1726000000000');
  assert.deepEqual(store.hosts.map((h) => h.id), ['1726000000001']);
});
