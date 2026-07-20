'use strict';

// lib/hangulKeymap.js 순수 로직 단위 테스트 — Korean IME(두벌식)가 눌린 물리 키
// 대신 호환 자모(U+3130-U+318F)를 보내는 문제의 역-매핑 테이블만 검증한다.
// UI/xtermFrame의 실제 raw-mode 키 이벤트 배선은 여기서 다루지 않는다(그 경로는
// 코드 인스펙션으로만 확인 가능 — 실제 한글 IME가 켜진 터미널에서의 동작은
// 이 환경에서 재현할 수 없다).

const test = require('node:test');
const assert = require('node:assert/strict');

const { hangulToQwerty } = require('../lib/hangulKeymap');

test('hangulToQwerty maps representative jamo to their Dubeolsik QWERTY key', () => {
  assert.equal(hangulToQwerty('ㅗ'), 'h');
  assert.equal(hangulToQwerty('ㅏ'), 'k');
  assert.equal(hangulToQwerty('ㅇ'), 'd');
  assert.equal(hangulToQwerty('ㅅ'), 't');
  assert.equal(hangulToQwerty('ㅣ'), 'l');
  assert.equal(hangulToQwerty('ㅎ'), 'g');
});

test('hangulToQwerty maps tense/shifted jamo to the same base letter as their plain counterpart', () => {
  assert.equal(hangulToQwerty('ㄲ'), 'r');
  assert.equal(hangulToQwerty('ㄱ'), 'r');
  assert.equal(hangulToQwerty('ㅃ'), 'q');
  assert.equal(hangulToQwerty('ㅂ'), 'q');
});

test('hangulToQwerty returns null for composite jamo (never produced by a single keystroke)', () => {
  assert.equal(hangulToQwerty('ㄳ'), null); // ㄳ (batchim cluster)
  assert.equal(hangulToQwerty('ㅘ'), null); // ㅘ (diphthong)
});

test('hangulToQwerty returns null for ASCII and other non-jamo input', () => {
  assert.equal(hangulToQwerty('h'), null);
  assert.equal(hangulToQwerty('a'), null);
  assert.equal(hangulToQwerty('가'), null); // precomposed Hangul syllable, not compatibility jamo
  assert.equal(hangulToQwerty('*'), null);
});

test('hangulToQwerty is defensive about non-single-char and non-string input', () => {
  assert.equal(hangulToQwerty(''), null);
  assert.equal(hangulToQwerty('ㅗㅏ'), null);
  assert.equal(hangulToQwerty(null), null);
  assert.equal(hangulToQwerty(undefined), null);
});
