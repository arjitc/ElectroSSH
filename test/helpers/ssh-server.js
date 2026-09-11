'use strict';

// A local SSH server for tests: accepts any login, opens a shell, and records
// what happened. Works under plain Node and inside Electron's main process.

const crypto = require('crypto');
const { Server, utils } = require('ssh2');

function generateHostKey(type = 'ed25519', options) {
  return utils.generateKeyPairSync(type, options).private;
}

/**
 * The key's fingerprint as ssh-keygen -l and PuTTY print it, computed from the
 * key itself rather than from anything the client received.
 */
function fingerprintOf(privateKey) {
  const publicBlob = utils.parseKey(privateKey).getPublicSSH();
  return 'SHA256:' + crypto.createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '');
}

/**
 * @param {object}   [opts]
 * @param {string}   [opts.hostKey]  private host key (a fresh Ed25519 key by default)
 * @param {number}   [opts.port]     0 picks a free port; pass a port to reuse one
 * @param {Function} [opts.onShell]  called with { client, stream } when a shell opens
 */
function startSshServer({ hostKey = generateHostKey(), port = 0, onShell } = {}) {
  const state = {
    openConnections: 0,
    shellsOpened: 0,
    ptySizes: [],        // size requested when each pty was opened
    windowChanges: [],   // every window-change request received
    shellData: []        // everything typed into any shell
  };
  const clients = new Set();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    state.openConnections++;
    client.on('close', () => {
      state.openConnections--;
      clients.delete(client);
    });
    client.on('error', () => {});
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc, rej, info) => {
          state.ptySizes.push({ cols: info.cols, rows: info.rows });
          if (acc) acc();
        });
        session.on('window-change', (acc, rej, info) => {
          state.windowChanges.push({ cols: info.cols, rows: info.rows });
          if (acc) acc();
        });
        session.on('shell', (acc) => {
          state.shellsOpened++;
          const stream = acc();
          stream.on('data', (d) => state.shellData.push(d.toString('binary')));
          stream.write('ready\r\n');
          if (onShell) onShell({ client, stream });
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        fingerprint: fingerprintOf(hostKey),
        // End live connections as well as the listener, or the process never exits
        close: () => new Promise((done) => {
          clients.forEach((c) => { try { c.end(); } catch (e) { /* already gone */ } });
          const fallback = setTimeout(done, 1000);
          server.close(() => { clearTimeout(fallback); done(); });
        })
      });
    });
  });
}

module.exports = { startSshServer, generateHostKey, fingerprintOf };
