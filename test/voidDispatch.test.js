'use strict';

// lib/voidDispatch 단위 테스트 — 순수 함수(buildDispatchArgs/buildDispatchEnv/
// parseResult/resolveProfile) 와 fail-soft 가드 위주로 검증한다. delegate() 의
// 실제 spawn(헤드리스 claude/codex 실행)은 이 환경에서 계정 로그인 없이는 검증
// 불가능하므로 다루지 않는다 — 다만 "빈 prompt → 절대 throw 하지 않고 ok:false"
// 와 "존재하지 않는 command → reject 하지 않고 ok:false" 는 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');

const vd = require('../lib/voidDispatch');

test('buildDispatchArgs: claude 는 -p + JSON 출력, 옵션이 뒤에 붙는다', () => {
  const args = vd.buildDispatchArgs('claude', '작업해줘', {
    model: 'claude-opus-4-8',
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit'],
  });
  assert.deepEqual(args, [
    '-p', '작업해줘', '--output-format', 'json',
    '--model', 'claude-opus-4-8',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit',
  ]);
});

test('buildDispatchArgs: 옵션 없으면 최소 인자만', () => {
  assert.deepEqual(vd.buildDispatchArgs('claude', 'hi'), ['-p', 'hi', '--output-format', 'json']);
});

test('buildDispatchArgs: codex 는 exec 서브커맨드', () => {
  assert.deepEqual(vd.buildDispatchArgs('codex', 'do it', { model: 'gpt-5' }), ['exec', 'do it', '-m', 'gpt-5']);
});

test('buildDispatchArgs: allowedTools 문자열도 그대로 허용', () => {
  const args = vd.buildDispatchArgs('claude', 'x', { allowedTools: 'Bash' });
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash');
});

test('buildDispatchArgs: 지원하지 않는 tool 은 throw', () => {
  assert.throws(() => vd.buildDispatchArgs('agy', 'x'), /지원하지 않는/);
});

test('buildDispatchEnv: 누수 변수를 제거하고 대상 CLAUDE_CONFIG_DIR 을 세팅한다', () => {
  const base = {
    CLAUDE_CONFIG_DIR: '/home/a/.claude-a',
    CLAUDE_CODE_OAUTH_TOKEN: 'A-token',
    ANTHROPIC_API_KEY: 'sk-A',
    TMUX: '/tmp/tmux-1000/default,123,0',
    PATH: '/usr/bin',
  };
  const resolved = { profile: 'b', toolCommand: 'claude', configDir: '/tmp/void-dispatch-test-b', session: null };
  const env = vd.buildDispatchEnv(base, resolved);

  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/void-dispatch-test-b'); // 대상으로 재설정
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);            // A 토큰 제거
  assert.equal(env.ANTHROPIC_API_KEY, undefined);                  // API 키 제거(청구 오염 방지)
  assert.equal(env.TMUX, undefined);                               // tmux 오염 방지
  assert.equal(env.PATH, '/usr/bin');                              // 무해한 변수는 보존
  assert.equal(base.CLAUDE_CONFIG_DIR, '/home/a/.claude-a');       // 입력 객체는 불변(얕은 복사)
});

test('buildDispatchEnv: codex 는 CODEX_HOME 을 세팅한다', () => {
  const resolved = { profile: 'b', toolCommand: 'codex', configDir: '/tmp/void-dispatch-test-codex-b', session: null };
  const env = vd.buildDispatchEnv({ CODEX_HOME: '/home/a/.codex-a' }, resolved);
  assert.equal(env.CODEX_HOME, '/tmp/void-dispatch-test-codex-b');
});

test('parseResult: claude JSON 에서 result/usage/cost 를 뽑는다', () => {
  const stdout = JSON.stringify({
    type: 'result', is_error: false, result: '완료했습니다',
    session_id: 'sess-123', total_cost_usd: 0.042,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  const r = vd.parseResult('claude', stdout);
  assert.equal(r.result, '완료했습니다');
  assert.equal(r.costUsd, 0.042);
  assert.equal(r.sessionId, 'sess-123');
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 50 });
  assert.equal(r.isError, false);
});

test('parseResult: is_error 를 그대로 반영한다', () => {
  const r = vd.parseResult('claude', JSON.stringify({ result: 'nope', is_error: true }));
  assert.equal(r.isError, true);
});

test('parseResult: 파싱 불가한 stdout 은 통째로 result 로 폴백', () => {
  const r = vd.parseResult('claude', 'not json at all');
  assert.equal(r.result, 'not json at all');
  assert.equal(r.usage, null);
  assert.equal(r.costUsd, null);
});

test('parseResult: codex 는 평문 stdout 을 그대로 반환', () => {
  const r = vd.parseResult('codex', 'plain text output');
  assert.equal(r.result, 'plain text output');
});

test('resolveProfile: 세션 레코드가 없어도 관례 경로로 폴백한다', () => {
  const resolved = vd.resolveProfile('nonexistent-profile-xyz', 'claude');
  assert.equal(resolved.profile, 'nonexistent-profile-xyz');
  assert.equal(resolved.toolCommand, 'claude');
  assert.match(resolved.configDir, /\.claude-nonexistent-profile-xyz$/);
});

test('resolveProfile: 빈 profile 은 throw', () => {
  assert.throws(() => vd.resolveProfile(''), /profile 이름이 필요/);
});

test('profileReadiness: 존재하지 않는 configDir 은 ready:false + 경고', () => {
  const r = vd.profileReadiness({ profile: 'ghost', toolCommand: 'claude', configDir: '/no/such/dir/void-xyz', session: null });
  assert.equal(r.ready, false);
  assert.ok(r.warnings.length >= 1);
});

test('delegate: 빈 prompt 는 throw 하지 않고 ok:false 로 resolve', async () => {
  const r = await vd.delegate('   ', { profile: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /prompt/);
});

test('delegate: 존재하지 않는 command 는 reject 하지 않고 ok:false 로 resolve', async () => {
  // toolCommand 를 알 수 없는 값으로 주면 buildDispatchArgs 에서 걸러진다.
  const r = await vd.delegate('작업', { profile: 'b', toolCommand: 'no-such-tool' });
  assert.equal(r.ok, false);
  assert.match(r.error, /지원하지 않는/);
});

test('listProfiles: 항상 배열을 반환한다(throw 없음)', () => {
  const list = vd.listProfiles('claude');
  assert.ok(Array.isArray(list));
});
