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

  // Settings events
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),

  // Host Management
  getHosts: () => ipcRenderer.invoke('get-hosts'),
  saveHost: (hostData) => ipcRenderer.invoke('save-host', hostData),
  deleteHost: (hostId) => ipcRenderer.invoke('delete-host', hostId),
  saveGroup: (groupName) => ipcRenderer.invoke('save-group', groupName),

  // SSH Keys
  listSSHKeys: () => ipcRenderer.invoke('list-ssh-keys'),
  addSSHKey: (payload) => ipcRenderer.invoke('add-ssh-key', payload),
  deleteSSHKey: (keyId) => ipcRenderer.invoke('delete-ssh-key', keyId),
  setDefaultSSHKey: (keyId) => ipcRenderer.invoke('set-default-ssh-key', keyId),
  generateSSHKey: (payload) => ipcRenderer.invoke('generate-ssh-key', payload),
  selectSSHKeyFile: () => ipcRenderer.invoke('pick-ssh-key-file'),
  selectSSHDirectory: () => ipcRenderer.invoke('pick-ssh-directory')
});
