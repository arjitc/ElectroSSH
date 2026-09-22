'use strict';

// Pasting into a terminal: line endings become Enter (\r), and when the remote
// program turns on bracketed paste, a multi-line paste arrives as one marked
// block to review instead of running line by line. Checked by what the SSH
// server actually receives. The system clipboard is put back at the end.

const { clipboard } = require('electron');
const { start, check, run, waitFor } = require('./harness');
const { startSshServer } = require('../helpers/ssh-server');

const ESC = String.fromCharCode(27);
const BRACKET_ON = `${ESC}[?2004h`; // what bash, zsh and vim send
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const visible = (s) => JSON.stringify(s.split(ESC).join('<ESC>'));

run(async () => {
  const savedClipboard = clipboard.readText();
  try {
    await testPaste();
  } finally {
    clipboard.writeText(savedClipboard);
  }
});

async function testPaste() {
  const t = await start();
  let shell = null;
  const server = await startSshServer({ onShell: ({ stream }) => { shell = stream; } });
  check('a session connects', await t.connect(server));

  // What the server has received since `mark`, as text
  let mark = 0;
  const received = () => Buffer.from(server.state.shellData.slice(mark).join(''), 'binary').toString('utf8');
  const terminalPoint = await t.js(`(() => { const r = document.querySelector('.terminal-instance.active .xterm-screen').getBoundingClientRect();
    return { x: Math.round(r.left + 60), y: Math.round(r.top + 60) }; })()`);

  const paste = async (text, how) => {
    clipboard.writeText(text);
    mark = server.state.shellData.length;
    if (how === 'keys') {
      await t.focus('.terminal-instance.active .xterm-helper-textarea');
      await t.press('V', ['control', 'shift']);
    } else {
      await t.clickAt(terminalPoint.x, terminalPoint.y, 'right');
    }
  };
  const arrives = (expected) => waitFor(() => received() === expected, 3000);

  await paste('echo one\necho two', 'right-click');
  check('without bracketed paste, lines arrive with Enter between them',
    await arrives('echo one\recho two'), visible(received()));

  shell.write(BRACKET_ON);
  await t.sleep(300);

  await paste('echo one\necho two', 'right-click');
  check('with bracketed paste on, a multi-line paste arrives as one marked block',
    await arrives(`${PASTE_START}echo one\recho two${PASTE_END}`), visible(received()));

  await paste('echo three\necho four', 'keys');
  check('Ctrl+Shift+V pastes the same way',
    await arrives(`${PASTE_START}echo three\recho four${PASTE_END}`), visible(received()));

  // Long enough to cross the old 2048-character chunk boundary mid-emoji
  const long = `x${'😀'.repeat(1500)}`;
  await paste(long, 'right-click');
  check('a long paste of emoji arrives intact', await arrives(`${PASTE_START}${long}${PASTE_END}`),
    { length: received().length, replacementChars: (received().match(/�/g) || []).length });

  await server.close();
}
