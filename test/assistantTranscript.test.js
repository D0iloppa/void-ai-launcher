'use strict';

// lib/assistantTranscript.js 테스트 — claude jsonl 트랜스크립트를 개인비서
// "이전 대화 이어하기" 화면 시딩용 { who, text } 엔트리로 파싱하는 순수 로직 +
// 얇은 fs wrapper(resolveTranscriptPath/readTranscript)의 실제 디렉토리 스모크
// 테스트. dashedFolderName 은 실제 온디스크 프로필
// (/home/doil/.assistant-claude-domi) 로 직접 검증됨 — 아래 마지막 테스트 참고.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transcript = require('../lib/assistantTranscript');

// ── parseTranscript: pure, no fs ────────────────────────────────────────

test('parseTranscript: extracts plain string content from user/assistant lines, in order', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: '안녕' } }),
    JSON.stringify({ type: 'assistant', message: { content: '안녕하세요!' } }),
  ].join('\n');
  const { entries } = transcript.parseTranscript(jsonl);
  assert.deepEqual(entries, [
    { who: 'user', text: '안녕' },
    { who: 'assistant', text: '안녕하세요!' },
  ]);
});

test('parseTranscript: joins text blocks from array-of-blocks content, skipping tool_use/tool_result/thinking blocks', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'internal reasoning, not shown' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: '결과를 확인했어요.' },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'x', content: 'file listing here' },
    ] } }),
  ].join('\n');
  const { entries } = transcript.parseTranscript(jsonl);
  // tool_result-only user turn has no 'text' block, so it's dropped entirely.
  assert.deepEqual(entries, [{ who: 'assistant', text: '결과를 확인했어요.' }]);
});

test('parseTranscript: multiple text blocks in one turn are joined with newlines', () => {
  const jsonl = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'part one' },
    { type: 'text', text: 'part two' },
  ] } });
  const { entries } = transcript.parseTranscript(jsonl);
  assert.equal(entries[0].text, 'part one\npart two');
});

test('parseTranscript: extracts a best-effort ai-title line and excludes it from entries', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: '질문' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: '온보딩 문제 확인', sessionId: 'abc' }),
    JSON.stringify({ type: 'assistant', message: { content: '답변' } }),
  ].join('\n');
  const { entries, aiTitle } = transcript.parseTranscript(jsonl);
  assert.equal(aiTitle, '온보딩 문제 확인');
  assert.equal(entries.length, 2);
});

test('parseTranscript: skips non-user/assistant line types (queue-operation, attachment, last-prompt, summary)', () => {
  const jsonl = [
    JSON.stringify({ type: 'queue-operation', op: 'noop' }),
    JSON.stringify({ type: 'attachment', name: 'file.png' }),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'last-prompt', text: 'ignored' }),
    JSON.stringify({ type: 'summary', note: 'ignored' }),
  ].join('\n');
  const { entries } = transcript.parseTranscript(jsonl);
  assert.deepEqual(entries, [{ who: 'user', text: 'hello' }]);
});

test('parseTranscript: tolerates malformed/blank lines without throwing or dropping valid ones', () => {
  const jsonl = [
    '{ not valid json',
    '',
    '   ',
    JSON.stringify({ type: 'user', message: { content: 'still works' } }),
    'also not json {{{',
  ].join('\n');
  const { entries } = transcript.parseTranscript(jsonl);
  assert.deepEqual(entries, [{ who: 'user', text: 'still works' }]);
});

test('parseTranscript: non-string input yields an empty result rather than throwing', () => {
  assert.deepEqual(transcript.parseTranscript(undefined), { entries: [], aiTitle: null });
  assert.deepEqual(transcript.parseTranscript(null), { entries: [], aiTitle: null });
});

// ── entriesToMarkdown: pure serialization, no fs ─────────────────────────

test('entriesToMarkdown: renders a title heading and a section per entry', () => {
  const md = transcript.entriesToMarkdown(
    [
      { who: 'user', text: '안녕' },
      { who: 'assistant', text: '안녕하세요!' },
    ],
    { title: '테스트 대화' }
  );
  assert.match(md, /^# 테스트 대화/);
  assert.match(md, /## 👤 User/);
  assert.match(md, /안녕/);
  assert.match(md, /## 🤖 Assistant/);
  assert.match(md, /안녕하세요!/);
});

test('entriesToMarkdown: falls back to a default title and tolerates an empty entries list', () => {
  const md = transcript.entriesToMarkdown([], {});
  assert.match(md, /^# 새 대화/);
});

// ── dashedFolderName: the pure cwd→folder-name transform ────────────────

test('dashedFolderName: replaces every / and . with -', () => {
  assert.equal(
    transcript.dashedFolderName('/home/doil/.assistant-claude-domi'),
    '-home-doil--assistant-claude-domi'
  );
  assert.equal(
    transcript.dashedFolderName('/home/doil/.assistant-claude-domi/workspace'),
    '-home-doil--assistant-claude-domi-workspace'
  );
});

// ── resolveTranscriptPath / readTranscript: thin fs wrappers ────────────

test('resolveTranscriptPath: prefers the workspace-cwd folder over the legacy configDir-cwd folder', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-transcript-test-'));
  const workspaceDir = path.join(configDir, 'workspace');
  const sessionId = 'sess-1';

  const wsFolder = transcript.dashedFolderName(workspaceDir);
  const legacyFolder = transcript.dashedFolderName(configDir);
  fs.mkdirSync(path.join(configDir, 'projects', wsFolder), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'projects', legacyFolder), { recursive: true });
  const wsPath = path.join(configDir, 'projects', wsFolder, `${sessionId}.jsonl`);
  const legacyPath = path.join(configDir, 'projects', legacyFolder, `${sessionId}.jsonl`);
  fs.writeFileSync(wsPath, JSON.stringify({ type: 'user', message: { content: 'from workspace' } }));
  fs.writeFileSync(legacyPath, JSON.stringify({ type: 'user', message: { content: 'from legacy' } }));

  const resolved = transcript.resolveTranscriptPath(configDir, workspaceDir, sessionId);
  assert.equal(resolved, wsPath);

  fs.rmSync(configDir, { recursive: true, force: true });
});

test('resolveTranscriptPath: falls back to the legacy configDir-cwd folder when workspace has none', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-transcript-test-'));
  const workspaceDir = path.join(configDir, 'workspace');
  const sessionId = 'sess-2';

  const legacyFolder = transcript.dashedFolderName(configDir);
  fs.mkdirSync(path.join(configDir, 'projects', legacyFolder), { recursive: true });
  const legacyPath = path.join(configDir, 'projects', legacyFolder, `${sessionId}.jsonl`);
  fs.writeFileSync(legacyPath, JSON.stringify({ type: 'user', message: { content: 'from legacy' } }));

  const resolved = transcript.resolveTranscriptPath(configDir, workspaceDir, sessionId);
  assert.equal(resolved, legacyPath);

  fs.rmSync(configDir, { recursive: true, force: true });
});

test('resolveTranscriptPath: returns null when neither folder has the sessionId jsonl', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-transcript-test-'));
  const workspaceDir = path.join(configDir, 'workspace');
  assert.equal(transcript.resolveTranscriptPath(configDir, workspaceDir, 'missing-session'), null);
  fs.rmSync(configDir, { recursive: true, force: true });
});

test('readTranscript: reads and parses a real file end-to-end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-transcript-read-test-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'hello!' } }),
  ].join('\n'));

  const { entries } = transcript.readTranscript(file);
  assert.deepEqual(entries, [{ who: 'user', text: 'hi' }, { who: 'assistant', text: 'hello!' }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTranscript: missing file fails open with an empty result', () => {
  assert.deepEqual(transcript.readTranscript('/no/such/path.jsonl'), { entries: [], aiTitle: null });
});

// ── Sanity check against the real on-disk domi profile (best-effort) ────
// 실제 /home/doil/.assistant-claude-domi/projects/ 폴더명이 dashedFolderName
// 의 결과와 실제로 일치하는지 확인한다. 그 프로필이 이 실행 환경에 없으면
// (다른 머신/CI) 조용히 스킵한다 — 이 테스트의 목적은 로컬 실사용 데이터에
// 대한 회귀 감시이지, 이식 가능한 계약 테스트가 아니다(그건 위 dashedFolderName
// 단위 테스트가 이미 담당).
test('sanity: dashedFolderName matches the real domi profile projects/ folder name (best-effort, skips if absent)', () => {
  const configDir = '/home/doil/.assistant-claude-domi';
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return; // not this machine — skip
  const workspaceDir = path.join(configDir, 'workspace');
  const expectedWorkspaceFolder = transcript.dashedFolderName(workspaceDir);
  const onDisk = fs.readdirSync(projectsDir);
  assert.ok(
    onDisk.includes(expectedWorkspaceFolder),
    `expected folder '${expectedWorkspaceFolder}' among ${JSON.stringify(onDisk)}`
  );
});
