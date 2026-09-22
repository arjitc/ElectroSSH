'use strict';

// The shell stream's life: output decoding, reconnecting over a live session,
// and input that arrives before the shell exists.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain, waitFor, sleep } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const app = loadMain();
let server;
let shells = [];

// Trust the test server's key for each connection, without saving it
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') app.answerHostKey(args.requestId, 'once');
});

before(async () => { server = await startSshServer({ onShell: ({ stream }) => shells.push(stream) }); });
after(async () => {
  await server.close();
  app.cleanup();
});

const messagesFor = (sessionId, from) =>
  app.sent.slice(from).filter((m) => m.args && m.args.sessionId === sessionId);
const typedSince = (index) => server.state.shellData.slice(index).join('');

test('a UTF-8 character split across SSH packets arrives intact', async () => {
  shells = [];
  const result = await app.connect({ sessionId: 'utf8', port: server.port });
  assert.equal(result.outcome, 'connected');
  const mark = app.sent.length;

  // '€' (E2 82 AC) then '😀' (F0 9F 98 80), cut mid-character twice, as a
  // busy link can deliver them
  for (const bytes of [[0xE2, 0x82], [0xAC, 0xF0], [0x9F, 0x98, 0x80]]) {
    shells[0].write(Buffer.from(bytes));
    await sleep(120);
  }
  await sleep(200);

  const text = messagesFor('utf8', mark).filter((m) => m.channel === 'ssh-data').map((m) => m.args.data).join('');
  app.disconnect('utf8');
  assert.equal(text, '€😀');
});

test('reconnecting over a live session: no stale "Closed", and the new connection works', async () => {
  const first = await app.connect({ sessionId: 'rc', port: server.port });
  assert.equal(first.outcome, 'connected');

  // The same session id again while the first connection is still open, as
  // the banner's Reconnect button does
  const mark = app.sent.length;
  const second = await app.connect({ sessionId: 'rc', port: server.port });
  assert.equal(second.outcome, 'connected', 'the new connection completes');
  await sleep(500); // the old connection finishes closing

  const statuses = messagesFor('rc', mark).filter((m) => m.channel === 'ssh-status').map((m) => m.args.status);
  assert.ok(!statuses.includes('Closed'), `the old connection's close is not reported: ${statuses.join(', ')}`);

  const index = server.state.shellData.length;
  app.emit('term-input', { sessionId: 'rc', data: 'still-here\r' });
  await waitFor(() => typedSince(index).includes('still-here'), { message: 'typing to reach the new shell' });
  assert.equal(server.state.openConnections, 1, 'only the new connection is left open');
  app.disconnect('rc');
});

test('keys typed while connecting are dropped quietly, not reported as errors', async () => {
  const mark = app.sent.length;
  const pending = app.connect({ sessionId: 'early', port: server.port });
  app.emit('term-input', { sessionId: 'early', data: '\r' }); // Enter pressed at "Connecting..."
  assert.equal((await pending).outcome, 'connected');
  const errors = messagesFor('early', mark).filter((m) => m.channel === 'ssh-error');
  app.disconnect('early');
  assert.deepEqual(errors, []);
});

test('once "Connected" is reported, the very next key reaches the shell', async () => {
  // Reported at 'ready', before the shell opened, a key typed straight
  // afterwards failed and marked a working tab disconnected
  let probed = false;
  const index = server.state.shellData.length;
  app.onSend((channel, args) => {
    if (channel === 'ssh-status' && args.sessionId === 'first-key' && args.status === 'Connected' && !probed) {
      probed = true;
      app.emit('term-input', { sessionId: 'first-key', data: 'first-key\r' });
    }
  });
  const mark = app.sent.length;
  assert.equal((await app.connect({ sessionId: 'first-key', port: server.port })).outcome, 'connected');
  await waitFor(() => typedSince(index).includes('first-key'), { message: 'the first key to reach the shell' });
  const errors = messagesFor('first-key', mark).filter((m) => m.channel === 'ssh-error');
  app.disconnect('first-key');
  assert.deepEqual(errors, []);
});
