const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client, utils: sshUtils } = require('ssh2');

let mainWindow;
const userDataPath = app.getPath('userData'); // Get a writable path
const hostsFilePath = path.join(userDataPath, 'saved_hosts.json');
const keysFilePath = path.join(userDataPath, 'ssh_keys.json');

console.log('Host data path:', hostsFilePath);
// Store active sessions: { sessionId: { conn: Client, stream: Stream } }
const sessions = {};
const defaultGroup = { id: 'default', name: 'Default' };

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
  
  // Ensure all hosts have a group assignment
  store.hosts = store.hosts.map(h => ({ ...h, groupId: h.groupId || defaultGroup.id }));
  
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  
  mainWindow.loadFile('index.html');
}

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
            { role: 'reload' },
            { role: 'forceReload' },
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
                    mainWindow.webContents.send('open-settings');
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
      
      ipcMain.on('ssh-disconnect', (event, sessionId) => {
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
      
      ipcMain.on('ssh-connect', (event, { sessionId, config, size }) => {
        if (sessions[sessionId]) {
          sessions[sessionId].conn.end();
          delete sessions[sessionId];
        }
        
        const conn = new Client();
        sessions[sessionId] = { conn, stream: null };
        
        conn.on('ready', () => {
          event.sender.send('ssh-status', { sessionId, status: 'Connected' });
          
          conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
            if (err) {
              event.sender.send('ssh-error', { sessionId, message: err.message });
              delete sessions[sessionId];
              return;
            }
            sessions[sessionId].stream = stream;
            
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
          event.sender.send('ssh-error', { sessionId, message: err.message });
          if (sessions[sessionId]) delete sessions[sessionId];
        });
        
        conn.on('end', () => {
          event.sender.send('ssh-status', { sessionId, status: 'Disconnected' });
          if (sessions[sessionId]) delete sessions[sessionId];
        });
        
        conn.on('close', (hadError) => {
          // ensure renderer knows connection closed
          event.sender.send('ssh-status', { sessionId, status: 'Closed', hadError });
          if (sessions[sessionId]) delete sessions[sessionId];
        });
        
        try {
          const connConfig = {
            host: config.host,
            port: parseInt(config.port),
            username: config.username,
            keepaliveInterval: (parseInt(config.keepalive) || 15) * 1000, 
            keepaliveCountMax: 3 // Default attempts before disconnecting
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
          
          conn.connect(connConfig);
        } catch (error) {
          event.sender.send('ssh-error', { sessionId, message: error.message });
          if (sessions[sessionId]) delete sessions[sessionId];
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
        if (session && session.stream) {
          session.stream.setWindow(rows, cols);
        }
      });