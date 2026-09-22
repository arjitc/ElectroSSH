'use strict';

// macOS keeps the app running after its window closes, and clicking the Dock
// icon ('activate') should bring a window back. Nothing listened for it, so a
// closed window could only be recovered by quitting. The event is emitted by
// hand here, so this runs on every platform.

const { BrowserWindow } = require('electron');
const { start, check, run, waitFor } = require('./harness');

run(async () => {
  const t = await start();
  const appWindows = () => BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w.webContents.getURL().endsWith('index.html'));

  t.closeWindow(); // no sessions, so it closes without asking
  check('the window closes', await waitFor(() => t.win.isDestroyed(), 5000));

  t.app.emit('activate');
  let reopened = null;
  check('activating the app opens a new window',
    await waitFor(() => (reopened = appWindows()[0]) && !reopened.webContents.isLoading(), 8000));
  const pageReady = reopened && await reopened.webContents.executeJavaScript(`!!document.getElementById('home-view')`);
  check('with the app loaded in it', pageReady === true);

  t.app.emit('activate');
  await t.sleep(800);
  check('activating again while a window is open opens no second one', appWindows().length === 1, appWindows().length);
});
