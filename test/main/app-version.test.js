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
