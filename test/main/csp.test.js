'use strict';

// The Content-Security-Policy in index.html, read as text. csp.e2e.js checks
// what it blocks in the running page; these catch what that can't: a policy
// placed after the scripts it's meant to cover (a <meta> policy only applies
// to what follows it), and one loosened to let scripts come from elsewhere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*>/);
const directives = meta
  ? Object.fromEntries(meta[1].split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name, values]))
  : {};

test('index.html has a Content-Security-Policy', () => {
  assert.ok(meta, 'no <meta http-equiv="Content-Security-Policy"> found');
});

test('it comes before every stylesheet and script', () => {
  const at = html.indexOf(meta[0]);
  const firstResource = html.search(/<(link|script)\b/);
  assert.ok(firstResource > at, 'a stylesheet or script comes before the policy, so the policy does not cover it');
});

test('anything not allowed is refused', () => {
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
});

test('scripts come only from the app\'s own files: no inline code, no eval, no other hosts', () => {
  assert.deepEqual(directives['script-src'], ["'self'"]);
});

test('styles may be inline (xterm injects <style> elements) but come from no other host', () => {
  assert.deepEqual(directives['style-src'], ["'self'", "'unsafe-inline'"]);
});
