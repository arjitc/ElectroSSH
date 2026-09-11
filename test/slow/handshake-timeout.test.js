'use strict';

// ssh2's own 20s handshake timeout counts the time a person spends reading the
// host key prompt. main.js replaces it with a timer that pauses while the
// prompt is open. This waits 23s before answering, so it lives outside the
// default test run: `npm run test:slow`.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const DECISION_DELAY_MS = 23000;

const app = loadMain();
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') setTimeout(() => app.answerHostKey(args.requestId, 'accept'), DECISION_DELAY_MS);
});

let server;
after(async () => {
  app.disconnect('slow');
  if (server) await server.close();
  app.cleanup();
});

test('a host key decision that takes longer than 20s still connects', { timeout: 60000 }, async () => {
  server = await startSshServer();
  const result = await app.connect({ sessionId: 'slow', port: server.port, timeoutMs: 45000 });
  assert.equal(result.outcome, 'connected');
  assert.ok(result.ms > 20000, `took ${result.ms}ms, which should exceed ssh2's 20s default`);
});
