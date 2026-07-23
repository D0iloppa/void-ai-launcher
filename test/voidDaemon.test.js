'use strict';

/*
 * lib/voidDaemon.js 유닛 테스트 — voidemon(상주 싱글턴 데몬)의 순수 로직만 검증한다.
 *
 * 실제 파일시스템/시그널/프로세스 스폰을 절대 건드리지 않는다 — acquireSingleton/
 * releaseSingleton 은 fsImpl(가짜 fs 구현)과 killFn(가짜 liveness 체크)을 주입해서
 * 테스트하고(lib/sync.js 의 override seam 패턴과 동일), runLoop 은 workerFn/sleepFn 을
 * 주입해 실제 lib/voidNotify.js 나 진짜 setTimeout 대기 없이 즉시 끝나게 한다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 테스트 저장소 격리(voidNotify.test.js 와 동일 취지): pidFilePath() 등이 실제
// ~/.config/void-launcher/ 를 건드리지 않도록, require 전에 XDG_CONFIG_HOME 을 임시 디렉토리로
// 돌린다. storageDir()(lib/storage.js)는 XDG_CONFIG_HOME 을 최우선 후보로 쓰고 캐시하지 않는다.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'void-daemon-test-'));

const voidDaemon = require('../lib/voidDaemon');

// ── 가짜 fs — pidfile 하나만 다루면 되므로 Map 백킹의 최소 구현 ──────────────────────────
function makeFakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));

  function notFound(p) {
    const err = new Error(`ENOENT: no such file, ${p}`);
    err.code = 'ENOENT';
    return err;
  }

  return {
    files, // 테스트 어서션용으로 직접 들여다볼 수 있게 노출
    openSync(p, flags) {
      if (flags === 'wx') {
        if (files.has(p)) {
          const err = new Error(`EEXIST: file already exists, ${p}`);
          err.code = 'EEXIST';
          throw err;
        }
        files.set(p, '');
        return p; // fd 대용으로 경로 문자열 자체를 씀 — writeSync/closeSync 에서만 쓰임
      }
      if (flags === 'a') {
        if (!files.has(p)) files.set(p, '');
        return p;
      }
      throw notFound(p);
    },
    writeSync(fd, data) {
      files.set(fd, (files.get(fd) || '') + data);
    },
    closeSync() {},
    readFileSync(p) {
      if (!files.has(p)) throw notFound(p);
      return files.get(p);
    },
    unlinkSync(p) {
      if (!files.has(p)) throw notFound(p);
      files.delete(p);
    },
  };
}

function aliveKillFn() {
  // process.kill(pid, 0) 이 살아있으면 그냥 리턴(no throw)
  return true;
}

function deadKillFn() {
  const err = new Error('kill ESRCH');
  err.code = 'ESRCH';
  throw err;
}

const PIDFILE = '/fake/voidemon.pid';

// ── acquireSingleton / releaseSingleton ─────────────────────────────────────────────────

test('acquireSingleton: succeeds when no pidfile exists', () => {
  const fsImpl = makeFakeFs();
  const result = voidDaemon.acquireSingleton({ pidFile: PIDFILE, fsImpl, killFn: aliveKillFn, pid: 111 });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 111);
  assert.equal(fsImpl.files.get(PIDFILE), '111');
});

test('acquireSingleton: second acquire while first is held (live pid) is refused', () => {
  const fsImpl = makeFakeFs({ [PIDFILE]: '111' });
  const result = voidDaemon.acquireSingleton({ pidFile: PIDFILE, fsImpl, killFn: aliveKillFn, pid: 222 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'running');
  assert.equal(result.pid, 111);
  // 실행 중인 소유자의 pidfile 은 손대지 않는다
  assert.equal(fsImpl.files.get(PIDFILE), '111');
});

test('acquireSingleton: a stale pidfile (dead pid) is reclaimed and acquisition succeeds', () => {
  const fsImpl = makeFakeFs({ [PIDFILE]: '999' });
  const result = voidDaemon.acquireSingleton({ pidFile: PIDFILE, fsImpl, killFn: deadKillFn, pid: 333 });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 333);
  assert.equal(fsImpl.files.get(PIDFILE), '333');
});

test('isAlive: ESRCH from killFn means dead, EPERM means alive, other errors propagate as dead', () => {
  assert.equal(voidDaemon.isAlive(123, aliveKillFn), true);
  assert.equal(voidDaemon.isAlive(123, deadKillFn), false);
  assert.equal(voidDaemon.isAlive(null, aliveKillFn), false);
  assert.equal(voidDaemon.isAlive(123, () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; }), true);
});

test('releaseSingleton: removes the pidfile only if it still holds OUR pid', () => {
  const fsImpl = makeFakeFs({ [PIDFILE]: '111' });
  // 다른 pid(555) 소유 — 지우면 안 됨
  const refused = voidDaemon.releaseSingleton({ pidFile: PIDFILE, fsImpl, pid: 555 });
  assert.equal(refused, false);
  assert.equal(fsImpl.files.get(PIDFILE), '111');

  // 우리 pid(111) 소유 — 지워야 함
  const released = voidDaemon.releaseSingleton({ pidFile: PIDFILE, fsImpl, pid: 111 });
  assert.equal(released, true);
  assert.equal(fsImpl.files.has(PIDFILE), false);
});

test('readPidFile: returns null when the pidfile is absent or unparsable', () => {
  assert.equal(voidDaemon.readPidFile({ pidFile: PIDFILE, fsImpl: makeFakeFs() }), null);
  assert.equal(voidDaemon.readPidFile({ pidFile: PIDFILE, fsImpl: makeFakeFs({ [PIDFILE]: 'not-a-pid' }) }), null);
  assert.equal(voidDaemon.readPidFile({ pidFile: PIDFILE, fsImpl: makeFakeFs({ [PIDFILE]: '42' }) }), 42);
});

// ── runLoop ──────────────────────────────────────────────────────────────────────────────

test('runLoop: once:true calls the stubbed worker exactly once and returns without sleeping', async () => {
  let calls = 0;
  let sleepCalls = 0;
  await voidDaemon.runLoop({
    once: true,
    workerFn: async () => { calls++; },
    sleepFn: async () => { sleepCalls++; },
  });
  assert.equal(calls, 1);
  assert.equal(sleepCalls, 0, 'once:true must return before ever sleeping');
});

test('runLoop: a shouldStop that trips after the first iteration behaves like once:true', async () => {
  let calls = 0;
  let stop = false;
  await voidDaemon.runLoop({
    shouldStop: () => stop,
    workerFn: async () => { calls++; stop = true; },
    sleepFn: async () => { throw new Error('should never sleep — shouldStop tripped first'); },
  });
  assert.equal(calls, 1);
});

test('runLoop: a throwing worker does NOT break the loop — the next iteration still runs (fail-open)', async () => {
  let calls = 0;
  let stop = false;
  const errors = [];
  await voidDaemon.runLoop({
    shouldStop: () => stop,
    workerFn: async () => {
      calls++;
      if (calls === 1) throw new Error('simulated poll failure');
      stop = true; // 두 번째 호출이 성공하면 멈춘다
    },
    sleepFn: async () => {}, // 즉시 리턴 — 실제 대기 없음
    logFn: (msg) => errors.push(msg),
  });
  assert.equal(calls, 2, 'worker must be called again after a throwing iteration');
  assert.ok(errors.some(m => /simulated poll failure/.test(m)));
});

test('runLoop: a rejecting (async-throwing) worker is equally swallowed', async () => {
  let calls = 0;
  let stop = false;
  await voidDaemon.runLoop({
    shouldStop: () => stop,
    workerFn: () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('rejected'));
      stop = true;
      return Promise.resolve();
    },
    sleepFn: async () => {},
    logFn: () => {},
  });
  assert.equal(calls, 2);
});

// ── module load has no side effects ─────────────────────────────────────────────────────

test('requiring lib/voidDaemon.js does not create a pidfile or start a loop', () => {
  // 이미 상단에서 require 됐다는 사실 자체가 이 테스트의 전제다 — 여기서는 실제
  // storageDir()/voidemon.pid 가 생성되지 않았음을 재확인한다.
  const fs = require('fs');
  assert.equal(fs.existsSync(voidDaemon.pidFilePath()), false);
});

// ── shouldEnsureDaemon ───────────────────────────────────────────────────────────────────

test('shouldEnsureDaemon: false only for daemon and notify-worker, true otherwise', () => {
  assert.equal(voidDaemon.shouldEnsureDaemon('daemon'), false);
  assert.equal(voidDaemon.shouldEnsureDaemon('DAEMON'), false, 'case-insensitive');
  assert.equal(voidDaemon.shouldEnsureDaemon('notify-worker'), false);
  assert.equal(voidDaemon.shouldEnsureDaemon('NOTIFY-WORKER'), false, 'case-insensitive');

  assert.equal(voidDaemon.shouldEnsureDaemon(undefined), true, 'no args -> interactive menu');
  assert.equal(voidDaemon.shouldEnsureDaemon('prompt'), true);
  assert.equal(voidDaemon.shouldEnsureDaemon('tokens'), true);
  assert.equal(voidDaemon.shouldEnsureDaemon('claude'), true, 'a tool name');
});

// ── ensureDaemonRunning ──────────────────────────────────────────────────────────────────

test('ensureDaemonRunning: a live pidfile short-circuits — no spawn, alreadyRunning:true', () => {
  const fsImpl = makeFakeFs({ [PIDFILE]: '111' });
  let spawnCalls = 0;
  const result = voidDaemon.ensureDaemonRunning({
    pidFile: PIDFILE,
    fsImpl,
    killFn: aliveKillFn,
    spawnFn: () => { spawnCalls++; throw new Error('should never be called'); },
  });
  assert.equal(spawnCalls, 0, 'must not spawn when a live daemon already owns the pidfile');
  assert.deepEqual(result, { started: false, alreadyRunning: true });
});

test('ensureDaemonRunning: no pidfile spawns the detached daemon exactly once', () => {
  const fsImpl = makeFakeFs();
  let spawnCalls = 0;
  let capturedOpts = null;
  const fakeChild = { pid: 4242, unref() {} };
  const result = voidDaemon.ensureDaemonRunning({
    pidFile: PIDFILE,
    fsImpl,
    killFn: aliveKillFn,
    spawnFn: (execPath, args, opts) => {
      spawnCalls++;
      capturedOpts = opts;
      return fakeChild;
    },
  });
  assert.equal(spawnCalls, 1, 'must spawn exactly once when no pidfile exists');
  assert.equal(capturedOpts.detached, true);
  assert.deepEqual(result, { started: true, alreadyRunning: false });
});

test('ensureDaemonRunning: a stale (dead pid) pidfile also spawns exactly once', () => {
  const fsImpl = makeFakeFs({ [PIDFILE]: '999' });
  let spawnCalls = 0;
  const fakeChild = { pid: 4343, unref() {} };
  const result = voidDaemon.ensureDaemonRunning({
    pidFile: PIDFILE,
    fsImpl,
    killFn: deadKillFn,
    spawnFn: () => { spawnCalls++; return fakeChild; },
  });
  assert.equal(spawnCalls, 1);
  assert.equal(result.started, true);
});

test('ensureDaemonRunning: a throwing spawnFn is swallowed (fail-open) and never throws', () => {
  const fsImpl = makeFakeFs();
  assert.doesNotThrow(() => {
    const result = voidDaemon.ensureDaemonRunning({
      pidFile: PIDFILE,
      fsImpl,
      killFn: aliveKillFn,
      spawnFn: () => { throw new Error('spawn boom'); },
    });
    assert.equal(result.started, false);
    assert.equal(result.alreadyRunning, false);
    assert.equal(result.skipped, true);
  });
});

test('ensureDaemonRunning: a throwing fsImpl (e.g. cannot open log file to spawn) is also swallowed', () => {
  // readPidFile() itself already swallows a broken readFileSync and reports "no pidfile", so
  // this exercises the OTHER half of the fail-open path: spawnDetachedDaemon's own
  // fsImpl.openSync(logFile) throwing must also never escape ensureDaemonRunning.
  const brokenFs = {
    readFileSync() { throw new Error('EIO: disk error'); },
    openSync() { throw new Error('EIO: cannot open log file'); },
  };
  assert.doesNotThrow(() => {
    const result = voidDaemon.ensureDaemonRunning({ pidFile: PIDFILE, fsImpl: brokenFs, killFn: aliveKillFn });
    assert.equal(result.skipped, true);
  });
});

test('pollMsFromEnv: defaults to 60000, honors VOID_NOTIFY_POLL_MS when valid', () => {
  const original = process.env.VOID_NOTIFY_POLL_MS;
  try {
    delete process.env.VOID_NOTIFY_POLL_MS;
    assert.equal(voidDaemon.pollMsFromEnv(), 60000);

    process.env.VOID_NOTIFY_POLL_MS = '5000';
    assert.equal(voidDaemon.pollMsFromEnv(), 5000);

    process.env.VOID_NOTIFY_POLL_MS = 'not-a-number';
    assert.equal(voidDaemon.pollMsFromEnv(), 60000);
  } finally {
    if (original === undefined) delete process.env.VOID_NOTIFY_POLL_MS;
    else process.env.VOID_NOTIFY_POLL_MS = original;
  }
});
