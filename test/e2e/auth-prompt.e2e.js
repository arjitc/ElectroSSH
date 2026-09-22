'use strict';

// Questions asked while connecting, in the real app: a saved host whose key is
// encrypted asks for the passphrase (wrong ones are asked again), and a
// two-factor server's one-time code prompt is shown in its own words. Esc
// cancels the connection.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer, generateKey } = require('../helpers/ssh-server');

const PASSPHRASE = 'correct horse battery';
const twoFactor = (ctx) => {
  if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
  ctx.prompt([{ prompt: 'Verification code: ', echo: true }], 'Two-factor login', 'Enter the code from your app.',
    (answers) => (answers[0] === '123456' ? ctx.accept() : ctx.reject(['keyboard-interactive'])));
};

// Only a key will do, so the test can't pass by quietly logging in some other way
const keyOnly = (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey']));

run(async () => {
  const t = await start();
  const keyServer = await startSshServer({ authenticate: keyOnly });
  const otpServer = await startSshServer({ authenticate: twoFactor });

  const dialog = () => t.js(`(() => {
    const m = document.getElementById('auth-prompt-modal');
    const inputs = [...m.querySelectorAll('#auth-prompt-fields input')];
    return {
      shown: !m.classList.contains('hidden'),
      title: document.getElementById('auth-prompt-title').textContent,
      instructions: document.getElementById('auth-prompt-instructions').textContent,
      error: document.getElementById('auth-prompt-error').textContent,
      labels: [...m.querySelectorAll('#auth-prompt-fields label')].map((l) => l.textContent),
      types: inputs.map((i) => i.type),
      focused: document.activeElement && document.activeElement.id
    };
  })()`);
  const answerWith = async (text) => {
    await t.js(`document.getElementById('auth-prompt-input-0').value = ${JSON.stringify(text)}; 'ok'`);
    await t.press('Return');
  };
  const acceptHostKeyIfAsked = () => t.js(`(() => { const m = document.getElementById('host-key-modal');
    if (!m.classList.contains('hidden')) document.getElementById('btn-host-key-once').click(); })()`);

  // --- A saved host whose key is encrypted, added the way a person would:
  // through Settings, so the page knows the key
  const keyPath = path.join(app.getPath('userData'), 'id_ed25519_locked');
  fs.writeFileSync(keyPath, generateKey('ed25519', { passphrase: PASSPHRASE, cipher: 'aes256-ctr' }));
  await t.js(`document.getElementById('existing-key-path').value = ${JSON.stringify(keyPath)};
    document.getElementById('existing-key-name').value = 'locked key';
    document.getElementById('btn-add-existing-key').click(); 'ok'`);
  await waitFor(() => t.js(`[...document.querySelectorAll('#save-key option')].some((o) => o.textContent.startsWith('locked key'))`));
  await t.js(`window.electronAPI.listSSHKeys()
    .then((result) => {
      const key = result.keys.find((k) => k.name === 'locked key');
      return window.electronAPI.saveHost({ name: 'Key box', host: '127.0.0.1', port: ${keyServer.port}, username: 'tester',
        authType: 'key', keyId: key.id, groupId: 'default', keepalive: 0 });
    })
    .then(() => { document.getElementById('search-input').dispatchEvent(new Event('input')); return 'ok'; })`);
  await waitFor(() => t.js(`!!document.querySelector('.tree-host')`));

  let before = keyServer.state.shellsOpened;
  await t.js(`document.querySelector('.tree-host').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 'ok'`);
  let d;
  check('a saved host with an encrypted key asks for its passphrase',
    await waitFor(async () => (d = await dialog()).shown, 5000) && d.title === 'Unlock private key', d);
  check('naming the key, in a hidden field that has focus',
    d.instructions.includes('id_ed25519_locked') && d.types[0] === 'password' && d.focused === 'auth-prompt-input-0', d);

  await answerWith('not it');
  check('a wrong passphrase is asked for again, saying so',
    await waitFor(async () => (d = await dialog()).shown && /did not unlock/.test(d.error), 5000), d);

  await answerWith(PASSPHRASE);
  check('the right one connects', await t.waitForShell(keyServer, before));

  // --- A two-factor server
  const quickConnect = (server) => t.js(`document.getElementById('quick-connect-btn').click();
    document.getElementById('inp-host').value = '127.0.0.1';
    document.getElementById('inp-port').value = '${server.port}';
    document.getElementById('inp-user').value = 'tester';
    document.getElementById('inp-pass').value = 'secret';
    document.getElementById('btn-connect').click(); 'ok'`);
  const waitForDialog = () => waitFor(async () => { await acceptHostKeyIfAsked(); return (d = await dialog()).shown; }, 8000);

  before = otpServer.state.shellsOpened;
  await quickConnect(otpServer);
  check('a one-time code prompt appears', await waitForDialog(), d);
  check('in the server\'s words, with the code visible as it is typed',
    d.title === 'Two-factor login' && d.instructions === 'Enter the code from your app.'
      && d.labels[0] === 'Verification code' && d.types[0] === 'text', d);
  await t.js(`document.getElementById('auth-prompt-input-0').value = '123456'; 'ok'`);
  await t.click('#btn-auth-submit');
  check('the code connects', await t.waitForShell(otpServer, before));

  // --- Esc cancels
  await quickConnect(otpServer);
  await waitForDialog();
  await t.press('Escape');
  const banner = () => t.js(`(() => { const tab = document.querySelector('.tab.active');
    const msg = document.querySelector('.terminal-instance.active .term-banner-msg');
    return { disconnected: tab.classList.contains('disconnected'), message: msg ? msg.textContent : '' }; })()`);
  let b;
  check('Esc cancels that connection, and the tab says why',
    await waitFor(async () => /not answered/.test((b = await banner()).message) && b.disconnected, 5000) && !(await dialog()).shown, b);

  await Promise.all([keyServer.close(), otpServer.close()]);
});
