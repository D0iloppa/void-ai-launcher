'use strict';

// lib/assistantCommands 순수 로직 단위 테스트 — 렌더링(lib/ui.js 의 팝업
// 오버레이/raw-mode 키 처리)과 launcher.js 의 /skills 인터셉터·세션 meta
// 왕복은 라이브 세션 없이 검증할 수 없어 여기서는 제외한다(assistantSettingsPanel.test.js
// 와 같은 이유 — 순수 함수만 검증).

const test = require('node:test');
const assert = require('node:assert/strict');

const assistantCommands = require('../lib/assistantCommands');

test('COMMANDS: /skills is the only local command, the rest are passthrough', () => {
  const byName = Object.fromEntries(assistantCommands.COMMANDS.map((c) => [c.name, c.kind]));
  assert.equal(byName['/skills'], 'local');
  assert.equal(byName['/mcp'], 'passthrough');
  assert.equal(byName['/usage'], 'passthrough');
  assert.equal(byName['/model'], 'passthrough');
  assert.equal(byName['/effort'], 'passthrough');
  assert.equal(byName['/resume'], undefined); // 헤드리스-거부 명령 — 목록에 없어야 함
});

test('COMMANDS: every entry has a non-empty Korean desc', () => {
  for (const c of assistantCommands.COMMANDS) {
    assert.equal(typeof c.desc, 'string');
    assert.ok(c.desc.length > 0);
  }
});

test('filterCommands: prefix match is case-insensitive', () => {
  const names = assistantCommands.filterCommands('/S').map((c) => c.name);
  assert.deepEqual(names.sort(), ['/skills'].sort());
});

test('filterCommands: "/" alone returns every command', () => {
  assert.equal(assistantCommands.filterCommands('/').length, assistantCommands.COMMANDS.length);
});

test('filterCommands: narrows as the prefix grows', () => {
  const s = assistantCommands.filterCommands('/s').map((c) => c.name);
  assert.deepEqual(s, ['/skills']);
  assert.deepEqual(assistantCommands.filterCommands('/skills').map((c) => c.name), ['/skills']);
  assert.deepEqual(assistantCommands.filterCommands('/skillsx'), []);
});

test('filterCommands: prefix without a leading "/" matches nothing', () => {
  assert.deepEqual(assistantCommands.filterCommands('skills'), []);
});

test('filterCommands: non-string/empty input matches nothing', () => {
  assert.deepEqual(assistantCommands.filterCommands(''), []);
  assert.deepEqual(assistantCommands.filterCommands(null), []);
  assert.deepEqual(assistantCommands.filterCommands(undefined), []);
});

test('parseLeadingToken: a bare partial command token is returned as-is', () => {
  assert.equal(assistantCommands.parseLeadingToken('/sk'), '/sk');
  assert.equal(assistantCommands.parseLeadingToken('/'), '/');
});

test('parseLeadingToken: a command with a trailing argument/space is not a leading token anymore', () => {
  assert.equal(assistantCommands.parseLeadingToken('/skills x'), null);
  assert.equal(assistantCommands.parseLeadingToken('/skills '), null);
});

test('parseLeadingToken: multi-line input is never a leading token', () => {
  assert.equal(assistantCommands.parseLeadingToken('/skills\nmore'), null);
});

test('parseLeadingToken: plain text not starting with "/" is null', () => {
  assert.equal(assistantCommands.parseLeadingToken('hello'), null);
});

test('parseLeadingToken: empty/null/undefined input is null', () => {
  assert.equal(assistantCommands.parseLeadingToken(''), null);
  assert.equal(assistantCommands.parseLeadingToken(null), null);
  assert.equal(assistantCommands.parseLeadingToken(undefined), null);
});
