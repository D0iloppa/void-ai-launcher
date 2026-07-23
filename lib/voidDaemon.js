'use strict';

/*
 * voidemon — the resident singleton daemon that drives lib/voidNotify.js's driver-agnostic
 * runWorkerOnce() on an interval.
 *
 * lib/voidNotify.js's header explicitly dropped cron: "1분 간격 cron 워커 ... 향후 상주
 * 데몬으로 완전히 대체될 예정" (CLAUDE.md's void-notify paragraph said the same, pending this
 * change). There is now NO cron code anywhere in this repo — `void daemon` (this file, driven
 * from launcher.js's `case 'daemon':`) is the SOLE scheduler. `void notify-worker` still exists
 * as a manual/scripted one-shot driver (see launcher.js) for ad-hoc runs or a user's own cron
 * if they really want one; this module is the "keep calling it forever" driver.
 *
 * ── Singleton (pidfile) ─────────────────────────────────────────────────────────────────────
 * A pidfile at storageDir()/voidemon.pid enforces "at most one daemon process". This is
 * belt-and-suspenders on top of voidNotify's lease-CAS (claimOne/claimDueBatch — a real
 * better-sqlite3 transaction, race-safe across processes): the CAS is the ULTIMATE backstop
 * against double-send even if two daemons somehow ran at once, but the pidfile is what
 * actually stops a user from starting a second daemon in the first place (two pollers doing
 * duplicate claim-attempts/API calls is wasteful even though the CAS keeps it *correct*).
 *
 * Cross-platform by construction: fs.openSync(path, 'wx') (O_CREAT|O_EXCL) and
 * process.kill(pid, 0) both work on Windows (the reason this daemon exists at all is that
 * cron isn't available there), unlike flock()-style advisory file locks.
 */

const fs = require('fs');
const path = require('path');
const { storageDir } = require('./storage');

const DEFAULT_POLL_MS = 60000;

function pollMsFromEnv() {
  const raw = process.env.VOID_NOTIFY_POLL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_MS;
}

function pidFilePath() {
  return path.join(storageDir(), 'voidemon.pid');
}

function logFilePath() {
  return path.join(storageDir(), 'voidemon.log');
}

// launcher.js's own path — the entry point the detached child re-invokes as
// `<entryFile> daemon --run`. Computed from __dirname (not require()'d — requiring launcher.js
// would execute its whole top-level module-load/menu machinery; we only need the path string).
function daemonEntryFile() {
  return path.join(__dirname, '..', 'launcher.js');
}

/*
 * Shared detached-spawn mechanics — the ONE place that knows how to fork off the resident
 * daemon as a background process that outlives the caller. Both launcher.js's `startDaemon`
 * (void daemon start) and `ensureDaemonRunning` below (the waker hook) call this so the two
 * spawn paths can never drift apart. All fs/process seams are injectable for tests; nothing
 * here is executed at require-time.
 */
function spawnDetachedDaemon({
  spawnFn = require('child_process').spawn,
  entryFile = daemonEntryFile(),
  execPath = process.execPath,
  fsImpl = fs,
  logFile = logFilePath(),
} = {}) {
  const logFd = fsImpl.openSync(logFile, 'a');
  let child;
  try {
    child = spawnFn(execPath, [entryFile, 'daemon', '--run'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
  } finally {
    try { fsImpl.closeSync(logFd); } catch {}
  }
  return child;
}

// pid liveness probe. process.kill(pid, 0) sends no signal, just checks existence/permission:
// throws ESRCH if the pid doesn't exist (dead/never existed), EPERM if it exists but we lack
// permission to signal it (still alive as far as we're concerned — treat as running).
function isAlive(pid, killFn = process.kill) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function readPidFile({ pidFile = pidFilePath(), fsImpl = fs } = {}) {
  try {
    const raw = fsImpl.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/*
 * Acquire the singleton pidfile.
 *   - fsImpl.openSync(pidFile, 'wx') is O_CREAT|O_EXCL — atomic create-iff-absent. If two
 *     processes race here, the OS guarantees only one openSync succeeds; the loser lands in
 *     the catch branch below and re-checks liveness (it will see the winner's freshly-written
 *     live pid and correctly refuse).
 *   - If the file already exists, read the stored pid and probe liveness:
 *       - ALIVE  -> refuse: { ok:false, reason:'running', pid }.
 *       - DEAD   -> stale pidfile from a crashed/killed previous daemon that never got to
 *                   release() — remove it and retry acquisition exactly once (guarded by
 *                   `_retried` so a pathologically-recreated file can't recurse forever).
 *
 * Race window (documented, intentionally not closed further): between "we decided the old
 * pid is dead" and "we unlink + recreate", a second process running this same function
 * could interleave the identical steps and also decide the file is stale. Both would then
 * recreate the pidfile (the second write wins) and both would proceed to run a poll loop
 * for at least one cycle before either notices the other. This window only exists right
 * after a crash (a live daemon's pidfile is never "stale"), so it's narrow in practice. It
 * is not closed with a lock-on-the-lock because voidNotify.claimOne's transactional CAS
 * already guarantees at most one of the two daemons actually claims+sends any given queue
 * item — so even in this rare double-acquire case, no message is ever double-delivered;
 * the pidfile's job is merely to make the common case be "exactly one poller", not to be a
 * distributed consensus lock.
 */
function acquireSingleton({ pidFile = pidFilePath(), fsImpl = fs, killFn = process.kill, pid = process.pid, _retried = false } = {}) {
  let fd;
  try {
    fd = fsImpl.openSync(pidFile, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existingPid = readPidFile({ pidFile, fsImpl });
    if (isAlive(existingPid, killFn)) {
      return { ok: false, reason: 'running', pid: existingPid };
    }
    if (_retried) {
      return { ok: false, reason: 'unreclaimable', pid: existingPid };
    }
    try { fsImpl.unlinkSync(pidFile); } catch {}
    return acquireSingleton({ pidFile, fsImpl, killFn, pid, _retried: true });
  }
  try {
    fsImpl.writeSync(fd, String(pid));
  } finally {
    fsImpl.closeSync(fd);
  }
  return { ok: true, pid };
}

// Release — only removes the pidfile if it still names OUR pid. This matters because a
// slow/delayed release (e.g. shutdown taking a while) could in principle run after some
// other process already reclaimed a "stale" file and started its own daemon; we must never
// delete a newer instance's lock out from under it.
function releaseSingleton({ pidFile = pidFilePath(), fsImpl = fs, pid = process.pid } = {}) {
  const existingPid = readPidFile({ pidFile, fsImpl });
  if (existingPid !== pid) return false;
  try { fsImpl.unlinkSync(pidFile); } catch {}
  return true;
}

// Default sleep: broken into 1s steps and re-checks shouldStop between each, so a SIGTERM/
// SIGINT-triggered shutdown flag is noticed within ~1s instead of waiting out the full
// pollMs. Tests inject their own instantaneous sleepFn so they never actually wait.
async function defaultSleep(ms, shouldStop = () => false) {
  const STEP_MS = 1000;
  let waited = 0;
  while (waited < ms) {
    if (shouldStop()) return;
    const chunk = Math.min(STEP_MS, ms - waited);
    await new Promise(resolve => setTimeout(resolve, chunk));
    waited += chunk;
  }
}

/*
 * Core loop — driver-agnostic like runWorkerOnce() itself: repeatedly calls workerFn() then
 * sleeps pollMs, until shouldStop() is true (checked before each call AND before/during each
 * sleep so shutdown is prompt). Every iteration is wrapped in try/catch — a throwing/
 * rejecting workerFn must never kill the loop (fail-open, mirroring voidContext's hook
 * philosophy: log + continue, never let a bad poll take the daemon down). `once:true` (or a
 * shouldStop that trips after the first iteration) runs exactly one iteration and returns,
 * which is what the test suite uses to drive this without ever actually sleeping.
 */
async function runLoop({
  pollMs = pollMsFromEnv(),
  once = false,
  shouldStop = () => false,
  workerFn,
  sleepFn,
  logFn,
} = {}) {
  const worker = workerFn || (() => require('./voidNotify').runWorkerOnce());
  const log = logFn || ((...args) => console.error(...args));
  const sleep = sleepFn || defaultSleep;

  for (;;) {
    if (shouldStop()) return;
    try {
      await worker();
    } catch (e) {
      log(`[voidemon] poll error: ${e && e.message ? e.message : e}`);
    }
    if (once || shouldStop()) return;
    await sleep(pollMs, shouldStop);
  }
}

/*
 * "waker" — the auto-ensure hook launcher.js calls on (almost) every void invocation so the
 * user never has to remember `void daemon start`. Deliberately silent + fail-open:
 *   - Peek the pidfile; if a live daemon already owns it, this is the overwhelmingly common
 *     case (voidemon running from a previous launch) — return immediately, print NOTHING.
 *   - Otherwise spawn one via the same spawnDetachedDaemon() startDaemon uses, so the two
 *     paths can't diverge. No success banner either — the ask was "silent when already
 *     running", and printing only on first-spawn-of-the-session would be a confusing
 *     asymmetry, so this stays quiet in both branches.
 *   - The ENTIRE thing is wrapped in try/catch: a launch of `void <anything>` must never be
 *     slowed down or broken by daemon plumbing, mirroring voidContext's auto-record hook
 *     philosophy (lib/voidContext.js / launcher.js's launchTool) of fail-open-and-forget.
 * Returns a status object purely for testability — every caller in launcher.js ignores it.
 */
function ensureDaemonRunning({
  pidFile = pidFilePath(),
  fsImpl = fs,
  killFn = process.kill,
  spawnFn,
  entryFile,
  execPath,
  logFile,
} = {}) {
  try {
    const existingPid = readPidFile({ pidFile, fsImpl });
    if (existingPid && isAlive(existingPid, killFn)) {
      return { started: false, alreadyRunning: true };
    }
    spawnDetachedDaemon({ spawnFn, entryFile, execPath, fsImpl, logFile });
    return { started: true, alreadyRunning: false };
  } catch {
    // fail-open: pidfile unreadable, spawn threw, disk full, whatever — a launch must proceed
    // regardless. Nothing is printed; this is a best-effort convenience, not a requirement.
    return { started: false, alreadyRunning: false, skipped: true };
  }
}

/*
 * Pure guard deciding which subcommands should trigger the waker above. Kept as a pure
 * function of the command string (no fs/process access) so it's trivially unit-testable.
 *
 *   - 'daemon'        — its own control path. `daemon stop` must not be instantly revived by
 *                       an ensure running in the SAME invocation, and `daemon --run` IS the
 *                       daemon (spawning another one from inside itself would be absurd).
 *   - 'notify-worker' — the one-shot manual/cron driver; running it once shouldn't imply the
 *                       user wants a resident poller too.
 *   - everything else (interactive menu i.e. cmd === undefined, tool launches, prompt/tokens/
 *     sessions/host/notify/update/...) — true.
 */
function shouldEnsureDaemon(cmd) {
  if (cmd === undefined || cmd === null) return true;
  const lc = String(cmd).toLowerCase();
  return lc !== 'daemon' && lc !== 'notify-worker';
}

module.exports = {
  DEFAULT_POLL_MS,
  pollMsFromEnv,
  pidFilePath,
  logFilePath,
  daemonEntryFile,
  isAlive,
  readPidFile,
  acquireSingleton,
  releaseSingleton,
  runLoop,
  spawnDetachedDaemon,
  ensureDaemonRunning,
  shouldEnsureDaemon,
};
