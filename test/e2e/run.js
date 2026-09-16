'use strict';

// Runs each test/e2e/*.e2e.js in its own Electron process and reports the
// results. The real app window opens briefly for each file.
//
//   npm run test:e2e                              all files
//   node test/e2e/run.js test/e2e/tab-close.e2e.js  one file

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electronBinary = require('electron'); // resolves to the executable under Node

const TIMEOUT_MS = 150000;

// One parent directory for every file's throwaway app data, removed at the
// end: a file can't delete its own while Chromium still holds it open.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electrossh-e2e-run-'));

const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => path.resolve(f))
  : fs.readdirSync(__dirname).filter((f) => f.endsWith('.e2e.js')).sort().map((f) => path.join(__dirname, f));

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(electronBinary, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTROSSH_E2E_DATA: dataRoot }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter((l) => /^(ok|not ok) \d+ - |^ {2}# /.test(l));
      resolve({ file, code, lines, stderr, timedOut: code === null });
    });
  });
}

(async () => {
  let failedFiles = 0;
  let checks = 0;
  for (const file of files) {
    const name = path.relative(process.cwd(), file);
    let r = await runFile(file);

    // Electron's main process can freeze for minutes while Windows deals with
    // a crashed renderer, which looks exactly like a hung test. A file that
    // ran out of time without failing a check gets one more go.
    const stalled = r.timedOut && !r.lines.some((l) => l.startsWith('not ok'));
    if (stalled) r = await runFile(file);

    const failures = r.lines.filter((l) => l.startsWith('not ok'));
    checks += r.lines.filter((l) => /^(ok|not ok) /.test(l)).length;
    const passed = r.code === 0 && failures.length === 0 && r.lines.length > 0;
    if (!passed) failedFiles++;

    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${stalled ? '  (first attempt stalled, re-run)' : ''}`);
    r.lines.forEach((l) => console.log(`      ${l}`));
    if (r.timedOut) console.log(`      # timed out after ${TIMEOUT_MS / 1000}s`);
    else if (!passed && r.lines.length === 0) console.log('      # no results reported');
    if (!passed && (r.timedOut || r.lines.length === 0)) console.log(r.stderr.split(/\r?\n/).slice(-15).join('\n'));
  }
  console.log(`\n${files.length - failedFiles}/${files.length} files passed, ${checks} checks`);
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log(`(could not remove ${dataRoot}: ${e.code})`);
  }
  process.exit(failedFiles ? 1 : 0);
})();
