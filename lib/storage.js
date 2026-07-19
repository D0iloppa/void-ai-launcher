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

// assistant 프로필은 CLI 네임드 세션과 별개 개념이므로 'assistant-' 접두사로
// configDir 이 실제 세션(.<tool>-<name>)과 절대 겹치지 않도록 분리한다.
function resolveAssistantConfigDir(toolCommand, assistantName) {
  const tool = (toolCommand || '').toLowerCase();
  const leaf = `.assistant-${tool}-${assistantName}`;
  return firstWritableDir([
    path.join(os.homedir(), leaf),
    path.join(storageDir(), 'assistants', leaf),
    path.join(os.tmpdir(), 'void-launcher', 'assistants', leaf),
  ]);
}

// void-persistent 계정 스위처(phase 1) 의 persist 프로필 디렉토리 — 실제 세션
// (.<tool>-<name>) 및 어시스턴트(.assistant-<tool>-<name>) 와 렉시컬하게 겹치지
// 않도록 별도 접두사를 쓴다. 이 디렉토리는 여러 계정의 크리덴셜을 번갈아 써
// 넣는 "활성 슬롯" 이므로 항상 claude 전용이다(toolCommand 파라미터 없음).
// NOTE: 'experiments' 디렉토리 leaf 는 온디스크 경로 문자열이다 — 기존 사용자의
// persist 프로필을 orphan 시키지 않도록 이름을 바꾸지 않고 그대로 둔다
// (기능명은 void-persistent 로 리네임됐지만 이 경로 세그먼트는 예외).
function resolvePersistProfileDir(name) {
  const leaf = `.claude-persist-${name}`;
  return firstWritableDir([
    path.join(os.homedir(), leaf),
    path.join(storageDir(), 'experiments', leaf),
    path.join(os.tmpdir(), 'void-launcher', 'experiments', leaf),
  ]);
}

function readJson(file)       { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data){ fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }

function getLast()      { return readJson(path.join(storageDir(), 'last.json')); }
function saveLast(entry){ writeJson(path.join(storageDir(), 'last.json'), { ...entry, timestamp: Date.now() }); }

function getInitStatus()       { return readJson(path.join(storageDir(), 'init-status.json')); }
function saveInitStatus(entry) { writeJson(path.join(storageDir(), 'init-status.json'), { ...entry, timestamp: Date.now() }); }

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

// resume(switch) 핸드오프 락 — void-to-void 메시징의 resume seedType 이 수락되면
// source 세션(A)에 "이미 다른 프로필로 넘어갔다"는 표시를 남긴다. Additive/
// non-breaking: 세션 레코드에 필드를 하나 얹을 뿐이고 기본은 부재(undefined)라
// 기존 getSession()/getSessions() 소비자는 영향 없음. 실제 lock/ack 로직은
// lib/messaging/resumeFork.js 가 갖는다 — 여기는 순수 저장 접근자.
function setSessionHandoff(name, toolCommand, info) {
  const session = getSession(name, toolCommand);
  if (!session) return false;
  session.handedOff = info || null;
  saveSession(session);
  return true;
}

// 사용량 조회 캐시는 lib/usageDb.js (SQLite) 로 이전됨 — 여러 void 프로세스가
// 동시에 JSON 파일을 read-modify-write 하면서 발생할 수 있는 경합/유실을 피하기 위함.

// ── 어시스턴트 프로필 ──────────────────────────────────
// CLI 네임드 세션과 별개 개념 — assistant는 name만으로 고유하다 (도구 변형이 아님).

function getAssistants() {
  return readJson(path.join(storageDir(), 'assistants.json')) || [];
}

function saveAssistant(entry) {
  const assistants = getAssistants().filter(a => a.name !== entry.name);
  assistants.push(entry);
  writeJson(path.join(storageDir(), 'assistants.json'), assistants);
}

function deleteAssistant(name) {
  const assistants = getAssistants().filter(a => a.name !== name);
  writeJson(path.join(storageDir(), 'assistants.json'), assistants);
}

function getAssistant(name) {
  return getAssistants().find(a => a.name === name) || null;
}

module.exports = {
  storageDir,
  resolveToolStateDir,
  resolveSessionConfigDir,
  resolveAssistantConfigDir,
  resolvePersistProfileDir,
  getLast, saveLast,
  getInitStatus, saveInitStatus,
  getHistory, appendHistory,
  getSessions, saveSession, deleteSession, getSession, setSessionHandoff,
  getAssistants, saveAssistant, deleteAssistant, getAssistant,
};
