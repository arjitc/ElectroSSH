'use strict';

// Connection dots. A tab is amber while connecting, green once its shell is
// open, red once dropped, and amber again while reconnecting. A saved host's
// dot in the tree is green only while one of its tabs is live.

const net = require('net');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

const AMBER = 'rgb(210, 153, 34)'; // --warn

run(async () => {
  const t = await start();
  let serverSide = null;
  const server = await startSshServer({ onShell: ({ client }) => { serverSide = client; } });

  const tabState = () => t.js(`(() => { const tab = document.querySelector('#tabs-strip .tab.active');
    return tab ? { classes: tab.className, dot: getComputedStyle(tab.querySelector('.tab-dot')).backgroundColor } : null; })()`);
  const treeDotLive = () => t.js(`document.querySelector('.tree-host').classList.contains('connected')`);
  let s;

  // A server that accepts the TCP connection and never speaks SSH
  const silent = net.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  await t.js(`document.getElementById('quick-connect-btn').click();
    document.getElementById('inp-host').value = '127.0.0.1';
    document.getElementById('inp-port').value = '${silent.address().port}';
    document.getElementById('inp-user').value = 'tester';
    document.getElementById('btn-connect').click(); 'ok'`);
  await t.sleep(600);
  s = await tabState();
  check('a tab still connecting has an amber dot, not a green one',
    s && s.classes.includes('connecting') && s.dot === AMBER, s);
  await t.click('#tabs-strip .tab.active .close-tab');
  silent.close();

  // A saved host, connected from the tree
  await t.js(`window.electronAPI.saveHost({ name: 'Box', host: '127.0.0.1', port: ${server.port}, username: 'tester',
      password: 'x', authType: 'password', groupId: 'default', keepalive: 0 })
    .then(() => { document.getElementById('search-input').dispatchEvent(new Event('input')); return 'ok'; })`);
  await waitFor(() => t.js(`!!document.querySelector('.tree-host')`));
  let before = server.state.shellsOpened;
  await t.js(`document.querySelector('.tree-host').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 'ok'`);
  await t.waitForShell(server, before);
  s = await tabState();
  check('once the shell is open the tab is live', !s.classes.includes('connecting') && !s.classes.includes('disconnected'), s);
  check('and the host\'s dot in the tree is green', await waitFor(treeDotLive));

  // The server drops the connection
  serverSide.end();
  check('a dropped session turns the tab red',
    await waitFor(async () => (s = await tabState()).classes.includes('disconnected'), 5000), s);
  check('and the host\'s dot in the tree goes out', await waitFor(async () => !(await treeDotLive())), 'still green');

  // Reconnect: amber while the host key prompt waits, green again after
  await t.click('.terminal-instance.active .term-banner-reconnect');
  await waitFor(() => t.js(`!document.getElementById('host-key-modal').classList.contains('hidden')`), 5000);
  s = await tabState();
  check('reconnecting turns the tab amber again', s.classes.includes('connecting') && !s.classes.includes('disconnected'), s);
  check('while the tree dot stays out', !(await treeDotLive()));
  before = server.state.shellsOpened;
  check('the reconnect goes through', await t.waitForShell(server, before));
  check('and both dots are live again', await waitFor(treeDotLive) && !(await tabState()).classes.includes('connecting'));

  await server.close();
});
