'use strict';

// Host key verification (trust on first use) through the real ssh-connect
// flow, against local SSH servers whose host keys the test controls. The
// tests run in order: each builds on the known_hosts.json left by the last.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadMain, waitFor } = require('../helpers/main-harness');
const { startSshServer, generateHostKey, fingerprintOf } = require('../helpers/ssh-server');

const app = loadMain();
const KNOWN_HOSTS = 'known_hosts.json';

// How the "user" answers the next prompt(s)
let answer = () => {};
const prompts = [];
app.onSend((channel, args) => {
  if (channel !== 'host-key-prompt') return;
  prompts.push(args);
  answer(args);
});
const respondWith = (decision) => { answer = (p) => app.answerHostKey(p.requestId, decision); };
const promptsSince = (i) => prompts.slice(i);

const keyA = generateHostKey();                       // the genuine server
const keyB = generateHostKey();                       // an impostor, or a rebuilt box
const keyRsa = generateHostKey('rsa', { bits: 2048 }); // same host, other key type
let port;
let hostId;
let server;
let sessionCount = 0;
const nextSessionId = () => `s${++sessionCount}`;

async function serveOnSamePort(hostKey) {
  if (server) await server.close();
  server = await startSshServer({ hostKey, port });
}

before(async () => {
  server = await startSshServer({ hostKey: keyA });
  port = server.port;
  hostId = `127.0.0.1:${port}`;
});

after(async () => {
  for (let i = 1; i <= sessionCount; i++) app.disconnect(`s${i}`);
  if (server) await server.close();
  app.cleanup();
});

test('first contact prompts with the key type and fingerprint, and Accept saves it', async () => {
  const mark = prompts.length;
  respondWith('accept');
  const result = await app.connect({ sessionId: nextSessionId(), port });
  const [prompt] = promptsSince(mark);

  assert.equal(result.outcome, 'connected');
  assert.equal(prompt.status, 'unknown');
  assert.equal(prompt.keyType, 'ssh-ed25519');
  assert.equal(prompt.fingerprint, fingerprintOf(keyA));
  assert.ok(!('key' in prompt), 'the raw key blob stays in the main process');
  assert.ok(app.readStore(KNOWN_HOSTS).hosts[hostId]['ssh-ed25519'], 'saved to known_hosts.json');
});

test('fingerprint matches ssh-keygen -l output', { skip: !hasSshKeygen() && 'ssh-keygen not on PATH' }, () => {
  const saved = app.readStore(KNOWN_HOSTS).hosts[hostId]['ssh-ed25519'];
  const pubFile = path.join(app.userData, 'server.pub');
  fs.writeFileSync(pubFile, `ssh-ed25519 ${saved.key} test\n`);
  const reported = execFileSync('ssh-keygen', ['-lf', pubFile], { encoding: 'utf-8' }).split(/\s+/)[1];
  assert.equal(saved.fingerprint, reported);
});

test('a known host with the same key connects without asking', async () => {
  const mark = prompts.length;
  respondWith('reject'); // would fail the connection if a prompt appeared
  const result = await app.connect({ sessionId: nextSessionId(), port });
  assert.equal(result.outcome, 'connected');
  assert.equal(promptsSince(mark).length, 0);
});

test('a changed key warns with both fingerprints, and Reject refuses to connect', async () => {
  await serveOnSamePort(keyB);
  const mark = prompts.length;
  respondWith('reject');
  const result = await app.connect({ sessionId: nextSessionId(), port });
  const [prompt] = promptsSince(mark);

  assert.equal(prompt.status, 'changed');
  assert.equal(prompt.fingerprint, fingerprintOf(keyB));
  assert.equal(prompt.previousFingerprint, fingerprintOf(keyA));
  assert.equal(result.outcome, 'error');
  assert.equal(result.message, 'Connection cancelled: the host key was not accepted.');
  assert.equal(app.readStore(KNOWN_HOSTS).hosts[hostId]['ssh-ed25519'].fingerprint, fingerprintOf(keyA),
    'the saved key is untouched');
});

test('Connect Once connects without saving, and asks again next time', async () => {
  respondWith('once');
  const result = await app.connect({ sessionId: nextSessionId(), port });
  assert.equal(result.outcome, 'connected');
  assert.equal(app.readStore(KNOWN_HOSTS).hosts[hostId]['ssh-ed25519'].fingerprint, fingerprintOf(keyA));

  const mark = prompts.length;
  respondWith('reject');
  await app.connect({ sessionId: nextSessionId(), port });
  assert.equal(promptsSince(mark).length, 1);
});

test('a new key type for a known host is flagged separately, and Accept stores both', async () => {
  await serveOnSamePort(keyRsa);
  const mark = prompts.length;
  respondWith('accept');
  const result = await app.connect({ sessionId: nextSessionId(), port });
  const [prompt] = promptsSince(mark);

  assert.equal(result.outcome, 'connected');
  assert.equal(prompt.status, 'new-key-type');
  assert.deepEqual(prompt.knownKeyTypes, ['ssh-ed25519']);
  assert.deepEqual(Object.keys(app.readStore(KNOWN_HOSTS).hosts[hostId]).sort(), ['ssh-ed25519', 'ssh-rsa']);
});

test('closing the tab while the prompt is open cancels it and connects nothing', async () => {
  const other = await startSshServer();
  const sessionId = nextSessionId();
  const mark = app.sent.length;
  let prompt = null;
  answer = (p) => { prompt = p; setTimeout(() => app.disconnect(sessionId), 100); };
  app.connect({ sessionId, port: other.port, timeoutMs: 2500 });

  await waitFor(() => prompt, { message: 'host key prompt' });
  await waitFor(() => app.sent.slice(mark).some((m) => m.channel === 'host-key-prompt-cancel'),
    { message: 'prompt cancel message' });
  const after = app.sent.slice(mark);
  assert.ok(after.some((m) => m.channel === 'host-key-prompt-cancel' && m.args.requestId === prompt.requestId),
    'the renderer is told to dismiss the dialog');
  assert.ok(!after.some((m) => m.channel === 'ssh-data' && m.args.sessionId === sessionId), 'no shell opened');
  assert.ok(!(app.readStore(KNOWN_HOSTS).hosts[`127.0.0.1:${other.port}`]), 'nothing saved');
  await other.close();
});

test('rekeys during a session do not prompt again after Connect Once', async () => {
  // ssh2 re-runs the host verifier on every key exchange; the key this
  // connection already accepted must not be asked about a second time.
  let rekeys = 0;
  let marker = false;
  const rekeying = await startSshServer({
    onShell: ({ client, stream }) => {
      setTimeout(() => client.rekey(() => {
        rekeys++;
        client.rekey(() => { rekeys++; stream.write('after-rekey\r\n'); marker = true; });
      }), 150);
    }
  });
  const sessionId = nextSessionId();
  const mark = prompts.length;
  respondWith('once');
  const result = await app.connect({ sessionId, port: rekeying.port });
  await waitFor(() => marker, { message: 'both rekeys to finish' });

  assert.equal(result.outcome, 'connected');
  assert.equal(rekeys, 2);
  assert.equal(promptsSince(mark).length, 1, 'one prompt for the whole session');
  assert.ok(!app.sent.some((m) => m.channel === 'ssh-error' && m.args.sessionId === sessionId));
  app.disconnect(sessionId);
  await rekeying.close();
});

function hasSshKeygen() {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // ssh-keygen exits non-zero for -? but still exists; ENOENT means it's missing
    return e.code !== 'ENOENT';
  }
}
