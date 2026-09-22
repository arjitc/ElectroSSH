'use strict';

// The sidebar shows the version from package.json, so a release only needs
// the bump there.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadMain, PROJECT_ROOT } = require('../helpers/main-harness');

const app = loadMain();
after(() => app.cleanup());

test('app-version reports the version in package.json', async () => {
  const { version } = require(path.join(PROJECT_ROOT, 'package.json'));
  assert.equal(await app.invoke('app-version'), version);
});

test('app-info gives Settings > About the version, the project address and runtime versions', async () => {
  const { version } = require(path.join(PROJECT_ROOT, 'package.json'));
  const info = await app.invoke('app-info');
  assert.equal(info.version, version);
  assert.equal(info.repoUrl, 'https://github.com/arjitc/ElectroSSH');
  // This harness runs main.js under plain Node, where the electron and chrome
  // versions don't exist; about.e2e.js checks the real ones inside Electron
  for (const field of ['electron', 'chrome', 'node']) {
    assert.equal(info[field], process.versions[field], field);
  }
  // The name people know, not Node's "Windows_NT" or "Darwin"
  const expectedName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform];
  if (expectedName) assert.ok(info.os.startsWith(`${expectedName} `), info.os);
  assert.ok(info.os.endsWith(`(${process.arch})`), info.os);
});
