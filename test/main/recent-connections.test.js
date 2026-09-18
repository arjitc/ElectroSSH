'use strict';

// Main records each successful connection for the home view's recent list:
// newest first, at most 10, one entry per saved host or one-off target, and
// never a password.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const { loadMain } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const app = loadMain();
let server;
let sessionCount = 0;

// Trust the test server's key for each connection, without saving it
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') app.answerHostKey(args.requestId, 'once');
});

before(async () => { server = await startSshServer(); });
after(async () => {
  await server.close();
  app.cleanup();
});

const recent = () => app.invoke('get-recent-connections');
const resetRecent = () => app.writeStore('recent_connections.json', { entries: [] });

/** Connect, wait for the shell (or a failure), then disconnect. */
async function connectOnce(options = {}) {
  const sessionId = `recent-${++sessionCount}`;
  const result = await app.connect({ sessionId, port: server.port, ...options });
  if (result.outcome === 'connected') app.disconnect(sessionId);
  return result;
}

test('a successful connection is recorded, without its password', async () => {
  const result = await connectOnce({ config: { password: 'correct-horse-battery' } });
  assert.equal(result.outcome, 'connected');

  const list = await recent();
  assert.equal(list.length, 1);
  const [entry] = list;
  assert.deepEqual(Object.keys(entry).sort(),
    ['authType', 'host', 'hostId', 'id', 'keepalive', 'keyId', 'lastConnected', 'name', 'port', 'username']);
  assert.equal(entry.host, '127.0.0.1');
  assert.equal(entry.port, server.port);
  assert.equal(entry.username, 'tester');
  assert.equal(entry.authType, 'password');
  assert.equal(entry.hostId, null);
  assert.ok(Date.now() - entry.lastConnected < 10000, 'lastConnected is a current timestamp');

  const raw = fs.readFileSync(app.storePath('recent_connections.json'), 'utf-8');
  assert.ok(!raw.includes('correct-horse-battery'), 'the password is not in the file');
});

test('a one-off session keeps the keep-alive it used, normalized', async () => {
  resetRecent();
  await connectOnce({ config: { username: 'kay', keepalive: 15 } });
  await connectOnce({ config: { username: 'lee', keepalive: '-3' } });
  const byUser = Object.fromEntries((await recent()).map((e) => [e.username, e.keepalive]));
  assert.deepEqual(byUser, { kay: 15, lee: 5 });
});

test('a connection that fails is not recorded', async () => {
  // A port that was free a moment ago: the connection is refused
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const listed = await recent();
  const result = await connectOnce({ port });
  assert.equal(result.outcome, 'error');
  assert.deepEqual(await recent(), listed);
});

test('the newest is first, and a repeat moves up instead of duplicating', async () => {
  resetRecent();
  await connectOnce({ config: { username: 'alice' } });
  await connectOnce({ config: { username: 'bob' } });
  await connectOnce({ config: { username: 'alice' } });
  assert.deepEqual((await recent()).map((e) => e.username), ['alice', 'bob']);
});

test('only the 10 most recent are kept', async () => {
  const older = Array.from({ length: 10 }, (_, i) => ({
    hostId: null, name: null, host: `10.0.0.${i}`, port: 22, username: 'root',
    authType: 'password', keyId: null, lastConnected: 1000 + i
  }));
  app.writeStore('recent_connections.json', { entries: older });

  await connectOnce();
  const list = await recent();
  assert.equal(list.length, 10);
  assert.equal(list[0].host, '127.0.0.1');
  assert.equal(list[1].host, '10.0.0.9');
  assert.ok(!list.some((e) => e.host === '10.0.0.0'), 'the oldest entry is dropped');
});

test('a saved host is recorded by id and name; an unknown id counts as one-off', async () => {
  resetRecent();
  app.writeStore('saved_hosts.json', {
    hosts: [{ id: 'h1', name: 'Build box', host: '127.0.0.1', port: server.port, username: 'tester', authType: 'password' }],
    groups: [{ id: 'default', name: 'Default' }]
  });

  await connectOnce({ hostId: 'h1' });
  await connectOnce({ hostId: 'no-such-host' });
  const [oneOff, saved] = await recent();

  assert.equal(saved.hostId, 'h1');
  assert.equal(saved.name, 'Build box');
  assert.equal(saved.id, 'host:h1');
  assert.equal(oneOff.hostId, null);
  assert.equal(oneOff.name, null);
  assert.equal(oneOff.id, `quick:tester@127.0.0.1:${server.port}`);
});

test('entries can be removed one at a time, or all at once', async () => {
  resetRecent();
  await connectOnce({ config: { username: 'alice' } });
  await connectOnce({ config: { username: 'bob' } });

  const [bob] = await recent();
  const afterRemove = await app.invoke('remove-recent-connection', bob.id);
  assert.deepEqual(afterRemove.map((e) => e.username), ['alice']);
  assert.deepEqual(await recent(), afterRemove);

  assert.deepEqual(await app.invoke('clear-recent-connections'), []);
  assert.deepEqual(await recent(), []);
});

test('an unreadable file starts a new list', async () => {
  fs.writeFileSync(app.storePath('recent_connections.json'), '{ not json');
  assert.deepEqual(await recent(), []);
  await connectOnce();
  assert.equal((await recent()).length, 1);
});
