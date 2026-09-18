'use strict';

// Quick Connect lives in a dialog behind the lightning button and
// Ctrl+Shift+N (which works from inside the terminal), and the home
// view lists recent connections: newest first, a saved host reconnecting in
// one click, a one-off session reopening Quick Connect filled in (its
// password is never stored).

const { ipcMain } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

run(async () => {
  const t = await start();
  const server = await startSshServer();

  const quickConnect = () => t.js(`(() => ({
    shown: !document.getElementById('quick-connect-modal').classList.contains('hidden'),
    focused: document.activeElement && document.activeElement.id,
    host: document.getElementById('inp-host').value,
    port: document.getElementById('inp-port').value,
    user: document.getElementById('inp-user').value,
    pass: document.getElementById('inp-pass').value,
    keepalive: document.getElementById('inp-keepalive').value,
    error: document.getElementById('quick-connect-error').classList.contains('hidden')
      ? '' : document.getElementById('quick-connect-error').textContent
  }))()`);
  const recentRows = () => t.js(`[...document.querySelectorAll('#recent-list .recent-row')].map((row) => ({
    name: row.querySelector('.recent-name').textContent,
    meta: row.querySelector('.recent-meta').textContent,
    time: row.querySelector('.recent-time').textContent
  }))`);
  const listEmpty = () => t.js(`!!document.querySelector('#recent-list .recent-empty')`);
  const tabCount = () => t.js(`document.querySelectorAll('#tabs-strip .tab').length`);
  let rows = [];
  const waitForRows = (n) => waitFor(async () => (rows = await recentRows()).length === n);

  check('a fresh install shows an empty recent list', await waitFor(listEmpty));

  // Every connect request main receives, to see what the dialog sent
  const connectRequests = [];
  ipcMain.on('ssh-connect', (event, payload) => connectRequests.push(payload));

  // The lightning button opens an empty Quick Connect, ready for a host
  await t.click('#quick-connect-btn');
  let form = await quickConnect();
  check('the lightning button opens Quick Connect', form.shown && form.focused === 'inp-host', form);
  check('with the default keep-alive of 5 seconds', form.keepalive === '5', form);

  // A keep-alive it can't use is refused, saying why, as in the host dialog
  await t.js(`document.getElementById('inp-host').value = '127.0.0.1';
    document.getElementById('inp-user').value = 'tester';
    document.getElementById('inp-keepalive').value = '-3';
    document.getElementById('btn-connect').click(); 'ok'`);
  form = await quickConnect();
  check('an invalid keep-alive is refused, saying why',
    form.shown && form.error.startsWith('Keep-alive must be a whole number') && connectRequests.length === 0, form);
  await t.press('Escape');
  check('Esc closes it', !(await quickConnect()).shown);

  // A one-off session with its own keep-alive; the dialog closes and forgets
  // the password
  let before = server.state.shellsOpened;
  await t.js(`document.getElementById('quick-connect-btn').click();
    document.getElementById('inp-host').value = '127.0.0.1';
    document.getElementById('inp-port').value = '${server.port}';
    document.getElementById('inp-user').value = 'tester';
    document.getElementById('inp-pass').value = 'x';
    document.getElementById('inp-keepalive').value = '15';
    document.getElementById('btn-connect').click(); 'ok'`);
  check('a Quick Connect session connects', await t.waitForShell(server, before));
  check('using the keep-alive set in the dialog',
    connectRequests.length === 1 && connectRequests[0].config.keepalive === 15, connectRequests.map((r) => r.config.keepalive));
  form = await quickConnect();
  check('Quick Connect closes and clears the password', !form.shown && form.pass === '', form);

  // The shortcut works with the terminal focused
  await t.focus('.terminal-instance.active .xterm-helper-textarea');
  await t.press('N', ['control', 'shift']);
  form = await quickConnect();
  check('Ctrl+Shift+N opens Quick Connect from the terminal', form.shown && form.focused === 'inp-host', form);
  await t.press('Escape');

  // ...but not over another dialog
  await t.click('#add-group-btn');
  await t.press('N', ['control', 'shift']);
  check('Ctrl+Shift+N does nothing while another dialog is open', !(await quickConnect()).shown);
  await t.press('Escape');

  // Listed on the shortcuts page, and in the buttons' tooltips
  const listed = await t.js(`[...document.querySelectorAll('#shortcut-groups .shortcut-row')]
    .filter((row) => row.querySelector('.shortcut-action').firstChild.textContent === 'Quick Connect')
    .map((row) => [...row.querySelectorAll('kbd')].map((k) => k.textContent).join('+'))`);
  check('the shortcuts page lists Ctrl+Shift+N for Quick Connect', listed.length === 1 && listed[0] === 'Ctrl+Shift+N', listed);
  const tooltip = await t.js(`document.getElementById('quick-connect-btn').title`);
  check('the lightning button\'s tooltip shows the shortcut', tooltip === 'Quick Connect (Ctrl+Shift+N)', tooltip);

  await t.click('#new-tab-btn');
  check('the session is listed on the home view', await waitForRows(1), rows);
  check('as a Quick Connect entry for user@host:port',
    rows[0] && rows[0].name === '127.0.0.1' && rows[0].meta === `tester@127.0.0.1:${server.port} · Quick Connect`, rows);
  check('connected just now', rows[0] && rows[0].time === 'just now', rows);

  // Its password was never stored, so it reopens Quick Connect filled in
  await t.click('#recent-list .recent-open');
  form = await quickConnect();
  check('a one-off entry reopens Quick Connect filled in',
    form.shown && form.host === '127.0.0.1' && form.port === String(server.port) && form.user === 'tester' && form.pass === '', form);
  check('with the keep-alive it used', form.keepalive === '15', form);
  check('with the password field focused', form.focused === 'inp-pass', form);
  await t.press('Escape');

  // A saved host, connected from the tree
  await t.js(`window.electronAPI.saveHost({ name: 'Build box', host: '127.0.0.1', port: ${server.port}, username: 'tester',
    password: 'x', authType: 'password', groupId: 'default', keepalive: 0 }).then(() => {
      document.getElementById('search-input').dispatchEvent(new Event('input'));
      return 'ok';
    })`);
  await waitFor(() => t.js(`!!document.querySelector('.tree-host')`));
  before = server.state.shellsOpened;
  await t.js(`document.querySelector('.tree-host').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 'ok'`);
  check('a saved host connects', await t.waitForShell(server, before));

  await t.click('#new-tab-btn');
  check('it joins the list, newest first, under its saved name',
    await waitForRows(2) && rows[0].name === 'Build box' && rows[0].meta === `tester@127.0.0.1:${server.port}`
      && rows[1].name === '127.0.0.1', rows);

  // One click reconnects a saved host, in a new tab, without the dialog
  const tabs = await tabCount();
  before = server.state.shellsOpened;
  await t.click('#recent-list .recent-open');
  check('a saved entry reconnects in one click', await t.waitForShell(server, before) && !(await quickConnect()).shown);
  check('in a new tab', (await tabCount()) === tabs + 1);

  // Removing entries
  await t.click('#new-tab-btn');
  await waitForRows(2);
  await t.click('last:#recent-list .recent-remove');
  check('× removes one entry', await waitForRows(1) && rows[0].name === 'Build box', rows);
  await t.click('#btn-clear-recent');
  check('Clear empties the list', await waitFor(listEmpty));
  check('for good', (await t.js(`window.electronAPI.getRecentConnections().then((list) => list.length)`)) === 0);

  await server.close();
});
