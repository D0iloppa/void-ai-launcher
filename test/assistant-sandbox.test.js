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
