'use strict';

// Spaces around an address, username or display name, usually pasted, are
// dropped by Quick Connect and the host dialog; " 127.0.0.1 " would fail to
// resolve. The password is sent exactly as typed, and a field of nothing but
// spaces counts as empty.

const { ipcMain } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

const PASSWORD = ' pass word ';

// Only this username and this exact password get in, so a trimmed password or
// an untrimmed username fails the login rather than passing unnoticed
const exactLogin = (ctx) => (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === PASSWORD
  ? ctx.accept() : ctx.reject(['password']));

run(async () => {
  const t = await start();
  const server = await startSshServer({ authenticate: exactLogin });

  const connectRequests = [];
  ipcMain.on('ssh-connect', (event, payload) => connectRequests.push(payload));

  // --- Quick Connect
  const quickConnect = (host, user) => t.js(`document.getElementById('quick-connect-btn').click();
    document.getElementById('inp-host').value = ${JSON.stringify(host)};
    document.getElementById('inp-port').value = '${server.port}';
    document.getElementById('inp-user').value = ${JSON.stringify(user)};
    document.getElementById('inp-pass').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('btn-connect').click(); 'ok'`);

  await quickConnect('   ', 'tester');
  const refused = await t.js(`({ shown: !document.getElementById('quick-connect-modal').classList.contains('hidden'),
    border: document.getElementById('inp-host').style.border })`);
  check('Quick Connect treats an address of only spaces as missing',
    refused.shown && refused.border !== '' && connectRequests.length === 0, refused);
  await t.press('Escape');

  let before = server.state.shellsOpened;
  await quickConnect('  127.0.0.1 ', ' tester\t');
  check('Quick Connect with spaces around the address and username connects', await t.waitForShell(server, before));
  const sent = connectRequests[0] && connectRequests[0].config;
  check('sending them trimmed, and the password as typed',
    sent && sent.host === '127.0.0.1' && sent.username === 'tester' && sent.password === PASSWORD, sent);
  const tabLabel = await t.js(`document.querySelector('.tab.active .tab-label').textContent`);
  check('the tab is named after the trimmed address', tabLabel === '127.0.0.1', tabLabel);

  // --- The host dialog
  const fillHostDialog = (name) => t.js(`document.getElementById('add-host-btn').click();
    document.getElementById('save-name').value = ${JSON.stringify(name)};
    document.getElementById('save-host').value = ' 127.0.0.1  ';
    document.getElementById('save-port').value = '${server.port}';
    document.getElementById('save-user').value = '  tester ';
    document.getElementById('save-pass').value = ${JSON.stringify(PASSWORD)};
    document.getElementById('btn-save-confirm').click(); 'ok'`);
  const hostDialog = () => t.js(`({ shown: !document.getElementById('save-host-modal').classList.contains('hidden'),
    error: document.getElementById('host-error').textContent })`);

  await fillHostDialog('   ');
  let dialog = await hostDialog();
  check('the host dialog treats a display name of only spaces as missing',
    dialog.shown && dialog.error === 'Display name, host and username are required.', dialog);
  await t.press('Escape');

  await fillHostDialog('  Build box   ');
  check('a host with spaces around its fields saves', await waitFor(async () => !(await hostDialog()).shown));
  const { hosts } = await t.js(`window.electronAPI.getHosts()`);
  const saved = hosts[0] || {};
  check('without the spaces, and with the password as typed',
    hosts.length === 1 && saved.name === 'Build box' && saved.host === '127.0.0.1' && saved.username === 'tester'
      && saved.password === PASSWORD, saved);
  await waitFor(() => t.js(`!!document.querySelector('.tree-host')`));
  const row = await t.js(`({ name: document.querySelector('.tree-host .host-name').textContent,
    meta: document.querySelector('.tree-host .host-meta').textContent })`);
  check('and is listed that way', row.name === 'Build box' && row.meta.startsWith(`tester@127.0.0.1:${server.port}`), row);

  before = server.state.shellsOpened;
  await t.js(`document.querySelector('.tree-host').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 'ok'`);
  check('it connects', await t.waitForShell(server, before));

  await server.close();
});
