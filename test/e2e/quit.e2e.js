'use strict';

// Quitting (File > Quit, Cmd+Q) goes through the same window 'close' guard:
// Cancel must abandon the quit entirely; confirming must let it finish.

const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

run(async () => {
  const t = await start();
  const server = await startSshServer();
  const dialogShown = () => waitFor(async () => (await t.confirmDialog()).shown);

  let willQuit = false;
  // Reaching will-quit means the close guard let the quit through. Stop it
  // there so this process can still report. Every window is closed by now,
  // the harness's spare included, so put one back.
  t.app.on('will-quit', (event) => {
    willQuit = true;
    event.preventDefault();
    t.keepAlive();
  });

  check('a session connects', await t.connect(server));

  // Quit, answered Cancel
  t.app.quit();
  await dialogShown();
  check('quitting asks in the in-app dialog', (await t.confirmDialog()).title === 'Close ElectroSSH?');
  await t.click('#btn-session-loss-cancel');
  await t.sleep(600);
  check('Cancel abandons the quit', !willQuit && !t.win.isDestroyed());
  check('Cancel keeps the session', server.state.openConnections === 1);
  t.keepAlive(); // the cancelled quit still closed the spare window

  // Quit, answered Close and Disconnect
  t.app.quit();
  await dialogShown();
  await t.click('#btn-session-loss-confirm');
  check('confirming lets the quit go through', await waitFor(() => willQuit, 5000));
  check('confirming ends the SSH connection', await waitFor(() => server.state.openConnections === 0, 3000),
    server.state.openConnections);
  check('the native dialog was not needed', t.native.calls.length === 0, t.native.calls);

  await server.close();
});
