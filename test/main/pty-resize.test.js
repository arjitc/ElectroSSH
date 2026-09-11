'use strict';

// The remote pty must end up the size the terminal is drawing at. A resize
// that arrived during the SSH handshake used to be dropped, leaving full-screen
// apps like htop drawing short.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain, waitFor, sleep } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const app = loadMain();
// These tests are about sizing, so trust each test server's key when asked
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') setImmediate(() => app.answerHostKey(args.requestId, 'once'));
});

const servers = [];
const sessions = [];
after(async () => {
  sessions.forEach((id) => app.disconnect(id));
  await Promise.all(servers.map((s) => s.close()));
  app.cleanup();
});

const CONNECT_SIZE = { cols: 80, rows: 24 };
const RESIZED = { cols: 203, rows: 61 };

// The size the remote side ends up with: the last window-change, else the pty's opening size
const effectiveSize = (state) => state.windowChanges[state.windowChanges.length - 1] || state.ptySizes[state.ptySizes.length - 1];

test('a resize sent while the handshake is still running reaches the pty', async () => {
  const server = await startSshServer();
  servers.push(server);
  sessions.push('during');

  const connecting = app.connect({ sessionId: 'during', port: server.port, size: CONNECT_SIZE });
  // The window is resized before the shell exists
  app.emit('term-resize', { sessionId: 'during', ...RESIZED });

  assert.equal((await connecting).outcome, 'connected');
  await sleep(300); // let any window-change land
  assert.deepEqual(effectiveSize(server.state), RESIZED);
});

test('a resize after the shell opens sends one window-change, and repeats are deduplicated', async () => {
  const server = await startSshServer();
  servers.push(server);
  sessions.push('after');

  assert.equal((await app.connect({ sessionId: 'after', port: server.port, size: CONNECT_SIZE })).outcome, 'connected');
  assert.deepEqual(server.state.ptySizes[0], CONNECT_SIZE);

  for (let i = 0; i < 3; i++) app.emit('term-resize', { sessionId: 'after', ...RESIZED });
  await waitFor(() => server.state.windowChanges.length > 0, { message: 'window-change' });
  await sleep(300);

  assert.deepEqual(server.state.windowChanges, [RESIZED], 'exactly one packet for three identical resizes');
});
