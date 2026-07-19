'use strict';

// EXPERIMENTAL — phase 1 (수동 계정 전환) ONLY.
//
// 이 모듈이 이 기능의 유일한 로직 보유처다: configDb.js/storage.js 는 얇은
// 저장 접근자만 갖고, xtermFrame.js 는 opts.experimentSwitch 로 게이팅된
// 순수 UI 훅만 갖는다 (undefined 이면 기존 동작과 byte-identical).
//
// 설계 근거 (already-verified, see CLAUDE.md/spec):
//   - Claude 크리덴셜 = <CLAUDE_CONFIG_DIR>/.credentials.json 의
//     claudeAiOauth 서브트리 + <CLAUDE_CONFIG_DIR>/.claude.json 의
//     oauthAccount 서브트리.
//   - claude --resume <sessionId> 는 헤드리스로도 동작 — persist 디렉토리를
//     고정한 채 크리덴셜만 갈아끼우고 --resume 하면 같은 세션이 이어진다.
//
// Phase 2(자동 전환)/phase 3(사용량 로컬 로그)는 여기서 시작하지 않는다 —
// 아래 seam 주석들이 그 지점을 표시한다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const configDb = require('../configDb');
const storage = require('../storage');
const { resolvePersistProfileDir } = storage;

// ── 가용성 게이트 ────────────────────────────────────────────────────────
// lib/xtermFrame.js 의 runXtermWrapped 가 node-pty/@xterm/headless 를 그대로
// require 하는 것과 동일한 방식으로 미리 점검한다 — 메뉴 아이템 자체를
// 숨기는 데 쓰인다(launcher.js 에서 defensive require + isAvailable()).
function isAvailable() {
  try {
    require('node-pty');
    require('@xterm/headless');
    return true;
  } catch {
    return false;
  }
}

// ── persist 프로필 ───────────────────────────────────────────────────────

function createExperimentProfile(name) {
  const configDir = resolvePersistProfileDir(name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // 새 크리덴셜을 미리 심지 않는다 — switchTo() 가 pool 첫 멤버에서 채워 넣는다.
  configDb.setExperimentSwitcher({
    enabled: true,
    persistDir: configDir,
    pool: [],
    activePoolIndex: -1,
    autoMode: false,
    autoState: {},
  });
  return configDir;
}

// ── pool CRUD ────────────────────────────────────────────────────────────
// pool 멤버는 storage.getSessions() 에 이미 등록된(claude 커맨드) 세션에 대한
// 참조({name, toolCommand}) 만 담는다 — 실제 configDir 은 항상
// getSession(name, toolCommand) 으로 조회해 이중 보관을 피한다.

function eligibleSessions() {
  return storage.getSessions().filter(s => (s.toolCommand || 'claude').toLowerCase() === 'claude');
}

function addPoolMember(name, toolCommand = 'claude') {
  const session = storage.getSession(name, toolCommand);
  if (!session) return { ok: false, error: `등록된 세션이 아닙니다: ${name}` };
  const state = configDb.getExperimentSwitcher();
  if (state.pool.some(m => m.name === name && (m.toolCommand || 'claude') === toolCommand)) {
    return { ok: false, error: '이미 pool 에 있습니다.' };
  }
  state.pool.push({ name, toolCommand, lastSessionId: null, lastCwd: null, lastAccountUuid: null });
  configDb.setExperimentSwitcher(state);
  return { ok: true, pool: state.pool };
}

function removePoolMember(index) {
  const state = configDb.getExperimentSwitcher();
  if (index < 0 || index >= state.pool.length) return { ok: false, error: '잘못된 인덱스' };
  state.pool.splice(index, 1);
  if (state.activePoolIndex === index) state.activePoolIndex = -1;
  else if (state.activePoolIndex > index) state.activePoolIndex -= 1;
  configDb.setExperimentSwitcher(state);
  return { ok: true, pool: state.pool };
}

// ── credential 파일 I/O ──────────────────────────────────────────────────

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 임시 파일에 쓴 뒤 renameSync — 부분 write 상태로 남는 것을 방지(atomic).
function writeJsonAtomic(file, data, mode = 0o600) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

function credentialsPath(dir) { return path.join(dir, '.credentials.json'); }
function claudeJsonPath(dir)  { return path.join(dir, '.claude.json'); }

// ── switchTo — mobius Switcher.switchTo 포팅 ────────────────────────────
// 1) source 읽기(NEVER mutate) → 2) persist 스냅샷(rollback 용) →
// 3) persist 원자적 write → 4) 실패 시 rollback → 5) 성공 시 activePoolIndex 갱신.
function switchTo(poolIndex) {
  const state = configDb.getExperimentSwitcher();
  const member = state.pool[poolIndex];
  if (!member) return { ok: false, error: '잘못된 pool 인덱스' };
  if (!state.persistDir) return { ok: false, error: 'persist 프로필이 없습니다. 먼저 생성하세요.' };

  const session = storage.getSession(member.name, member.toolCommand || 'claude');
  if (!session || !session.configDir) {
    return { ok: false, error: `세션을 찾을 수 없습니다: ${member.name}` };
  }
  const sourceDir = session.configDir; // NEVER mutate this directory

  // 1) source 읽기
  const sourceCreds = readJsonSafe(credentialsPath(sourceDir));
  const accessToken = sourceCreds && sourceCreds.claudeAiOauth && sourceCreds.claudeAiOauth.accessToken;
  if (!accessToken) {
    return { ok: false, error: `source 세션에 유효한 크리덴셜이 없습니다: ${member.name}` };
  }
  const sourceClaudeJson = readJsonSafe(claudeJsonPath(sourceDir)) || {};
  const sourceOauthAccount = sourceClaudeJson.oauthAccount;
  if (!sourceOauthAccount || typeof sourceOauthAccount !== 'object') {
    return { ok: false, error: `source 세션에 oauthAccount 정보가 없습니다: ${member.name}` };
  }

  const persistDir = state.persistDir;
  const persistCredsPath = credentialsPath(persistDir);
  const persistClaudeJsonPath = claudeJsonPath(persistDir);

  // 2) 현재 persist 상태 스냅샷 (rollback 용 — 파일이 없으면 null 로 기록)
  const snapshotCredsBytes = fs.existsSync(persistCredsPath) ? fs.readFileSync(persistCredsPath) : null;
  const snapshotClaudeJson = readJsonSafe(persistClaudeJsonPath);

  const restoreSnapshot = () => {
    try {
      if (snapshotCredsBytes) fs.writeFileSync(persistCredsPath, snapshotCredsBytes, { mode: 0o600 });
      else if (fs.existsSync(persistCredsPath)) fs.rmSync(persistCredsPath);
    } catch {}
    try {
      if (snapshotClaudeJson) writeJsonAtomic(persistClaudeJsonPath, snapshotClaudeJson);
      else if (fs.existsSync(persistClaudeJsonPath)) fs.rmSync(persistClaudeJsonPath);
    } catch {}
  };

  try {
    fs.mkdirSync(persistDir, { recursive: true, mode: 0o700 });

    // 3) 원자적 write — .credentials.json
    writeJsonAtomic(persistCredsPath, { claudeAiOauth: sourceCreds.claudeAiOauth }, 0o600);

    // .claude.json — 최초 seed 시엔 source 의 전체 .claude.json(단 projects 제외)
    // 을 복사해 온보딩/머신 플래그(hasCompletedOnboarding, userID, machineID,
    // theme, numStartups 등)를 물려받는다. 이게 없으면 claude 가 persist
    // 디렉토리를 신규 설치로 보고 대화형 온보딩/로그인을 요구한다(대화형에서만
    // 발생 — 헤드리스 -p 로는 재현되지 않는다). 이후 전환 시엔 persist 가 쌓아온
    // 상태(자체 projects 이력 등)를 보존하고 oauthAccount 만 patch 한다.
    const existing = readJsonSafe(persistClaudeJsonPath);
    let targetClaudeJson;
    if (existing) {
      targetClaudeJson = existing;
    } else {
      targetClaudeJson = { ...sourceClaudeJson };
      delete targetClaudeJson.projects; // persist 디렉토리는 자체 대화 이력을 쌓는다
    }
    targetClaudeJson.oauthAccount = sourceOauthAccount;
    writeJsonAtomic(persistClaudeJsonPath, targetClaudeJson, 0o600);
  } catch (err) {
    restoreSnapshot();
    return { ok: false, error: String(err && err.message || err) };
  }

  // 6) 성공 — 상태 갱신
  member.lastAccountUuid = sourceOauthAccount.accountUuid || null;
  state.activePoolIndex = poolIndex;
  configDb.setExperimentSwitcher(state);

  return {
    ok: true,
    persistDir,
    resumeSessionId: member.lastSessionId || null,
    resumeCwd: member.lastCwd || null,
  };
}

// ── 세션 캡처 ────────────────────────────────────────────────────────────

function encodeCwd(cwd) {
  return String(cwd || '').replace(/[\\/]/g, '-');
}

// persistDir/projects/<encodeCwd(cwd)>/*.jsonl 중 최신(mtime) 파일의
// basename(확장자 제외) 을 sessionId 로 반환한다.
function captureLastSession(persistDir, cwd) {
  try {
    const projDir = path.join(persistDir, 'projects', encodeCwd(cwd));
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

// ── 실행 루프 ────────────────────────────────────────────────────────────
// runner.js 의 runTool 은 건드리지 않는다 — 이 함수가 유일한 신규 호출부다.
// (lib/runner.js ~lines 131-257 의 env/wrapOpts 구성 방식을 참고해 여기서
// 독립적으로 재현한다.)
async function runExperimentSession(tool, c, config) {
  const { runXtermWrapped, applyTheme } = require('../xtermFrame');
  const { loadTheme } = require('../theme');

  const state = configDb.getExperimentSwitcher();
  if (!state.persistDir || state.pool.length === 0) {
    return { ok: false, error: 'persist 프로필 또는 pool 이 비어 있습니다.' };
  }

  let activeIndex = state.activePoolIndex;
  // 최초 실행(아직 한 번도 switchTo 되지 않음) — pool 첫 멤버로 전환해 persist
  // 디렉토리에 크리덴셜을 채워 넣는다.
  if (activeIndex < 0) {
    const first = switchTo(0);
    if (!first.ok) return first;
    activeIndex = 0;
  }

  const settings = (config && config.settings) || {};
  const palette = config ? loadTheme(config) : {};
  try { applyTheme(palette); } catch {}
  const wrapOptsBase = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
  };

  // restartSignal: mutable box the xtermFrame panel writes into when the user
  // picks S (switch) — its presence after runXtermWrapped resolves means
  // "relaunch with a new active member", its absence means "child exited
  // normally, return to menu".
  let restartSignal = { requested: null };

  while (true) {
    const currentState = configDb.getExperimentSwitcher();
    const member = currentState.pool[activeIndex];
    if (!member) return { ok: false, error: '활성 pool 멤버를 찾을 수 없습니다.' };

    const env = { ...process.env };
    env.CLAUDE_CONFIG_DIR = currentState.persistDir;

    const baseArgs = tool.args || [];
    const resumeId = member.lastSessionId;
    const args = resumeId ? [...baseArgs, '--resume', resumeId] : [...baseArgs];
    const toolObj = { command: tool.command, args };

    const label = `✳ ${tool.name}  [experiment:${member.name}]`;

    restartSignal.requested = null;
    const wrapOpts = {
      ...wrapOptsBase,
      experimentSwitch: {
        pool: currentState.pool,
        activePoolIndex: activeIndex,
        autoMode: Boolean(currentState.autoMode),
        // phase 2 (자동 전환): 백그라운드 폴러(lib/usageWarmup.js →
        // lib/experiments/autoSwitchDriver.js)가 남긴 pendingRestart 를
        // xtermFrame 의 barTimer 틱이 소비한다 — 수동 S 키와 동일한
        // onControlAction 경로로 재시작을 유발한다.
        pollPendingRestart: () => require('./autoSwitchDriver').consumePendingRestart(),
      },
      onControlAction: async (action) => {
        if (!action || action.type !== 'switch') return;
        const result = switchTo(action.poolIndex);
        if (result.ok) {
          restartSignal.requested = {
            configDir: result.persistDir,
            resumeSessionId: result.resumeSessionId,
            resumeCwd: result.resumeCwd,
            poolIndex: action.poolIndex,
          };
        }
      },
      restartSignal,
    };

    const wrapped = await runXtermWrapped(toolObj, env, label, wrapOpts);
    if (!wrapped) {
      return { ok: false, error: 'xterm wrapper 를 사용할 수 없습니다 (node-pty/TTY 미지원 환경).' };
    }

    // 방금 활성이었던 세션의 최신 sessionId 를 캡처해 다음 --resume 에 대비한다.
    const sid = captureLastSession(currentState.persistDir, process.cwd());
    if (sid) {
      const freshState = configDb.getExperimentSwitcher();
      const freshMember = freshState.pool[activeIndex];
      if (freshMember) {
        freshMember.lastSessionId = sid;
        freshMember.lastCwd = process.cwd();
        configDb.setExperimentSwitcher(freshState);
      }
    }

    if (!restartSignal.requested) {
      return { ok: true };
    }

    // 전환 요청됨 — 새 활성 인덱스로 루프를 이어 재실행한다.
    activeIndex = restartSignal.requested.poolIndex;
  }
}

module.exports = {
  isAvailable,
  createExperimentProfile,
  eligibleSessions,
  addPoolMember,
  removePoolMember,
  switchTo,
  captureLastSession,
  runExperimentSession,
  encodeCwd,
};
