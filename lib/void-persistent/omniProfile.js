'use strict';

// void-omni-persistent — experiments 서브메뉴의 형제 기능.
//
// void-persistent(switchProfile.js)는 하나의 persist 디렉토리 아래 여러 claude
// 계정을 "풀링"해 자동/수동 전환하는 기능이다. void-omni-persistent 는 그와 달리
// 프로필마다 완전히 독립된 설정(toolCommand + omniroute_url + omniroute_api_key)
// 을 갖는다 — 풀도 전환도 없다: 프로필 생성 → 격리 config 디렉토리 부여 →
// 실행 시 그 디렉토리 + omniroute BASE_URL/API_KEY env var 를 얹어 lib/runner.js
// 의 runTool 위에서 그대로 실행한다.
//
// switchProfile.js/configDb.js 의 기존 함수 시그니처는 건드리지 않는다 —
// 이 파일은 전적으로 새 문서 키(void_omni_persistent:profiles)와 새 config
// 디렉토리 네임스페이스(.omni-persist-<tool>-<name>) 위에서만 동작한다.

const fs = require('fs');

const configDb = require('../configDb');
const storage = require('../storage');
const { resolveOmniPersistProfileDir } = storage;

// agy(Antigravity CLI) 는 제외 — 실제 바이너리(strings 덤프) 확인 결과 커스텀
// base_url/api_key 를 가리키는 env var 자체가 없다(Google 자체 OAuth 로그인
// 전용 구조, ANTIGRAVITY_* 는 내부 IPC 용). 나중에 실제 방법을 찾으면 다시
// 추가한다 — 그전까지는 확실히 동작하는 claude/codex만 지원.
const SUPPORTED_TOOL_COMMANDS = ['claude', 'codex'];

// CLI 별 omniroute 라우팅 env var 매핑.
//  - claude → ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY — Anthropic 공식 지원
//    env var, 확실함.
//  - codex  → OPENAI_BASE_URL / OPENAI_API_KEY — 확실함.
const ENV_VAR_MAP = {
  claude: { baseUrl: 'ANTHROPIC_BASE_URL', apiKey: 'ANTHROPIC_API_KEY' },
  codex:  { baseUrl: 'OPENAI_BASE_URL', apiKey: 'OPENAI_API_KEY' },
};

// ── 가용성 게이트 ────────────────────────────────────────────────────────
// void-persistent(switchProfile.isAvailable)는 xtermFrame 의 컨트롤 패널
// (S 키로 pool 전환)에 의존하므로 node-pty/@xterm/headless 를 필수로 미리
// 점검한다. void-omni-persistent 는 그런 전환 UI가 없고 lib/runner.js 의
// runTool 위에서 그대로 실행되며, runTool 자체가 이미 xtermFrame → node-pty
// wrapper → spawnSync 순으로 graceful degrade 하므로 별도 사전 게이트가
// 필요 없다 — 항상 노출한다.
function isAvailable() {
  return true;
}

function listProfiles() {
  return configDb.getVoidOmniPersistentProfiles().profiles;
}

function findProfile(name) {
  return listProfiles().find(p => p.name === name) || null;
}

function createProfile({ name, toolCommand, omniroute_url, omniroute_api_key }) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
    return { ok: false, error: '유효하지 않은 이름입니다.' };
  }
  if (!SUPPORTED_TOOL_COMMANDS.includes(toolCommand)) {
    return { ok: false, error: `지원하지 않는 toolCommand: ${toolCommand}` };
  }
  if (!omniroute_url || !omniroute_api_key) {
    return { ok: false, error: 'omniroute_url / omniroute_api_key 는 필수입니다.' };
  }

  const state = configDb.getVoidOmniPersistentProfiles();
  if (state.profiles.some(p => p.name === name)) {
    return { ok: false, error: `이미 존재하는 프로필입니다: ${name}` };
  }

  const configDir = resolveOmniPersistProfileDir(toolCommand, name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const profile = {
    name,
    toolCommand,
    omniroute_url,
    omniroute_api_key,
    created_at: new Date().toISOString(),
  };
  state.profiles.push(profile);
  configDb.setVoidOmniPersistentProfiles(state);

  return { ok: true, profile, configDir };
}

function deleteProfile(name) {
  const state = configDb.getVoidOmniPersistentProfiles();
  const idx = state.profiles.findIndex(p => p.name === name);
  if (idx < 0) return { ok: false, error: `프로필을 찾을 수 없습니다: ${name}` };
  state.profiles.splice(idx, 1);
  configDb.setVoidOmniPersistentProfiles(state);
  return { ok: true };
}

// ── 실행 ─────────────────────────────────────────────────────────────────
// lib/runner.js 의 resolveSessionProfile 은 mode 로 { type:'session', session }
// 객체를 받으면 storage.js 의 sessions.json 조회 없이 그 세션 객체를 그대로
// 쓴다(runner.js:68-70) — 이 seam 을 그대로 재사용해 격리 configDir 적용을
// applySessionEnv 에 위임한다(named-session 과 동일 메커니즘, 새 코드 없음).
//
// runTool 은 env 오버라이드 파라미터를 받지 않는다(lib/runner.js:131). 최소
// 침습적으로 process.env 에 omniroute BASE_URL/API_KEY 를 임시로 얹었다가
// 실행 직후 복원한다 — runTool 내부의 `env = { ...process.env }` 스냅샷은
// 호출부가 `await runTool(...)` 로 넘어가기 전, 즉 이 함수가 env 를 세팅한
// 직후 동기적으로 실행되므로(async 함수는 첫 await 까지 동기 실행) 타이밍이
// 안전하다.
async function runOmniPersistentSession(tool, profile, c, config) {
  const { runTool } = require('../runner');

  const configDir = resolveOmniPersistProfileDir(profile.toolCommand, profile.name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const session = { name: profile.name, toolCommand: profile.toolCommand, configDir };
  const mode = { type: 'session', session };

  const envVars = ENV_VAR_MAP[profile.toolCommand];
  const prevValues = {};
  if (envVars) {
    prevValues[envVars.baseUrl] = process.env[envVars.baseUrl];
    prevValues[envVars.apiKey] = process.env[envVars.apiKey];
    process.env[envVars.baseUrl] = profile.omniroute_url;
    process.env[envVars.apiKey] = profile.omniroute_api_key;
  }

  try {
    await runTool(tool, mode, c, config);
    return { ok: true };
  } finally {
    if (envVars) {
      for (const key of [envVars.baseUrl, envVars.apiKey]) {
        if (prevValues[key] === undefined) delete process.env[key];
        else process.env[key] = prevValues[key];
      }
    }
  }
}

module.exports = {
  isAvailable,
  SUPPORTED_TOOL_COMMANDS,
  ENV_VAR_MAP,
  listProfiles,
  findProfile,
  createProfile,
  deleteProfile,
  runOmniPersistentSession,
};
