'use strict';

// Questions asked while connecting: a private key's passphrase (saved hosts
// have no field for one, so it's asked for when the key turns out to be
// encrypted), and keyboard-interactive login (servers set up for PAM or a
// second factor often offer nothing else).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');
const { loadMain, waitFor, sleep } = require('../helpers/main-harness');
const { startSshServer } = require('../helpers/ssh-server');

const PASSPHRASE = 'correct horse battery';
const app = loadMain();

// Every auth-prompt main sends, and how the "person" answers it: a function
// from the prompt to its answers, or null to cancel.
let prompts = [];
let answer = null;
app.onSend((channel, args) => {
  if (channel === 'host-key-prompt') app.answerHostKey(args.requestId, 'once');
  if (channel === 'auth-prompt') {
    prompts.push(args);
    setImmediate(() => app.emit('auth-response', { requestId: args.requestId, answers: answer(args) }));
  }
});

// Servers that accept only keyboard-interactive, asking what a real one would
const passwordOnlyKbd = (ctx) => {
  if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
  ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
    (answers[0] === 'secret' ? ctx.accept() : ctx.reject(['keyboard-interactive'])));
};
const twoFactor = (ctx) => {
  if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
  ctx.prompt([{ prompt: 'Verification code: ', echo: true }], 'Two-factor login', 'Enter the code from your app.',
    (answers) => (answers[0] === '123456' ? ctx.accept() : ctx.reject(['keyboard-interactive'])));
};

let keyServer;
let kbdServer;
let otpServer;
let keyPath;

before(async () => {
  keyServer = await startSshServer();
  kbdServer = await startSshServer({ authenticate: passwordOnlyKbd });
  otpServer = await startSshServer({ authenticate: twoFactor });
  keyPath = path.join(app.userData, 'id_ed25519_locked');
  fs.writeFileSync(keyPath, utils.generateKeyPairSync('ed25519', { passphrase: PASSPHRASE, cipher: 'aes256-ctr' }).private);
});
after(async () => {
  await Promise.all([keyServer.close(), kbdServer.close(), otpServer.close()]);
  app.cleanup();
});
beforeEach(() => { prompts = []; });

let sessionCount = 0;
async function connect(server, config) {
  const sessionId = `auth-${++sessionCount}`;
  const result = await app.connect({ sessionId, port: server.port, config });
  if (result.outcome === 'connected') app.disconnect(sessionId);
  return result;
}
const withKey = (extra = {}) => ({ authType: 'key', privateKeyPath: keyPath, password: null, ...extra });

// --- A key's passphrase

test('an encrypted key without a passphrase is asked for one, and connects once given it', async () => {
  answer = () => [PASSPHRASE];
  assert.equal((await connect(keyServer, withKey())).outcome, 'connected');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, 'passphrase');
  assert.deepEqual(prompts[0].prompts, [{ prompt: 'Passphrase', echo: false }]);
  assert.match(prompts[0].instructions, /id_ed25519_locked/);
  assert.equal(prompts[0].error, '');
});

test('a wrong passphrase is asked for again, saying so', async () => {
  let asked = 0;
  answer = () => [++asked === 1 ? 'not it' : PASSPHRASE];
  assert.equal((await connect(keyServer, withKey())).outcome, 'connected');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].error, /did not unlock/);
});

test('after three wrong passphrases the key error is reported', async () => {
  answer = () => ['not it'];
  const result = await connect(keyServer, withKey());
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /Cannot use private key/);
  assert.equal(prompts.length, 3);
});

test('cancelling the passphrase cancels the connection before anything is sent', async () => {
  answer = () => null;
  const accepted = keyServer.state.connectionsAccepted;
  const result = await connect(keyServer, withKey());
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /passphrase was not entered/);
  await sleep(200);
  assert.equal(keyServer.state.connectionsAccepted, accepted, 'no connection was attempted');
});

test('a passphrase already given (Quick Connect) is used without asking', async () => {
  answer = () => null;
  assert.equal((await connect(keyServer, withKey({ passphrase: PASSPHRASE }))).outcome, 'connected');
  assert.equal(prompts.length, 0);
});

// --- Keyboard-interactive

test('a keyboard-interactive-only server gets the saved password, without asking', async () => {
  answer = () => null;
  const result = await connect(kbdServer, { authType: 'password', password: 'secret' });
  assert.equal(result.outcome, 'connected');
  assert.equal(prompts.length, 0);
});

test('a one-time code prompt is put to the person, in the server\'s words', async () => {
  answer = (p) => (p.prompts[0].prompt === 'Verification code: ' ? ['123456'] : null);
  const result = await connect(otpServer, { authType: 'password', password: 'secret' });
  assert.equal(result.outcome, 'connected');
  assert.equal(prompts.length, 1);
  const [p] = prompts;
  assert.equal(p.kind, 'keyboard-interactive');
  assert.equal(p.title, 'Two-factor login');
  assert.equal(p.instructions, 'Enter the code from your app.');
  assert.deepEqual(p.prompts, [{ prompt: 'Verification code: ', echo: true }]);
});

test('cancelling a server\'s question ends the connection', async () => {
  answer = () => null;
  const result = await connect(otpServer, { authType: 'password', password: 'secret' });
  assert.equal(result.outcome, 'error');
  assert.match(result.message, /not answered/);
  await waitFor(() => otpServer.state.openConnections === 0, { message: 'the server to see the connection end' });
});
