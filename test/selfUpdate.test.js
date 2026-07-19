'use strict';

/*
 * lib/selfUpdate.js 유닛/통합 테스트.
 *
 * checkUpdate()/applyUpdate() 는 실제 이 repo(void-ai-launcher)의 git 상태를
 * 절대 건드리지 않는다 — 두 함수 모두 { repoRoot } 오버라이드를 받으므로,
 * 여기서는 os.tmpdir() 아래에 만든 격리된 임시 git repo(들)만 대상으로
 * 호출한다. 네트워크도 전혀 쓰지 않는다 — "origin" 역할은 로컬 bare repo가,
 * push 는 별도로 clone 한 "committer" 워킹카피가 담당한다.
 *
 * 순수 파싱 로직(parseBehindCount/diffTouchesPackageLock)은 git 자체 없이도
 * 검증 가능하도록 별도 함수로 분리되어 있다 — 문서화된 설계 의도 그대로,
 * 네트워크/외부 git 출력 형식 변화에 흔들리지 않는 회귀 테스트로 둔다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const selfUpdate = require('../lib/selfUpdate');

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 새 git repo 초기화 + 테스트 전용 로컬(전역이 아님) identity 설정 + 초기 커밋.
function initRepo(dir, { fileName = 'a.txt', content = 'hello\n' } = {}) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'selfupdate-test@example.com']);
  git(dir, ['config', 'user.name', 'SelfUpdate Test']);
  fs.writeFileSync(path.join(dir, fileName), content);
  git(dir, ['add', fileName]);
  git(dir, ['commit', '-q', '-m', 'init']);
}

const cleanupDirs = [];
test.after(() => {
  for (const dir of cleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
function track(dir) { cleanupDirs.push(dir); return dir; }

// ── 순수 파싱 로직 ──────────────────────────────────────────────────────────

test('parseBehindCount parses a plain rev-list --count output', () => {
  assert.equal(selfUpdate.parseBehindCount('0\n'), 0);
  assert.equal(selfUpdate.parseBehindCount('3\n'), 3);
  assert.equal(selfUpdate.parseBehindCount('  12  '), 12);
});

test('parseBehindCount fails open (0) on empty/garbage input', () => {
  assert.equal(selfUpdate.parseBehindCount(''), 0);
  assert.equal(selfUpdate.parseBehindCount(undefined), 0);
  assert.equal(selfUpdate.parseBehindCount('not-a-number'), 0);
  assert.equal(selfUpdate.parseBehindCount('-5'), 0); // 음수는 무의미 — 0으로 정규화
});

test('diffTouchesPackageLock detects package-lock.json among changed files', () => {
  assert.equal(selfUpdate.diffTouchesPackageLock('lib/foo.js\npackage-lock.json\nREADME.md\n'), true);
  assert.equal(selfUpdate.diffTouchesPackageLock('lib/foo.js\nREADME.md\n'), false);
  assert.equal(selfUpdate.diffTouchesPackageLock(''), false);
  assert.equal(selfUpdate.diffTouchesPackageLock(undefined), false);
});

test('diffTouchesPackageLock does not false-positive on similar paths', () => {
  // 정확히 저장소 루트의 package-lock.json 만 매치 — 하위 디렉토리나 유사 이름은 아님.
  assert.equal(selfUpdate.diffTouchesPackageLock('sub/package-lock.json\n'), false);
  assert.equal(selfUpdate.diffTouchesPackageLock('package-lock.json.bak\n'), false);
});

// ── hasGitDir ───────────────────────────────────────────────────────────────

test('hasGitDir is false for a plain directory with no .git', () => {
  const dir = track(mkTmpDir('void-selfupdate-nogit-'));
  assert.equal(selfUpdate.hasGitDir(dir), false);
});

// ── checkUpdate: not a repo ──────────────────────────────────────────────────

test('checkUpdate fails open with available:false when repoRoot has no .git', () => {
  const dir = track(mkTmpDir('void-selfupdate-nogit2-'));
  const result = selfUpdate.checkUpdate({ repoRoot: dir });
  assert.deepEqual(result, {
    available: false, behind: 0, clean: true, sha: null, upstreamSha: null, reason: 'not-a-repo',
  });
});

// ── checkUpdate: no upstream (local-only branch) ────────────────────────────

test('checkUpdate treats a repo with no upstream as behind:0, reason:no-upstream (not an error)', () => {
  const dir = track(mkTmpDir('void-selfupdate-noupstream-'));
  initRepo(dir);

  const result = selfUpdate.checkUpdate({ repoRoot: dir });
  assert.equal(result.available, true);
  assert.equal(result.behind, 0);
  assert.equal(result.reason, 'no-upstream');
  assert.equal(result.clean, true);
  assert.equal(result.upstreamSha, null);
  assert.equal(typeof result.sha, 'string');
});

// ── applyUpdate: dirty checkout → refuse ────────────────────────────────────

test('applyUpdate refuses (ok:false, reason:dirty) when the working tree has uncommitted changes', () => {
  const dir = track(mkTmpDir('void-selfupdate-dirty-'));
  initRepo(dir);
  // 커밋하지 않은 수정 — untracked 파일도 아니고 tracked 파일의 변경으로 만든다.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'modified but not committed\n');

  const result = selfUpdate.applyUpdate({ repoRoot: dir });
  assert.deepEqual(result, { ok: false, reason: 'dirty' });
});

test('applyUpdate refuses (ok:false, reason:not-a-repo) when repoRoot has no .git', () => {
  const dir = track(mkTmpDir('void-selfupdate-notrepo-'));
  const result = selfUpdate.applyUpdate({ repoRoot: dir });
  assert.deepEqual(result, { ok: false, reason: 'not-a-repo' });
});

// ── checkUpdate/applyUpdate: real behind-count + ff-only pull, fully offline ─
//
// "origin" 은 로컬 bare repo. "committer" 는 origin 에 push 하는 용도의 별도
// 워킹카피(같은 워킹트리에 직접 push 하면 checked-out 브랜치 갱신 문제가 있어
// 피한다). "worker" 는 테스트 대상 — origin 을 clone 해 자동으로 업스트림
// 트래킹이 설정된 상태에서 시작한다.

function setupOriginCommitterWorker() {
  const originDir = track(mkTmpDir('void-selfupdate-origin-'));
  git(originDir, ['init', '--bare', '-q']);

  const committerDir = track(mkTmpDir('void-selfupdate-committer-'));
  git(path.dirname(committerDir), ['clone', '-q', originDir, committerDir]);
  git(committerDir, ['config', 'user.email', 'selfupdate-test@example.com']);
  git(committerDir, ['config', 'user.name', 'SelfUpdate Test']);
  fs.writeFileSync(path.join(committerDir, 'a.txt'), 'v1\n');
  git(committerDir, ['add', 'a.txt']);
  git(committerDir, ['commit', '-q', '-m', 'v1']);
  const branch = git(committerDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(committerDir, ['push', '-q', 'origin', branch]);

  const workerDir = track(mkTmpDir('void-selfupdate-worker-'));
  git(path.dirname(workerDir), ['clone', '-q', originDir, workerDir]);
  git(workerDir, ['config', 'user.email', 'selfupdate-test@example.com']);
  git(workerDir, ['config', 'user.name', 'SelfUpdate Test']);

  return { originDir, committerDir, workerDir, branch };
}

test('checkUpdate reports behind:0 right after clone, then behind:1 after a new upstream commit', () => {
  const { committerDir, workerDir, branch } = setupOriginCommitterWorker();

  const fresh = selfUpdate.checkUpdate({ repoRoot: workerDir });
  assert.equal(fresh.available, true);
  assert.equal(fresh.reason, null);
  assert.equal(fresh.behind, 0);
  assert.equal(fresh.clean, true);

  // committer 가 새 커밋을 origin 에 push
  fs.writeFileSync(path.join(committerDir, 'a.txt'), 'v2\n');
  git(committerDir, ['add', 'a.txt']);
  git(committerDir, ['commit', '-q', '-m', 'v2']);
  git(committerDir, ['push', '-q', 'origin', branch]);

  const behind = selfUpdate.checkUpdate({ repoRoot: workerDir });
  assert.equal(behind.available, true);
  assert.equal(behind.reason, null);
  assert.equal(behind.behind, 1);
  assert.equal(behind.clean, true);
  assert.notEqual(behind.upstreamSha, behind.sha);
});

test('applyUpdate fast-forwards a clean, behind worker repo and never touches npm when package-lock.json is untouched', () => {
  const { committerDir, workerDir, branch } = setupOriginCommitterWorker();

  fs.writeFileSync(path.join(committerDir, 'a.txt'), 'v2\n');
  git(committerDir, ['add', 'a.txt']);
  git(committerDir, ['commit', '-q', '-m', 'v2']);
  git(committerDir, ['push', '-q', 'origin', branch]);

  const beforeSha = git(workerDir, ['rev-parse', 'HEAD']).trim();
  const result = selfUpdate.applyUpdate({ repoRoot: workerDir });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'updated');
  assert.equal(result.npmFailed, false);
  assert.notEqual(result.sha, beforeSha);
  assert.equal(fs.readFileSync(path.join(workerDir, 'a.txt'), 'utf8'), 'v2\n');

  // 이미 최신이 된 뒤 다시 확인하면 behind:0
  const after = selfUpdate.checkUpdate({ repoRoot: workerDir });
  assert.equal(after.behind, 0);
});

// ── peersAlive ───────────────────────────────────────────────────────────────

test('peersAlive never throws and returns a number (fail-open even if registry lookup misbehaves)', () => {
  const n = selfUpdate.peersAlive();
  assert.equal(typeof n, 'number');
  assert.ok(n >= 0);
});
