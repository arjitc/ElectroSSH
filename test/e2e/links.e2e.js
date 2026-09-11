'use strict';

// Links in terminal output, end to end: the window refuses window.open and
// navigation, plain clicks don't open anything, Ctrl+click opens http(s) links
// through main's checked 'open-external', and an OSC 8 hyperlink to a file:
// URL never opens. shell.openExternal is replaced so no browser launches.

const { BrowserWindow, shell } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// OSC 8 hyperlink: the visible text differs from the target
const osc8 = (target, text) => `${ESC}]8;;${target}${BEL}${text}${ESC}]8;;${BEL}`;

run(async () => {
  const opened = [];
  shell.openExternal = async (url) => { opened.push(url); };

  const t = await start();

  // The page can't open windows or navigate away
  const windowsBefore = BrowserWindow.getAllWindows().length;
  const openResult = await t.js(`String(window.open('https://example.com/'))`);
  await t.sleep(300);
  check('window.open returns null', openResult === 'null', openResult);
  check('window.open creates no window', BrowserWindow.getAllWindows().length === windowsBefore);
  const url = t.wc.getURL();
  await t.js(`location.href = 'https://example.com/'; 'ok'`).catch(() => {});
  await t.sleep(1000);
  check('navigating away is blocked', t.wc.getURL() === url, t.wc.getURL());

  let remoteShell = null;
  const server = await startSshServer({ onShell: ({ stream }) => { remoteShell = stream; } });
  check('a session connects', await t.connect(server));

  // Wait for the terminal's size to stop changing (it refits after connecting);
  // a late refit would move the cells out from under the clicks below
  for (let settled = 0, seen = -1; settled < 3;) {
    const now = server.state.windowChanges.length;
    settled = now === seen ? settled + 1 : 0;
    seen = now;
    await t.sleep(200);
  }

  // Now print links at known positions: row 0 a plain URL from column 6,
  // row 1 an OSC 8 link to a file: URL from column 6
  remoteShell.write(
    `${ESC}[2J${ESC}[H` +
    'Docs: https://example.com/guide end\r\n' +
    `File: ${osc8('file:///C:/Windows/System32/calc.exe', 'open me')} end\r\n`
  );
  await t.sleep(400);

  // Map a terminal cell to window coordinates
  const grid = server.state.windowChanges[server.state.windowChanges.length - 1] || server.state.ptySizes[0];
  const screen = await t.js(`(() => { const r = document.querySelector('.terminal-instance.active .xterm-screen').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const cell = (col, row) => ({
    x: Math.round(screen.left + (col + 0.5) * (screen.width / grid.cols)),
    y: Math.round(screen.top + (row + 0.5) * (screen.height / grid.rows))
  });
  const mouse = (type, { x, y }, modifiers = []) => t.wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers });
  const clickCell = async (col, row, modifiers) => {
    const p = cell(col, row);
    mouse('mouseMove', p, modifiers);
    await t.sleep(250);
    mouse('mouseDown', p, modifiers);
    mouse('mouseUp', p, modifiers);
    await t.sleep(400);
  };
  const hint = () => t.js(`({ visible: document.getElementById('link-hint').classList.contains('visible'),
    url: document.getElementById('link-hint-url').textContent })`);

  // Hovering the URL shows where it goes. Pointer moves from sendInputEvent
  // never reach xterm's link detection (clicks do, since xterm re-checks on
  // mouse-up), so this dispatches the DOM mousemove xterm listens for. It
  // still runs xterm's linkifier, the addon's hover callback and our hint.
  const hoverAt = ({ x, y }) => t.js(`document.querySelector('.terminal-instance.active .xterm-screen')
    .dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${x}, clientY: ${y} })); 'ok'`);
  await hoverAt(cell(0, 5));
  await hoverAt(cell(12, 0));
  const hovered = await waitFor(async () => (await hint()).visible, 2000);
  check('hovering a link shows its destination', hovered && (await hint()).url === 'https://example.com/guide', await hint());

  await clickCell(12, 0);
  check('a plain click does not open the link', opened.length === 0, opened);

  await clickCell(12, 0, ['control']);
  check('Ctrl+click opens it in the browser', await waitFor(() => opened.length === 1, 2000) && opened[0] === 'https://example.com/guide', opened);

  // The file: hyperlink must never reach the browser
  mouse('mouseMove', cell(0, 5));
  await t.sleep(200);
  await clickCell(8, 1, ['control']);
  await t.sleep(400);
  check('Ctrl+click on a file: hyperlink opens nothing', opened.length === 1, opened);

  await server.close();
});
