'use strict';

// A tab's close button asks first only while its session is connected.

const net = require('net');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

run(async () => {
  const t = await start();
  const server = await startSshServer();
  const tabCount = () => t.js(`document.querySelectorAll('#tabs-strip .tab').length`);
  const openConnections = () => server.state.openConnections;
  const clickTabX = () => t.click('last:#tabs-strip .tab .close-tab');

  check('a session connects', await t.connect(server));

  // Genuine click on the tab's close button
  await clickTabX();
  const dialog = await t.confirmDialog();
  check('closing a connected tab asks first', dialog.shown && dialog.title === 'Close this tab?', dialog);
  check('the dialog names that one session', dialog.sessions.length === 1, dialog.sessions);
  check('Cancel has focus', dialog.focused === 'btn-session-loss-cancel', dialog.focused);

  await t.press('Return');
  check('Enter keeps the tab and the connection', !(await t.confirmDialog()).shown && (await tabCount()) === 1 && openConnections() === 1);

  await clickTabX();
  await t.press('Escape');
  check('Esc keeps the tab', !(await t.confirmDialog()).shown && (await tabCount()) === 1);

  await clickTabX();
  await t.clickAt(12, 12); // the backdrop's corner; the dialog itself sits in the middle
  check('a click outside the dialog keeps the tab', !(await t.confirmDialog()).shown && (await tabCount()) === 1);

  // Middle-click on the tab asks as well
  const box = await t.js(`(() => { const r = document.querySelector('#tabs-strip .tab .tab-label').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await t.clickAt(box.x, box.y, 'middle');
  check('middle-clicking the tab asks too', (await t.confirmDialog()).shown);

  await t.click('#btn-session-loss-confirm');
  await t.sleep(800);
  check('Close and Disconnect closes the tab', (await tabCount()) === 0);
  check('Close and Disconnect ends the SSH connection', openConnections() === 0, openConnections());

  // A session the server has ended: nothing live, so no question
  let endFromServer = null;
  const dropping = await startSshServer({ onShell: ({ client }) => { endFromServer = () => client.end(); } });
  await t.connect(dropping);
  endFromServer();
  // Wait for the page to learn the session is gone, rather than guessing how long that takes
  const markedDisconnected = await waitFor(() => t.js(`!!document.querySelector('#tabs-strip .tab.disconnected')`));
  check('the tab shows the session has dropped', markedDisconnected);
  await clickTabX();
  {
    const d = await t.confirmDialog();
    const n = await tabCount();
    check('a dropped session closes without asking', !d.shown && n === 0, { dialog: d, tabs: n });
  }

  // A session still connecting: this server accepts the TCP connection but
  // never speaks SSH, so the handshake never finishes
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  await t.js(`document.getElementById('new-tab-btn').click();
    document.getElementById('inp-host').value = '127.0.0.1';
    document.getElementById('inp-port').value = '${silent.address().port}';
    document.getElementById('inp-user').value = 'tester';
    document.getElementById('btn-connect').click(); 'ok'`);
  await waitFor(async () => (await tabCount()) === 1);
  await clickTabX();
  {
    const d = await t.confirmDialog();
    const n = await tabCount();
    check('a tab still connecting closes without asking', !d.shown && n === 0, { dialog: d, tabs: n });
  }

  silent.close();
  await dropping.close();
  await server.close();
});
