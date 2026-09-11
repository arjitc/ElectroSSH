'use strict';

// The close confirmation normally appears in the page. If the page is frozen
// or has crashed it can't, and a close guard waiting on it would make the
// window impossible to close. main.js falls back to a native dialog when the
// page doesn't acknowledge within 1.5s.

const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

run(async () => {
  const t = await start();
  const server = await startSshServer();

  check('a session connects', await t.connect(server));

  // Frozen page: the native dialog takes over; Cancel keeps the window
  t.native.answer = 'cancel';
  t.native.calls.length = 0;
  t.js('const end = Date.now() + 5000; while (Date.now() < end) {}').catch(() => {}); // busy for 5s
  await t.sleep(200);
  const frozeAt = Date.now();
  t.closeWindow();
  const usedNative = await waitFor(() => t.native.calls.length > 0, 4000);
  const waited = Date.now() - frozeAt;
  check('with the page frozen, the native dialog takes over', usedNative, t.native.calls);
  check('it takes over after about 1.5s, not immediately and not never', waited >= 1200 && waited < 4000, waited);
  check('Cancel on the native dialog keeps the window and the session',
    !t.win.isDestroyed() && server.state.openConnections === 1);

  // When the page recovers, the in-app dialog it received late must not linger
  await t.sleep(5500);
  check('no stale in-app dialog once the page recovers', !(await t.confirmDialog()).shown);

  // Crashed page: the native dialog takes over; confirming closes the window
  // and the SSH connection
  t.native.answer = 'confirm';
  t.native.calls.length = 0;
  t.wc.forcefullyCrashRenderer();
  await t.sleep(800);
  t.closeWindow();
  const closed = await waitFor(() => t.win.isDestroyed(), 6000);
  check('with the page crashed, the native dialog takes over', t.native.calls.length === 1, t.native.calls);
  check('confirming closes the window', closed, { destroyed: t.win.isDestroyed(), native: t.native.calls });
  check('confirming ends the SSH connection', await waitFor(() => server.state.openConnections === 0, 3000),
    server.state.openConnections);

  await server.close();
});
