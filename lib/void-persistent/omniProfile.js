'use strict';

// void-omni-persistent — experiments 서브메뉴의 형제 기능.
//
// void-persistent(switchProfile.js)는 하나의 persist 디렉토리 아래 여러 claude
// 계정을 "풀링"해 자동/수동 전환하는 기능이다. void-omni-persistent 는 그와 달리
// 프로필마다 완전히 독립된 설정(toolCommand + omniroute_url + omniroute_api_key +
// model)을 갖는다 — 풀도 전환도 없다: 프로필 생성 → 격리 config 디렉토리 부여 →
// 실행 시 그 디렉토리 + CLI 별 omniroute env var(buildLaunchEnv 참고)를 얹어
// lib/runner.js 의 runTool 위에서 그대로 실행한다.
//
// switchProfile.js/configDb.js 의 기존 함수 시그니처는 건드리지 않는다 —
// 이 파일은 전적으로 새 문서 키(void_omni_persistent:profiles)와 새 config
// 디렉토리 네임스페이스(.omni-persist-<tool>-<name>) 위에서만 동작한다.
//
// 이 라운드에서 추가된 것:
//  - `model` 필드 — 프로필 생성 시 omniroute 콤보 중 하나를 선택해 고정한다
//    (claude 는 ANTHROPIC_MODEL, 아래 buildLaunchEnv 참고).
//  - checkOmnirouteHealth() — 프로필 생성 전, 입력한 omniroute_url 이 실제로
//    살아있는 인스턴스인지 /api/monitoring/health 로 사전 확인(인증 불필요).
//  - listCombos() — docker/models 의 `router.py list_combos` 를 셸아웃해 콤보
//    이름 목록을 가져온다(admin 관리 키 필요 — 아래 함수 주석 참고).

const fs = require('fs');

const configDb = require('../configDb');
const storage = require('../storage');
const { resolveOmniPersistProfileDir } = storage;

// docker/models/.env 의 OMNIROUTE_url_local 과 동일한 값 — omniroute_url 을
// 생략하면 이 로컬 기본값을 쓴다.
const DEFAULT_OMNIROUTE_URL = 'http://localhost:20128/v1';

// agy(Antigravity CLI) 는 제외 — 실제 바이너리(strings 덤프) 확인 결과 커스텀
// base_url/api_key 를 가리키는 env var 자체가 없다(Google 자체 OAuth 로그인
// 전용 구조, ANTIGRAVITY_* 는 내부 IPC 용). 나중에 실제 방법을 찾으면 다시
// 추가한다 — 그전까지는 확실히 동작하는 claude/codex만 지원.
const SUPPORTED_TOOL_COMMANDS = ['claude', 'codex'];

// CLI 별 omniroute 라우팅 env var 세트 — 실행 직전 process.env 에 얹었다가
// 실행 후 복원한다(runOmniPersistentSession 참고).
//  - claude: 로컬에서 실측 검증됨(2026-07) — ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN
//    (AUTH_TOKEN 이지 API_KEY 가 아님) + ANTHROPIC_API_KEY 를 강제로 빈 문자열로
//    비워서 부모 셸에서 상속된 진짜 키가 AUTH_TOKEN 을 이기지 못하게 한다 +
//    ANTHROPIC_MODEL(콤보 이름, 예: doil-combo).
//  - codex: 아직 claude 처럼 실측 검증되지 않았다 — 기존(이전 라운드)에 있던
//    OPENAI_BASE_URL/OPENAI_API_KEY 가정을 그대로 둔 것뿐이다. codex 도 claude 의
//    AUTH_TOKEN/MODEL 상당의 별도 env var 가 필요할 수 있음 — 실측 없이 임의로
//    "고치지" 말 것, 검증되기 전까지는 이 주석으로 계속 플래그만 해둔다.
function buildLaunchEnv(toolCommand, profile) {
  if (toolCommand === 'claude') {
    return {
      ANTHROPIC_BASE_URL: profile.omniroute_url,
      ANTHROPIC_AUTH_TOKEN: profile.omniroute_api_key,
      ANTHROPIC_API_KEY: '', // force-blank — 상속된 진짜 키가 AUTH_TOKEN 을 이기면 안 됨
      ANTHROPIC_MODEL: profile.model,
    };
  }
  if (toolCommand === 'codex') {
    return {
      OPENAI_BASE_URL: profile.omniroute_url,
      OPENAI_API_KEY: profile.omniroute_api_key,
    };
  }
  return {};
}

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

function createProfile({ name, toolCommand, omniroute_url, omniroute_api_key, model }) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
    return { ok: false, error: '유효하지 않은 이름입니다.' };
  }
  if (!SUPPORTED_TOOL_COMMANDS.includes(toolCommand)) {
    return { ok: false, error: `지원하지 않는 toolCommand: ${toolCommand}` };
  }
  // omniroute_url 은 더 이상 필수가 아니다 — 비어있으면 로컬 기본값을 쓴다.
  const url = (omniroute_url || '').trim() || DEFAULT_OMNIROUTE_URL;
  if (!omniroute_api_key || !model) {
    return { ok: false, error: 'omniroute_api_key / model 은 필수입니다.' };
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
    omniroute_url: url,
    omniroute_api_key,
    model,
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

  const session = { name: profile.name, toolCommand: profile.toolCommand, configDir, omniPersistent: true };
  const mode = { type: 'session', session };

  const envVars = buildLaunchEnv(profile.toolCommand, profile);
  const prevValues = {};
  for (const key of Object.keys(envVars)) {
    prevValues[key] = process.env[key];
    process.env[key] = envVars[key];
  }

  try {
    await runTool(tool, mode, c, config);
    return { ok: true };
  } finally {
    for (const key of Object.keys(envVars)) {
      if (prevValues[key] === undefined) delete process.env[key];
      else process.env[key] = prevValues[key];
    }
  }
}

// ── 헬스체크 ───────────────────────────────────────────────────────────────
// 프로필 생성 흐름에서 사용자가 입력(또는 기본값으로 채택)한 omniroute_url 이
// 실제로 살아있는 인스턴스인지 저장 전에 확인한다. /api/monitoring/health 는
// 인증이 필요 없다(실측 확인됨) — origin 은 omni.py 의 _mgmt_origins() 와 같은
// 방식으로 baseUrl 에서 트레일링 /v1 을 벗겨 구한다. 절대 throw 하지 않는다.
function checkOmnirouteHealth(baseUrl) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = String(baseUrl).replace(/\/v1\/?$/, '');
    } catch {
      resolve({ ok: false, error: 'invalid base URL' });
      return;
    }
    let url;
    let mod;
    try {
      url = `${origin}/api/monitoring/health`;
      mod = url.startsWith('https:') ? require('https') : require('http');
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
      return;
    }
    let req;
    try {
      req = mod.get(url, { timeout: 8000 }, (res) => {
        res.resume(); // drain — 상태 코드만 관심 대상
        resolve({ ok: res.statusCode === 200, error: res.statusCode === 200 ? null : `HTTP ${res.statusCode}` });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
      return;
    }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
  });
}

// ── 콤보 목록 ──────────────────────────────────────────────────────────────
// docker/models 의 `router.py list_combos` 를 셸아웃한다(routerPath() 는
// omnirouteUsageTier.js 에 이미 있는 라우터 경로 해석 로직 — 중복 구현하지
// 않고 그대로 재사용). 반환되는 각 콤보는 이름뿐 아니라 그 콤보를 구성하는
// 멤버 모델 id 목록(models: string[])도 함께 담고 있다 — 콤보 이름 자체를
// ANTHROPIC_MODEL 로 쓰면 Claude Code 의 /model 피커에 "opaque custom model"
// 하나로만 보여 개별 모델을 고를 수 없으므로, 호출부(launcher.js)가 콤보
// 이름이 아니라 그 안의 실제 모델 id 하나를 고르게 하기 위함이다. 주의:
// /api/combos 는 admin 관리 키(OMNIROUTE_key)로만 인증되므로, 이 함수는 이
// 머신이 docker/models 체크아웃 + 그 admin 키를 가진 경우에만 콤보를
// 돌려준다 — 진짜 외부(원격) omniroute 인스턴스를 가리키는
// void-omni-persistent 프로필에서는 그냥 실패(ok:false)한다. 이는 의도된/합의된
// 제약이며, "로컬이냐 원격이냐"를 URL 로 구분하려는 시도는 하지 않는다(호출부는
// 콤보 없음/조회 불가를 동일한 안내 메시지로 취급).
function listCombos() {
  const { routerPath } = require('./omnirouteUsageTier');
  const { spawnSync } = require('child_process');
  const rp = routerPath();
  if (!rp) return { ok: false, combos: [] };
  let result;
  try {
    result = spawnSync('python3', [rp, 'list_combos'], { encoding: 'utf8', timeout: 8000 });
  } catch {
    return { ok: false, combos: [] };
  }
  if (!result || result.error || result.status !== 0 || !result.stdout) return { ok: false, combos: [] };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, combos: [] };
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.combos)) {
    return { ok: false, combos: [] };
  }
  // "비어있음" = 콤보가 아예 없거나, 모든 콤보의 models 가 비어 고를 게 없는 경우.
  const combos = parsed.combos.filter(
    c => c && typeof c.name === 'string' && Array.isArray(c.models) && c.models.length > 0
  );
  if (combos.length === 0) return { ok: false, combos: [] };
  return { ok: true, combos };
}

module.exports = {
  isAvailable,
  SUPPORTED_TOOL_COMMANDS,
  DEFAULT_OMNIROUTE_URL,
  buildLaunchEnv,
  listProfiles,
  findProfile,
  createProfile,
  deleteProfile,
  runOmniPersistentSession,
  checkOmnirouteHealth,
  listCombos,
};
