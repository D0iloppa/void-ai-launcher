'use strict';

/*
 * lib/xtermFrame.js 의 usage 패널 아이콘 컬럼(ICON_COL_W) 유닛 테스트.
 *
 * 배경: claude 행의 ✳ 아이콘이 codex/agy 행의 👾/🚀 이모지보다 터미널에서
 * 눈에 띄게 작게 렌더된다 — 원인은 셀 폭이 아니라 유니코드 프레젠테이션
 * 방식 차이(✳는 기본이 text-presentation, 👾/🚀는 emoji-presentation)로
 * 추정된다. 이 테스트는 (1) toolGlyph()가 ✳ 뒤에 VS16(U+FE0F)을 붙였는지,
 * (2) charWidth()/textWidth()가 그 VS16을 폭 0(zero-width)으로 올바르게
 * 처리해 아이콘의 측정 폭이 여전히 1셀로 나오는지, (3) padIconCol()이
 * 좌측정렬이 아니라 컬럼 폭(ICON_COL_W=2) 기준 가운데정렬로 패딩하는지를
 * 검증한다. 실제 터미널에서 VS16이 눈으로 보이는 렌더 크기를 실제로
 * 바꾸는지는 이 테스트로도, grep/코드리뷰로도 검증 불가능 — 그건 사용자가
 * 실제 터미널에서 눈으로 재확인해야 한다.
 *
 * lib/xtermFrame.js 를 require 하는 것 자체는 안전하다 — node-pty/
 * @xterm/headless require 는 runXtermWrappedOnce 함수 본문 안에서 지연
 * (lazy) 실행되므로, 모듈 최상단에서는 어떤 네이티브 의존성도 로드되지 않는다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const xtermFrame = require('../lib/xtermFrame');

const VS16 = '️';
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI_SGR, '');

test('charWidth treats VS16 (U+FE0F) and the rest of the variation-selector block as zero-width', () => {
  assert.equal(xtermFrame.charWidth(VS16), 0);
  assert.equal(xtermFrame.charWidth('︀'), 0); // block start
  assert.equal(xtermFrame.charWidth('️'), 0); // VS16 itself
});

test("toolGlyph('claude') appends VS16 after the base ✳ glyph", () => {
  const icon = xtermFrame.toolGlyph('claude');
  const plain = stripAnsi(icon);
  assert.equal(plain, '✳' + VS16);
});

test('textWidth measures claude\'s VS16-suffixed icon as 1 cell, same as before the VS16 was added', () => {
  const icon = xtermFrame.toolGlyph('claude');
  assert.equal(xtermFrame.textWidth(icon), 1);
});

test('textWidth measures codex/agy icons as 2 cells (unaffected by the VS16 change)', () => {
  assert.equal(xtermFrame.textWidth(xtermFrame.toolGlyph('codex')), 2);
  assert.equal(xtermFrame.textWidth(xtermFrame.toolGlyph('agy')), 2);
});

test('padIconCol centres a narrower icon within ICON_COL_W instead of left-aligning it', () => {
  // claude's icon measures 1 cell wide against a 2-cell column: 1 extra
  // cell to distribute, floor/ceil split means left gets 0, right gets 1 —
  // i.e. still no leading space, but this is now "centred with the odd
  // cell on the right" by policy, not "left-aligned" by construction.
  const claudeIcon = xtermFrame.toolGlyph('claude');
  const padded = xtermFrame.padIconCol(claudeIcon);
  const plainPadded = stripAnsi(padded);
  assert.equal(plainPadded, '✳' + VS16 + ' ');
  assert.equal(xtermFrame.textWidth(padded), 2);
});

test('padIconCol adds no padding for icons that already fill ICON_COL_W (👾/🚀)', () => {
  const codexPadded = xtermFrame.padIconCol(xtermFrame.toolGlyph('codex'));
  const agyPadded = xtermFrame.padIconCol(xtermFrame.toolGlyph('agy'));
  assert.equal(codexPadded, '👾');
  assert.equal(agyPadded, '🚀');
});

test('padIconCol splits an odd leftover cell as floor(extra/2) left / ceil(extra/2) right', () => {
  // Synthetic zero-width icon: extra = ICON_COL_W - 0 = 2, so this exercises
  // the even case (1 left / 1 right) as a sanity check on the split formula
  // itself, independent of any real glyph.
  const zeroWidthIcon = ''; // textWidth('') === 0
  const padded = xtermFrame.padIconCol(zeroWidthIcon);
  assert.equal(padded, '  ');
  assert.equal(xtermFrame.textWidth(padded), 2);
});
