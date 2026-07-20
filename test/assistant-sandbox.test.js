'use strict';

// lib/assistant.js의 "개인비서 샌드박스" 순수/파일시스템 로직 단위 테스트 —
// 실제 configDir(~/.config 등)은 절대 건드리지 않고 임시 디렉토리만 사용한다.
// 검증 대상: skills 심링크 생성/백필 멱등성, workspace 디렉토리 생성/백필 멱등성,
// DEFAULT_ALLOWED_TOOLS에서 'Agent'가 빠지고 Task/Skill은 남아 있는지.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assistant = require('../lib/assistant');

function mkTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'void-assistant-test-'));
}

// lib/assistant.js가 실제로 링크하는 대상 — 레포 루트의 공용 스킬 저장소(이미
// _global/g_skills/.gitkeep로 커밋돼 있는 실재 디렉토리). GLOBAL_SKILLS_DIR 자체는
// export되지 않으므로, 같은 계산식(__dirname/../_global/g_skills)으로 독립 계산한다.
const GLOBAL_SKILLS_DIR = path.join(__dirname, '..', '_global', 'g_skills');

test('DEFAULT_ALLOWED_TOOLS no longer contains the dead "Agent" entry, keeps Task/Skill', () => {
  const tools = assistant.DEFAULT_ALLOWED_TOOLS;
  assert.ok(Array.isArray(tools));
  assert.ok(!tools.includes('Agent'));
  assert.ok(tools.includes('Task'));
  assert.ok(tools.includes('Skill'));
});

test('linkAssistantSkills creates a symlink from configDir/skills to the global skills dir', () => {
  const configDir = mkTempConfigDir();
  try {
    assistant.linkAssistantSkills(configDir);

    const linkPath = path.join(configDir, 'skills');
    const stat = fs.lstatSync(linkPath);
    assert.ok(stat.isSymbolicLink());

    const resolved = path.resolve(configDir, fs.readlinkSync(linkPath));
    assert.equal(resolved, path.resolve(GLOBAL_SKILLS_DIR));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('linkAssistantSkills is idempotent (safe to call again on an existing correct link)', () => {
  const configDir = mkTempConfigDir();
  try {
    assistant.linkAssistantSkills(configDir);
    assert.doesNotThrow(() => assistant.linkAssistantSkills(configDir));

    const linkPath = path.join(configDir, 'skills');
    const resolved = path.resolve(configDir, fs.readlinkSync(linkPath));
    assert.equal(resolved, path.resolve(GLOBAL_SKILLS_DIR));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('linkAssistantSkills does not touch a pre-existing non-symlink skills dir', () => {
  const configDir = mkTempConfigDir();
  try {
    const linkPath = path.join(configDir, 'skills');
    fs.mkdirSync(linkPath); // 실제 디렉토리(심링크 아님)가 이미 있는 상황

    assistant.linkAssistantSkills(configDir);

    const stat = fs.lstatSync(linkPath);
    assert.ok(stat.isDirectory());
    assert.ok(!stat.isSymbolicLink());
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('ensureAssistantWorkspace creates <configDir>/workspace and returns its path', () => {
  const configDir = mkTempConfigDir();
  try {
    const workspaceDir = assistant.ensureAssistantWorkspace(configDir);
    assert.equal(workspaceDir, path.join(configDir, 'workspace'));
    assert.ok(fs.statSync(workspaceDir).isDirectory());
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('ensureAssistantWorkspace is idempotent (backfill on an already-provisioned profile)', () => {
  const configDir = mkTempConfigDir();
  try {
    const first = assistant.ensureAssistantWorkspace(configDir);
    const second = assistant.ensureAssistantWorkspace(configDir);
    assert.equal(first, second);
    assert.ok(fs.statSync(second).isDirectory());
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 온보딩 에이전트는 실제로 세션의 cwd(=<configDir>/workspace)에 persona.md를
// 쓴다 — personaPath는 이 워크스페이스 경로를 최우선으로 삼고, 있으면 그것을
// 반환해야 한다. (구 버전에서는 <configDir>/persona.md 루트만 봐서 워크스페이스에
// 쓰인 파일을 영영 찾지 못했다 — 이번에 고친 회귀 버그.)
test('personaPath prefers <configDir>/workspace/persona.md when it exists', () => {
  const configDir = mkTempConfigDir();
  try {
    const workspaceDir = path.join(configDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'persona.md'), '# workspace persona');

    assert.equal(assistant.personaPath(configDir), path.join(workspaceDir, 'persona.md'));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 이 기능 도입 이전에 configDir 루트에 직접 저장된 legacy persona.md도 계속
// 인식해야 한다(하위호환) — workspace에 파일이 없을 때만 폴백.
test('personaPath falls back to legacy <configDir>/persona.md when no workspace copy exists', () => {
  const configDir = mkTempConfigDir();
  try {
    fs.writeFileSync(path.join(configDir, 'persona.md'), '# legacy persona');

    assert.equal(assistant.personaPath(configDir), path.join(configDir, 'persona.md'));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 둘 다 없으면(아직 온보딩 전) workspace 경로를 "앞으로 쓰일 정본 위치"로 반환한다
// — 존재 여부 판단(fs.existsSync(personaPath(...)))이 세 경우 모두 옳게 동작하려면
// 필요한 동작.
test('personaPath returns the workspace path as the canonical location when neither file exists yet', () => {
  const configDir = mkTempConfigDir();
  try {
    assert.equal(assistant.personaPath(configDir), path.join(configDir, 'workspace', 'persona.md'));
    assert.ok(!fs.existsSync(assistant.personaPath(configDir)));
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// 루트 원인 버그의 회귀 테스트: workspace/persona.md만 있고 configDir 루트에는
// 없는 프로필(정확히 domi 프로필과 같은 모양)에서 refreshOnboardStatus가
// isOnboard를 true로 승격해야 한다.
// personaExists===true 분기는 saveAssistant(profile)을 호출해 assistants.json에
// 실제로 쓴다 — storage.js의 storageDir()이 매 호출마다 XDG_CONFIG_HOME을 다시
// 읽으므로, 실제 사용자 설정(~/.config/void-launcher/assistants.json)을 절대
// 건드리지 않도록 이 테스트에서만 임시 디렉토리로 스왑한다(resumeFork.test.js와
// 동일한 격리 패턴).
test('refreshOnboardStatus flips isOnboard to true when only workspace/persona.md exists', () => {
  const configDir = mkTempConfigDir();
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-assistant-test-xdg-'));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    const workspaceDir = path.join(configDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'persona.md'), '# persona');

    const profile = { name: 'regression-test', configDir, isOnboard: false };
    const result = assistant.refreshOnboardStatus(profile);

    assert.equal(result.isOnboard, true);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(xdgDir, { recursive: true, force: true });
  }
});

test('refreshOnboardStatus leaves isOnboard false when no persona.md exists anywhere', () => {
  const configDir = mkTempConfigDir();
  try {
    const profile = { name: 'regression-test-2', configDir, isOnboard: false };
    const result = assistant.refreshOnboardStatus(profile);

    assert.equal(result.isOnboard, false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// installSkillsFromDir — 외부 스킬 소스 디렉토리를 GLOBAL_SKILLS_DIR(또는 여기서는
// 실제 저장소를 오염시키지 않기 위한 임시 targetDir 오버라이드)에 심링크로 설치한다.
// mkTempConfigDir()과 같은 mkdtemp 패턴으로 소스/대상 양쪽 모두 임시 디렉토리를 쓴다.
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('installSkillsFromDir symlinks only directories containing SKILL.md, skips the rest', () => {
  const sourceDir = mkTempDir('void-skills-src-');
  const targetDir = mkTempDir('void-skills-target-');
  try {
    const skillDir = path.join(sourceDir, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# my skill');

    fs.mkdirSync(path.join(sourceDir, 'not-a-skill')); // 디렉토리지만 SKILL.md 없음
    fs.writeFileSync(path.join(sourceDir, 'README.md'), '# readme'); // 일반 파일

    const result = assistant.installSkillsFromDir(sourceDir, targetDir);

    assert.deepEqual(result.installed, ['my-skill']);
    assert.deepEqual(result.already, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.skipped.includes('not-a-skill'));
    assert.ok(result.skipped.includes('README.md'));

    const linkPath = path.join(targetDir, 'my-skill');
    const stat = fs.lstatSync(linkPath);
    assert.ok(stat.isSymbolicLink());
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(skillDir));
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installSkillsFromDir is idempotent — a second run reports "already", nothing re-created', () => {
  const sourceDir = mkTempDir('void-skills-src-');
  const targetDir = mkTempDir('void-skills-target-');
  try {
    const skillDir = path.join(sourceDir, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# my skill');

    const first = assistant.installSkillsFromDir(sourceDir, targetDir);
    assert.deepEqual(first.installed, ['my-skill']);

    const second = assistant.installSkillsFromDir(sourceDir, targetDir);
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.already, ['my-skill']);
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installSkillsFromDir records a conflict and does not overwrite a pre-existing real dir at the target name', () => {
  const sourceDir = mkTempDir('void-skills-src-');
  const targetDir = mkTempDir('void-skills-target-');
  try {
    const skillDir = path.join(sourceDir, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# my skill');

    const conflictPath = path.join(targetDir, 'my-skill');
    fs.mkdirSync(conflictPath, { recursive: true });
    fs.writeFileSync(path.join(conflictPath, 'sentinel.txt'), 'do not touch');

    const result = assistant.installSkillsFromDir(sourceDir, targetDir);

    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.conflicts, ['my-skill']);

    const stat = fs.lstatSync(conflictPath);
    assert.ok(stat.isDirectory());
    assert.ok(!stat.isSymbolicLink());
    assert.ok(fs.existsSync(path.join(conflictPath, 'sentinel.txt')));
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installSkillsFromDir returns an error result (does not throw) for a nonexistent sourceDir', () => {
  const targetDir = mkTempDir('void-skills-target-');
  const missingSource = path.join(targetDir, 'does-not-exist');
  try {
    const result = assistant.installSkillsFromDir(missingSource, targetDir);

    assert.deepEqual(result.installed, []);
    assert.ok(result.errors.length >= 1);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
