'use strict';

// Closing or reloading the app while SSH sessions are open: the menu wiring,
// the in-app confirmation, and what each answer does to live connections.
// Also checks Ctrl+W / Ctrl+R still belong to the shell inside the terminal.

const { Menu } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

run(async () => {
  const t = await start();
  const server = await startSshServer();
  const openConnections = () => server.state.openConnections;
  const pageMarker = () => t.js('window.__e2eMarker || null').catch(() => null);
  const requestCount = () => t.sentToPage.filter((c) => c === 'session-loss-prompt').length;
  const dialogShown = () => waitFor(async () => (await t.confirmDialog()).shown);

  // Ctrl+R and Ctrl+Shift+R must be our confirming items, not Electron's
  // built-in roles, which reload instantly
  const viewItems = Menu.getApplicationMenu().items.find((i) => i.label === 'View').submenu.items;
  const reloadItem = t.menuItem('View', 'Reload');
  const forceItem = t.menuItem('View', 'Force Reload');
  check('View > Reload is bound to Ctrl+R', reloadItem && reloadItem.accelerator === 'CmdOrCtrl+R');
  check('View > Force Reload is bound to Ctrl+Shift+R', forceItem && forceItem.accelerator === 'CmdOrCtrl+Shift+R');
  check('no built-in instant-reload role is left in the View menu',
    !viewItems.some((i) => i.role === 'reload' || i.role === 'forcereload'), viewItems.map((i) => i.role));

  const connected = (await t.connect(server)) && (await t.connect(server));
  check('two sessions connect', connected && openConnections() === 2, openConnections());
  await t.js(`window.__e2eMarker = 'original'; 'ok'`);

  // Reload with sessions open, answered Cancel
  await t.focus('#search-input');
  t.menuReload();
  await dialogShown();
  const reload = await t.confirmDialog();
  check('reloading asks in the in-app dialog', reload.shown && reload.title === 'Reload ElectroSSH?', reload);
  check('the dialog lists both sessions', reload.sessions.length === 2, reload.sessions);
  check('Cancel has focus', reload.focused === 'btn-session-loss-cancel', reload.focused);
  await t.click('#btn-session-loss-cancel');
  check('Cancel keeps the page and both sessions', (await pageMarker()) === 'original' && openConnections() === 2);
  check('Cancel returns focus to where it was', (await t.js('document.activeElement.id')) === 'search-input');
  check('the native dialog was not needed', t.native.calls.length === 0, t.native.calls);

  // Closing, answered with Esc
  t.closeWindow();
  await dialogShown();
  check('closing asks too', (await t.confirmDialog()).title === 'Close ElectroSSH?');
  await t.press('Escape');
  check('Esc cancels; the window and sessions stay',
    !(await t.confirmDialog()).shown && !t.win.isDestroyed() && openConnections() === 2);

  // Closing, answered with Enter (Cancel is focused)
  t.closeWindow();
  await dialogShown();
  await t.press('Return');
  check('Enter cancels', !(await t.confirmDialog()).shown && !t.win.isDestroyed() && openConnections() === 2);

  // A second close while the dialog is already up must not stack another request
  const before = requestCount();
  t.closeWindow();
  await t.sleep(200);
  t.closeWindow();
  await t.sleep(400);
  check('a second close while the dialog is open sends no second request', requestCount() - before === 1, requestCount() - before);
  await t.press('Escape');

  // Inside the terminal, the keys go to the remote shell, not the menu
  server.state.shellData.length = 0;
  await t.focus('last:.terminal-instance.active textarea.xterm-helper-textarea');
  await t.press('W', ['control']);
  await t.press('R', ['control']);
  check('in the terminal, Ctrl+W and Ctrl+R reach the shell',
    server.state.shellData.includes('\u0017') && server.state.shellData.includes('\u0012'), server.state.shellData);
  check('in the terminal, no dialog appears', !(await t.confirmDialog()).shown);

  // Reload confirmed: the page reloads and the connections are closed (a
  // reload used to leave them running with no tab attached)
  t.menuReload();
  await dialogShown();
  await t.click('#btn-session-loss-confirm');
  await waitFor(async () => (await pageMarker()) === null && openConnections() === 0);
  check('confirming reloads the page', (await pageMarker()) === null);
  check('confirming closes the SSH connections', openConnections() === 0, openConnections());

  // With no sessions open, reload happens without asking
  await t.js(`window.__e2eMarker = 'no-sessions'; 'ok'`);
  const beforeEmpty = requestCount();
  t.menuReload();
  await waitFor(async () => (await pageMarker()) === null);
  check('with no sessions open, reload does not ask', requestCount() === beforeEmpty && (await pageMarker()) === null);

  await server.close();
});
