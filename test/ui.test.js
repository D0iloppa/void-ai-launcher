'use strict';

// lib/ui 순수 함수(colWidth/truncateCols/makeBox) 단위 테스트 — 렌더링 전체
// 화면(TUI raw-mode 루프)은 검증하지 않는다(pet.test.js 와 같은 이유로 제외:
// 여기선 박스/폭 계산에 쓰이는 순수 함수만 검증). setColors 가 module-private
// `C`(RESET 등)를 채워야 truncateCols/makeBox 가 색 코드를 방출하므로, 테스트
// 시작 전에 실제 테마 팩 하나로 초기화한다.

const test = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../lib/ui');
const theme = require('../lib/theme');

const palette = theme.loadTheme({});
const colors = theme.makeColors(palette);
ui.setColors(colors, palette);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = s => s.replace(ANSI_RE, '');

test('colWidth: CJK Symbols and Punctuation (U+3000-U+303F) counts as double-width', () => {
  // U+3000 IDEOGRAPHIC SPACE, U+3001 IDEOGRAPHIC COMMA, U+3002 IDEOGRAPHIC FULL STOP
  assert.equal(ui.colWidth('　'), 2);
  assert.equal(ui.colWidth('、'), 2);
  assert.equal(ui.colWidth('。'), 2);
  assert.equal(ui.colWidth('「」'), 4);
});

test('colWidth: a combining mark contributes zero width', () => {
  // U+0301 COMBINING ACUTE ACCENT stacked on "e" — should read as width 1
  // (the base char only), not 2.
  const withMark = 'é';
  assert.equal(ui.colWidth(withMark), 1);
  assert.equal(ui.colWidth('́'), 0);
  // Combining Diacritical Marks for Symbols (U+20D0 block) too.
  assert.equal(ui.colWidth('⃐'), 0);
});

test('colWidth: a ZWJ-joined emoji cluster counts once, not per joined codepoint', () => {
  // U+1F468 MAN + ZWJ + U+1F469 WOMAN + ZWJ + U+1F467 GIRL — terminals draw
  // this whole family sequence as one double-width glyph.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal(ui.colWidth(family), 2);
});

test('colWidth: unchanged Hangul/CJK/emoji-allowlist behavior still holds', () => {
  assert.equal(ui.colWidth('가'), 2);       // Hangul syllable
  assert.equal(ui.colWidth('中'), 2);       // CJK Unified Ideograph
  assert.equal(ui.colWidth('⚡'), 2);       // allowlisted single-codepoint emoji
  assert.equal(ui.colWidth('a'), 1);        // plain ASCII unaffected
});

test('colWidth: standalone Hangul Compatibility Jamo (U+3130-U+318F) counts as double-width', () => {
  // Typing single jamo (ㅇㅇㅇ) rather than composed syllables used to shift
  // the layout because these were undercounted as width 1.
  assert.equal(ui.colWidth('ㅇ'), 2);       // U+3147
  assert.equal(ui.colWidth('ㄱ'), 2);       // U+3131
  assert.equal(ui.colWidth('ㅏ'), 2);       // U+314F
  assert.equal(ui.colWidth('ㅇㅇㅇ'), 6);
});

test('truncateCols: no-op when the string already fits', () => {
  const s = colors.signal + 'hello' + colors.RESET;
  assert.equal(ui.truncateCols(s, 20), s);
});

test('truncateCols: preserves embedded color codes on the kept portion and always ends with RESET', () => {
  const s = colors.signal + 'abcdefghij' + colors.RESET;
  const out = ui.truncateCols(s, 5);
  // The signal color set before the cut point must still be present in the
  // truncated output (previously it was discarded because truncation
  // rebuilt from the ANSI-stripped string).
  assert.ok(out.includes(colors.signal), 'expected the original color code to survive truncation');
  // Must never leak color past the cut — always trail with RESET.
  assert.ok(out.endsWith(colors.RESET), 'expected truncateCols to end with C.RESET');
  // Visible (non-ANSI) text should be capped below the requested width
  // (room reserved for the ellipsis marker) and end with the ellipsis.
  const plain = stripAnsi(out);
  assert.ok(plain.endsWith('…'));
  assert.ok(ui.colWidth(out) <= 5);
});

test('makeBox: every rendered line has exactly innerWidth + 2 columns (borders)', () => {
  const innerWidth = 20;
  const lines = ui.makeBox(innerWidth, ['short', 'a longer line that will need truncating for sure'], { title: 'T' });
  for (const line of lines) {
    assert.equal(ui.colWidth(line), innerWidth + 2);
  }
});

test('clampBoxKeepingBorders: clips overflowing content but always keeps top and bottom border rows', () => {
  const box = Array.from({ length: 10 }, (_, i) => `line${i}`);
  const clamped = ui.clampBoxKeepingBorders(box, 5);
  assert.equal(clamped.length, 5);
  assert.equal(clamped[0], box[0]);
  assert.equal(clamped[clamped.length - 1], box[box.length - 1]);
  // middle rows are clipped, not the tail (which would have eaten the border)
  assert.deepEqual(clamped.slice(1, -1), box.slice(1, 4));
});

test('clampBoxKeepingBorders: leaves the box untouched when it already fits', () => {
  const box = ['top', 'a', 'b', 'bottom'];
  assert.deepEqual(ui.clampBoxKeepingBorders(box, 4), box);
  assert.deepEqual(ui.clampBoxKeepingBorders(box, 10), box);
});

test('clampBoxKeepingBorders: degenerate maxRows never throws and stays border-first', () => {
  const box = ['top', 'a', 'b', 'c', 'bottom'];
  assert.deepEqual(ui.clampBoxKeepingBorders(box, 0), []);
  assert.deepEqual(ui.clampBoxKeepingBorders(box, 1), ['top']);
  // maxRows===2: only room for top+bottom, no content rows survive.
  assert.deepEqual(ui.clampBoxKeepingBorders(box, 2), ['top', 'bottom']);
});

// ── renderInlineMarkdown (assistant-chat lightweight markdown) ──────────

test('renderInlineMarkdown: balanced **bold** becomes BOLD+text+RESET with markers removed', () => {
  const out = ui.renderInlineMarkdown('this is **CLI에서** important');
  assert.ok(out.includes(colors.BOLD + 'CLI에서' + colors.RESET), 'expected BOLD-wrapped inner text');
  assert.ok(!stripAnsi(out).includes('**'), 'literal ** markers must be gone from the visible text');
});

test('renderInlineMarkdown: an unclosed/dangling ** is left literal (streaming mid-span safety)', () => {
  const out = ui.renderInlineMarkdown('typing **not yet closed');
  assert.equal(out, 'typing **not yet closed');
  assert.ok(!out.includes(colors.BOLD), 'must not emit an unterminated BOLD code');
});

test('renderInlineMarkdown: a lone ** with nothing after it is left literal, not garbled', () => {
  const out = ui.renderInlineMarkdown('wait **');
  assert.equal(out, 'wait **');
});

test('renderInlineMarkdown: `code` span gets a distinct style with backticks removed', () => {
  const out = ui.renderInlineMarkdown('run `claude --resume` now');
  assert.ok(out.includes(colors.DIM), 'expected the DIM code-span style');
  assert.ok(out.includes('claude --resume'));
  assert.ok(!stripAnsi(out).includes('`'), 'literal backticks must be gone from the visible text');
});

test('renderInlineMarkdown: an unclosed backtick is left literal', () => {
  const out = ui.renderInlineMarkdown('this has an unclosed `tick');
  assert.equal(out, 'this has an unclosed `tick');
});

test('renderInlineMarkdown: plain text with no markers is unchanged', () => {
  const s = 'just a plain reply, nothing special.';
  assert.equal(ui.renderInlineMarkdown(s), s);
});

test('renderInlineMarkdown: leading "# " / "## " / "### " header strips hashes and bolds the line', () => {
  const out = ui.renderInlineMarkdown('## 제목입니다');
  assert.equal(out, colors.BOLD + '제목입니다' + colors.RESET);
});

test('renderInlineMarkdown: leading "- " / "* " bullet becomes a "• " prefix', () => {
  assert.equal(stripAnsi(ui.renderInlineMarkdown('- first item')), '• first item');
  assert.equal(stripAnsi(ui.renderInlineMarkdown('* second item')), '• second item');
  // a bold marker must never be misread as a bullet
  const bold = ui.renderInlineMarkdown('**bold not bullet**');
  assert.ok(!stripAnsi(bold).startsWith('•'));
});

test('renderInlineMarkdown: CJK + bold — colWidth of the styled string matches the marker-free plain text', () => {
  const out = ui.renderInlineMarkdown('**한글볼드**');
  assert.equal(ui.colWidth(out), ui.colWidth('한글볼드'));
});

test('wrapCols: preserves a bold span across a wrapped line boundary without leaking styling', () => {
  const styled = ui.renderInlineMarkdown('a **bbbbbbbbbb** c');
  const lines = ui.wrapCols(styled, 5);
  // every wrapped line must be independently well-formed: no dangling SGR
  // state carries past a line's own RESET into "whatever renders after it".
  for (const line of lines) {
    const opens = (line.match(/\x1b\[1m/g) || []).length;
    const resets = (line.match(/\x1b\[0m/g) || []).length;
    assert.ok(resets >= opens, `line "${line}" opens bold without a matching RESET`);
  }
  // and the visible text (ANSI stripped) reassembles to the original words
  assert.equal(stripAnsi(lines.join('')), 'a bbbbbbbbbb c');
});
