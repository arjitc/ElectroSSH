const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // SSH Methods
  connectSSH: (payload) => ipcRenderer.send('ssh-connect', payload),
  disconnectSSH: (sessionId) => ipcRenderer.send('ssh-disconnect', sessionId),
  sendInput: (payload) => ipcRenderer.send('term-input', payload),
  resizeTerm: (payload) => ipcRenderer.send('term-resize', payload),

  // SSH Listeners
  onData: (callback) => ipcRenderer.on('ssh-data', (event, args) => callback(args)),
  onError: (callback) => ipcRenderer.on('ssh-error', (event, args) => callback(args)),
  onStatus: (callback) => ipcRenderer.on('ssh-status', (event, args) => callback(args)),

  // Host key verification
  onHostKeyPrompt: (callback) => ipcRenderer.on('host-key-prompt', (event, args) => callback(args)),
  onHostKeyPromptCancel: (callback) => ipcRenderer.on('host-key-prompt-cancel', (event, args) => callback(args)),
  respondHostKey: (payload) => ipcRenderer.send('host-key-response', payload),

  // Settings events
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', (event, page) => callback(page)),

  // "Close/reload and disconnect?" confirmation, shown in-app
  onSessionLossPrompt: (callback) => ipcRenderer.on('session-loss-prompt', (event, args) => callback(args)),
  onSessionLossPromptCancel: (callback) => ipcRenderer.on('session-loss-prompt-cancel', (event, args) => callback(args)),
  ackSessionLossPrompt: (requestId) => ipcRenderer.send('session-loss-ack', { requestId }),
  respondSessionLossPrompt: (requestId, confirmed) => ipcRenderer.send('session-loss-response', { requestId, confirmed }),

  // Links clicked in terminal output (http/https only, checked in main)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Window chrome ('overlay-right', 'overlay-left' or 'native')
  getWindowChrome: () => ipcRenderer.invoke('window-chrome'),

  // Version from package.json, shown beside the app name
  getAppVersion: () => ipcRenderer.invoke('app-version'),

  // Recent connections, newest first (main records each successful connect)
  getRecentConnections: () => ipcRenderer.invoke('get-recent-connections'),
  removeRecentConnection: (id) => ipcRenderer.invoke('remove-recent-connection', id),
  clearRecentConnections: () => ipcRenderer.invoke('clear-recent-connections'),

  // Host Management
  getHosts: () => ipcRenderer.invoke('get-hosts'),
  saveHost: (hostData) => ipcRenderer.invoke('save-host', hostData),
  deleteHost: (hostId) => ipcRenderer.invoke('delete-host', hostId),
  saveGroup: (groupName) => ipcRenderer.invoke('save-group', groupName),
  renameGroup: (payload) => ipcRenderer.invoke('rename-group', payload),
  deleteGroup: (groupId) => ipcRenderer.invoke('delete-group', groupId),

  // SSH Keys
  listSSHKeys: () => ipcRenderer.invoke('list-ssh-keys'),
  addSSHKey: (payload) => ipcRenderer.invoke('add-ssh-key', payload),
  deleteSSHKey: (keyId) => ipcRenderer.invoke('delete-ssh-key', keyId),
  setDefaultSSHKey: (keyId) => ipcRenderer.invoke('set-default-ssh-key', keyId),
  generateSSHKey: (payload) => ipcRenderer.invoke('generate-ssh-key', payload),
  selectSSHKeyFile: () => ipcRenderer.invoke('pick-ssh-key-file'),
  selectSSHDirectory: () => ipcRenderer.invoke('pick-ssh-directory')
});
