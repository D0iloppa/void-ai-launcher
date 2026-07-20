'use strict';

// lib/composerModel.js 순수 함수 단위 테스트 — 개인비서 채팅 컴포저의
// 텍스트/커서 모델(삽입/삭제/이동/줄바꿈/뷰포트). ui.js 의 raw-mode 루프 자체는
// (ui.test.js/pet.test.js 와 같은 이유로) 검증하지 않고, 여기 순수 헬퍼들만
// 검증한다.

const test = require('node:test');
const assert = require('node:assert/strict');

const cm = require('../lib/composerModel');

// 테스트 전용 단순 폭 함수 — ASCII 는 폭 1. CJK 폭 상호작용은 ui.colWidth를
// 쓰는 별도 테스트에서 검증한다.
const asciiWidth = () => 1;

test('insertText: inserts at cursor position (mid-text), not only at the end', () => {
  const r = cm.insertText('helloworld', 5, ' ');
  assert.equal(r.value, 'hello world');
  assert.equal(r.cursor, 6);
});

test('insertText: cursor is clamped into range', () => {
  const r = cm.insertText('abc', 99, 'X');
  assert.equal(r.value, 'abcX');
  assert.equal(r.cursor, 4);
});

test('deleteBackward: removes the char before cursor, cursor moves back one', () => {
  const r = cm.deleteBackward('hello', 5);
  assert.equal(r.value, 'hell');
  assert.equal(r.cursor, 4);
});

test('deleteBackward: mid-text deletion removes the correct char', () => {
  const r = cm.deleteBackward('abcde', 3); // cursor between 'c' and 'd'
  assert.equal(r.value, 'abde');
  assert.equal(r.cursor, 2);
});

test('deleteBackward: no-op at position 0', () => {
  const r = cm.deleteBackward('abc', 0);
  assert.equal(r.value, 'abc');
  assert.equal(r.cursor, 0);
});

test('deleteForward: removes the char at cursor', () => {
  const r = cm.deleteForward('abcde', 2);
  assert.equal(r.value, 'abde');
  assert.equal(r.cursor, 2);
});

test('moveLeft/moveRight: clamp at bounds', () => {
  assert.equal(cm.moveLeft('abc', 0), 0);
  assert.equal(cm.moveLeft('abc', 2), 1);
  assert.equal(cm.moveRight('abc', 3), 3);
  assert.equal(cm.moveRight('abc', 1), 2);
});

test('insert/delete/move operate on codepoints, not UTF-16 code units (surrogate pairs stay intact)', () => {
  const emoji = '\u{1F600}'; // U+1F600, a surrogate pair in UTF-16 (length === 2)
  const value = 'a' + emoji + 'b';
  assert.equal(cm.length(value), 3); // 'a', emoji, 'b' — 3 codepoints
  // Moving left from the end twice should land just after 'a', not
  // mid-surrogate-pair.
  let cursor = cm.length(value);
  cursor = cm.moveLeft(value, cursor); // now before 'b'
  cursor = cm.moveLeft(value, cursor); // now before emoji
  assert.equal(cursor, 1);
  const del = cm.deleteBackward(value, 2); // delete the emoji as one unit
  assert.equal(del.value, 'ab');
});

test('layoutVisualLines: wraps a long line at width, tracking start/end codepoint ranges', () => {
  const lines = cm.layoutVisualLines('abcdefgh', 3, asciiWidth);
  assert.deepEqual(lines.map(l => l.text), ['abc', 'def', 'gh']);
  assert.deepEqual(lines.map(l => [l.start, l.end]), [[0, 3], [3, 6], [6, 8]]);
});

test('layoutVisualLines: explicit \\n splits into separate logical/visual lines', () => {
  const lines = cm.layoutVisualLines('ab\ncd', 10, asciiWidth);
  assert.deepEqual(lines.map(l => l.text), ['ab', 'cd']);
  // 'ab' occupies [0,2), the '\n' itself is index 2, 'cd' occupies [3,5).
  assert.deepEqual(lines.map(l => [l.start, l.end]), [[0, 2], [3, 5]]);
});

test('layoutVisualLines: empty string yields a single empty visual line', () => {
  const lines = cm.layoutVisualLines('', 10, asciiWidth);
  assert.deepEqual(lines, [{ start: 0, end: 0, text: '' }]);
});

test('layoutVisualLines: uses ui.colWidth for CJK-aware wrapping (double-width chars)', () => {
  const ui = require('../lib/ui');
  const theme = require('../lib/theme');
  ui.setColors(theme.makeColors(theme.loadTheme({})), theme.loadTheme({}));
  // Each CJK char is width 2, so width=4 fits exactly 2 chars per visual line.
  const lines = cm.layoutVisualLines('가나다라', 4, ui.colWidth);
  assert.deepEqual(lines.map(l => l.text), ['가나', '다라']);
});

test('moveHome/moveEnd: jump to the start/end of the current VISUAL (wrapped) line, not the whole logical line', () => {
  const value = 'abcdefgh'; // wraps to 'abc'/'def'/'gh' at width 3
  // cursor at index 4 ('e', within the 'def' visual line)
  assert.equal(cm.moveHome(value, 4, 3, asciiWidth), 3);
  assert.equal(cm.moveEnd(value, 4, 3, asciiWidth), 6);
});

test('moveVisualRow: moves cursor up/down between wrapped visual lines, preserving column', () => {
  const value = 'abcdefgh'; // 'abc'/'def'/'gh'
  // Start at col 2 of row0 ('c', index 2) -> down should land at col 2 of row1 ('f', index 5)
  const down1 = cm.moveVisualRow(value, 2, 3, asciiWidth, 1);
  assert.equal(down1, 5);
  // From row1 col2 (index 5, 'f') down again -> row2 only has 2 chars ('gh'),
  // so column clamps to end of that line (index 8).
  const down2 = cm.moveVisualRow(value, 5, 3, asciiWidth, 1);
  assert.equal(down2, 8);
  // From the very first row, moving up returns the SAME cursor (can't move further).
  assert.equal(cm.moveVisualRow(value, 1, 3, asciiWidth, -1), 1);
  // From the very last row, moving down returns the SAME cursor.
  assert.equal(cm.moveVisualRow(value, 8, 3, asciiWidth, 1), 8);
});

test('moveVisualRow: works across explicit newlines too', () => {
  const value = 'hello\nhi';
  // cursor at index 3 ('l' in "hello", col 3) -> down onto "hi" (len 2) clamps to col 2 (end)
  const down = cm.moveVisualRow(value, 3, 10, asciiWidth, 1);
  assert.equal(down, 8); // end of "hi" (index 6..8)
  // Moving back up recomputes column from the CURRENT cursor (col 2, since
  // that's where the clamp left it) — there is no persisted "goal column"
  // threaded across a chain of moves, only the single-step column of
  // wherever the cursor currently sits. So this lands at col 2 of "hello"
  // (index 2), not back at the original col 3. This is a deliberate
  // simplicity tradeoff (stateless: recomputed fresh from value+cursor on
  // every keypress) — documented here so it isn't mistaken for a bug.
  const up = cm.moveVisualRow(value, 8, 10, asciiWidth, -1);
  assert.equal(up, 2);
});

test('computeViewportTop: content shorter than the viewport always starts at 0', () => {
  assert.equal(cm.computeViewportTop(2, 4, 0), 0);
  assert.equal(cm.computeViewportTop(2, 4, 1), 0);
});

test('computeViewportTop: default is bottom-anchored when cursor is within/at the tail', () => {
  // 6 total visual lines, 4-row viewport, cursor on the last line (row 5)
  assert.equal(cm.computeViewportTop(6, 4, 5), 2);
});

test('computeViewportTop: scrolls up to reveal the cursor when it moves above the current window', () => {
  // Same 6-line content; cursor moved (via Up) to row 1, above the bottom-anchored window [2..5]
  assert.equal(cm.computeViewportTop(6, 4, 1), 1);
});

test('computeViewportTop: never scrolls the top row past what content allows', () => {
  assert.equal(cm.computeViewportTop(6, 4, 0), 0);
});
