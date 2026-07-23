'use strict';

/*
 * lib/xtermFrame.js 의 mail 'resume' accept 즉시-재시작 seam 유닛 테스트.
 *
 * runXtermWrapped/runXtermWrappedOnce 본체는 node-pty/@xterm/headless + 실제
 * TTY 가 있어야 실행되는 대형 스테이트풀 함수라 여기서 직접 구동하지 않는다.
 * 대신 이번 패스에서 새로 뽑아낸 순수 헬퍼 buildMailRestartTool/
 * buildMailRestartLabel 만 독립적으로 검증한다 — mail-accept-confirm 의
 * 'resume' 분기가 mailRestartSignal.requested 로 넘기는 directive 모양
 * ({configDir, resumeSessionId, cwd, landingName})을 그대로 흉내낸다.
 *
 * lib/xtermFrame.js 를 require 하는 것 자체는 안전하다 — node-pty/
 * @xterm/headless require 는 runXtermWrappedOnce 함수 본문 안에서 지연
 * (lazy) 실행되므로, 모듈 최상단에서는 어떤 네이티브 의존성도 로드되지 않는다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const xtermFrame = require('../lib/xtermFrame');

test('buildMailRestartTool returns null when there is no restart request', () => {
  assert.equal(xtermFrame.buildMailRestartTool({ command: 'claude', args: [] }, null), null);
});

test('buildMailRestartTool appends --resume <sessionId> to the ORIGINAL args (not any prior iteration\'s args)', () => {
  const originalTool = { command: 'claude', args: ['--some-flag'] };
  const req = { configDir: '/tmp/landing', resumeSessionId: 'sess-123', cwd: '/mnt/c/DEV/void-ai-launcher', landingName: 'bob' };

  const result = xtermFrame.buildMailRestartTool(originalTool, req);
  assert.deepEqual(result, { command: 'claude', args: ['--some-flag', '--resume', 'sess-123'] });

  // originalTool.args must not be mutated by the call
  assert.deepEqual(originalTool.args, ['--some-flag']);
});

test('buildMailRestartTool omits --resume when the request carries no resumeSessionId', () => {
  const originalTool = { command: 'claude', args: [] };
  const req = { configDir: '/tmp/landing', resumeSessionId: null, cwd: '/x', landingName: 'bob' };
  const result = xtermFrame.buildMailRestartTool(originalTool, req);
  assert.deepEqual(result, { command: 'claude', args: [] });
});

test('buildMailRestartTool is idempotent across repeated calls from the same original tool (no --resume accumulation)', () => {
  const originalTool = { command: 'claude', args: [] };
  const req1 = { resumeSessionId: 'sess-1' };
  const req2 = { resumeSessionId: 'sess-2' };

  const first = xtermFrame.buildMailRestartTool(originalTool, req1);
  const second = xtermFrame.buildMailRestartTool(originalTool, req2);

  assert.deepEqual(first.args, ['--resume', 'sess-1']);
  assert.deepEqual(second.args, ['--resume', 'sess-2']); // NOT ['--resume','sess-1','--resume','sess-2']
});

test('buildMailRestartLabel appends the landing session name when present', () => {
  const req = { landingName: 'bob' };
  assert.equal(xtermFrame.buildMailRestartLabel('✳ claude  [alice]', req), '✳ claude  [alice]  → [bob]');
});

test('buildMailRestartLabel leaves the label untouched when there is no request or no landingName', () => {
  assert.equal(xtermFrame.buildMailRestartLabel('✳ claude  [alice]', null), '✳ claude  [alice]');
  assert.equal(xtermFrame.buildMailRestartLabel('✳ claude  [alice]', {}), '✳ claude  [alice]');
});

test('getInputProfile returns wrapperMouse true for codex and agy', () => {
  const codexProfile = xtermFrame.getInputProfile('codex');
  assert.equal(codexProfile.wrapperMouse, true);
  assert.equal(codexProfile.mouseEnable, '\x1b[?1000h\x1b[?1006h');

  const agyProfile = xtermFrame.getInputProfile('agy');
  assert.equal(agyProfile.wrapperMouse, true);
  assert.equal(agyProfile.mouseEnable, '\x1b[?1000h\x1b[?1006h');

  const claudeProfile = xtermFrame.getInputProfile('claude');
  assert.equal(claudeProfile.wrapperMouse, false);
  assert.equal(claudeProfile.mouseEnable, '');
});
