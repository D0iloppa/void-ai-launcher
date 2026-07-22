'use strict';

// lib/clipboard 단위 테스트 — 순수 함수 buildOsc52() 위주로 검증한다.
// copyToClipboard()의 실제 클립보드 반영(터미널 OSC 52 지원 여부, OS 클립보드
// 바이너리 존재 여부)은 이 테스트 환경에서 검증 불가능하므로 다루지 않는다 —
// "절대 throw 하지 않는다(fail-open)"만 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');

const clipboard = require('../lib/clipboard');

test('buildOsc52: bare form contains base64 of the input and round-trips', () => {
  const text = 'export ANTHROPIC_API_KEY="sk-ant-abc123"';
  const seq = clipboard.buildOsc52(text);

  const b64 = Buffer.from(text, 'utf8').toString('base64');
  assert.equal(seq, `\x1b]52;c;${b64}\x07`);

  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  assert.equal(decoded, text);
});

test('buildOsc52: empty string still produces a well-formed sequence', () => {
  const seq = clipboard.buildOsc52('');
  assert.equal(seq, '\x1b]52;c;\x07');
});

test('buildOsc52: tmux env wraps the bare OSC in a tmux DCS passthrough with ESC doubled', () => {
  const prevTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
  try {
    const text = 'hello';
    const seq = clipboard.buildOsc52(text);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const bare = `\x1b]52;c;${b64}\x07`;
    const expected = `\x1bPtmux;${bare.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
    assert.equal(seq, expected);
    // every literal ESC belonging to the inner payload must appear doubled
    assert.ok(seq.includes('\x1b\x1b]52;c;'));
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
  }
});

test('buildOsc52: screen TERM wraps the bare OSC in a plain DCS passthrough with ESC doubled', () => {
  const prevTmux = process.env.TMUX;
  const prevTerm = process.env.TERM;
  delete process.env.TMUX;
  process.env.TERM = 'screen-256color';
  try {
    const text = 'hello';
    const seq = clipboard.buildOsc52(text);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const bare = `\x1b]52;c;${b64}\x07`;
    const expected = `\x1bP${bare.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
    assert.equal(seq, expected);
    assert.ok(!seq.startsWith('\x1bPtmux;'));
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
    if (prevTerm === undefined) delete process.env.TERM; else process.env.TERM = prevTerm;
  }
});

test('buildOsc52: plain TERM (no tmux/screen) produces the bare sequence', () => {
  const prevTmux = process.env.TMUX;
  const prevTerm = process.env.TERM;
  delete process.env.TMUX;
  process.env.TERM = 'xterm-256color';
  try {
    const text = 'hello';
    const seq = clipboard.buildOsc52(text);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    assert.equal(seq, `\x1b]52;c;${b64}\x07`);
  } finally {
    if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
    if (prevTerm === undefined) delete process.env.TERM; else process.env.TERM = prevTerm;
  }
});

test('copyToClipboard: never throws and reports a result shape even with no OS clipboard tool available', () => {
  assert.doesNotThrow(() => {
    const result = clipboard.copyToClipboard('some-secret-token');
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.ok, 'boolean');
  });
});

test('copyToClipboard: fail-open even when process.stdout.write throws (OSC 52 path broken)', () => {
  const stdout = process.stdout;
  const originalWrite = stdout.write;
  stdout.write = () => { throw new Error('EPIPE simulated'); };
  try {
    assert.doesNotThrow(() => {
      const result = clipboard.copyToClipboard('some-secret-token');
      assert.equal(typeof result, 'object');
      // With OSC 52 forced to fail and (in this sandboxed test environment)
      // no OS clipboard binary on PATH, this should resolve to a clean
      // failure rather than throwing.
      assert.equal(typeof result.ok, 'boolean');
    });
  } finally {
    stdout.write = originalWrite;
  }
});
