'use strict';

// Runs inside Electron's main process. Boots the real app (main.js, preload.js,
// index.html) against a throwaway userData directory, and drives it with
// genuine input through webContents.sendInputEvent.
//
// Input handled by the page (typing, Esc/Enter in a dialog, keys in the
// terminal, mouse clicks) is sent as real events and is reliable. Keys that
// only matter once Chromium hands them to the application menu (Ctrl+W and
// Ctrl+R outside the terminal) are not: synthetic events don't consistently
// make that round trip. Tests trigger those menu actions directly instead, and
// assert the menu's key bindings separately.
//
// Each *.e2e.js file is its own Electron process (see run.js). A file calls
// start(), makes check() calls, and ends with finish(), which prints TAP-style
// lines and exits non-zero if anything failed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, Menu, dialog } = require('electron');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an async predicate until it is truthy; false if it never is within
 * timeoutMs. Electron can pause this process's event loop for a few seconds
 * (tearing down a crashed page, for one), which can push past the deadline
 * without a single poll running, so the predicate gets one last look.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return Boolean(await predicate());
}

const results = [];
let finished = false;

// Each result is printed as soon as it's known, so a test that hangs still
// shows how far it got.
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'ok' : 'not ok'} ${results.length} - ${name}`);
  if (!ok && detail !== undefined) console.log(`  # ${JSON.stringify(detail)}`);
}

// The userData directory is left for run.js to delete: Chromium keeps files in
// it open until this process has exited.
function finish() {
  if (finished) return;
  finished = true;
  console.log(`1..${results.length}`);
  app.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
}

/** Wrap a test body: any exception is reported as a failure rather than hanging. */
function run(body) {
  body().then(finish, (err) => {
    check('no unexpected error', false, String((err && err.stack) || err));
    finish();
  });
}

/**
 * Boot the app and wait for its window to be ready.
 * Native dialogs are scripted: set native.answer to 'confirm' or 'cancel';
 * native.calls records each one shown.
 */
async function start() {
  const parent = process.env.ELECTROSSH_E2E_DATA || os.tmpdir();
  const userData = fs.mkdtempSync(path.join(parent, 'electrossh-e2e-'));
  app.setPath('userData', userData);

  // Writing a crash dump can freeze this process for anything from a couple
  // of seconds to minutes after forcefullyCrashRenderer(), which stalls the
  // timers the tests wait on. No dump is wanted here, and any that appears
  // goes to the throwaway directory.
  app.commandLine.appendSwitch('disable-breakpad');
  app.setPath('crashDumps', path.join(userData, 'crashes'));

  const native = { calls: [], answer: 'cancel' };
  dialog.showMessageBox = async (win, opts) => {
    native.calls.push(opts.message);
    return { response: native.answer === 'confirm' ? 0 : opts.cancelId };
  };

  // main.js loads 'index.html' relative to the app root; point it at the project
  const originalLoadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (file, options) {
    return originalLoadFile.call(this, path.resolve(PROJECT_ROOT, file), options);
  };

  const log = console.log;
  console.log = () => {}; // main.js logs its data path on load
  // ELECTROSSH_MAIN runs another build of main.js (keep it in the project root
  // so it finds preload.js), e.g. to check that a test fails without its fix
  require(process.env.ELECTROSSH_MAIN ? path.resolve(process.env.ELECTROSSH_MAIN) : path.join(PROJECT_ROOT, 'main.js'));
  console.log = log;

  // Keep the process alive when the app's window closes, so results can be reported
  app.removeAllListeners('window-all-closed');
  app.on('window-all-closed', () => {});

  await app.whenReady();
  let win;
  for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(50);

  // A hidden spare window, so that when the app's window closes (on purpose,
  // or because a check failed) Electron never has zero windows. With none
  // left, this process's event loop can stall before it reports anything.
  // app.quit() closes the spare along with everything else, so a test that
  // quits calls keepAlive() to replace it.
  let spare = new BrowserWindow({ show: false });
  const keepAlive = () => {
    if (spare.isDestroyed()) spare = new BrowserWindow({ show: false });
  };
  const wc = win.webContents;
  // executeJavaScript on a window that has closed never settles, which would
  // hang a test instead of failing it; so refuse up front and cap every call
  const js = (code, timeoutMs = 8000) => {
    if (wc.isDestroyed()) return Promise.reject(new Error('the app window has closed'));
    return Promise.race([
      wc.executeJavaScript(code),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error(`page call timed out after ${timeoutMs}ms`)), timeoutMs))
    ]);
  };
  for (let i = 0; i < 200; i++) {
    const ready = await js(`document.readyState === 'complete' && !!document.getElementById('home-view')`).catch(() => false);
    if (ready) break;
    await sleep(50);
  }
  await sleep(400); // let the initial host and key loads settle

  // Count what main sends to the page, e.g. how many confirmation requests
  const sentToPage = [];
  const originalSend = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    sentToPage.push(channel);
    return originalSend(channel, ...args);
  };

  const press = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(400);
  };

  // Genuine mouse click on the centre of the first element matching selector
  const click = async (selector) => {
    const box = await js(`(() => { const el = ${selectorExpr(selector)}; if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    wc.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(400);
  };

  // Genuine mouse click at a point in the window, e.g. a dialog's backdrop
  const clickAt = async (x, y, button = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await sleep(400);
  };

  const focus = (selector) => js(`(() => { const el = ${selectorExpr(selector)}; if (el) el.focus(); return document.activeElement === el; })()`);

  /** State of the "disconnect?" confirmation dialog. */
  const confirmDialog = () => js(`(() => {
    const m = document.getElementById('session-loss-modal');
    return {
      shown: !m.classList.contains('hidden'),
      title: document.getElementById('session-loss-title').textContent,
      sessions: [...document.querySelectorAll('#session-loss-list li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()),
      focused: document.activeElement && document.activeElement.id
    };
  })()`).catch(() => ({ shown: false }));

  /**
   * Answer host key prompts with "Connect Once" until the test server has
   * opened more than `before` shells. Resolves true once it has.
   */
  const waitForShell = async (server, before) => {
    for (let i = 0; i < 60 && server.state.shellsOpened === before; i++) {
      await js(`(() => { const m = document.getElementById('host-key-modal');
        if (!m.classList.contains('hidden')) document.getElementById('btn-host-key-once').click(); })()`).catch(() => {});
      await sleep(150);
    }
    await sleep(300);
    return server.state.shellsOpened > before;
  };

  /** Quick Connect to a local test server; resolves as waitForShell does. */
  const connect = async (server) => {
    const before = server.state.shellsOpened;
    await js(`document.getElementById('quick-connect-btn').click();
      document.getElementById('inp-host').value = '127.0.0.1';
      document.getElementById('inp-port').value = '${server.port}';
      document.getElementById('inp-user').value = 'tester';
      document.getElementById('inp-pass').value = 'x';
      document.getElementById('btn-connect').click(); 'ok'`);
    return waitForShell(server, before);
  };

  /** A menu item by its path, e.g. menuItem('View', 'Reload'). */
  const menuItem = (menuLabel, itemLabel) => {
    const top = Menu.getApplicationMenu().items.find((i) => i.label === menuLabel);
    return top && top.submenu.items.find((i) => i.label === itemLabel);
  };

  // What Ctrl+R and Ctrl+W do once they reach the menu: the Reload item's
  // click, and the close role, which calls BrowserWindow.close().
  const menuReload = () => menuItem('View', 'Reload').click();
  const closeWindow = () => win.close();

  return { app, win, wc, js, press, click, clickAt, focus, confirmDialog, connect, native, sentToPage, sleep, menuItem, menuReload, closeWindow, keepAlive, waitForShell };
}

// 'css selector' or 'last:css selector' (the last match)
function selectorExpr(selector) {
  if (selector.startsWith('last:')) {
    return `[...document.querySelectorAll(${JSON.stringify(selector.slice(5))})].pop()`;
  }
  return `document.querySelector(${JSON.stringify(selector)})`;
}

module.exports = { start, check, finish, run, sleep, waitFor };
