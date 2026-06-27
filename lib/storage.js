'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function storageDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir  = path.join(base, 'void-launcher');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJson(file)       { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data){ fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }

function getLast()      { return readJson(path.join(storageDir(), 'last.json')); }
function saveLast(entry){ writeJson(path.join(storageDir(), 'last.json'), { ...entry, timestamp: Date.now() }); }

function getHistory() { return readJson(path.join(storageDir(), 'history.json')) || []; }

function appendHistory(entry) {
  const file    = path.join(storageDir(), 'history.json');
  const history = getHistory();
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > 200) history.length = 200;
  writeJson(file, history);
}

// ── Claude 네임드 세션 ─────────────────────────────────

function getSessions() {
  return readJson(path.join(storageDir(), 'sessions.json')) || [];
}

function saveSession(entry) {
  const sessions = getSessions().filter(s => s.name !== entry.name);
  sessions.push(entry);
  writeJson(path.join(storageDir(), 'sessions.json'), sessions);
}

function deleteSession(name) {
  const sessions = getSessions().filter(s => s.name !== name);
  writeJson(path.join(storageDir(), 'sessions.json'), sessions);
}

function getSession(name) {
  return getSessions().find(s => s.name === name) || null;
}

module.exports = {
  storageDir,
  getLast, saveLast,
  getHistory, appendHistory,
  getSessions, saveSession, deleteSession, getSession,
};
