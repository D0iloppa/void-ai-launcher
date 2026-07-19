'use strict';

/*
 * resumeFork.js — resume 포인터 / 복사 / uuid rewrite / source-session lock
 * (Phase B, seedType 'resume' | 'resume-fork' 전용 로직).
 *
 * Grounding facts (검증됨 — 그대로 신뢰):
 *   - resume 가능한 Claude Code 대화 = 파일 하나
 *     `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<uuid>.jsonl`.
 *     cwd-slug = cwd 의 모든 '/'와 '\\'를 '-'로 치환한 것
 *     (lib/experiments/switchProfile.js:193 encodeCwd 와 동일 — 아래 참고).
 *   - 그 jsonl 하나면 `claude --resume <uuid>` 로 충분히 재개된다. 인덱스/DB/
 *     사이드카 불필요. sessionId/cwd 필드는 있지만 크리덴셜 필드는 없다.
 *
 * lib/experiments/switchProfile.js 의 encodeCwd/captureLastSession 을
 * require 하지 않고 의도적으로 미러링(중복)한다 — messaging 과 experiments 는
 * 서로 다른 관심사이고, switchProfile.js 는 phase 1 계정 스위처 전용 모듈이라
 * 결합시키지 않는다(과제 지시: "mirror", "reuse" 아님).
 *
 * pointer 형태(그래프 store 의 resume/resume-fork 메시지 payload) —
 * { sessionId, cwd, sourceProfile, toolCommand } — 파일 바이트를 담지 않는
 * 순수 포인터. sourceProfile = source named session 의 이름(storage.getSession
 * 으로 configDir 을 그때그때 재조회 — 이중 보관하지 않음).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const storage = require('../storage');
const store = require('./store');

// ── cwd slug (switchProfile.js:193 encodeCwd 미러) ─────────────────────

function encodeCwd(cwd) {
  return String(cwd || '').replace(/[\\/]/g, '-');
}

// persistDir(=configDir)/projects/<encodeCwd(cwd)>/*.jsonl 중 최신(mtime) 파일의
// basename(확장자 제외)을 sessionId 로 반환한다. (switchProfile.js:199
// captureLastSession 미러 — 순수 fs 읽기, 부작용 없음.)
function pickLatestSessionId(configDir, cwd) {
  try {
    const projDir = path.join(configDir, 'projects', encodeCwd(cwd));
    if (!fs.existsSync(projDir)) return null;
    const entries = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
    if (entries.length === 0) return null;
    let newest = null;
    let newestMtime = -Infinity;
    for (const f of entries) {
      const full = path.join(projDir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = f; }
      } catch {}
    }
    return newest ? newest.slice(0, -'.jsonl'.length) : null;
  } catch {
    return null;
  }
}

// ── pointer ──────────────────────────────────────────────────────────────

// session = storage 세션 레코드({name, toolCommand, configDir}). sessionId를
// 명시하지 않으면 session.configDir + cwd 로 최신 sessionId 를 추론한다.
function buildResumePointer(session, { sessionId, cwd = process.cwd() } = {}) {
  if (!session || !session.name) {
    throw new Error('resumeFork.buildResumePointer: session({name,toolCommand,configDir}) 이 필요합니다');
  }
  const resolvedSessionId = sessionId || pickLatestSessionId(session.configDir, cwd);
  if (!resolvedSessionId) {
    throw new Error(`resumeFork.buildResumePointer: '${session.name}' 에 대해 resume 가능한 sessionId 를 찾지 못했습니다`);
  }
  return {
    sessionId: resolvedSessionId,
    cwd,
    sourceProfile: session.name,
    toolCommand: session.toolCommand || 'claude',
  };
}

// 순수 함수 — pointer + source configDir 로 절대 jsonl 경로만 계산한다(fs 접근 없음).
function resolveSourceJsonlPath(pointer, sourceConfigDir) {
  if (!pointer || !pointer.sessionId || !pointer.cwd) {
    throw new Error('resumeFork.resolveSourceJsonlPath: pointer.sessionId/cwd 가 필요합니다');
  }
  if (!sourceConfigDir) {
    throw new Error('resumeFork.resolveSourceJsonlPath: sourceConfigDir 이 필요합니다');
  }
  return path.join(sourceConfigDir, 'projects', encodeCwd(pointer.cwd), `${pointer.sessionId}.jsonl`);
}

// INVARIANT 가드 — .credentials.json/.claude.json 을 실수로 넘기지 않도록 경로
// 형태 자체를 검증한다: .jsonl 로 끝나야 하고 'projects' 디렉토리 아래여야 한다.
function _assertJsonlUnderProjects(absPath) {
  if (!absPath.endsWith('.jsonl')) {
    throw new Error(`resumeFork: source path 는 .jsonl 이어야 합니다: ${absPath}`);
  }
  const parts = absPath.split(path.sep);
  if (!parts.includes('projects')) {
    throw new Error(`resumeFork: source path 는 projects/ 디렉토리 아래여야 합니다: ${absPath}`);
  }
}

function genForkUuid() {
  return crypto.randomUUID();
}

// pointer 가 가리키는 jsonl 을 targetConfigDir 로 복사한다. newUuid 가 있으면
// (resume-fork) 새 파일명 + 매 라인 sessionId 필드를 rewrite 하고, 없으면
// (resume/switch) 같은 uuid 로 그대로 복사한다. cwd 필드는 절대 건드리지 않는다.
// .credentials.json/.claude.json 은 복사 대상이 아니다 — 오직 이 jsonl 하나뿐.
function copyResumeJsonl(pointer, targetConfigDir, { newUuid = null } = {}) {
  if (!pointer) throw new Error('resumeFork.copyResumeJsonl: pointer 가 필요합니다');
  if (!targetConfigDir) throw new Error('resumeFork.copyResumeJsonl: targetConfigDir 이 필요합니다');

  const sourceSession = storage.getSession(pointer.sourceProfile, pointer.toolCommand);
  if (!sourceSession || !sourceSession.configDir) {
    throw new Error(`resumeFork.copyResumeJsonl: source 세션을 찾을 수 없습니다: ${pointer.sourceProfile}`);
  }
  const srcPath = resolveSourceJsonlPath(pointer, sourceSession.configDir);
  _assertJsonlUnderProjects(srcPath);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`resumeFork.copyResumeJsonl: source jsonl 이 없습니다: ${srcPath}`);
  }

  const targetUuid = newUuid || pointer.sessionId;
  const targetProjDir = path.join(targetConfigDir, 'projects', encodeCwd(pointer.cwd));
  fs.mkdirSync(targetProjDir, { recursive: true, mode: 0o700 });
  const targetPath = path.join(targetProjDir, `${targetUuid}.jsonl`);

  if (newUuid) {
    // 매 라인을 JSON 으로 파싱해 sessionId 필드만 rewrite. cwd 는 그대로 둔다.
    // 파싱 불가한 라인(빈 줄 등)은 그대로 통과시킨다(방어적).
    const raw = fs.readFileSync(srcPath, 'utf8');
    const rewritten = raw.split('\n').map(line => {
      if (!line.trim()) return line;
      let obj;
      try { obj = JSON.parse(line); } catch { return line; }
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'sessionId')) obj.sessionId = newUuid;
      return JSON.stringify(obj);
    });
    fs.writeFileSync(targetPath, rewritten.join('\n'), { mode: 0o600 });
  } else {
    fs.copyFileSync(srcPath, targetPath);
  }

  return { uuid: targetUuid, path: targetPath };
}

// ── source-session lock (resume/switch 핸드오프) ─────────────────────────
// sessionRef = {name, toolCommand}. storage.js 의 sessions.json 은 로컬 머신의
// 모든 void 프로세스가 공유하므로, B(수신측)가 accept 한 즉시 A 의 source
// 세션 레코드에 handedOff 를 세팅할 수 있다(별도 IPC 불필요).

function lockSourceSession({ name, toolCommand = 'claude' } = {}, info = {}) {
  if (!name) throw new Error('resumeFork.lockSourceSession: name 이 필요합니다');
  return storage.setSessionHandoff(name, toolCommand, {
    to: info.to || null,
    at: new Date().toISOString(),
  });
}

function isSessionLocked({ name, toolCommand = 'claude' } = {}) {
  if (!name) return false;
  const session = storage.getSession(name, toolCommand);
  return !!(session && session.handedOff);
}

// A 측 폴링 유틸 — messageHandle(=A 가 보낸 resume 메시지의 handle)을 다시
// 읽어 B 가 accept 했는지 확인하고, 아직 lock 되지 않았다면 지금 적용한다.
// acceptSeed()의 'resume' 분기가 이미 즉시 lock 을 걸어주지만(동일 로컬
// storage 공유이므로), 별도 시점에(예: UI 새로고침) 재확인/재적용하고 싶은
// 호출부를 위한 멱등 헬퍼로 남겨둔다.
function checkAndApplyHandoffLock(messageHandle) {
  const message = store.getMessage(messageHandle);
  if (!message || message.seedType !== 'resume' || !message.payload) return false;
  const { accepted, acceptedBy, sourceProfile, toolCommand } = message.payload;
  if (!accepted) return false;
  if (isSessionLocked({ name: sourceProfile, toolCommand })) return false; // 이미 처리됨
  lockSourceSession({ name: sourceProfile, toolCommand }, { to: acceptedBy });
  return true;
}

// ── acceptSeed 라우팅 ────────────────────────────────────────────────────

// 순수 라우팅 테이블 — seedType → directive.kind. 부작용 없음(유닛 테스트로
// 라우팅 자체만 독립적으로 검증하기 위해 acceptSeed 본체에서 분리).
function seedRouteKind(seedType) {
  if (seedType === 'msg') return 'inject';
  if (seedType === 'resume') return 'switch';
  if (seedType === 'resume-fork') return 'register';
  return null;
}

// xtermFrame.js 의 buildMailAcceptPrompt 가 하던 일(메시지를 아이 프로세스에게
// "읽어줘" 라고 지시)을 그래프 store 기준으로 재현한다. 예전엔 온디스크 .md
// 경로를 넘겼지만 이제 파일이 없으므로 본문을 직접 인라인한다 — 의도는 동일.
function buildMsgAcceptPrompt(message) {
  return `다음 메시지를 읽어줘:\n\n${(message && message.body) || ''}`;
}

// resume-fork 수락 시 B 에 새 named session 을 등록한다. storage.js 에는
// 프로그래매틱 "createCliSession" 함수가 없으므로(lib/sessions.js 의
// createCliSession 은 대화형 메뉴 전용, export 도 안 됨) lib/sessions.js
// createCliSession 이 쓰는 것과 동일한 조합(resolveSessionConfigDir +
// saveSession)을 직접 재현한다.
function registerForkedSession({ pointer, newUuid, name, toolCommand }) {
  const resolvedToolCommand = toolCommand || pointer.toolCommand || 'claude';
  const configDir = storage.resolveSessionConfigDir(resolvedToolCommand, name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const copyResult = copyResumeJsonl(pointer, configDir, { newUuid });
  const session = { name, toolCommand: resolvedToolCommand, configDir, created_at: new Date().toISOString() };
  storage.saveSession(session);
  return { session, resume: copyResult };
}

// message = mailbox.listInbox()/store 레코드 형태({seedType, payload, body, ...}).
// ctx (seedType 별로 다르게 소비됨):
//   msg          — 없음(순수)
//   resume       — { targetConfigDir, messageHandle, acceptedBy }
//   resume-fork  — { newSessionName, toolCommand, acceptedBy }
//
// 반환 directive:
//   msg          → { kind:'inject',   promptText }
//   resume       → { kind:'switch',   configDir, resumeSessionId, cwd }
//   resume-fork  → { kind:'register', session }
function acceptSeed(message, ctx = {}) {
  if (!message || !message.seedType) {
    throw new Error('resumeFork.acceptSeed: message.seedType 이 필요합니다');
  }
  const kind = seedRouteKind(message.seedType);
  if (!kind) throw new Error(`resumeFork.acceptSeed: 알 수 없는 seedType '${message.seedType}'`);

  if (message.seedType === 'msg') {
    return { kind: 'inject', promptText: buildMsgAcceptPrompt(message) };
  }

  if (message.seedType === 'resume') {
    const pointer = message.payload;
    if (!pointer) throw new Error("resumeFork.acceptSeed: 'resume' 메시지에 payload(pointer) 가 없습니다");
    const targetConfigDir = ctx.targetConfigDir;
    if (!targetConfigDir) throw new Error("resumeFork.acceptSeed: 'resume' 처리에는 ctx.targetConfigDir 이 필요합니다");

    const result = copyResumeJsonl(pointer, targetConfigDir, { newUuid: null });

    // 핸드오프 ack — 메시지에 accepted 마크를 남기고(공유 그래프라 A 도 조회
    // 가능), 로컬 storage 도 A/B 프로세스 간 공유이므로 source 세션도 바로 lock.
    if (ctx.messageHandle) {
      try { store.markResumeAccepted(ctx.messageHandle, ctx.acceptedBy || null); } catch {}
    }
    try {
      lockSourceSession({ name: pointer.sourceProfile, toolCommand: pointer.toolCommand }, { to: ctx.acceptedBy || null });
    } catch {}

    return { kind: 'switch', configDir: targetConfigDir, resumeSessionId: result.uuid, cwd: pointer.cwd };
  }

  // 'resume-fork'
  const pointer = message.payload;
  if (!pointer) throw new Error("resumeFork.acceptSeed: 'resume-fork' 메시지에 payload(pointer) 가 없습니다");
  const newUuid = genForkUuid();
  const name = ctx.newSessionName || `${pointer.sourceProfile}-fork-${newUuid.slice(0, 8)}`;
  const { session } = registerForkedSession({ pointer, newUuid, name, toolCommand: ctx.toolCommand || pointer.toolCommand });
  // source 는 건드리지 않는다 — lock/ack 없음(신규 독립 세션이므로).
  return { kind: 'register', session };
}

module.exports = {
  encodeCwd,
  pickLatestSessionId,
  buildResumePointer,
  resolveSourceJsonlPath,
  copyResumeJsonl,
  genForkUuid,
  lockSourceSession,
  isSessionLocked,
  checkAndApplyHandoffLock,
  seedRouteKind,
  acceptSeed,
};
