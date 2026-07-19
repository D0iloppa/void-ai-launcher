'use strict';

// lib/selfUpdate.js — git 기반 자체 업데이트 코어.
//
// 모든 공개 함수는 fail-open 이다: 어떤 오류·타임아웃이 나도 예외를 던지지
// 않고 무해한 결과 객체를 반환한다 — bootstrap.js(시작 시 업데이트 프롬프트)
// 와 launcher.js(설정 메뉴의 수동 업데이트)가 이 모듈을 그대로 신뢰하고
// 호출하므로, 이 모듈이 깨져도 void 실행 자체를 절대 막아서는 안 된다.
//
// dirty checkout(커밋되지 않은 변경 있음)에는 절대 pull 하지 않으며,
// hard-reset/force 옵션은 어디에도 쓰지 않는다 — `git pull --ff-only` 만 사용.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 이 파일 기준 repo root (lib/ 의 부모). 실사용 경로는 항상 이 값을 쓰고,
// 테스트에서만 checkUpdate/applyUpdate 에 { repoRoot } 오버라이드를 넘겨
// 격리된 임시 git repo 를 대상으로 검증한다(진짜 repo 의 git 상태는 절대 건드리지 않음).
const REAL_REPO_ROOT = path.join(__dirname, '..');

const GIT_TIMEOUT_MS = 8000;    // fetch/조회용 — 네트워크 지연으로 launch 를 막지 않도록 짧게
const PULL_TIMEOUT_MS = 30000;  // pull 은 fetch 보다 오래 걸릴 수 있어 여유를 둠
const NPM_TIMEOUT_MS = 120000;  // package-lock.json 변경 시의 npm install

function hasGitDir(repoRoot) {
  try { return fs.existsSync(path.join(repoRoot, '.git')); }
  catch { return false; }
}

// spawnSync('git', ...) 얇은 래퍼 — cmd_generator.js 의 기존 spawnSync 관례
// (cwd/encoding 지정)를 그대로 따른다. 실패/타임아웃/바이너리 부재 모두 예외를
// 던지지 않고 {ok:false} 로 정규화한다.
function runGit(repoRoot, args, timeout = GIT_TIMEOUT_MS) {
  try {
    const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout });
    if (res.error || res.status !== 0) {
      return {
        ok: false,
        stdout: res.stdout || '',
        stderr: (res.stderr || '') + (res.error ? String(res.error.message || res.error) : ''),
      };
    }
    return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String((e && e.message) || e) };
  }
}

function isClean(repoRoot) {
  const r = runGit(repoRoot, ['status', '--porcelain']);
  return r.ok && r.stdout.trim().length === 0;
}

function headSha(repoRoot) {
  const r = runGit(repoRoot, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

function upstreamSha(repoRoot) {
  const r = runGit(repoRoot, ['rev-parse', '@{u}']);
  return r.ok ? r.stdout.trim() : null;
}

// HEAD..@{u} 뒤처짐 커밋 수 파싱 — 순수 함수로 분리해 네트워크/git 없이
// 테스트할 수 있게 한다 (`git rev-list --count ...` 의 stdout 문자열만 필요).
function parseBehindCount(revListStdout) {
  const n = parseInt(String(revListStdout || '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// package-lock.json 이 두 커밋 사이 diff 에 포함되는지 — 순수 함수(테스트 가능).
// `git diff --name-only <a> <b>` 의 stdout 문자열만 필요.
function diffTouchesPackageLock(diffNameOnlyStdout) {
  return String(diffNameOnlyStdout || '')
    .split('\n')
    .map(l => l.trim())
    .includes('package-lock.json');
}

// checkUpdate(): git fetch 후 behind-count/clean/sha 를 확인한다.
// upstream 이 없거나(로컬 전용 브랜치) detached HEAD/ambiguous 인 경우는 에러가
// 아니라 "확인 대상 아님" 으로 취급한다 ({behind:0, reason:'no-upstream'}) —
// 절대 예외를 던지거나 실패로 보고하지 않는다.
function checkUpdate({ repoRoot = REAL_REPO_ROOT } = {}) {
  const benign = { available: false, behind: 0, clean: true, sha: null, upstreamSha: null, reason: 'not-a-repo' };
  try {
    if (!hasGitDir(repoRoot)) return benign;

    // fetch 실패(오프라인 등)는 치명적이지 않음 — 로컬에 이미 있는 정보로 계속 진행.
    runGit(repoRoot, ['fetch'], GIT_TIMEOUT_MS);

    const clean = isClean(repoRoot);
    const sha = headSha(repoRoot);

    const upstream = runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream.ok) {
      // upstream 미설정 / detached HEAD / ambiguous ref — 스킵, 에러 아님.
      return { available: true, behind: 0, clean, sha, upstreamSha: null, reason: 'no-upstream' };
    }

    const uSha = upstreamSha(repoRoot);
    const revList = runGit(repoRoot, ['rev-list', '--count', 'HEAD..@{u}']);
    if (!revList.ok) {
      return { available: true, behind: 0, clean, sha, upstreamSha: uSha, reason: 'rev-list-failed' };
    }

    const behind = parseBehindCount(revList.stdout);
    return { available: true, behind, clean, sha, upstreamSha: uSha, reason: null };
  } catch {
    return benign;
  }
}

// peersAlive(): 다른 void 프로세스가 몇 개 실행 중인지 — messaging/registry.js
// 를 재사용한다. require 실패/조회 실패는 0으로 degrade(확인 불가 = 실행 중인
// 프로세스 없음으로 취급해도 안전한 쪽 — git pull --ff-only 자체는 워킹 트리를
// 손상시키지 않으므로 최악의 경우도 조용히 업데이트가 진행되는 정도).
function peersAlive() {
  try {
    const { listPeers } = require('./messaging/registry');
    return listPeers({ includeSelf: false }).length;
  } catch {
    return 0;
  }
}

// applyUpdate(): dirty 면 거부, 그 외엔 --ff-only 로만 pull(hard-reset/force 없음).
// package-lock.json 이 pull 로 변경됐으면 npm install 을 시도하되, 그 실패는
// fail-open 으로 삼는다 — pull 자체는 이미 끝난 상태라 재기동은 여전히 안전하다.
function applyUpdate({ repoRoot = REAL_REPO_ROOT } = {}) {
  try {
    if (!hasGitDir(repoRoot)) return { ok: false, reason: 'not-a-repo' };
    if (!isClean(repoRoot)) return { ok: false, reason: 'dirty' };

    const beforeSha = headSha(repoRoot);

    const pull = runGit(repoRoot, ['pull', '--ff-only'], PULL_TIMEOUT_MS);
    if (!pull.ok) return { ok: false, reason: 'pull-failed', error: pull.stderr };

    const afterSha = headSha(repoRoot);
    let npmFailed = false;

    if (beforeSha && afterSha && beforeSha !== afterSha) {
      const diff = runGit(repoRoot, ['diff', '--name-only', beforeSha, afterSha]);
      if (diff.ok && diffTouchesPackageLock(diff.stdout)) {
        try {
          const isWin = process.platform === 'win32';
          const res = isWin
            ? spawnSync('cmd', ['/c', 'npm', 'install'], { cwd: repoRoot, encoding: 'utf8', timeout: NPM_TIMEOUT_MS })
            : spawnSync('npm', ['install'], { cwd: repoRoot, encoding: 'utf8', timeout: NPM_TIMEOUT_MS });
          if (res.error || res.status !== 0) npmFailed = true;
        } catch {
          npmFailed = true;
        }
      }
    }

    return { ok: true, reason: 'updated', sha: afterSha, npmFailed };
  } catch (e) {
    return { ok: false, reason: 'error', error: String((e && e.message) || e) };
  }
}

module.exports = {
  repoRoot: REAL_REPO_ROOT,
  hasGitDir,
  checkUpdate,
  peersAlive,
  applyUpdate,
  // 순수 파싱 로직 — 네트워크/git 없이 테스트 가능
  parseBehindCount,
  diffTouchesPackageLock,
};
