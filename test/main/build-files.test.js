'use strict';

// The installer packs only the files listed in package.json's build.files,
// plus package.json and the production dependencies (electron-builder adds
// those itself). A file the app loads but the list leaves out works under
// `npm start` and every other test, and is missing only from the installed
// app, so these checks read what the app loads and compare.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const patterns = pkg.build.files;
const packed = patterns.filter((p) => !p.startsWith('!'));
// Extensions dropped from node_modules, from patterns like "!**/node_modules/**/*.{md,map}"
const droppedExtensions = new Set(patterns
  .filter((p) => p.startsWith('!**/node_modules/'))
  .flatMap((p) => {
    const m = p.match(/\*\.\{([^}]+)\}$/) || p.match(/\*\.(\w+)$/);
    return m ? m[1].split(',') : [];
  }));

// What index.html loads: its <script src> and <link href>, split into the
// project's own files and files from node_modules
const pageFiles = [...read('index.html').matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
const ownPageFiles = pageFiles.filter((f) => !f.startsWith('node_modules/'));
const modulePageFiles = pageFiles.filter((f) => f.startsWith('node_modules/'));

test('the list names only files that exist', () => {
  packed.forEach((file) => assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed but doesn't exist`));
});

test('the main process files are packed', () => {
  const main = read('main.js');
  const loaded = [
    pkg.main,
    ...[...main.matchAll(/path\.join\(__dirname, '([^']+)'\)/g)].map((m) => m[1]),
    ...[...main.matchAll(/loadFile\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...main.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]).filter((f) => f !== 'package.json')
  ];
  assert.deepEqual(loaded.filter((f) => !packed.includes(f)), [], 'loaded by main.js but not packed');
  assert.ok(loaded.includes('preload.js') && loaded.includes('index.html'), `found: ${loaded}`);
});

test('the page\'s own scripts and styles are packed', () => {
  assert.ok(ownPageFiles.includes('renderer.js') && ownPageFiles.includes('styles.css'), `found: ${ownPageFiles}`);
  assert.deepEqual(ownPageFiles.filter((f) => !packed.includes(f)), [], 'loaded by index.html but not packed');
});

test('what the page loads from node_modules comes from production dependencies', () => {
  assert.ok(modulePageFiles.length >= 6, `found: ${modulePageFiles}`); // xterm, its CSS and four addons
  const dependencies = Object.keys(pkg.dependencies);
  modulePageFiles.forEach((file) => {
    const [, first, second] = file.split('/');
    const name = first.startsWith('@') ? `${first}/${second}` : first;
    assert.ok(dependencies.includes(name), `${file} is from ${name}, which isn't in dependencies, so it isn't packed`);
  });
});

test('and isn\'t a kind of file the list drops from node_modules', () => {
  assert.ok(droppedExtensions.has('map') && droppedExtensions.has('md'), `parsed: ${[...droppedExtensions]}`);
  modulePageFiles.forEach((file) => {
    assert.ok(!droppedExtensions.has(path.extname(file).slice(1)), `${file} would be dropped`);
  });
});

test('development files stay out', () => {
  ['CLAUDE.md', 'README.md', 'docs', 'test', 'dist'].forEach((file) => {
    assert.ok(!packed.some((p) => p === file || p.startsWith(`${file}/`) || p.startsWith('**')),
      `${file} would be packed`);
  });
});
