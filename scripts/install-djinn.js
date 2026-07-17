#!/usr/bin/env node
// VOID//ai-launcher — mandatory dJinn (@d0iloppa/djinn) install helper.
// Runs as the project's `preinstall` script (see package.json). @d0iloppa/djinn
// and its transitive better-sqlite3 native dependency are MANDATORY — this
// script installs them imperatively (npm cannot resolve a `file:` dependency
// pointing at a tgz that doesn't exist yet, and that path is created by this
// very script on the fallback branch — resolving before preinstall runs is
// npm's normal dependency-tree order, which is why @d0iloppa/djinn is
// deliberately NOT listed in package.json dependencies at all).
//
// Behavior:
//   1. Fast path: @d0iloppa/djinn already present in node_modules → skip, exit 0.
//   2. Common path: a committed vendor/d0iloppa-djinn-*.tgz exists → install it.
//   3. Fallback: no tgz → pull the vendor/dJinn git submodule (shallow), build
//      a fresh tgz via `npm pack`, then install that.
//   4. Any failure anywhere in 2/3 → nonzero exit, which aborts the outer
//      `npm install` (preinstall failure fails the whole lifecycle). No silent
//      degradation at install time — see lib/usageDb.js for why the module
//      still keeps a defensive require() try/catch for runtime-only failures
//      (e.g. Node ABI mismatch after a Node upgrade), which is unrelated to
//      this install-time guarantee.
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DJINN_SUBMODULE = path.join(VENDOR_DIR, 'dJinn');

const log = msg => console.log(`[install-djinn] ${msg}`);
const err = msg => console.error(`[install-djinn] ${msg}`);

// Mirrors cmd_generator.js's packageInstalled(): check node_modules directly
// rather than require.resolve, since some packages ship restrictive "exports"
// maps that make require.resolve throw even when the package is installed.
function packageInstalled(name) {
  try {
    return fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'));
  } catch {
    return false;
  }
}

function findCommittedTgz() {
  let entries;
  try {
    entries = fs.readdirSync(VENDOR_DIR);
  } catch {
    return null;
  }
  const match = entries.find(f => /^d0iloppa-djinn-.*\.tgz$/.test(f));
  return match ? path.join(VENDOR_DIR, match) : null;
}

function installTgz(tgzPath) {
  log(`installing @d0iloppa/djinn from ${path.relative(ROOT, tgzPath)} ...`);
  execSync(`npm install ${JSON.stringify(tgzPath)} --no-save --no-audit --no-fund`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  log('@d0iloppa/djinn installed.');
}

function buildTgzFromSubmodule() {
  log('no committed vendor/d0iloppa-djinn-*.tgz found — falling back to git submodule build.');
  log('fetching vendor/dJinn submodule (shallow)...');
  execSync('git submodule update --init --depth 1 vendor/dJinn', { cwd: ROOT, stdio: 'inherit' });

  log('building tgz via npm pack...');
  execSync('npm pack --pack-destination ..', { cwd: DJINN_SUBMODULE, stdio: 'inherit' });

  const tgzPath = findCommittedTgz();
  if (!tgzPath) {
    throw new Error('npm pack completed but no vendor/d0iloppa-djinn-*.tgz was found afterward.');
  }
  return tgzPath;
}

function main() {
  if (packageInstalled('@d0iloppa/djinn')) {
    log('@d0iloppa/djinn already present in node_modules — skipping.');
    return;
  }

  const existingTgz = findCommittedTgz();
  const tgzPath = existingTgz || buildTgzFromSubmodule();
  installTgz(tgzPath);
}

try {
  main();
} catch (e) {
  err(`FAILED: ${e && e.message ? e.message : e}`);
  err('@d0iloppa/djinn (and its mandatory better-sqlite3 dependency) could not be installed.');
  process.exit(1);
}
