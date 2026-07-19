'use strict';
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getAssistants, saveAssistant, deleteAssistant, getAssistant,
  resolveAssistantConfigDir,
} = require('./storage');

// 저장소 루트의 마스터 템플릿 — 새 프로필의 configDir에 최초 1회만 복사된다
// (usageDb.js의 레거시 마이그레이션과 동일한 "없으면 복사, 있으면 건드리지 않음" 원칙).
const ONBOARDING_TEMPLATE_PATH = path.join(__dirname, '..', 'ONBOARDING.md');

// lib/sessions.js의 세션명 검증과 동일한 규칙을 재사용한다 (영문/숫자로 시작, 영문/숫자/- 허용).
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// 'Agent'는 제거됨 — 실제 설치된 claude CLI(2.1.215)를 --allowedTools 값을 바꿔가며
// 실증 테스트한 결과, system/init 이벤트가 알려주는 세션의 실제 tools 카탈로그에는
// 'Task'만 있고 'Agent'는 존재하지 않는다(서브에이전트 스폰 tool_use 블록 자체는
// "name":"Agent"로 표시되지만, 그건 내부 표시명일 뿐 --allowedTools/카탈로그 상의
// 유효한 토큰은 'Task'다). 즉 'Agent'는 목록에 있어도 아무것도 매칭하지 않는 죽은
// 항목이었다 — Task/Skill만 남긴다.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Skill', 'Task'];

// 레포 루트의 공용 스킬 저장소 — cmd_generator.js의 linkGlobalSkills()가 네임드 CLI
// 세션(sessions.json)에 연결하는 것과 동일한 디렉토리. 그 함수는 건드리지 않고,
// 어시스턴트 프로필 전용 병행 경로로 아래에서 따로 연결한다.
const GLOBAL_SKILLS_DIR = path.join(__dirname, '..', '_global', 'g_skills');

function fmtNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 프로세스 전역에서 동시에 상주하는 어시스턴트 세션은 하나뿐 — 네임드 CLI 세션 전환과
// 동일한 단순화. 동시 다중 어시스턴트가 필요해지면 이 부분만 맵으로 바꾸면 된다.
let currentSession = null;
let currentSessionName = null;

// uv로 격리된 Python venv를 configDir 안에 만든다. uv가 없거나 실패하면
// 프로필 생성 자체를 실패시킨다 (호출자가 표시할 수 있는 구체적인 에러 메시지와 함께) —
// 깨지거나 없는 venv로 조용히 넘어가지 않는다.
function createAssistantVenv(configDir) {
  const venvDir = path.join(configDir, 'venv');
  let result;
  try {
    result = spawnSync('uv', ['venv', venvDir], { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    throw new Error(`Python venv 생성 실패 (uv 실행 불가): ${err && err.message || err}`);
  }

  if (result.error) {
    throw new Error(`Python venv 생성 실패 (uv 실행 불가): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Python venv 생성 실패 (uv venv 종료 코드 ${result.status}): ${detail || '알 수 없는 오류'}`);
  }
}

// 공유 온보딩 템플릿을 프로필의 configDir에 최초 1회만 시드한다 — 있으면 덮어쓰지 않는다.
function seedOnboardingTemplate(configDir) {
  const dest = path.join(configDir, 'ONBOARDING.md');
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(ONBOARDING_TEMPLATE_PATH, dest);
  }
}

// _global/g_skills → <configDir>/skills 심링크. cmd_generator.js의 linkGlobalSkills()와
// 같은 방식(디렉토리 심볼릭 링크, Windows는 junction)이지만 이 함수는 어시스턴트
// 프로필만 대상으로 한다. 프로필 생성 시 + 세션 시작 시(레거시 프로필 백필) 양쪽에서
// 호출되는 멱등 연산 — 이미 정상 연결돼 있으면 아무것도 하지 않고, 링크가 아닌 다른
// 무언가가 이미 있으면 건드리지 않는다. 실패해도 세션 시작을 막지 않는다(fail-open).
function linkAssistantSkills(configDir) {
  try {
    fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true, mode: 0o700 });
    const linkPath = path.join(configDir, 'skills');
    if (fs.existsSync(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const current = path.resolve(configDir, fs.readlinkSync(linkPath));
        if (current === path.resolve(GLOBAL_SKILLS_DIR)) return; // 이미 정상 연결됨
      }
      return; // 심링크가 아닌 다른 것이 이미 있으면 건드리지 않는다
    }
    fs.symlinkSync(GLOBAL_SKILLS_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // 권한/플랫폼 문제로 실패해도 어시스턴트 세션 자체는 정상적으로 시작돼야 한다.
  }
}

// 어시스턴트 전용 작업공간(rw) — 자격증명/venv/persona가 있는 configDir과 분리해,
// Bash/Write 등 실제 작업 산출물은 여기 담는다. 프로필 생성 시 + 세션 시작 시(레거시
// 프로필 백필) 양쪽에서 호출되는 멱등 연산. mkdirSync 실패 시에도 세션 시작을 막지
// 않도록 configDir 자체로 폴백한다(호출자가 그대로 cwd로 써도 안전).
function ensureAssistantWorkspace(configDir) {
  const workspaceDir = path.join(configDir, 'workspace');
  try {
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    return workspaceDir;
  } catch {
    return configDir;
  }
}

// c 는 선택값이다: 전달되면(그리고 토큰이 하나 이상 등록되어 있으면) 생성 직후
// lib/tokens.js의 pickRegisteredToken UI로 이 프로필에 연결할 토큰을 바로 고르게
// 한다. c 를 생략하거나 사용자가 취소/미등록이면 record.tokenService/tokenAlias는
// 비워둔다 — 채팅 진입 시 launcher.js의 ensureAssistantAuthToken 이 이를 감지해
// 안내하고, 나중에 어시스턴트 상세 메뉴에서 링크/재연결할 수 있다.
async function createAssistantProfile(name, { toolCommand, c, model, effort } = {}) {
  if (!name || !NAME_RE.test(name)) {
    throw new Error('유효하지 않은 어시스턴트 이름입니다. 영문/숫자/-만 사용, 영문 또는 숫자로 시작해야 합니다.');
  }

  const command = (toolCommand || 'claude').toLowerCase();
  const configDir = resolveAssistantConfigDir(command, name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  createAssistantVenv(configDir);
  seedOnboardingTemplate(configDir);
  linkAssistantSkills(configDir);
  ensureAssistantWorkspace(configDir);

  const record = {
    name,
    toolCommand: command,
    configDir,
    created_at: fmtNow(),
    isOnboard: false,
  };

  // model/effort는 선택값 — 지정되지 않으면 claude CLI 자체 기본값을 쓰도록
  // 필드를 아예 비워 둔다 (기본값 강제는 UI/온보딩 레이어의 몫).
  if (model) record.model = model;
  if (effort) record.effort = effort;

  if (c && command === 'claude') {
    try {
      const { pickRegisteredToken } = require('./tokens');
      const picked = await pickRegisteredToken(c);
      if (picked) {
        record.tokenService = picked.service;
        record.tokenAlias = picked.alias;
      }
    } catch {
      // 토큰 선택 UI 실패는 프로필 생성 자체를 막지 않는다 — 링크는 나중에도 가능.
    }
  }

  saveAssistant(record);
  return record;
}

function listAssistantProfiles() {
  return getAssistants().map(refreshOnboardStatus);
}

function removeAssistantProfile(name) {
  if (currentSessionName === name && currentSession) {
    try { currentSession.stop(); } catch {}
    currentSession = null;
    currentSessionName = null;
  }
  // configDir(및 그 안의 OAuth 자격증명)은 세션 등록 해제와 동일하게 보존한다 —
  // lib/sessions.js의 '세션 등록 해제'와 같은 정책 (완전 삭제는 별도 UI 동작으로 남겨둔다).
  deleteAssistant(name);
}

function applyAssistantEnv(env, profile) {
  const command = (profile.toolCommand || 'claude').toLowerCase();
  if (command === 'codex') {
    env.CODEX_HOME = profile.configDir;
    return;
  }
  if (command === 'agy') {
    env.AGY_HOME = profile.configDir;
    env.AGY_CONFIG_DIR = profile.configDir;
    return;
  }
  env.CLAUDE_CONFIG_DIR = profile.configDir;
}

function loadMemory(configDir) {
  const memoryPath = path.join(configDir, 'memory.md');
  try {
    return fs.readFileSync(memoryPath, 'utf8');
  } catch {
    return null;
  }
}

function loadPersona(configDir) {
  const personaPath = path.join(configDir, 'persona.md');
  try {
    return fs.readFileSync(personaPath, 'utf8');
  } catch {
    return null;
  }
}

function loadOnboarding(configDir) {
  const onboardingPath = path.join(configDir, 'ONBOARDING.md');
  let content;
  try {
    content = fs.readFileSync(onboardingPath, 'utf8');
  } catch {
    // 온보딩 파일이 이 프로필에 시드되지 않은 예외적인 경우(예: 이 기능 도입 이전에
    // 만들어진 프로필) — 저장소 루트의 마스터 템플릿으로 폴백한다.
    try {
      content = fs.readFileSync(ONBOARDING_TEMPLATE_PATH, 'utf8');
    } catch {
      return '';
    }
  }
  // ONBOARDING.md는 persona.md 저장 경로를 {{CONFIG_DIR}} 플레이스홀더로 적어둔다 —
  // 세션의 cwd가 이제 configDir이 아니라 workspace이므로(작업 2), "현재 작업
  // 디렉토리"에 저장하라고 하면 잘못된 곳(workspace)에 쓰이게 된다. loadPersona가
  // 읽는 위치는 그대로 configDir이므로, 여기서 세션 시작 시점의 실제 절대경로로
  // 치환해 어시스턴트가 정확히 그 경로에 저장하도록 지시한다.
  return content.split('{{CONFIG_DIR}}').join(configDir);
}

// persona.md가 있으면 그것을 시스템 프롬프트로 쓰고(+ memory.md 있으면 이어붙임),
// 없으면 아직 온보딩이 끝나지 않은 것이므로 ONBOARDING.md를 시스템 프롬프트로 쓴다.
// 매 세션 시작마다 다시 판단한다 (세션 중간 핫스왑은 없음 — 의도적으로 단순화).
function resolveSystemPrompt(configDir) {
  const persona = loadPersona(configDir);
  if (persona !== null) {
    const memoryContent = loadMemory(configDir);
    return memoryContent ? `${persona}\n\n${memoryContent}` : persona;
  }
  return loadOnboarding(configDir);
}

// persona.md가 실제로 쓰인 시점(=온보딩 완료)을 profile.isOnboard 에 반영한다.
// - isOnboard 가 이미 true 면 그대로 둔다.
// - persona.md 가 있으면(방금 쓰였든, isOnboard 필드 도입 이전에 만들어진 프로필이든)
//   true로 승격하고 저장한다 — 레거시 프로필 백필.
// - 그 외에는 아직 온보딩 중이므로 false로 채워 둔다(필드 자체가 없던 레거시 대비).
function refreshOnboardStatus(profile) {
  if (!profile || profile.isOnboard === true) return profile;

  const personaExists = fs.existsSync(path.join(profile.configDir, 'persona.md'));
  if (personaExists) {
    profile.isOnboard = true;
    saveAssistant(profile);
  } else if (profile.isOnboard !== false) {
    profile.isOnboard = false;
  }
  return profile;
}

function startAssistantSession(name) {
  const profile = getAssistant(name);
  if (!profile) {
    throw new Error(`'${name}' 어시스턴트 프로필을 찾을 수 없습니다.`);
  }

  if (currentSession) {
    try { currentSession.stop(); } catch {}
    currentSession = null;
    currentSessionName = null;
  }

  // 이 기능 도입 이전에 만들어진 프로필(skills 링크/workspace 없음)에 대한
  // lazy backfill — 멱등이라 매번 호출해도 안전하다.
  linkAssistantSkills(profile.configDir);
  const workspaceDir = ensureAssistantWorkspace(profile.configDir);

  const env = { ...process.env };
  applyAssistantEnv(env, profile);

  // 격리된 configDir 에는 .credentials.json 이 없어 claude 가 바로 로그인 실패하므로,
  // 이 프로필에 명시적으로 연결된(profile.tokenService/tokenAlias) 토큰을 일반 토큰
  // 저장소(lib/config.js → configDb.js 의 token:<service>:<alias>)에서 찾아 주입한다
  // (config-dir 는 작업공간 격리용, 이 토큰은 .credentials.json 없이도 되는 인증용 —
  // 둘 다 함께 필요). 더 이상 'claude' 서비스의 "아무 alias나" 암묵적으로 고르지
  // 않는다 — 여러 계정을 등록해 두고 프로필마다 다른 토큰을 명시적으로 지정할 수
  // 있어야 하기 때문. 링크가 없거나 링크된 토큰을 찾지 못하면 조용히 넘어간다 —
  // 호출자(launcher.js)가 채팅 진입 전에 이미 존재 여부를 확인해 안내하는 책임을 진다.
  const command = (profile.toolCommand || 'claude').toLowerCase();
  if (command === 'claude' && profile.tokenService && profile.tokenAlias) {
    const token = require('./config').getToken(profile.tokenService, profile.tokenAlias);
    if (token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  }

  // 이 프로필 전용 venv를 활성화 — 어시스턴트가 Bash 툴로 실행하는 Python은
  // 시스템 Python이 아니라 이 격리된 venv 안에서 돌아가야 한다.
  const venvDir = path.join(profile.configDir, 'venv');
  env.VIRTUAL_ENV = venvDir;
  // uv venv 는 Windows 에서 bin/ 이 아니라 Scripts/ 를 만들고, PATH 구분자도
  // ':' 가 아니라 ';' 다 — path.join/path.delimiter 로 플랫폼에 맞춰 계산.
  const venvBinDir = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  env.PATH = `${venvBinDir}${path.delimiter}${env.PATH || ''}`;

  const systemPrompt = resolveSystemPrompt(profile.configDir);

  // claude CLI만 이 두 플래그를 지원 확인됨 (claude --help) — 지정된 필드만
  // args에 추가하고, 비어 있으면 아예 넣지 않아 CLI 자체 기본값을 쓰게 둔다.
  const spawnArgs = [];
  if (profile.model) spawnArgs.push('--model', profile.model);
  if (profile.effort) spawnArgs.push('--effort', profile.effort);

  const { createSession } = require('../vendor/void-assistant');
  const session = createSession({
    command: profile.toolCommand,
    args: spawnArgs,
    env,
    cwd: workspaceDir, // 자격증명/venv/persona가 있는 configDir 대신 전용 workspace를 cwd로 — HOME/XDG는 실사용자 것을 그대로 상속한다(진짜 HOME 샌드박스 아님)
    systemPrompt,
    allowedTools: DEFAULT_ALLOWED_TOOLS,
  });

  currentSession = session;
  currentSessionName = name;
  return session;
}

function getActiveAssistantSession() {
  return currentSession;
}

module.exports = {
  createAssistantProfile,
  listAssistantProfiles,
  removeAssistantProfile,
  startAssistantSession,
  getActiveAssistantSession,
  refreshOnboardStatus,
  linkAssistantSkills,
  ensureAssistantWorkspace,
  DEFAULT_ALLOWED_TOOLS,
};
