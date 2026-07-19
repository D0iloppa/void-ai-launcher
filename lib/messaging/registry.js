'use strict';

/*
 * registry.js — void-to-void presence registry (Phase A).
 *
 * Each running `void` process registers itself under a stable-for-its-
 * lifetime id (`<sanitized-label>-<pid>`) in a shared registry directory
 * under storageDir()/mail/registry/. Peers are discovered by listing that
 * directory and pruning entries whose pid is no longer alive. This is a
 * pure filesystem mechanism — no dJinn, no network — so it works across
 * any number of void instances on the same machine sharing the same
 * ~/.config/void-launcher/ storage root.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { storageDir } = require('../storage');

const MAIL_ROOT = path.join(storageDir(), 'mail');
const REGISTRY_DIR = path.join(MAIL_ROOT, 'registry');
const INBOX_DIR = path.join(MAIL_ROOT, 'inbox');

function ensureDirs() {
  for (const dir of [MAIL_ROOT, REGISTRY_DIR, INBOX_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  }
}
ensureDirs();

function sanitize(label) {
  return String(label || '').replace(/[^a-zA-Z0-9]/g, '_') || 'void';
}

const SELF_LABEL = os.hostname();
const SELF_ID = `${sanitize(SELF_LABEL)}-${process.pid}`;

function selfId() { return SELF_ID; }

function selfIdentity() {
  return {
    id: SELF_ID,
    label: SELF_LABEL,
    pid: process.pid,
    display: `${SELF_LABEL} #${process.pid}`,
  };
}

function registryFile(id) {
  return path.join(REGISTRY_DIR, `${id}.json`);
}

function registerSelf() {
  ensureDirs();
  const entry = {
    id: SELF_ID,
    label: SELF_LABEL,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(registryFile(SELF_ID), JSON.stringify(entry, null, 2), { mode: 0o600 });
  } catch {}
  return entry;
}

function deregisterSelf() {
  try { fs.unlinkSync(registryFile(SELF_ID)); } catch {}
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: process exists but is owned by someone else — still "alive".
    // ESRCH (or anything else): treat as dead.
    return e && e.code === 'EPERM';
  }
}

function readRegistryEntry(file) {
  try {
    const raw = fs.readFileSync(path.join(REGISTRY_DIR, file), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.pid === 'number' && data.id) return data;
  } catch {}
  return null;
}

function pruneRegistry() {
  ensureDirs();
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); } catch { return []; }

  const alive = [];
  for (const file of files) {
    const entry = readRegistryEntry(file);
    if (!entry) {
      try { fs.unlinkSync(path.join(REGISTRY_DIR, file)); } catch {}
      continue;
    }
    if (!isPidAlive(entry.pid)) {
      try { fs.unlinkSync(path.join(REGISTRY_DIR, file)); } catch {}
      continue;
    }
    alive.push(entry);
  }
  return alive;
}

function listPeers({ includeSelf = false } = {}) {
  const alive = pruneRegistry();
  return alive.filter(e => includeSelf || e.id !== SELF_ID);
}

// Best-effort cleanup on exit. 'exit' handlers must be synchronous — unlinkSync
// is fine here. SIGINT/SIGTERM are also wired so a Ctrl+C exit deregisters
// promptly instead of lingering as a stale (but pid-dead, so harmless) entry
// until the next peer's pruneRegistry() call sweeps it.
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  try { process.on('exit', deregisterSelf); } catch {}
  try { process.on('SIGINT', () => { deregisterSelf(); process.exit(130); }); } catch {}
  try { process.on('SIGTERM', () => { deregisterSelf(); process.exit(143); }); } catch {}
}

module.exports = {
  MAIL_ROOT,
  REGISTRY_DIR,
  INBOX_DIR,
  sanitize,
  selfId,
  selfIdentity,
  registerSelf,
  deregisterSelf,
  pruneRegistry,
  listPeers,
  hookExit,
};
