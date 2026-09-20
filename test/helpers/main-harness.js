'use strict';

// Loads the real main.js under plain Node with the `electron` module stubbed,
// so its ipcMain handlers can be called directly. Each call gets a fresh copy
// of main.js (it keeps module-level state) and its own temporary userData
// directory for the JSON stores.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// ELECTROSSH_MAIN points the suite at another build of main.js, e.g. to check
// that a test fails without the fix it guards.
const MAIN_PATH = process.env.ELECTROSSH_MAIN
  ? path.resolve(process.env.ELECTROSSH_MAIN)
  : path.join(PROJECT_ROOT, 'main.js');

function loadMain({ shell = {}, dialog = {}, clipboard = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'electrossh-test-'));
  const ipcOn = {};
  const ipcHandle = {};
  const sent = [];            // everything main sends to "the renderer"
  const listeners = [];

  // Electron throws on a send to a webContents that has been destroyed, which
  // is what happens when a session outlives its window; destroySender() makes
  // the stub behave the same way.
  let senderDestroyed = false;
  const sender = {
    isDestroyed: () => senderDestroyed,
    send: (channel, args) => {
      if (senderDestroyed) throw new TypeError('Object has been destroyed');
      sent.push({ channel, args });
      listeners.forEach((fn) => fn(channel, args));
    }
  };
  const event = { sender };

  const electron = {
    app: {
      name: 'electrossh-test',
      getPath: () => userData,
      whenReady: () => new Promise(() => {}), // never opens a window
      on: () => {},
      quit: () => {},
      exit: () => {}
    },
    BrowserWindow: Object.assign(class {}, { getFocusedWindow: () => null, getAllWindows: () => [] }),
    ipcMain: {
      on: (channel, fn) => { ipcOn[channel] = fn; },
      handle: (channel, fn) => { ipcHandle[channel] = fn; }
    },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    shell: { openExternal: async () => {}, ...shell },
    clipboard: { writeText: () => {}, ...clipboard },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async (win, opts) => ({ response: opts.cancelId }),
      ...dialog
    }
  };

  const originalLoad = Module._load;
  const originalLog = console.log;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  console.log = () => {}; // main.js logs its data path on load
  try {
    delete require.cache[require.resolve(MAIN_PATH)];
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
  }

  /**
   * Open an SSH session through 'ssh-connect', the way the renderer does.
   * Resolves once the shell sends data ('connected') or main reports an error.
   * `config` overrides fields of the default connection settings; `hostId`
   * is the saved host it came from, as the renderer sends it.
   */
  function connect({ sessionId, port, size = { cols: 80, rows: 24 }, timeoutMs = 15000, config = {}, hostId }) {
    const start = sent.length;
    const t0 = Date.now();
    ipcOn['ssh-connect'](event, {
      sessionId,
      config: { host: '127.0.0.1', port, username: 'tester', password: 'x', authType: 'password', keepalive: 0, ...config },
      size,
      hostId
    });
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        const mine = sent.slice(start).filter((m) => m.args && m.args.sessionId === sessionId);
        const data = mine.find((m) => m.channel === 'ssh-data');
        const error = mine.find((m) => m.channel === 'ssh-error');
        if (data || error || Date.now() - t0 > timeoutMs) {
          clearInterval(poll);
          resolve(data ? { outcome: 'connected', ms: Date.now() - t0 }
            : error ? { outcome: 'error', message: error.args.message, ms: Date.now() - t0 }
              : { outcome: 'timeout', ms: Date.now() - t0 });
        }
      }, 20);
    });
  }

  return {
    userData,
    sent,
    connect,
    disconnect: (sessionId) => ipcOn['ssh-disconnect'](event, sessionId),
    /** Answer a host key prompt the way the dialog does: 'accept' | 'once' | 'reject'. */
    answerHostKey: (requestId, decision) => ipcOn['host-key-response'](event, { requestId, decision }),
    /** Call an ipcMain.handle() channel, as ipcRenderer.invoke would. */
    invoke: (channel, ...args) => ipcHandle[channel](event, ...args),
    /** Call an ipcMain.on() channel, as ipcRenderer.send would. */
    emit: (channel, payload) => ipcOn[channel](event, payload),
    /** Run fn(channel, args) for every message main sends to the renderer. */
    onSend: (fn) => listeners.push(fn),
    /** The window has closed: any further send throws, as Electron's does. */
    destroySender: () => { senderDestroyed = true; },
    storePath: (name) => path.join(userData, name),
    readStore: (name) => {
      try { return JSON.parse(fs.readFileSync(path.join(userData, name), 'utf-8')); } catch (e) { return null; }
    },
    writeStore: (name, data) => fs.writeFileSync(path.join(userData, name), JSON.stringify(data, null, 2)),
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true })
  };
}

/** Poll until fn() is truthy; resolves with its value, or throws after timeoutMs. */
async function waitFor(fn, { timeoutMs = 8000, intervalMs = 25, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { loadMain, waitFor, sleep, PROJECT_ROOT };
