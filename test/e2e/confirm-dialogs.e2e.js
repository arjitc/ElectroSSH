'use strict';

// Deleting a host or a group and removing a key ask in the app's own dialog,
// not a native window.confirm, and a failed key generation says so under the
// button rather than in an alert(). The page's confirm and alert are replaced
// with recorders (that say yes), so any native dialog left would show up.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { start, check, run, waitFor } = require('./harness');

run(async () => {
  const t = await start();
  await t.js(`window.__native = [];
    window.confirm = (message) => { window.__native.push('confirm: ' + message); return true; };
    window.alert = (message) => { window.__native.push('alert: ' + message); }; 'ok'`);

  const dialog = () => t.js(`(() => ({
    shown: !document.getElementById('session-loss-modal').classList.contains('hidden'),
    title: document.getElementById('session-loss-title').textContent,
    lead: document.getElementById('session-loss-lead').textContent,
    focused: document.activeElement && document.activeElement.id
  }))()`);
  const shown = (selector) => t.js(`!document.querySelector(${JSON.stringify(selector)}).classList.contains('hidden')`);
  const hostNames = () => t.js(`[...document.querySelectorAll('.tree-host .host-name')].map((n) => n.textContent)`);
  let d;

  // A key, added through Settings, and hosts: one plain, one using the key
  const userData = app.getPath('userData');
  const keyPath = path.join(userData, 'id_work');
  fs.writeFileSync(keyPath, 'not a real key; only listed');
  await t.js(`document.getElementById('existing-key-path').value = ${JSON.stringify(keyPath)};
    document.getElementById('existing-key-name').value = 'work key';
    document.getElementById('btn-add-existing-key').click(); 'ok'`);
  await waitFor(() => t.js(`[...document.querySelectorAll('#save-key option')].some((o) => o.textContent.startsWith('work key'))`));
  await t.js(`window.electronAPI.listSSHKeys()
    .then((r) => window.electronAPI.saveHost({ name: 'Keyed', host: '203.0.113.5', port: 22, username: 'deploy',
      authType: 'key', keyId: r.keys.find((k) => k.name === 'work key').id, groupId: 'default', keepalive: 5 }))
    .then(() => window.electronAPI.saveHost({ name: 'Web 01', host: '203.0.113.11', port: 22, username: 'ubuntu',
      password: 'x', authType: 'password', groupId: 'default', keepalive: 5 }))
    .then(() => window.electronAPI.saveGroup('Empty'))
    .then(() => { document.getElementById('search-input').dispatchEvent(new Event('input')); return 'ok'; })`);
  await waitFor(async () => (await hostNames()).length === 2);

  // --- Deleting a host
  await t.js(`[...document.querySelectorAll('.tree-host')].find((r) => r.querySelector('.host-name').textContent === 'Web 01')
    .querySelector('.edit-host-btn').click(); 'ok'`);
  await t.click('#btn-delete-host');
  d = await dialog();
  check('deleting a host asks in the app\'s own dialog',
    d.shown && d.title === 'Delete this host?' && d.lead.includes('"Web 01"'), d);
  check('with Cancel focused', d.focused === 'btn-session-loss-cancel', d);
  await t.press('Escape');
  check('Esc keeps the host, and its dialog stays open',
    !(await dialog()).shown && await shown('#save-host-modal') && (await hostNames()).includes('Web 01'));
  await t.click('#btn-delete-host');
  await t.click('#btn-session-loss-confirm');
  check('confirming deletes it', await waitFor(async () => !(await hostNames()).includes('Web 01'), 3000)
    && !(await shown('#save-host-modal')));

  // --- Deleting an empty group
  await t.js(`[...document.querySelectorAll('.tree-group')].find((g) => g.querySelector('.group-name').textContent === 'Empty')
    .querySelector('.rename-group-btn').click(); 'ok'`);
  await t.click('#btn-group-delete');
  d = await dialog();
  check('deleting a group asks in the app\'s own dialog', d.shown && d.title === 'Delete this group?' && d.lead.includes('"Empty"'), d);
  await t.click('#btn-session-loss-confirm');
  check('confirming deletes it', await waitFor(() => t.js(
    `![...document.querySelectorAll('#group-filter option')].some((o) => o.textContent === 'Empty')`), 3000));

  // --- Removing a key a host uses
  await t.click('#open-settings-btn');
  await t.js(`document.getElementById('settings-nav-keys').click();
    [...document.querySelectorAll('.key-card')].find((c) => c.querySelector('.key-title span').textContent === 'work key')
      .querySelector('.btn-danger').id = 'test-remove-key'; 'ok'`);
  await t.click('#test-remove-key');
  d = await dialog();
  check('removing a key asks in the app\'s own dialog', d.shown && d.title === 'Remove this key?', d);
  check('and warns that a saved host uses it', /1 saved host uses it/.test(d.lead), d.lead);
  await t.click('#btn-session-loss-cancel');
  const keyListed = () => t.js(`[...document.querySelectorAll('.key-card .key-title span')].some((s) => s.textContent === 'work key')`);
  check('Cancel keeps the key', !(await dialog()).shown && await keyListed());
  await t.js(`[...document.querySelectorAll('.key-card')].find((c) => c.querySelector('.key-title span').textContent === 'work key')
    .querySelector('.btn-danger').id = 'test-remove-key'; 'ok'`);
  await t.click('#test-remove-key');
  await t.click('#btn-session-loss-confirm');
  check('confirming removes it', await waitFor(async () => !(await keyListed()), 3000));

  // --- A key generation that fails
  fs.writeFileSync(path.join(userData, 'id_taken'), 'already here');
  // The button is far down the Settings page; bring it on screen for a real click
  await t.js(`document.getElementById('new-key-directory').value = ${JSON.stringify(userData)};
    document.getElementById('new-key-name').value = 'id_taken';
    document.getElementById('btn-generate-key').scrollIntoView({ block: 'center' }); 'ok'`);
  await t.click('#btn-generate-key');
  let error = '';
  check('a failed key generation says so under the button',
    await waitFor(async () => (error = await t.js(`document.getElementById('generate-key-error').textContent`)).length > 0, 5000)
      && error.startsWith('Key generation failed: Key ') && error.endsWith('already exists'), error);
  check('without Electron\'s "Error invoking remote method" prefix', !error.includes('invoking remote method'), error);

  const native = await t.js('window.__native');
  check('no native confirm() or alert() was used', native.length === 0, native);
});
