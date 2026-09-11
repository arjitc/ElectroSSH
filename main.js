const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Client, utils: sshUtils } = require('ssh2');

let mainWindow;
const userDataPath = app.getPath('userData'); // Get a writable path
const hostsFilePath = path.join(userDataPath, 'saved_hosts.json');
const keysFilePath = path.join(userDataPath, 'ssh_keys.json');
const knownHostsFilePath = path.join(userDataPath, 'known_hosts.json');

console.log('Host data path:', hostsFilePath);
// Store active sessions: { sessionId: { conn: Client, stream: Stream } }
const sessions = {};
const defaultGroup = { id: 'default', name: 'Default' };

// Seconds between SSH keepalive packets. 0 turns keepalives off entirely.
const DEFAULT_KEEPALIVE = 5;
const MAX_KEEPALIVE = 3600;

// Accepts whatever the renderer or an older store had and returns a usable
// number of seconds: anything unparseable falls back to the default, and
// only an explicit 0 disables keepalives.
function normalizeKeepalive(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_KEEPALIVE;
  if (String(value).trim() === '') return DEFAULT_KEEPALIVE;
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_KEEPALIVE;
  return Math.min(seconds, MAX_KEEPALIVE);
}

// Default SSH directory for discovery and generation
const defaultSSHDir = path.join(process.env.HOME || process.env.USERPROFILE || __dirname, '.ssh');

function readHostStore() {
  let store = { hosts: [], groups: [defaultGroup] };
  if (!fs.existsSync(hostsFilePath)) return store;
  
  try {
    const data = JSON.parse(fs.readFileSync(hostsFilePath, 'utf-8'));
    if (Array.isArray(data)) {
      // Legacy format: plain hosts array
      store.hosts = data;
    } else if (data && typeof data === 'object') {
      store.hosts = Array.isArray(data.hosts) ? data.hosts : [];
      store.groups = Array.isArray(data.groups) && data.groups.length > 0 ? data.groups : [defaultGroup];
    }
  } catch (e) {
    // ignore parse errors and return defaults
  }
  
  // Ensure every host has a group assignment and a keepalive value
  store.hosts = store.hosts.map(h => ({
    ...h,
    groupId: h.groupId || defaultGroup.id,
    keepalive: normalizeKeepalive(h.keepalive)
  }));
  
  // Ensure default group always exists
  if (!store.groups.some(g => g.id === defaultGroup.id)) {
    store.groups = [defaultGroup, ...store.groups];
  }
  
  return store;
}

function writeHostStore(store) {
  // Remove any duplicate groups by id
  const uniqueGroups = [];
  const seenIds = new Set();
  (store.groups || []).forEach(g => {
    if (!g || !g.id || seenIds.has(g.id)) return;
    seenIds.add(g.id);
    uniqueGroups.push({ id: g.id, name: g.name || g.id });
  });
  
  const cleanedStore = {
    hosts: Array.isArray(store.hosts) ? store.hosts : [],
    groups: uniqueGroups.length > 0 ? uniqueGroups : [defaultGroup]
  };
  
  fs.writeFileSync(hostsFilePath, JSON.stringify(cleanedStore, null, 2), 'utf-8');
}

// --- Known Hosts (host key verification) ---
//
// Trust-on-first-use, like PuTTY and OpenSSH: the first time we see a host we
// ask the user to confirm its key, then check every later connection against
// what was saved. Keys are stored per host *and* per key type, because a
// server can legitimately hold several (RSA and Ed25519, say) and present a
// different one after an upgrade, which is not the same as a key changing.
//
// Shape: { hosts: { "example.com:22": { "ssh-ed25519": { key, fingerprint, addedAt } } } }

function readKnownHosts() {
  try {
    const data = JSON.parse(fs.readFileSync(knownHostsFilePath, 'utf-8'));
    if (data && typeof data.hosts === 'object' && data.hosts !== null) return data;
  } catch (e) {
    // missing or unreadable: start from an empty store
  }
  return { hosts: {} };
}

function writeKnownHosts(store) {
  fs.writeFileSync(knownHostsFilePath, JSON.stringify(store, null, 2), 'utf-8');
}

function knownHostId(host, port) {
  return `${String(host || '').trim().toLowerCase()}:${parseInt(port, 10) || 22}`;
}

// The verifier receives the raw public key blob in SSH wire format, which
// starts with a length-prefixed key type ("ssh-ed25519", "ssh-rsa", ...).
// The fingerprint matches what OpenSSH and PuTTY display: SHA256, base64,
// no padding.
function describeHostKey(blob) {
  let keyType = 'unknown';
  if (blob.length >= 4) {
    const len = blob.readUInt32BE(0);
    if (len > 0 && len < 64 && blob.length >= 4 + len) {
      const candidate = blob.toString('ascii', 4, 4 + len);
      // The server chooses this string, and it is both shown to the user and
      // used as a property name in the store. Real key types only use these
      // characters (ssh-ed25519, ecdsa-sha2-nistp256, sk-ssh-ed25519@openssh.com).
      if (/^[A-Za-z0-9@.+-]+$/.test(candidate)) keyType = candidate;
    }
  }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { keyType, fingerprint, key: blob.toString('base64') };
}

function classifyHostKey(store, hostId, info) {
  const entry = store.hosts[hostId];
  if (!entry || Object.keys(entry).length === 0) return { status: 'unknown' };

  const stored = entry[info.keyType];
  if (stored) {
    if (stored.key === info.key) return { status: 'trusted' };
    return { status: 'changed', previousFingerprint: stored.fingerprint };
  }
  return { status: 'new-key-type', knownKeyTypes: Object.keys(entry) };
}

function saveKnownHostKey(hostId, info) {
  const store = readKnownHosts();
  store.hosts[hostId] = store.hosts[hostId] || {};
  store.hosts[hostId][info.keyType] = {
    key: info.key,
    fingerprint: info.fingerprint,
    addedAt: new Date().toISOString()
  };
  writeKnownHosts(store);
}

// --- SSH Key Store Helpers ---

function readKeyStore() {
  if (!fs.existsSync(keysFilePath)) {
    return { keys: [], defaultKeyId: null, ignoredPaths: [] };
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(keysFilePath, 'utf-8'));
    const keys = Array.isArray(data.keys) ? data.keys.filter(Boolean) : [];
    const ignoredPaths = Array.isArray(data.ignoredPaths) ? data.ignoredPaths : [];
    return {
      keys,
      defaultKeyId: data.defaultKeyId || null,
      ignoredPaths
    };
  } catch (err) {
    return { keys: [], defaultKeyId: null, ignoredPaths: [] };
  }
}

function writeKeyStore(store) {
  const unique = [];
  const seen = new Set();
  (store.keys || []).forEach((k) => {
    if (!k || !k.id || !k.privateKeyPath || seen.has(k.privateKeyPath)) return;
    seen.add(k.privateKeyPath);
    unique.push({
      id: k.id,
      name: k.name || path.basename(k.privateKeyPath),
      privateKeyPath: k.privateKeyPath,
      publicKeyPath: k.publicKeyPath || `${k.privateKeyPath}.pub`
    });
  });
  
  const payload = {
    keys: unique,
    defaultKeyId: store.defaultKeyId || null,
    ignoredPaths: Array.isArray(store.ignoredPaths) ? store.ignoredPaths : []
  };
  
  fs.writeFileSync(keysFilePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function looksLikePuttyKey(buffer) {
  if (!buffer) return false;
  const slice = buffer.toString('utf-8', 0, 64);
  return slice.includes('PuTTY-User-Key-File-');
}

function convertPuttyKey(privateKeyPath, passphrase) {
  const tempOut = path.join(
    os.tmpdir(),
    `openssh-${Date.now()}-${path.basename(privateKeyPath)}`
  );
  
  const args = [privateKeyPath, '-O', 'private-openssh', '-o', tempOut];
  // Supply passphrase when provided to avoid interactive prompts
  if (passphrase) args.push('-passphrase', passphrase);
  
  try {
    execFileSync('puttygen', args, { encoding: 'utf-8', stdio: 'pipe' });
    const converted = fs.readFileSync(tempOut);
    fs.unlinkSync(tempOut);
    return converted;
  } catch (err) {
    if (fs.existsSync(tempOut)) {
      try {
        fs.unlinkSync(tempOut);
      } catch (_) {
        // ignore cleanup errors
      }
    }
    
    if (err.code === 'ENOENT') {
      throw new Error(
        'PuTTY key detected. Install puttygen and try again or export the key to OpenSSH format.'
      );
    }
    
    const stderr = err.stderr ? err.stderr.toString('utf-8').trim() : '';
    const detail = stderr || err.message;
    throw new Error(`PuTTY key detected but conversion failed: ${detail}`);
  }
}

function discoverSSHKeys() {
  const discovered = [];
  if (!fs.existsSync(defaultSSHDir)) return discovered;
  
  try {
    const entries = fs.readdirSync(defaultSSHDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (!entry.isFile()) return;
      const fullPath = path.join(defaultSSHDir, entry.name);
      if (entry.name.endsWith('.pub')) return;
      
      const pubCandidate = `${fullPath}.pub`;
      if (!fs.existsSync(pubCandidate)) return;
      
      discovered.push({
        id: `auto-${entry.name}`,
        name: entry.name,
        privateKeyPath: fullPath,
        publicKeyPath: pubCandidate,
        discovered: true
      });
    });
  } catch (err) {
    // ignore discovery errors
  }
  
  return discovered;
}

// The window controls are drawn over our own top bar on Windows and macOS.
// Other platforms keep the standard frame, where overlays are unreliable.
function windowChromeMode() {
  if (process.platform === 'win32') return 'overlay-right';
  if (process.platform === 'darwin') return 'overlay-left';
  return 'native';
}

function createWindow() {
  const chrome = windowChromeMode();

  const options = {
    width: 1180,
    height: 760,
    minWidth: 780,
    minHeight: 480,
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  };

  if (chrome === 'overlay-right') {
    options.titleBarStyle = 'hidden';
    options.titleBarOverlay = {
      color: '#12161b',
      symbolColor: '#98a3b0',
      height: 42
    };
  } else if (chrome === 'overlay-left') {
    options.titleBarStyle = 'hiddenInset';
    options.trafficLightPosition = { x: 14, y: 13 };
  }

  mainWindow = new BrowserWindow(options);

  // The app never opens windows or navigates away from index.html. Refuse
  // both, so a link in terminal output (or xterm's own window.open fallback)
  // can't turn into an Electron window pointed at an arbitrary URL. Links
  // the user opens go to their browser via 'open-external' instead.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Closing the window ends every SSH session, so ask first while any are
  // open. This covers every way out: Ctrl+W, the title bar's close button,
  // Alt+F4 and File > Quit all arrive here as a 'close' event.
  let closeConfirmed = false;
  let closePromptOpen = false;
  mainWindow.on('close', (event) => {
    if (closeConfirmed) return;
    const open = Object.keys(sessions).length;
    if (open === 0) return;

    event.preventDefault();
    if (closePromptOpen) return; // Ctrl+W pressed again while the prompt is up
    closePromptOpen = true;
    confirmSessionLoss(mainWindow, 'close', open).then((confirmed) => {
      closePromptOpen = false;
      if (!confirmed) {
        quitRequested = false;
        return;
      }
      closeConfirmed = true;
      disconnectAllSessions();
      if (quitRequested) app.quit();
      else mainWindow.close();
    });
  });

  // A page that starts loading has no tabs, so any SSH session still open
  // belonged to the page it replaced. Without this, a reload (from the menu,
  // from DevTools, or after a renderer crash) left authenticated shells
  // running with nothing attached to them.
  mainWindow.webContents.on('did-start-loading', () => disconnectAllSessions());

  mainWindow.loadFile('index.html');
}

// Set while the app is quitting, so a confirmed close finishes the quit
// rather than only closing the window (which on macOS leaves the app running).
let quitRequested = false;
app.on('before-quit', () => { quitRequested = true; });

// Ask before an action that disconnects open sessions. The question is shown
// as an in-app dialog, styled like the rest of the app and able to name the
// sessions at stake. The page must acknowledge the request promptly; if it
// can't (crashed, hung, still loading), fall back to a native dialog so the
// window can always be closed.
const SESSION_LOSS_ACK_MS = 1500;
const pendingSessionLossPrompts = new Map(); // requestId -> { acknowledge, answer }

function confirmSessionLoss(win, action, count) {
  if (!win || win.isDestroyed()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const requestId = crypto.randomBytes(8).toString('hex');
    let acknowledged = false;

    const fallback = setTimeout(() => {
      if (acknowledged) return;
      pendingSessionLossPrompts.delete(requestId);
      // In case the page does show its dialog late, don't leave it behind
      if (!win.isDestroyed()) win.webContents.send('session-loss-prompt-cancel', { requestId });
      nativeConfirmSessionLoss(win, action, count).then(resolve);
    }, SESSION_LOSS_ACK_MS);

    pendingSessionLossPrompts.set(requestId, {
      acknowledge: () => {
        acknowledged = true;
        clearTimeout(fallback);
      },
      answer: (confirmed) => {
        clearTimeout(fallback);
        pendingSessionLossPrompts.delete(requestId);
        resolve(confirmed);
      }
    });

    win.webContents.send('session-loss-prompt', { requestId, action, sessionIds: Object.keys(sessions) });
  });
}

ipcMain.on('session-loss-ack', (event, { requestId }) => {
  const pending = pendingSessionLossPrompts.get(requestId);
  if (pending) pending.acknowledge();
});

ipcMain.on('session-loss-response', (event, { requestId, confirmed }) => {
  const pending = pendingSessionLossPrompts.get(requestId);
  if (pending) pending.answer(confirmed === true);
});

// Native fallback for when the page can't show its own dialog.
// Cancel is the default button, so a stray Enter keeps everything open.
function nativeConfirmSessionLoss(win, action, count) {
  const open = `${count} SSH session${count === 1 ? ' is' : 's are'} open`;
  const copy = action === 'reload'
    ? { title: 'Reload ElectroSSH', verb: 'Reload', detail: 'Reloading disconnects them and closes their tabs.' }
    : { title: 'Close ElectroSSH', verb: 'Close', detail: 'Closing the app disconnects them.' };
  return dialog.showMessageBox(win, {
    type: 'warning',
    title: copy.title,
    message: `${copy.verb} ElectroSSH? ${open}.`,
    detail: copy.detail,
    buttons: [`${copy.verb} and Disconnect`, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }).then(({ response }) => response === 0);
}

// Reload replaces every terminal tab, so it asks first while sessions are open
let reloadPromptOpen = false;
async function reloadWindow(ignoreCache) {
  if (!mainWindow || mainWindow.isDestroyed() || reloadPromptOpen) return;
  const open = Object.keys(sessions).length;
  if (open > 0) {
    reloadPromptOpen = true;
    const confirmed = await confirmSessionLoss(mainWindow, 'reload', open);
    reloadPromptOpen = false;
    if (!confirmed) return;
  }
  disconnectAllSessions();
  if (ignoreCache) mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

ipcMain.handle('window-chrome', () => windowChromeMode());

// Open a link from terminal output in the user's browser. That text is written
// by the remote host, so only web URLs are allowed: shell.openExternal will
// launch any registered protocol handler (file:, ms-msdt:, search-ms:, ...),
// and several of those have been used to run code.
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

ipcMain.handle('open-external', async (event, rawUrl) => {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return { ok: false, reason: 'invalid' };
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
  if (!OPENABLE_PROTOCOLS.has(url.protocol)) return { ok: false, reason: 'protocol' };
  await shell.openExternal(url.href);
  return { ok: true };
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  
  const template = [
    ...(isMac
      ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideothers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }]
      : []),
      {
        label: 'File',
        submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          ...(isMac
            ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
              }
            ]
            : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }])
          ]
        },
        {
          label: 'View',
          submenu: [
            // Not the built-in roles: those reload instantly, and Ctrl+R pressed
            // anywhere outside the terminal would wipe every open session.
            { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => reloadWindow(false) },
            { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => reloadWindow(true) },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            ...(isMac
              ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'windowMenu' }]
              : [{ role: 'close' }])
            ]
          },
          {
            label: 'Settings',
            submenu: [
              {
                label: 'Manage SSH Keys',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('open-settings', 'keys');
                  }
                }
              },
              {
                label: 'Keyboard Shortcuts',
                click: () => {
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('open-settings', 'shortcuts');
                  }
                }
              }
            ]
          },
          {
            role: 'help',
            submenu: [
              {
                label: 'Learn More',
                click: async () => {
                  await shell.openExternal('https://electronjs.org');
                }
              },
              {
                label: 'Documentation',
                click: async () => {
                  await shell.openExternal('https://electronjs.org/docs');
                }
              },
              {
                label: 'Community Discussions',
                click: async () => {
                  await shell.openExternal('https://www.electronjs.org/community');
                }
              },
              {
                label: 'Search Issues',
                click: async () => {
                  await shell.openExternal('https://github.com/electron/electron/issues');
                }
              }
            ]
          }
        ];
        
        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
      }
      
      app.whenReady().then(() => {
        createWindow();
        buildMenu();
      });
      
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
      });
      
      // --- SSH Key Management ---
      
      function mergeKeys() {
        const store = readKeyStore();
        const discovered = discoverSSHKeys();
        const ignored = new Set(store.ignoredPaths || []);
        const all = [...store.keys];
        const seen = new Set(store.keys.map((k) => k.privateKeyPath));
        
        discovered.forEach((k) => {
          if (ignored.has(k.privateKeyPath)) return;
          if (!seen.has(k.privateKeyPath)) {
            all.push(k);
            seen.add(k.privateKeyPath);
          }
        });
        
        return { keys: all, defaultKeyId: store.defaultKeyId || null, defaultSSHDir };
      }
      
      ipcMain.handle('list-ssh-keys', async () => {
        return mergeKeys();
      });
      
      ipcMain.handle('pick-ssh-key-file', async () => {
        const win = BrowserWindow.getFocusedWindow() || mainWindow;
        const result = await dialog.showOpenDialog(win, {
          title: 'Select Private Key',
          defaultPath: defaultSSHDir,
          properties: ['openFile', 'dontAddToRecent']
        });
        
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
      });
      
      ipcMain.handle('pick-ssh-directory', async () => {
        const win = BrowserWindow.getFocusedWindow() || mainWindow;
        const result = await dialog.showOpenDialog(win, {
          title: 'Select Directory to Save Key',
          defaultPath: defaultSSHDir,
          properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
        });
        
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
      });
      
      ipcMain.handle('add-ssh-key', async (event, { privateKeyPath, name }) => {
        if (!privateKeyPath) return mergeKeys();
        
        const trimmedPath = privateKeyPath.trim();
        if (!fs.existsSync(trimmedPath)) return mergeKeys();
        
        const store = readKeyStore();
        const already = store.keys.some((k) => k.privateKeyPath === trimmedPath);
        const keyId = already ? store.keys.find((k) => k.privateKeyPath === trimmedPath).id : Date.now().toString();
        
        if (!already) {
          store.keys.push({
            id: keyId,
            name: name || path.basename(trimmedPath),
            privateKeyPath: trimmedPath,
            publicKeyPath: `${trimmedPath}.pub`
          });
        }
        
        writeKeyStore(store);
        return mergeKeys();
      });
      
      ipcMain.handle('delete-ssh-key', async (event, keyId) => {
        if (!keyId) return mergeKeys();
        
        const merged = mergeKeys();
        const target = merged.keys.find((k) => k.id === keyId);
        if (!target) return merged;
        
        const store = readKeyStore();
        const filtered = store.keys.filter((k) => k.id !== keyId);
        const ignoredPaths = new Set(store.ignoredPaths || []);
        if (target.discovered) {
          ignoredPaths.add(target.privateKeyPath);
        }
        
        const newDefault = store.defaultKeyId === keyId ? null : store.defaultKeyId;
        
        writeKeyStore({
          keys: filtered,
          defaultKeyId: newDefault,
          ignoredPaths: Array.from(ignoredPaths)
        });
        return mergeKeys();
      });
      
      ipcMain.handle('set-default-ssh-key', async (event, keyId) => {
        const store = readKeyStore();
        store.defaultKeyId = keyId || null;
        writeKeyStore(store);
        return mergeKeys();
      });
      
      ipcMain.handle('generate-ssh-key', async (event, { name, passphrase, type, size, directory }) => {
        const safeName = (name || '').trim() || 'id_ed25519';
        const requestedType = (type || 'ed25519').toLowerCase();
        const allowedTypes = new Set(['ed25519', 'rsa', 'ecdsa']);
        const keyType = allowedTypes.has(requestedType) ? requestedType : 'ed25519';
        
        const targetDir = (directory && directory.trim()) ? path.resolve(directory.trim()) : defaultSSHDir;
        const privateKeyPath = path.join(targetDir, safeName);
        
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        }
        
        // Do not overwrite existing keys
        if (fs.existsSync(privateKeyPath)) {
          throw new Error(`Key ${privateKeyPath} already exists`);
        }
        
        const args = ['-t', keyType, '-f', privateKeyPath, '-N', passphrase || ''];
        
        const numericSize = parseInt(size, 10);
        const includeSize = Number.isInteger(numericSize) && numericSize > 0;
        if (keyType === 'rsa' && includeSize) {
          args.push('-b', `${numericSize}`);
        } else if (keyType === 'ecdsa' && includeSize) {
          args.push('-b', `${numericSize}`);
        }
        
        await new Promise((resolve, reject) => {
          execFile('ssh-keygen', args, (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
              return;
            }
            resolve(stdout);
          });
        });
        
        const store = readKeyStore();
        const id = Date.now().toString();
        store.keys.push({
          id,
          name: safeName,
          privateKeyPath,
          publicKeyPath: `${privateKeyPath}.pub`
        });
        
        if (!store.defaultKeyId) {
          store.defaultKeyId = id;
        }
        
        writeKeyStore(store);
        return mergeKeys();
      });
      
      // --- Host Management (JSON File) ---
      
      ipcMain.handle('get-hosts', async () => {
        return readHostStore();
      });
      
      ipcMain.handle('save-host', async (event, hostData) => {
        const store = readHostStore();
        hostData = { ...hostData, keepalive: normalizeKeepalive(hostData.keepalive) };
        const targetGroupId = hostData.groupId || defaultGroup.id;
        const hasGroup = store.groups.some(g => g.id === targetGroupId);
        if (!hasGroup) {
          store.groups.push({ id: targetGroupId, name: hostData.groupName || targetGroupId });
        }
        
        const existingHostIndex = store.hosts.findIndex(h => h.id === hostData.id);
        
        if (existingHostIndex !== -1) {
          // Update existing host
          store.hosts[existingHostIndex] = { ...store.hosts[existingHostIndex], ...hostData, groupId: targetGroupId };
        } else {
          // Add new host (generate ID)
          const id = Date.now().toString(); // Simple timestamp ID
          store.hosts.push({ ...hostData, id, groupId: targetGroupId });
        }
        
        writeHostStore(store);
        return store;
      });
      
      ipcMain.handle('delete-host', async (event, hostId) => {
        const store = readHostStore();
        store.hosts = store.hosts.filter(host => host.id !== hostId);
        
        writeHostStore(store);
        return store;
      });
      
      // A group is only removable once it is empty. The renderer disables the
      // button in that case, but the rule is enforced here too so a stale
      // window can't delete a group that has gained hosts in the meantime.
      ipcMain.handle('delete-group', async (event, groupId) => {
        const store = readHostStore();
        if (!groupId) return { ok: false, reason: 'missing-id', store };

        // readHostStore re-creates the default group whenever it is absent, so
        // removing it would just make it reappear under its original name.
        if (groupId === defaultGroup.id) return { ok: false, reason: 'default-group', store };

        if (!store.groups.some(g => g.id === groupId)) {
          return { ok: false, reason: 'not-found', store };
        }

        const hostCount = store.hosts.filter(h => (h.groupId || defaultGroup.id) === groupId).length;
        if (hostCount > 0) return { ok: false, reason: 'has-hosts', hostCount, store };

        store.groups = store.groups.filter(g => g.id !== groupId);
        writeHostStore(store);
        return { ok: true, store: readHostStore() };
      });

      ipcMain.handle('rename-group', async (event, { groupId, name }) => {
        const trimmed = (name || '').trim();
        const store = readHostStore();
        if (!groupId || !trimmed) return store;

        const target = store.groups.find(g => g.id === groupId);
        if (!target) return store;

        // Another group already using the name blocks the rename
        const clash = store.groups.some(
          g => g.id !== groupId && g.name.toLowerCase() === trimmed.toLowerCase()
        );
        if (clash) return store;

        target.name = trimmed;
        writeHostStore(store);
        return readHostStore();
      });

      ipcMain.handle('save-group', async (event, groupName) => {
        const trimmed = (groupName || '').trim();
        if (!trimmed) return readHostStore();
        
        const store = readHostStore();
        const exists = store.groups.some(g => g.name.toLowerCase() === trimmed.toLowerCase());
        if (exists) return store;
        
        const id = `${Date.now().toString()}-${Math.random().toString(16).slice(2, 6)}`;
        store.groups.push({ id, name: trimmed });
        
        writeHostStore(store);
        return store;
      });
      
      
      // --- SSH Connection Management ---

      // Push a session's most recent terminal size to the remote pty. Safe to
      // call before the shell exists; it is re-applied once the stream opens.
      function applyWindowSize(session) {
        if (!session || !session.stream || !session.size) return;
        const { cols, rows } = session.size;
        if (!cols || !rows) return;
        if (session.appliedSize
            && session.appliedSize.cols === cols
            && session.appliedSize.rows === rows) {
          return;
        }
        try {
          // ssh2 wants (rows, cols); 0 pixel dimensions means "unspecified"
          session.stream.setWindow(rows, cols, 0, 0);
          session.appliedSize = { cols, rows };
        } catch (err) {
          console.error(`setWindow failed for ${session.id}: ${err.message}`);
        }
      }
      
      // Host key prompts waiting on the user: requestId -> { sessionId, resolve }
      const pendingHostKeyPrompts = new Map();

      function promptHostKey(sender, payload) {
        return new Promise((resolve) => {
          const requestId = `${payload.sessionId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          pendingHostKeyPrompts.set(requestId, { sessionId: payload.sessionId, resolve });
          sender.send('host-key-prompt', { requestId, ...payload });
        });
      }

      // Resolve any prompt for a session that is going away, and tell the
      // renderer to take the dialog down.
      function cancelHostKeyPrompts(sessionId, sender) {
        for (const [requestId, pending] of pendingHostKeyPrompts) {
          if (pending.sessionId !== sessionId) continue;
          pendingHostKeyPrompts.delete(requestId);
          pending.resolve('reject');
          if (sender && !sender.isDestroyed()) sender.send('host-key-prompt-cancel', { requestId });
        }
      }

      // End every SSH connection. Used when the page that owns them is going
      // away; the entry is removed first so each connection's close handler
      // sees it is no longer current and stays quiet.
      function disconnectAllSessions() {
        Object.keys(sessions).forEach((sessionId) => {
          const session = sessions[sessionId];
          cancelHostKeyPrompts(sessionId, null);
          delete sessions[sessionId];
          try {
            session.conn.end();
          } catch (e) {
            // already closed
          }
        });
      }

      ipcMain.on('host-key-response', (event, { requestId, decision }) => {
        const pending = pendingHostKeyPrompts.get(requestId);
        if (!pending) return;
        pendingHostKeyPrompts.delete(requestId);
        pending.resolve(['accept', 'once'].includes(decision) ? decision : 'reject');
      });

      ipcMain.on('ssh-disconnect', (event, sessionId) => {
        cancelHostKeyPrompts(sessionId, event.sender);
        const session = sessions[sessionId];
        if (session && session.conn) {
          try {
            session.conn.end();
          } catch (e) {
            console.error(`Error disconnecting session ${sessionId}: ${e.message}`);
          }
          delete sessions[sessionId];
        }
      });
      
      // ssh2's own readyTimeout covers the whole handshake, including the time
      // a person spends reading a host key prompt, so it is disabled and this
      // timer runs instead, paused while a prompt is open.
      const HANDSHAKE_TIMEOUT_MS = 20000;

      ipcMain.on('ssh-connect', (event, { sessionId, config, size }) => {
        if (sessions[sessionId]) {
          cancelHostKeyPrompts(sessionId, event.sender);
          sessions[sessionId].conn.end();
          delete sessions[sessionId];
        }

        const conn = new Client();
        sessions[sessionId] = { id: sessionId, conn, stream: null, size: { ...size }, appliedSize: null };

        // On reconnect the previous connection's end/close events arrive after
        // this one has taken over the session id. Only the current connection
        // may report status or tear the session down.
        const isCurrent = () => Boolean(sessions[sessionId] && sessions[sessionId].conn === conn);

        let handshakeTimer = null;
        const clearHandshakeTimer = () => {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        };
        const armHandshakeTimer = () => {
          clearHandshakeTimer();
          handshakeTimer = setTimeout(() => {
            if (!isCurrent()) return;
            event.sender.send('ssh-error', { sessionId, message: 'Timed out while waiting for handshake' });
            conn.destroy();
          }, HANDSHAKE_TIMEOUT_MS);
        };

        const hostId = knownHostId(config.host, config.port);
        let acceptedHostKey = null;   // survives rekeys within this connection
        let hostKeyRejected = false;

        const hostVerifier = (keyBlob, verify) => {
          const info = describeHostKey(keyBlob);

          // ssh2 runs the verifier again on every rekey during a long session.
          // The key this connection already accepted must not prompt again,
          // or "Connect once" would re-ask an hour into the session.
          if (acceptedHostKey && acceptedHostKey === info.key) {
            verify(true);
            return;
          }

          const verdict = classifyHostKey(readKnownHosts(), hostId, info);
          if (verdict.status === 'trusted') {
            acceptedHostKey = info.key;
            verify(true);
            return;
          }

          clearHandshakeTimer(); // a person is deciding now
          promptHostKey(event.sender, {
            sessionId,
            host: config.host,
            port: parseInt(config.port, 10) || 22,
            keyType: info.keyType,
            fingerprint: info.fingerprint,
            ...verdict
          }).then((decision) => {
            if (!isCurrent()) {
              verify(false);
              return;
            }
            if (decision === 'accept' || decision === 'once') {
              if (decision === 'accept') saveKnownHostKey(hostId, info);
              acceptedHostKey = info.key;
              armHandshakeTimer(); // the rest of the handshake is machine-paced again
              verify(true);
            } else {
              hostKeyRejected = true;
              verify(false);
            }
          });
        };

        conn.on('ready', () => {
          clearHandshakeTimer();
          event.sender.send('ssh-status', { sessionId, status: 'Connected' });

          // Open the shell at whatever size the terminal is *now*, which may
          // differ from the size sent with the connect request if the window
          // was resized while the handshake was in flight.
          const current = sessions[sessionId] ? sessions[sessionId].size : size;
          conn.shell({ term: 'xterm-256color', cols: current.cols, rows: current.rows }, (err, stream) => {
            if (err) {
              event.sender.send('ssh-error', { sessionId, message: err.message });
              delete sessions[sessionId];
              return;
            }
            sessions[sessionId].stream = stream;
            sessions[sessionId].appliedSize = { ...current };
            // Catch any resize that landed between 'ready' and the shell opening
            applyWindowSize(sessions[sessionId]);

            stream.on('data', (data) => {
              event.sender.send('ssh-data', { sessionId, data: data.toString('utf-8') });
            });
            
            stream.on('close', (code, signal) => {
              event.sender.send('ssh-status', { sessionId, status: 'Closed', code, signal });
              if (sessions[sessionId]) delete sessions[sessionId];
            });
            
            stream.on('exit', (code, signal) => {
              event.sender.send('ssh-status', { sessionId, status: 'Exit', code, signal });
            });
            
            // Handle window change requests from the renderer process
            stream.on('window-change', () => {
              event.sender.send('ssh-status', { sessionId, status: 'window-change' });
            });
          });
        });
        
        conn.on('error', (err) => {
          clearHandshakeTimer();
          if (!isCurrent()) return;
          cancelHostKeyPrompts(sessionId, event.sender);
          const message = hostKeyRejected
            ? 'Connection cancelled: the host key was not accepted.'
            : err.message;
          event.sender.send('ssh-error', { sessionId, message });
          delete sessions[sessionId];
        });

        conn.on('end', () => {
          clearHandshakeTimer();
          if (!isCurrent()) return;
          cancelHostKeyPrompts(sessionId, event.sender);
          event.sender.send('ssh-status', { sessionId, status: 'Disconnected' });
          delete sessions[sessionId];
        });

        conn.on('close', (hadError) => {
          clearHandshakeTimer();
          if (!isCurrent()) return;
          // e.g. the server's LoginGraceTime expired while the prompt was open
          cancelHostKeyPrompts(sessionId, event.sender);
          event.sender.send('ssh-status', { sessionId, status: 'Closed', hadError });
          delete sessions[sessionId];
        });
        
        try {
          const keepaliveSeconds = normalizeKeepalive(config.keepalive);
          const connConfig = {
            host: config.host,
            port: parseInt(config.port),
            username: config.username,
            // ssh2 treats 0 as "no keepalives"
            keepaliveInterval: keepaliveSeconds * 1000,
            keepaliveCountMax: 3, // Missed replies tolerated before disconnecting
            hostVerifier,
            readyTimeout: 0 // replaced by the pausable handshake timer above
          };
          
          if (config.authType === 'key' && config.privateKeyPath) {
            let keyBuffer = fs.readFileSync(config.privateKeyPath);
            const passphrase = config.passphrase || undefined;
            
            const parseKey = (buffer) => {
              let parsed = sshUtils.parseKey(buffer, passphrase);
              if (Array.isArray(parsed)) parsed = parsed[0];
              return parsed;
            };
            
            let parsed = parseKey(keyBuffer);
            
            if (parsed instanceof Error && looksLikePuttyKey(keyBuffer)) {
              const convertedBuffer = convertPuttyKey(config.privateKeyPath, passphrase);
              parsed = parseKey(convertedBuffer);
              if (!(parsed instanceof Error)) {
                keyBuffer = convertedBuffer;
              }
            }
            
            if (parsed instanceof Error) {
              const details = parsed.message || 'Unsupported key format';
              throw new Error(`Cannot use private key (${config.privateKeyPath}): ${details}`);
            }
            
            connConfig.privateKey = keyBuffer;
            if (config.passphrase) connConfig.passphrase = config.passphrase;
          } else {
            connConfig.password = config.password;
          }
          
          armHandshakeTimer();
          conn.connect(connConfig);
        } catch (error) {
          clearHandshakeTimer();
          event.sender.send('ssh-error', { sessionId, message: error.message });
          if (isCurrent()) delete sessions[sessionId];
        }
      });
      
      ipcMain.on('term-input', (event, { sessionId, data }) => {
        const session = sessions[sessionId];
        if (session && session.stream) {
          try {
            session.stream.write(data);
          } catch (err) {
            event.sender.send('ssh-error', { sessionId, message: `write error: ${err.message}` });
          }
        } else {
          event.sender.send('ssh-error', { sessionId, message: 'No active stream for session' });
        }
      });
      
      ipcMain.on('term-resize', (event, { sessionId, cols, rows }) => {
        const session = sessions[sessionId];
        if (!session) return;

        // Always remember the latest size. A resize can arrive while the SSH
        // handshake is still in flight; previously those were dropped, so the
        // pty kept the size it was opened with while xterm had already grown
        // and full-screen apps such as htop drew short.
        session.size = { cols, rows };
        applyWindowSize(session);
      });