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

// WSL/DrvFs 환경 (예: /mnt/c/... 로 마운트된 저장소)에서 실행 중인 void/launcher
// 프로세스가 better-sqlite3의 네이티브 .node 바이너리를 mmap으로 열고 있으면,
// npm의 arborist가 reify 도중 better-sqlite3를 rename하려다 EACCES로 실패한다
// (권한이 0777이어도 실패함 — DrvFs 특성이지 dJinn/sqlite-vec 결함이 아니며,
// sqlite-vec만 단독 설치해도 재현된다). 이 신호를 감지해서 안내 메시지를 띄운다.
function isBetterSqlite3RenameEacces(text) {
  return /EACCES/.test(text) && (/better-sqlite3/.test(text) || /rename/i.test(text));
}

function npmInstallOnce(tgzPath) {
  // stdout은 그대로 inherit해서 npm 진행 로그를 실시간으로 보여주고, stderr만
  // pipe로 받아 실패 시 원인 텍스트를 검사할 수 있게 한다 (성공 시에는 execSync가
  // 캡처된 stderr에 접근할 방법을 주지 않으므로 실패 시에만 그대로 재출력한다).
  execSync(`npm install ${JSON.stringify(tgzPath)} --no-save --no-audit --no-fund`, {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'pipe'],
  });
}

function installTgz(tgzPath) {
  log(`installing @d0iloppa/djinn from ${path.relative(ROOT, tgzPath)} ...`);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      npmInstallOnce(tgzPath);
      log('@d0iloppa/djinn installed.');
      return;
    } catch (e) {
      const stderrText = e && e.stderr ? e.stderr.toString() : '';
      if (stderrText) process.stderr.write(stderrText);

      if (!isBetterSqlite3RenameEacces(`${(e && e.message) || ''}\n${stderrText}`)) {
        throw e; // unrelated failure — propagate as-is, no special handling
      }

      if (attempt === 1) {
        // A running void/launcher process can transiently hold the lock;
        // one short retry is cheap and sometimes enough on its own.
        log('npm install hit an EACCES rename error — this can be a transient lock; retrying once...');
        try {
          execSync(process.platform === 'win32' ? 'ping -n 2 127.0.0.1 >NUL' : 'sleep 1', { stdio: 'ignore' });
        } catch {
          /* best-effort delay only, ignore failures */
        }
        continue;
      }

      err('npm install failed again with an EACCES error while renaming better-sqlite3.');
      err('Likely cause: a running `void`/launcher process (or another node process using this repo) still has the native SQLite binary (better-sqlite3\'s .node file) memory-mapped open.');
      err('On WSL, when this repo is on a Windows drive mounted via DrvFs (e.g. /mnt/c/...), renaming a file/directory that is mmap-open elsewhere fails with EACCES even though permissions are 0777 — this is a DrvFs limitation, not a dJinn/sqlite-vec defect (it reproduces installing sqlite-vec alone).');
      err('Fix: close all running `void` sessions (and any other node process with this repo open), then re-run the install.');
      throw e;
    }
  }
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
