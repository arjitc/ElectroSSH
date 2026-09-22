'use strict';

// Settings > About: the version, the project's pages and a copyable block of
// versions for bug reports. Windows can't show the menu bar, so this is where
// every platform finds the Help menu's links. The system clipboard is put back
// at the end, and shell.openExternal is replaced so no browser opens.

const fs = require('fs');
const path = require('path');
const { clipboard, shell } = require('electron');
const { start, check, run, waitFor } = require('./harness');

const REPO = 'https://github.com/arjitc/ElectroSSH';
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

run(async () => {
  const savedClipboard = clipboard.readText();
  const opened = [];
  shell.openExternal = async (url) => { opened.push(url); };
  try {
    await testAbout(opened);
  } finally {
    clipboard.writeText(savedClipboard);
  }
});

async function testAbout(opened) {
  const t = await start();
  const aboutShown = () => t.js(`document.getElementById('settings-view').classList.contains('visible')
    && document.getElementById('settings-page-about').classList.contains('active')`);

  // The version label in the sidebar opens it
  await waitFor(() => t.js(`!document.getElementById('app-version').classList.contains('hidden')`));
  await t.click('#app-version');
  check('clicking the version in the sidebar opens Settings > About', await waitFor(aboutShown, 3000));

  const page = await t.js(`({
    version: document.getElementById('about-version').textContent,
    details: document.getElementById('about-details').textContent,
    hints: [...document.querySelectorAll('.about-link[data-link] .about-link-hint')].map((h) => h.textContent)
  })`);
  check('it shows the version from package.json', page.version === `Version ${version}`, page.version);
  check('and the versions a bug report needs',
    page.details.startsWith(`ElectroSSH ${version}\nElectron `) && page.details.includes('Chromium') && page.details.includes('Node'), page.details);
  check('each link says where it goes', page.hints.join(' | ') ===
    'github.com/arjitc/ElectroSSH | github.com/arjitc/ElectroSSH/releases | github.com/arjitc/ElectroSSH/issues', page.hints);

  for (const link of ['repo', 'releases', 'issues']) await t.click(`.about-link[data-link="${link}"]`);
  check('the links open the project\'s pages in the browser',
    await waitFor(() => opened.length === 3, 2000) && opened.join(' ') === `${REPO} ${REPO}/releases ${REPO}/issues`, opened);

  clipboard.writeText('something else');
  await t.click('#btn-copy-about-details');
  check('"Copy details" puts them on the clipboard',
    await waitFor(() => clipboard.readText() === page.details, 2000), clipboard.readText());

  await t.click('.about-link[data-page="shortcuts"]');
  check('"Keyboard Shortcuts" goes to that page',
    await t.js(`document.getElementById('settings-page-shortcuts').classList.contains('active')`));

  // The shortcuts page only claims Alt shows the menu bar where it does
  const altListed = await t.js(`[...document.querySelectorAll('.shortcut-action')].some((a) => a.firstChild.textContent === 'Show the menu bar')`);
  check(`the shortcuts page lists Alt for the menu bar only on Linux (this is ${process.platform})`,
    altListed === (process.platform === 'linux'), altListed);

  // And the Help menu (macOS, Linux) reaches it too
  await t.js(`document.getElementById('settings-nav-keys').click(); 'ok'`);
  t.menuItem('Help', 'About ElectroSSH').click();
  check('Help > About ElectroSSH opens the same page', await waitFor(aboutShown, 3000));
}
