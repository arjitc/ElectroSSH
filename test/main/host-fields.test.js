'use strict';

// A saved host's display name, address and username are trimmed: spaces
// around them come from pasting, and "example.com " fails to resolve. Hosts
// saved before this was done are cleaned as they're read. The password is
// kept exactly as typed.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');

const app = loadMain();
after(() => app.cleanup());

test('a new host is saved without spaces around its name, address and username', async () => {
  const store = await app.invoke('save-host', {
    name: '  Web server  ', host: ' 203.0.113.10 ', port: 22, username: '\tdeploy ', password: ' pass word ',
    authType: 'password', groupId: 'default'
  });
  const host = store.hosts.find((h) => h.host === '203.0.113.10');
  assert.ok(host, 'saved with a trimmed address');
  assert.equal(host.name, 'Web server');
  assert.equal(host.username, 'deploy');
  assert.equal(host.password, ' pass word ', 'the password is left as typed');
});

test('editing a host trims too', async () => {
  const { hosts } = await app.invoke('save-host', { name: 'db', host: '203.0.113.20', port: 22, username: 'root' });
  const { id } = hosts.find((h) => h.name === 'db');
  const store = await app.invoke('save-host', { id, name: 'db ', host: '203.0.113.21 ', port: 22, username: ' root' });
  const edited = store.hosts.filter((h) => h.id === id);
  assert.equal(edited.length, 1, 'edited in place');
  assert.deepEqual([edited[0].name, edited[0].host, edited[0].username], ['db', '203.0.113.21', 'root']);
});

test('a host saved with spaces before this fix reads back trimmed', async () => {
  app.writeStore('saved_hosts.json', {
    groups: [{ id: 'default', name: 'Default' }],
    hosts: [{ id: 'old', name: 'Mail ', host: 'mail.example.com ', port: 22, username: ' admin', password: ' x ', groupId: 'default' }]
  });
  const { hosts } = await app.invoke('get-hosts');
  const old = hosts.find((h) => h.id === 'old');
  assert.deepEqual([old.name, old.host, old.username], ['Mail', 'mail.example.com', 'admin']);
  assert.equal(old.password, ' x ');
});

test('fields that aren\'t text are left alone', async () => {
  app.writeStore('saved_hosts.json', {
    groups: [{ id: 'default', name: 'Default' }],
    hosts: [{ id: 'odd', host: '203.0.113.30', port: 22, groupId: 'default' }]
  });
  const { hosts } = await app.invoke('get-hosts');
  const odd = hosts.find((h) => h.id === 'odd');
  assert.equal(odd.name, undefined);
  assert.equal(odd.username, undefined);
  assert.equal(odd.host, '203.0.113.30');
});
