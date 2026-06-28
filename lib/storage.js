'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function storageDir() {
  const candidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'void-launcher') : null,
    path.join(os.homedir(), '.config', 'void-launcher'),
    path.join(process.cwd(), '.void-launcher'),
    path.join(os.tmpdir(), 'void-launcher'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }

  throw new Error('void-launcher 저장 디렉토리를 만들 수 없습니다.');
}

function firstWritableDir(candidates) {
  for (const dir of candidates.filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }

  throw new Error('writable 디렉토리를 찾을 수 없습니다.');
}

function resolveToolStateDir(toolCommand) {
  const tool = (toolCommand || '').toLowerCase();
  const leaf = `.${tool}`;
  return firstWritableDir([
    path.join(os.homedir(), leaf),
    path.join(storageDir(), 'tool-state', leaf),
    path.join(os.tmpdir(), 'void-launcher', 'tool-state', leaf),
  ]);
}

function resolveSessionConfigDir(toolCommand, sessionName) {
  const tool = (toolCommand || '').toLowerCase();
  const leaf = `.${tool}-${sessionName}`;
  return firstWritableDir([
    path.join(os.homedir(), leaf),
    path.join(storageDir(), 'sessions', leaf),
    path.join(os.tmpdir(), 'void-launcher', 'sessions', leaf),
  ]);
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
  const toolCommand = entry.toolCommand || 'claude';
  const sessions = getSessions().filter(s =>
    !(s.name === entry.name && (s.toolCommand || 'claude') === toolCommand)
  );
  sessions.push(entry);
  writeJson(path.join(storageDir(), 'sessions.json'), sessions);
}

function deleteSession(name, toolCommand = null) {
  const sessions = getSessions().filter(s => {
    if (s.name !== name) return true;
    if (!toolCommand) return false;
    return (s.toolCommand || 'claude') !== toolCommand;
  });
  writeJson(path.join(storageDir(), 'sessions.json'), sessions);
}

function getSession(name, toolCommand = null) {
  return getSessions().find(s =>
    s.name === name && (!toolCommand || (s.toolCommand || 'claude') === toolCommand)
  ) || null;
}

module.exports = {
  storageDir,
  resolveToolStateDir,
  resolveSessionConfigDir,
  getLast, saveLast,
  getHistory, appendHistory,
  getSessions, saveSession, deleteSession, getSession,
};
