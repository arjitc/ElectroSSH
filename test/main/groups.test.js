'use strict';

// Group rename and delete, through main.js's 'rename-group' / 'delete-group'
// handlers against a real (temporary) saved_hosts.json.

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');

const app = loadMain();
after(() => app.cleanup());

const STORE = 'saved_hosts.json';
const nameOf = (store, id) => (store.groups.find((g) => g.id === id) || {}).name;
const hasGroup = (store, id) => store.groups.some((g) => g.id === id);

beforeEach(() => {
  app.writeStore(STORE, {
    groups: [
      { id: 'default', name: 'Default' },
      { id: 'g-prod', name: 'Production' },
      { id: 'g-lax', name: 'LAX' },
      { id: 'g-empty', name: 'Empty Group' }
    ],
    hosts: [
      { id: 'h1', name: 'web-01', host: '10.0.0.1', port: 22, username: 'deploy', groupId: 'g-prod' },
      { id: 'h2', name: 'db', host: '10.0.0.2', port: 22, username: 'root', groupId: 'g-prod' },
      { id: 'h3', name: 'box', host: '10.0.0.3', port: 22, username: 'root', groupId: 'default' }
    ]
  });
});

describe('rename-group', () => {
  test('renames the group and keeps its hosts', async () => {
    const store = await app.invoke('rename-group', { groupId: 'g-prod', name: 'Production EU' });
    assert.equal(nameOf(store, 'g-prod'), 'Production EU');
    assert.equal(store.hosts.filter((h) => h.groupId === 'g-prod').length, 2);
    assert.equal(nameOf(app.readStore(STORE), 'g-prod'), 'Production EU', 'persisted');
  });

  test('trims whitespace', async () => {
    const store = await app.invoke('rename-group', { groupId: 'g-lax', name: '  Los Angeles  ' });
    assert.equal(nameOf(store, 'g-lax'), 'Los Angeles');
  });

  test('refuses a name another group already has, ignoring case', async () => {
    const store = await app.invoke('rename-group', { groupId: 'g-lax', name: 'production' });
    assert.equal(nameOf(store, 'g-lax'), 'LAX');
  });

  test('allows a group to keep its own name', async () => {
    const store = await app.invoke('rename-group', { groupId: 'g-lax', name: 'lax' });
    assert.equal(nameOf(store, 'g-lax'), 'lax');
  });

  test('refuses a blank name', async () => {
    const store = await app.invoke('rename-group', { groupId: 'g-lax', name: '   ' });
    assert.equal(nameOf(store, 'g-lax'), 'LAX');
  });

  test('ignores an unknown group', async () => {
    const store = await app.invoke('rename-group', { groupId: 'nope', name: 'Ghost' });
    assert.equal(store.groups.length, 4);
  });

  test('the Default group can be renamed, and no second Default appears', async () => {
    await app.invoke('rename-group', { groupId: 'default', name: 'Personal' });
    // readHostStore re-creates a missing 'default' group; renaming must not trigger that
    const store = await app.invoke('get-hosts');
    assert.equal(store.groups.filter((g) => g.id === 'default').length, 1);
    assert.equal(nameOf(store, 'default'), 'Personal');
    assert.ok(!store.groups.some((g) => g.name === 'Default'));
  });
});

describe('delete-group', () => {
  test('deletes an empty group and leaves everything else', async () => {
    const result = await app.invoke('delete-group', 'g-empty');
    assert.equal(result.ok, true);
    assert.ok(!hasGroup(result.store, 'g-empty'));
    assert.ok(!hasGroup(app.readStore(STORE), 'g-empty'), 'persisted');
    assert.deepEqual(result.store.groups.map((g) => g.id), ['default', 'g-prod', 'g-lax']);
    assert.equal(result.store.hosts.length, 3);
  });

  test('refuses a group that has hosts, and says how many', async () => {
    const result = await app.invoke('delete-group', 'g-prod');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'has-hosts');
    assert.equal(result.hostCount, 2);
    assert.ok(hasGroup(app.readStore(STORE), 'g-prod'));
  });

  test('refuses the built-in Default group', async () => {
    const result = await app.invoke('delete-group', 'default');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'default-group');
  });

  test('refuses unknown or missing ids', async () => {
    assert.equal((await app.invoke('delete-group', 'ghost')).reason, 'not-found');
    assert.equal((await app.invoke('delete-group', '')).reason, 'missing-id');
    assert.equal((await app.invoke('delete-group', undefined)).reason, 'missing-id');
  });

  test('a group becomes deletable once its last host is removed', async () => {
    await app.invoke('delete-host', 'h1');
    await app.invoke('delete-host', 'h2');
    const result = await app.invoke('delete-group', 'g-prod');
    assert.equal(result.ok, true);
  });
});
