'use strict';

// A session outlives the window it belonged to: the SSH channel closes after
// the page is gone, and main still has news to report. Electron throws on a
// send to a destroyed webContents, and an uncaught exception in the main
// process puts up its "A JavaScript error occurred" dialog, which blocks the
// app (and, in the e2e tests, looks exactly like a hang).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain, sleep } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const app = loadMain();
let server;

// Trust the test server's key for this connection, without saving it
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') app.answerHostKey(args.requestId, 'once');
});

before(async () => { server = await startSshServer(); });
after(async () => {
  await server.close();
  app.cleanup();
});

test('a session closing after the window is gone reports nothing, and throws nothing', async () => {
  const result = await app.connect({ sessionId: 'outlives-window', port: server.port });
  assert.equal(result.outcome, 'connected');

  app.destroySender();               // the window has closed
  const before = app.sent.length;
  app.disconnect('outlives-window'); // the channel closes; main would report it

  await sleep(600);
  assert.equal(app.sent.length, before, 'nothing was sent to the destroyed window');
});

test('the server sees the connection end', async () => {
  await sleep(200);
  assert.equal(server.state.openConnections, 0);
});
