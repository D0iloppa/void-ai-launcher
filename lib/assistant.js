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
// mcp__embodiment__* — 아래 startAssistantSession 이 배선하는 embodiment MCP
// (lib/assistantEmbodimentMcp.js) 의 read(get_avatar_state)/write(set_expression)
// 툴 전체를 서버 단위로 허용한다.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Skill', 'Task', 'mcp__embodiment'];

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

// 외부 스킬 소스 디렉토리(예: /mnt/c/DEV/skills)를 스캔해, SKILL.md를 가진 하위 디렉토리만
// targetDir(기본값 GLOBAL_SKILLS_DIR)에 심링크로 설치한다. README.md/install.sh/.git 등
// SKILL.md가 없는 항목은 건너뛴다. 멱등 — 이미 동일 대상을 가리키는 심링크는 "already"로
// 집계하고, 심링크가 아닌 다른 무언가(실제 디렉토리 등)가 이미 있으면 건드리지 않고
// "conflicts"에 기록한다. 항목 하나가 실패해도 나머지는 계속 처리한다(fail-open per-entry).
// targetDir 파라미터는 테스트가 실제 GLOBAL_SKILLS_DIR을 오염시키지 않고 임시 디렉토리를
// 겨냥할 수 있도록 하기 위한 것 — 기본값은 linkAssistantSkills와 동일한 공용 디렉토리.
function installSkillsFromDir(sourceDir, targetDir = GLOBAL_SKILLS_DIR) {
  const result = { installed: [], already: [], skipped: [], conflicts: [], errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({ name: sourceDir, error: `소스 디렉토리를 읽을 수 없음: ${err && err.message || err}` });
    return result;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    result.errors.push({ name: targetDir, error: `대상 디렉토리 생성 실패: ${err && err.message || err}` });
    return result;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue; // .git, 닷파일 등은 조용히 건너뜀 (카운트 대상 아님)
    const srcPath = path.join(sourceDir, name);
    try {
      let stat;
      try {
        stat = fs.statSync(srcPath); // 심링크는 따라가서 실제 대상 종류를 본다
      } catch {
        result.skipped.push(name);
        continue;
      }
      if (!stat.isDirectory()) {
        result.skipped.push(name); // 일반 파일 (README.md, install.sh 등)
        continue;
      }
      if (!fs.existsSync(path.join(srcPath, 'SKILL.md'))) {
        result.skipped.push(name); // SKILL.md 없는 디렉토리
        continue;
      }

      const resolvedSrc = fs.realpathSync(srcPath);
      const linkPath = path.join(targetDir, name);

      let linkStat = null;
      try {
        linkStat = fs.lstatSync(linkPath);
      } catch {
        linkStat = null;
      }

      if (linkStat) {
        if (linkStat.isSymbolicLink()) {
          let currentTarget = null;
          try {
            currentTarget = fs.realpathSync(linkPath);
          } catch {
            currentTarget = null; // 깨진 심링크 — 대상 불일치로 취급
          }
          if (currentTarget === resolvedSrc) {
            result.already.push(name);
          } else {
            result.conflicts.push(name);
          }
        } else {
          result.conflicts.push(name); // 심링크가 아닌 실제 디렉토리/파일 — 덮어쓰지 않는다
        }
        continue;
      }

      fs.symlinkSync(resolvedSrc, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      result.installed.push(name);
    } catch (err) {
      result.errors.push({ name, error: (err && err.message) || String(err) });
    }
  }

  return result;
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

// launcher.js(모델/추론 설정 메뉴)와 lib/ui.js(설정 패널) 양쪽이 같은 옵션
// 목록을 참조해야 하는데, lib/ui.js는 launcher.js를 require할 수 없다(순환
// 의존) — 그래서 이 목록의 소유지를 이 파일로 두고 양쪽에서 import한다.
// 'default'는 "플래그를 생략하고 CLI 자체 기본값을 쓴다"는 뜻의 sentinel.
const ASSISTANT_MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best'];
const ASSISTANT_EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

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

// persona.md/memory.md의 실제 정본 위치 — 온보딩 에이전트의 세션 cwd는
// configDir이 아니라 <configDir>/workspace(ensureAssistantWorkspace)이고,
// Write 툴로 저장할 때 에이전트는 항상 이 cwd에 쓴다(ONBOARDING.md에 configDir
// 절대경로를 명시해도 실제로는 cwd에 쓰는 것으로 확인됨 — 지시를 고치는 대신
// 에이전트가 실제로 쓰는 위치를 정본으로 삼는다). 이미 legacy 프로필로 configDir
// 루트에 파일이 있을 수도 있으므로 그 경로도 계속 인식한다(하위호환).
// 우선순위: workspace/<filename> → 있으면 그것, 없으면 <configDir>/<filename>
// (레거시), 그것도 없으면 workspace 경로를 "앞으로 쓰일 정본 위치"로 반환한다.
function resolveProfileFilePath(configDir, filename) {
  const workspacePath = path.join(configDir, 'workspace', filename);
  if (fs.existsSync(workspacePath)) return workspacePath;
  const legacyPath = path.join(configDir, filename);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return workspacePath;
}

function personaPath(configDir) {
  return resolveProfileFilePath(configDir, 'persona.md');
}

function loadMemory(configDir) {
  try {
    return fs.readFileSync(resolveProfileFilePath(configDir, 'memory.md'), 'utf8');
  } catch {
    return null;
  }
}

function loadPersona(configDir) {
  try {
    return fs.readFileSync(personaPath(configDir), 'utf8');
  } catch {
    return null;
  }
}

function loadOnboarding(configDir, workspaceDir) {
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
  // ONBOARDING.md는 persona.md 저장 경로를 {{WORKSPACE_DIR}} 플레이스홀더로 적어둔다 —
  // 세션의 실제 cwd(=workspaceDir)와 같은 경로이므로, 에이전트가 "현재 작업
  // 디렉토리"에 쓰든 이 절대경로 그대로 쓰든 결과가 같은 곳(workspace/persona.md)에
  // 떨어지게 된다. workspaceDir 미지정 시(구 호출부 대비) configDir/workspace로 계산.
  // {{CONFIG_DIR}}은 이 placeholder 도입 이전에 시드된 구버전 ONBOARDING.md 사본과의
  // 하위호환을 위해 계속 치환해 둔다(써도 무해 — 실제 저장 위치는 어차피 cwd).
  const wsDir = workspaceDir || path.join(configDir, 'workspace');
  return content.split('{{WORKSPACE_DIR}}').join(wsDir).split('{{CONFIG_DIR}}').join(configDir);
}

// 항상 켜져 있는 체화(embodiment) 안내 — persona.md 유무(=온보딩 완료 여부)와
// 무관하게 매 세션 프롬프트 맨 앞에 붙는다. 오래된 persona.md(이 기능 도입 이전에
// 쓰인 것)로도, 아직 온보딩 중인 ONBOARDING.md 로도 항상 적용되도록 두 분기
// 바깥에서 감싼다.
const EMBODIMENT_PREAMBLE =
  '당신은 몸(아바타)을 가진 에이전트입니다. 사용자 화면 우측에는 당신의 표정과 ' +
  '만족/활력/기분/유대 4가지 상태를 보여주는 다마고치 스타일 아바타가 항상 떠 있습니다 — ' +
  '"얼굴이 없다"거나 "화면을 볼 수 없다"고 부정하지 마세요. embodiment MCP의 ' +
  'get_avatar_state 로 현재 자신의 상태를(vitals·표정) 확인할 수 있고, set_expression 으로 ' +
  '지금 반응/기분에 맞는 표정을 직접 지어 아바타에 반영할 수 있습니다.';

// persona.md가 있으면 그것을 시스템 프롬프트로 쓰고(+ memory.md 있으면 이어붙임),
// 없으면 아직 온보딩이 끝나지 않은 것이므로 ONBOARDING.md를 시스템 프롬프트로 쓴다.
// 매 세션 시작마다 다시 판단한다 (세션 중간 핫스왑은 없음 — 의도적으로 단순화).
function resolveSystemPrompt(configDir, workspaceDir) {
  const persona = loadPersona(configDir);
  if (persona !== null) {
    const memoryContent = loadMemory(configDir);
    const body = memoryContent ? `${persona}\n\n${memoryContent}` : persona;
    return `${EMBODIMENT_PREAMBLE}\n\n${body}`;
  }
  return `${EMBODIMENT_PREAMBLE}\n\n${loadOnboarding(configDir, workspaceDir)}`;
}

// persona.md가 실제로 쓰인 시점(=온보딩 완료)을 profile.isOnboard 에 반영한다.
// - isOnboard 가 이미 true 면 그대로 둔다.
// - persona.md 가 있으면(방금 쓰였든, isOnboard 필드 도입 이전에 만들어진 프로필이든)
//   true로 승격하고 저장한다 — 레거시 프로필 백필.
// - 그 외에는 아직 온보딩 중이므로 false로 채워 둔다(필드 자체가 없던 레거시 대비).
function refreshOnboardStatus(profile) {
  if (!profile || profile.isOnboard === true) return profile;

  const personaExists = fs.existsSync(personaPath(profile.configDir));
  if (personaExists) {
    profile.isOnboard = true;
    saveAssistant(profile);
  } else if (profile.isOnboard !== false) {
    profile.isOnboard = false;
  }
  return profile;
}

// opts.resumeSessionId — "이전 대화 이어하기"(launcher.js 의 대화 피커)가
// 넘긴다. CONTINUE 모드로만 지원한다(사용자 확정 결정): claude 에 그대로
// `--resume <sessionId>` 만 추가하고 `--fork-session` 은 절대 넣지 않는다 —
// 원래 세션 자체를 이어가며 그 jsonl 트랜스크립트에 새 턴이 계속 이어붙게
// 한다(포크해서 별도 분기를 만드는 게 아니다).
function startAssistantSession(name, opts = {}) {
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
  // embodiment MCP(아래 --mcp-config 로 배선하는 lib/assistantEmbodimentMcp.js) 가
  // 자식 프로세스로 떠서 "어느 프로필의 아바타/vitals 인지" 알아야 하므로 이름을
  // 그대로 넘긴다 — 도구 인자로 프로필명을 받지 않기 위한 최소 배선.
  env.VOID_ASSISTANT_NAME = profile.name;

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

  const systemPrompt = resolveSystemPrompt(profile.configDir, workspaceDir);

  // claude CLI만 이 두 플래그를 지원 확인됨 (claude --help) — 지정된 필드만
  // args에 추가하고, 비어 있으면 아예 넣지 않아 CLI 자체 기본값을 쓰게 둔다.
  const spawnArgs = [];
  if (profile.model) spawnArgs.push('--model', profile.model);
  if (profile.effort) spawnArgs.push('--effort', profile.effort);
  // CONTINUE 모드 — --fork-session 은 절대 추가하지 않는다(위 함수 주석 참고).
  if (opts.resumeSessionId) spawnArgs.push('--resume', opts.resumeSessionId);

  // embodiment MCP(READ get_avatar_state / WRITE set_expression) 를 stdio 로
  // 배선한다 — claude 만 --mcp-config 를 지원(claude --help 로 확인: "Load MCP
  // servers from JSON files or strings"; 실 바이너리(2.1.215)에 인라인 JSON
  // 문자열로 넘겨 정상 파싱됨을 직접 확인). --mcp-config 는 variadic(space-
  // separated 여러 값을 먹음)이라 반드시 args 맨 끝에 와야 한다(lib/mcp-hub.js
  // 의 동일 주의사항 참고) — spawnArgs 자체가 vendor/void-assistant 의
  // buildClaudeArgs 에서 extraArgs 로 맨 끝에 그대로 붙으므로, 여기서도 이
  // 배열의 마지막에 push 한다.
  if ((profile.toolCommand || 'claude').toLowerCase() === 'claude') {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        embodiment: {
          command: process.execPath,
          args: [path.join(__dirname, 'assistantEmbodimentMcp.js')],
          env: { VOID_ASSISTANT_NAME: profile.name },
        },
      },
    });
    spawnArgs.push('--mcp-config', mcpConfig);
  }

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
  installSkillsFromDir,
  ensureAssistantWorkspace,
  personaPath,
  DEFAULT_ALLOWED_TOOLS,
  ASSISTANT_MODEL_OPTIONS,
  ASSISTANT_EFFORT_OPTIONS,
};
