'use strict';

// 'open-external' opens links clicked in terminal output. That text is written
// by the remote host, so only http/https may reach shell.openExternal, which
// would otherwise launch any registered protocol handler.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('../helpers/main-harness');

const opened = [];
const app = loadMain({ shell: { openExternal: async (url) => { opened.push(url); } } });
after(() => app.cleanup());

const cases = [
  // [input, should open, label]
  ['https://example.com/docs?q=1', true, 'https URL'],
  ['http://10.0.0.5:8080/status', true, 'http URL with a port'],
  ['HTTPS://EXAMPLE.COM/', true, 'upper-case scheme'],
  ['file:///C:/Windows/System32/calc.exe', false, 'file: URL'],
  ['ms-msdt:/id PCWDiagnostic /skip force', false, 'ms-msdt: (Follina)'],
  ['search-ms:query=x&crumb=location:\\\\attacker\\share', false, 'search-ms:'],
  ['javascript:alert(1)', false, 'javascript:'],
  ['vbscript:msgbox(1)', false, 'vbscript:'],
  ['\\\\attacker\\share\\payload.exe', false, 'UNC path'],
  ['ftp://files.example.com', false, 'ftp:'],
  ['mailto:someone@example.com', false, 'mailto:'],
  ['not a url', false, 'plain text'],
  [{ toString: () => 'https://sneaky.example' }, false, 'object that stringifies to https'],
  ['https://x/' + 'a'.repeat(5000), false, 'absurdly long URL']
];

for (const [url, shouldOpen, label] of cases) {
  test(`${shouldOpen ? 'opens' : 'refuses'} ${label}`, async () => {
    const before = opened.length;
    const result = await app.invoke('open-external', url);
    assert.equal(result.ok, shouldOpen);
    assert.equal(opened.length - before, shouldOpen ? 1 : 0, 'shell.openExternal call count');
  });
}
