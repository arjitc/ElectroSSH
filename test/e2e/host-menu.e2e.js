'use strict';

// Right-clicking a saved host opens an in-app menu that copies its address,
// display name or SSH port. The system clipboard is saved first and put back
// at the end, so running the tests doesn't lose what you had copied.

const { clipboard } = require('electron');
const { start, check, run, waitFor } = require('./harness');

run(async () => {
  const savedClipboard = clipboard.readText();
  try {
    await testHostMenu();
  } finally {
    clipboard.writeText(savedClipboard);
  }
});

async function testHostMenu() {
  const t = await start();
  await t.js(`window.electronAPI.saveHost({ name: 'BLR-VPN', host: '142.93.215.8', port: 2222, username: 'root',
      password: 'x', authType: 'password', groupId: 'default', keepalive: 5 })
    .then(() => window.electronAPI.saveHost({ name: 'Build box', host: 'build.internal', port: 22, username: 'ci',
      password: 'x', authType: 'password', groupId: 'default', keepalive: 5 }))
    .then(() => { document.getElementById('search-input').dispatchEvent(new Event('input')); return 'ok'; })`);
  await waitFor(() => t.js(`document.querySelectorAll('.tree-host').length === 2`));

  const rowExpr = (name) =>
    `[...document.querySelectorAll('.tree-host')].find((r) => r.querySelector('.host-name').textContent === ${JSON.stringify(name)})`;
  const rightClick = async (name) => {
    const p = await t.js(`(() => { const r = ${rowExpr(name)}.getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    await t.clickAt(p.x, p.y, 'right');
  };
  const menu = () => t.js(`(() => {
    const m = document.getElementById('host-context-menu');
    const r = m.getBoundingClientRect();
    const focused = m.contains(document.activeElement) && document.activeElement.querySelector('.context-menu-label');
    return {
      shown: !m.classList.contains('hidden'),
      items: [...m.querySelectorAll('.context-menu-item')].map((b) =>
        [b.querySelector('.context-menu-label').textContent, b.querySelector('.context-menu-value').textContent]),
      focused: focused ? focused.textContent : null,
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    };
  })()`);
  const hostFocused = (name) => t.js(`document.activeElement === ${rowExpr(name)}`);
  const copied = (text) => waitFor(() => clipboard.readText() === text, 2000);
  const toast = () => t.js(`({ visible: document.getElementById('copy-toast').classList.contains('visible'),
    text: document.getElementById('copy-toast').textContent })`);

  clipboard.writeText('something else');

  // A genuine right-click
  await rightClick('BLR-VPN');
  let m = await menu();
  check('right-clicking a host opens its menu', m.shown, m);
  check('offering its IP address, display name and SSH port', JSON.stringify(m.items) === JSON.stringify([
    ['Copy IP address', '142.93.215.8'], ['Copy display name', 'BLR-VPN'], ['Copy SSH port', '2222']]), m.items);
  check('with the first item focused', m.focused === 'Copy IP address', m);
  check('and the host selected', await t.js(`${rowExpr('BLR-VPN')}.classList.contains('selected')`));

  await t.click('#host-context-menu [data-copy="address"]');
  check('Copy IP address puts the address on the clipboard', await copied('142.93.215.8'), clipboard.readText());
  const note = await toast();
  check('the menu closes and says what was copied',
    !(await menu()).shown && note.visible && note.text === 'Copied 142.93.215.8', note);

  await rightClick('BLR-VPN');
  await t.click('#host-context-menu [data-copy="name"]');
  check('Copy display name copies the name', await copied('BLR-VPN'), clipboard.readText());

  // From the keyboard: Shift+F10 on the focused host, arrows, Enter, Esc
  await t.focus('.tree-host.selected');
  await t.press('F10', ['shift']);
  m = await menu();
  check('Shift+F10 opens it from the keyboard', m.shown && m.focused === 'Copy IP address', m);
  await t.press('Down');
  await t.press('Down');
  check('the arrow keys move through it', (await menu()).focused === 'Copy SSH port');
  await t.press('Return');
  check('Enter copies the port', await copied('2222'), clipboard.readText());
  check('and focus goes back to the host', await hostFocused('BLR-VPN'));

  await t.press('F10', ['shift']);
  await t.press('Escape');
  check('Esc closes it and focus goes back to the host', !(await menu()).shown && await hostFocused('BLR-VPN'));

  // A DNS name isn't called an IP address
  await rightClick('Build box');
  m = await menu();
  check('a DNS name is offered as "Copy hostname"',
    m.items[0] && m.items[0][0] === 'Copy hostname' && m.items[0][1] === 'build.internal', m.items);
  await t.clickAt(700, 120);
  check('clicking elsewhere closes it', !(await menu()).shown);

  // Opened in the window's bottom-right corner, it flips back inside
  await t.js(`${rowExpr('Build box')}.dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 })); 'ok'`);
  m = await menu();
  check('near the window\'s edge it stays inside the window', m.shown && m.inside, m);
  await t.press('Escape');
}
