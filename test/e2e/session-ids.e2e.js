'use strict';

// Each tab's session gets a random id (UUIDv4). With a timestamp, two tabs
// opened in the same millisecond would share one. By hand that can't happen
// (making a terminal takes tens of milliseconds), so the page's clock is
// held still while two open, as if they were.

const { start, check, run, waitFor, sleep } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

run(async () => {
  const t = await start();
  const server = await startSshServer();

  await t.js(`window.electronAPI.saveHost({ name: 'Build box', host: '127.0.0.1', port: ${server.port}, username: 'tester',
      password: 'x', authType: 'password', groupId: 'default', keepalive: 0 })
    .then(() => { document.getElementById('search-input').dispatchEvent(new Event('input')); return 'ok'; })`);
  await waitFor(() => t.js(`!!document.querySelector('.tree-host')`));

  // Two sessions opened with the clock stopped, then restarted
  await t.js(`(() => { const row = document.querySelector('.tree-host');
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    } finally {
      Date.now = realNow;
    } })(); 'ok'`);
  const tabIds = await t.js(`[...document.querySelectorAll('#tabs-strip .tab')].map((tab) => tab.id)`);
  check('two tabs open', tabIds.length === 2, tabIds);
  check('each with its own random session id',
    tabIds[0] !== tabIds[1] && tabIds.every((id) => UUID_V4.test(id.replace(/^tab-/, ''))), tabIds);

  // Accept both host key prompts until both shells are open
  const bothOpen = await waitFor(async () => {
    await t.js(`(() => { const m = document.getElementById('host-key-modal');
      if (!m.classList.contains('hidden')) document.getElementById('btn-host-key-once').click(); })()`);
    return server.state.shellsOpened >= 2;
  }, 10000);
  check('both sessions connect', bothOpen, server.state);
  await sleep(800);
  const states = () => t.js(`[...document.querySelectorAll('#tabs-strip .tab')].map((tab) =>
    tab.classList.contains('disconnected') ? 'disconnected' : tab.classList.contains('connecting') ? 'connecting' : 'connected')`);
  let s = await states();
  check('and both stay connected', s.length === 2 && s.every((x) => x === 'connected') && server.state.openConnections === 2,
    { tabs: s, open: server.state.openConnections });

  // Closing the first leaves the second alone
  await t.click('#tabs-strip .tab .close-tab');
  await t.click('#btn-session-loss-confirm');
  await waitFor(() => server.state.openConnections === 1);
  s = await states();
  check('closing one tab ends only its own session', s.length === 1 && s[0] === 'connected' && server.state.openConnections === 1,
    { tabs: s, open: server.state.openConnections });

  await server.close();
});
