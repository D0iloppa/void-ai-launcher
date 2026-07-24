'use strict';

/*
 * xtermFrame.js — cross-platform framed terminal built on @xterm/headless.
 *
 * It uses a real VT100/xterm parser (@xterm/headless): a node-pty child's raw output is
 * fed into an @xterm/headless Terminal, then buffer.active is read
 * cell-by-cell and COMPOSITED inside void's border/status-bar chrome.
 *
 * Unlike the earlier abandoned regex-strip approach (which broke on codex's
 * full-screen redraws), no child bytes are ever passed through and nothing is
 * regex-stripped — we always render from the parsed screen model. This is the
 * productionised version of _spike/xterm-headless-poc.js, upgraded with full
 * per-cell SGR fidelity, debounced repaints, and debounced resize handling.
 *
 * The chrome helpers below (topBar / bottomBar / computeMargins / ptyDims and
 * the color constants) are intentionally copied from lib/wrapper.js rather than
 * imported: the project owner requires wrapper.js to remain byte-for-byte
 * untouched (it is the Linux/macOS path). Keeping the strings identical means
 * the Windows frame is visually the same as the tmux frame, not degraded.
 */

// Korean IME emits Hangul Compatibility Jamo (U+3130-U+318F) for physical
// letter keys instead of ASCII — see lib/hangulKeymap.js header. Applied only
// at bare-letter control-panel/subview hotkey compares below, never to the
// raw child-stdin passthrough (child.write(input)) or free-text compose buffers.
const { hangulToQwerty } = require('./hangulKeymap');

// ── ANSI (mirrors lib/wrapper.js) ─────────────────────────
// SIG_BG/SIG_FG default to void-signature's green but are reassigned by
// applyTheme() (called once from launcher.js at boot, alongside
// ui.setColors()/wrapper.js's own applyTheme()) so this module's frame chrome
// follows the active theme pack instead of staying hardcoded — every existing
// usage site below is unchanged since these stay plain string bindings, just
// no longer const.
let SIG_BG = '\x1b[48;2;0;230;118m';
let SIG_FG = '\x1b[38;2;0;230;118m';
function applyTheme(palette) {
  if (!palette || !palette.signal) return;
  try {
    const { fg, bg } = require('./theme');
    SIG_FG = fg(palette.signal);
    SIG_BG = bg(palette.signal);
  } catch {}
}
const BLACK  = '\x1b[38;2;0;0;0m';
const RED_FG = '\x1b[38;2;230;50;50m';
const ORANGE_FG = '\x1b[38;2;249;115;22m';
// Amber for the middle usage band (60–79%) — sits between SIG green and RED.
const AMBER_FG = '\x1b[38;2;234;179;8m';
const BOLD   = '\x1b[1m';
const RST    = '\x1b[0m';
// A filled cell reaches the same visual edge as the header/footer bar. A │
// glyph has side bearings, which made the wrapper rails look inset on Windows.
const SIDE_RAIL = SIG_BG + ' ' + RST;

function at(row, col) { return `\x1b[${row};${col}H`; }

function charWidth(char) {
  const cp = char.codePointAt(0);
  if (cp === undefined || /[\u0000-\u001f\u007f-\u009f]/.test(char)) return 0;
  // Variation selectors (U+FE00-FE0F, including VS16 "emoji presentation
  // selector" at U+FE0F) are zero-width combining marks: they never advance
  // the cursor on their own, they only tell the terminal how to RENDER the
  // preceding base character (text-style vs. emoji-style glyph). toolGlyph()
  // appends VS16 after claude's ✳ to nudge terminals toward the same
  // emoji-presentation size 👾/🚀 already render at by default. Without this
  // branch the trailing VS16 falls through to the width-1 default below and
  // desyncs padIconCol()'s width math (the icon would measure 2 cells wide
  // before any padding is even added).
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  // Korean/CJK and emoji occupy two terminal cells. JavaScript's .length
  // counts UTF-16 code units instead, which caused the footer to wrap.
  if (
    cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    )
  ) return 2;
  return 1;
}

// SGR colour sequences (\x1b[...m) occupy zero terminal cells, but charWidth()
// sees their inner bytes ('[', digits, ';', 'm') as ordinary width-1 ASCII.
// Skip whole sequences here so width math and trim boundaries are based on
// visible cells only — the usage-overlay rows and the topBar gauge now carry
// embedded truecolor runs and flow through textWidth()/trimText() unchanged.
// Plain (no-ESC) strings take the exact same code path as before.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

function stripSgr(text) {
  return text.indexOf('\x1b') === -1 ? text : text.replace(ANSI_SGR, '');
}

function textWidth(text) {
  let width = 0;
  for (const char of stripSgr(text)) width += charWidth(char);
  return width;
}

function trimText(text, width) {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  if (width === 1) return '…';
  const hasSgr = text.indexOf('\x1b') !== -1;
  let result = '';
  let used = 0;
  let i = 0;
  while (i < text.length) {
    if (hasSgr && text.charCodeAt(i) === 0x1b) {
      ANSI_SGR.lastIndex = i;
      const m = ANSI_SGR.exec(text);
      if (m && m.index === i) {
        // Zero-width: keep the whole sequence, never cut inside it.
        result += m[0];
        i = ANSI_SGR.lastIndex;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(i));
    const charCells = charWidth(char);
    if (used + charCells > width - 1) break;
    result += char;
    used += charCells;
    i += char.length;
  }
  // A trimmed coloured string must not leak its last SGR run into whatever
  // the caller paints right after it (padding, borders).
  return result + '…' + (hasSgr ? RST : '');
}

// ── Usage gauge / band-colour helpers ─────────────────────
// Same 60/80 thresholds as launcher.js's bandColor() and the same glyph map as
// runner.js's toolIcon() — both re-implemented locally because the layering
// rule (established in earlier rounds) keeps xtermFrame.js a pure compositor
// with no business-logic requires (and requiring launcher.js would cycle).
const bandFg = (pct) =>
  pct >= 80 ? (BOLD + RED_FG) : pct >= 60 ? AMBER_FG : SIG_FG;

// Same glyph map as runner.js's toolIcon() (re-implemented locally — the
// layering rule keeps xtermFrame.js a pure compositor with no business-logic
// requires, and requiring runner.js from here would cycle since runner.js
// requires xtermFrame.js). Claude's ✳ is coloured with the same ORANGE_FG the
// topBar() header already uses for "✳ CLAUDE CODE" (see the styledLabel
// branch below) — claude's brand colour.
//
// An earlier round used fixed-width ASCII bracket tags ([CL]/[CX]/[AG])
// specifically to dodge a width-measurement risk: 👾/🚀 (U+1F47E/U+1F680)
// are unambiguously double-width per charWidth()'s emoji range, but ✳
// U+2733 is only 1 cell wide by that same table. Mixing 1-cell and 2-cell
// icons in the same leading column would desync the "S ...."/"W ...." gauge
// columns across rows. Rather than reverting to ASCII, pad every icon out to
// a shared ICON_COL_W using textWidth() (the ANSI/CJK-aware width helper
// already used for all alignment math in this file) — no hardcoded
// byte/char count, so this stays correct even if charWidth()'s table changes.
const ICON_COL_W = 2; // widest current icon (👾/🚀) — claude's ✳ (1 cell) pads out to match
// ✳ U+2733 is text-presentation by default in most fonts/terminals — a small
// glyph next to 👾/🚀's full-size colour-emoji presentation, which reads as
// a visible size mismatch even once the column WIDTH is equalised below.
// Appending U+FE0F (VARIATION SELECTOR-16, "emoji presentation selector")
// asks the terminal to render ✳ with its emoji-style glyph instead, closing
// most of that size gap. VS16 is zero-width (see charWidth()'s U+FE00-FE0F
// branch above) so it doesn't change ✳'s measured width — padIconCol() still
// sees a 1-cell icon and pads accordingly. This is a request, not a
// guarantee: presentation-selector support varies by terminal/font, so this
// must be eyeballed in the actual target terminal (see module notes).
const toolGlyph = (command) => {
  switch ((command || '').toLowerCase()) {
    case 'codex': return '👾';
    case 'claude': return ORANGE_FG + '✳️' + RST;
    case 'agy': return '🚀';
    default: return '◈';
  }
};
// Pads a (possibly ANSI-coloured) icon out to ICON_COL_W visible cells, using
// textWidth() so the padding is based on measured width, not char count.
// Centred rather than left-aligned: a narrower icon (currently only claude's
// 1-cell ✳ against the 2-cell 👾/🚀) sits visually mid-column instead of
// hugging the left edge, which reads more like "one icon, column-centred"
// and less like "icon + stray trailing space" next to the full-width ones.
// Extra padding splits floor/ceil (left gets the smaller half) so an odd
// leftover cell is deterministic rather than alternating by icon.
const padIconCol = (icon) => {
  const extra = Math.max(0, ICON_COL_W - textWidth(icon));
  const leftPad = Math.floor(extra / 2);
  const rightPad = extra - leftPad;
  return ' '.repeat(leftPad) + icon + ' '.repeat(rightPad);
};

// Compact, locale-independent reset time. Same rule as launcher.js's
// fmtResetCompact (re-implemented locally — the layering rule forbids
// requiring launcher.js from here): HH:mm today, else M/D HH:mm.
const fmtGaugeReset = (resetsAt) => {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
// Includes seconds (HH:mm:ss) — a bare HH:mm last-measured clock is easy to
// misread as a countdown/reset time rather than "when this was cached".
const fmtGaugeClock = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
// Shared 8-cell gauge bar for BOTH composeUsageRow (overlay) and
// composeGaugeText (topBar) — same glyph, same height, in both places.
//
// Glyph choice: U+25AC BLACK RECTANGLE ("▬"), from the Geometric Shapes
// block, part of Unicode since version 1.1 — an old, near-universally
// supported block (Consolas/Cascadia/DejaVu Sans Mono etc. all carry it),
// unlike the newer "Symbols for Legacy Computing" eighth-block glyphs
// (U+1FB00+) which have patchy font support and risk rendering as tofu on
// some Windows setups. In standard monospace fonts a rectangle glyph draws
// as a horizontal bar roughly VERTICALLY CENTERED within the cell — thinner
// than the full cell height and centered, not bottom-aligned like the
// earlier ▄ (lower-half-block) attempt. charWidth() already treats it as
// width 1 without any change needed: 0x25AC is far below every "wide" range
// in that function, matching Unicode's own EastAsianWidth 'N' Neutral
// classification for this codepoint (25AA..25B1 ; N), so it is reliably
// narrow everywhere — no ambiguous-width risk like the icon fix above.
//
// Filled AND unfilled (track) cells use this SAME glyph — only the colour
// differs (band colour vs a fixed dim grey) — so the bar still shows roughly
// how full it is (the empty portion isn't invisible, unlike a lone
// half-block on a blank background) without mixing two different glyph
// shapes, which would reintroduce the height/shape mismatch these changes
// are fixing.
const GAUGE_GLYPH = '▬';
const TRACK_FG = '\x1b[38;2;110;110;110m';
// Returns filledFg + filled glyphs + TRACK_FG + track glyphs, with NO
// trailing reset/restore code — callers append whatever colour/text comes
// next (composeUsageRow moves straight to a band-coloured "%"; composeGaugeText
// does the same before its header-chrome restore).
const gaugeBarSegment = (pct) => {
  let n = Math.round((pct / 100) * 8);
  // pct can be NaN here (both call sites only check `typeof x === 'number'`,
  // and typeof NaN === 'number'); Math.round(NaN) is NaN, and
  // GAUGE_GLYPH.repeat(NaN) silently returns '' for BOTH the filled and
  // track calls (ToIntegerOrInfinity(NaN) = 0), so the whole bar would
  // vanish instead of just miscounting. Treat NaN the same as 0% — 0 filled,
  // 8 track — matching how the rest of this file already falls back
  // defensively on invalid/missing usage data.
  if (Number.isNaN(n)) n = 0;
  n = Math.max(0, Math.min(8, n));
  // \x1b[22m clears bold/dim ONLY (not colour or background) before the
  // track run. bandFg()'s >=80% band returns BOLD + RED_FG, and SGR bold is
  // sticky — without this, the track (empty) cells in a red-band gauge would
  // inherit bold from the preceding filled run, an inconsistency with every
  // other band's regular-weight track. A bare RST would also clear bold but
  // would additionally drop composeGaugeText's SIG_BG background (this
  // function returns a MID-row fragment, not a restore point), punching a
  // default-background hole in the header — so only bold is cleared here.
  return `${bandFg(pct)}${GAUGE_GLYPH.repeat(n)}\x1b[22m${TRACK_FG}${GAUGE_GLYPH.repeat(8 - n)}`;
};

// One usage-overlay row: icon + tool/session key + band-coloured gauges, with
// the same tiered width fallback discipline as composeGaugeText below —
// tier 1: gauges + resets + last-measured clock; tier 2: drop the clock;
// tier 3: drop the reset times; tier 4: single gauge. The smallest tier is
// returned even when over budget (a row must never vanish); composite()'s
// ANSI-aware trimText() then ellipsises the rare still-too-narrow case.
function composeUsageRow(toolCommand, sessionKey, data, budget) {
  const icon = toolGlyph(toolCommand);
  // padIconCol() equalises the icon column width (see toolGlyph's comment
  // above) so the gauge columns that follow stay aligned across rows with
  // different icons.
  const prefix = `${padIconCol(icon)} ${toolCommand}/${sessionKey}`;
  if (!data || (!data.session && !data.weekly)) return `${prefix}: 데이터 없음`;
  const sWin = data.session;
  const wWin = data.weekly;
  const sPct = sWin && typeof sWin.usedPercent === 'number' ? Math.round(sWin.usedPercent) : null;
  const wPct = wWin && typeof wWin.usedPercent === 'number' ? Math.round(wWin.usedPercent) : null;
  if (sPct == null && wPct == null) {
    const pctOf = w => (w && typeof w.usedPercent === 'number') ? `${Math.round(w.usedPercent)}%` : '--';
    return `${prefix}: 세션 ${pctOf(sWin)} · 주간 ${pctOf(wWin)}`;
  }
  // Labeled reset time ("rst HH:mm") — bare parens read as ambiguous
  // (measured-at vs resets-at). Shortened from composeGaugeText's "reset at"
  // label: this overlay row's budget is hard-capped by the ~66-col overlay
  // box (composite()'s boxW = min(width-4, 70)) regardless of terminal width,
  // so "reset at" structurally never fit tier 1 for realistic session keys;
  // composeGaugeText now uses the same "rst" label (unified across both).
  const seg = (lbl, pct, reset) =>
    `${lbl} ${gaugeBarSegment(pct)} ${bandFg(pct)}${pct}%${RST}${reset ? ` rst ${reset}` : ''}`;
  const sesReset = sWin ? fmtGaugeReset(sWin.resetsAt) : '';
  const wkReset  = wWin ? fmtGaugeReset(wWin.resetsAt) : '';
  const sesFull = sPct != null ? seg('S', sPct, sesReset) : '';
  const wkFull  = wPct != null ? seg('W', wPct, wkReset) : '';
  const sesCore = sPct != null ? seg('S', sPct, '') : '';
  const wkCore  = wPct != null ? seg('W', wPct, '') : '';
  const clock = fmtGaugeClock(data.timestamp);
  const join = parts => parts.filter(Boolean).join(' ');
  const fits = str => textWidth(str) <= budget;
  const t1 = join([prefix, sesFull, wkFull, clock ? `⏱ at ${clock}` : '']);
  if (fits(t1)) return t1;
  const t2 = join([prefix, sesFull, wkFull]);
  if (fits(t2)) return t2;
  const t3 = join([prefix, sesCore, wkCore]);
  if (fits(t3)) return t3;
  return join([prefix, sesCore || wkCore]);
}

// The topBar gauge string: band-coloured bars/percentages using the SAME
// gaugeBarSegment() glyph as composeUsageRow's overlay rows (both now share
// one visual height/shape — see the glyph comment above), chromed with the
// header's own SIG_BG/BLACK (not a separate toned-down background — an
// earlier round tried dimming the gauge's own background to de-emphasise it,
// but a dimmed FULL-HEIGHT block still reads as visually "as tall" as the
// header; the fix that actually works is the centered, sub-full-height
// gaugeBarSegment glyph, so the background here just matches the header it
// sits in). No BOLD except inside the >=80% band (bandFg's own bold-red,
// same as composeUsageRow — an explicit RST at the very start also clears
// whatever BOLD the OUTER topBar() wrapping already turned on before this
// string begins, otherwise the gauge would render bold regardless of what
// colour codes are embedded here). Tier fallback against `budget` is
// unchanged from the previous version: 1) gauges+%+resets(+clock if roomy)
// → 2) gauges+% → 3) one gauge → 4) ''. textWidth() is ANSI-aware, so
// coloured candidates measure by visible cells.
function composeGaugeText(cached, budget) {
  const sWin = cached.session;
  const wWin = cached.weekly;
  const sPct = sWin && typeof sWin.usedPercent === 'number' ? Math.round(sWin.usedPercent) : null;
  const wPct = wWin && typeof wWin.usedPercent === 'number' ? Math.round(wWin.usedPercent) : null;
  // After a band-coloured (and possibly bold) run, restore the header's own
  // chrome rather than plain RST: RST alone would drop SIG_BG and punch a
  // default-background hole in the middle of the row.
  const restore = RST + SIG_BG + BLACK;
  const seg = (lbl, pct) => `${lbl} ${gaugeBarSegment(pct)} ${bandFg(pct)}${pct}%${restore}`;
  const sesCore = sPct != null ? seg('S', sPct) : '';
  const wkCore  = wPct != null ? seg('W', wPct) : '';
  const sesReset = sWin ? fmtGaugeReset(sWin.resetsAt) : '';
  const wkReset  = wWin ? fmtGaugeReset(wWin.resetsAt) : '';
  const fits = str => textWidth(str) <= budget;
  // RST first: clears the BOLD that topBar()'s outer SIG_BG+BLACK+BOLD wrap
  // already turned on before this string is spliced in.
  const wrap = str => RST + SIG_BG + BLACK + str + RST;

  // Tier 1: both gauges + % + labeled reset times (+ optional last-cached
  // clock). "rst" / "⏱ at" match composeUsageRow's overlay rows exactly
  // (unified label across both places); the SES/WK segments are joined with
  // " | " instead of a plain double-space for a clearer visual split.
  if (sesCore && wkCore) {
    const t1 = `${sesCore}${sesReset ? ` rst ${sesReset}` : ''} | ${wkCore}${wkReset ? ` rst ${wkReset}` : ''}`;
    if (fits(t1)) {
      const clock = cached.timestamp ? fmtGaugeClock(cached.timestamp) : '';
      if (clock && (budget - textWidth(t1)) > 15) {
        const withClock = `${t1} · ⏱ at ${clock}`;
        if (fits(withClock)) return wrap(withClock);
      }
      return wrap(t1);
    }
    // Tier 2: both gauges + % only.
    const t2 = `${sesCore} | ${wkCore}`;
    if (fits(t2)) return wrap(t2);
  }
  // Tier 3: session gauge + % only (fall back to weekly if session absent).
  if (sesCore && fits(sesCore)) return wrap(sesCore);
  if (!sesCore && wkCore && fits(wkCore)) return wrap(wkCore);
  // Tier 4: nothing fits.
  return '';
}

// ── Bar strings (identical output to lib/wrapper.js) ──────
// 이 프로세스의 인스턴스 식별자("<label> #<pid>") — messaging 수신자 목록이
// 쓰는 문자열(registry.selfIdentity().display)과 동일하다. 하단바 Workspace
// 우측에 박아두면 여러 void 터미널 중 어느 것이 수신자 목록의 어느 항목인지
// 눈으로 매칭할 수 있다(100개여도 pid 로 특정 가능). registry 없으면 조용히
// 생략(fail-open). pid/hostname 은 프로세스 수명 동안 불변이라 1회만 메모한다.
let _instanceTag;
function instanceTag() {
  if (_instanceTag !== undefined) return _instanceTag;
  try { _instanceTag = require('./messaging/registry').selfIdentity().display || null; }
  catch { _instanceTag = null; }
  return _instanceTag;
}

function topBar(cols, label, modeHint) {
  const plainLeft = ` Wrapper >_  ${label} `;
  // Keep the Claude mark warm without colouring the tool name or breaking
  // terminal column calculations with ANSI escape sequences.
  const styledLabel = label.startsWith('✳ ')
    ? ORANGE_FG + '✳' + BLACK + label.slice('✳'.length)
    : label;
  const left = ` Wrapper >_  ${styledLabel} `;
  const tabsWidth = Math.max(0, cols - textWidth(plainLeft) - 1);
  const tabText = trimText(modeHint || '', tabsWidth);
  // tabText may carry its own SGR runs (the usage gauge re-applies SIG_BG/
  // BLACK itself and ends in RST — see composeGaugeText); textWidth/trimText
  // are ANSI-aware so the padding math below stays based on visible cells.
  // The header style is re-asserted after tabText so the trailing pad keeps
  // the signature-green bar unbroken with no default-background gap.
  const pad = ' '.repeat(Math.max(0, cols - textWidth(plainLeft) - textWidth(tabText)));
  return SIG_BG + BLACK + BOLD + left + tabText + RST
    + SIG_BG + BLACK + BOLD + pad + RST;
}

function bottomBar(cols, helpText = '') {
  const time = new Date().toTimeString().slice(0, 8);
  const cwd   = process.cwd();
  const cwdS  = textWidth(cwd) > 40 ? '…' + trimText(cwd.slice(-39), 39) : cwd;
  // Workspace 바로 우측에 인스턴스 식별자("<label> #<pid>")를 붙인다 — messaging
  // 수신자 목록과 동일 문자열이라 어느 터미널이 어느 수신 후보인지 매칭 가능.
  const idTag = instanceTag();
  const idStr = idTag ? `[${idTag}] ` : '';
  const left  = ` Workspace: ${cwdS}  ${idStr}`;
  const right = ` ${time} `;
  const avail = Math.max(0, cols - textWidth(left) - textWidth(right));
  const mid   = trimText(helpText || 'VOID//ai-launcher', avail);
  const midWidth = textWidth(mid);
  const lpad  = Math.max(0, Math.floor((avail - midWidth) / 2));
  const rpad  = Math.max(0, avail - midWidth - lpad);
  return SIG_BG + BLACK + BOLD
    + left + ' '.repeat(lpad) + RED_FG + mid + BLACK + ' '.repeat(rpad) + right + RST;
}

// ── Frame layout (mirrors lib/wrapper.js) ─────────────────
const DEFAULT_HPAD = 2;
const DEFAULT_VPAD = 1;

function computeMargins(cols, rows, hpad, vpad) {
  const topM   = 2 + vpad;
  const botM   = rows - 1 - vpad;
  const leftM  = 2 + hpad;
  const rightM = cols - 1 - hpad;
  return { topM, botM, leftM, rightM };
}

function ptyDims(cols, rows, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  return {
    ptyrows: Math.max(1, botM - topM + 1),
    ptycols: Math.max(1, rightM - leftM + 1),
  };
}

// ── Per-cell SGR fidelity ─────────────────────────────────
// Build the SGR parameter list for a single @xterm/headless IBufferCell,
// covering the full attribute set (the spike only carried inverse+bold).
// Returns a canonical "\x1b[...m" string, or RST when the cell is plain.
function cellSgr(cell) {
  const params = [];

  // Foreground
  if (cell.isFgRGB()) {
    const v = cell.getFgColor();
    params.push(38, 2, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  } else if (cell.isFgPalette()) {
    params.push(38, 5, cell.getFgColor() & 0xff);
  } // default fg → emit nothing (reset baseline is default)

  // Background
  if (cell.isBgRGB()) {
    const v = cell.getBgColor();
    params.push(48, 2, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  } else if (cell.isBgPalette()) {
    params.push(48, 5, cell.getBgColor() & 0xff);
  } // default bg → emit nothing

  if (cell.isBold())          params.push(1);
  if (cell.isDim())           params.push(2);
  if (cell.isItalic())        params.push(3);
  if (cell.isUnderline())     params.push(4);
  if (cell.isBlink())         params.push(5);
  if (cell.isInverse())       params.push(7);
  if (cell.isInvisible())     params.push(8);
  if (cell.isStrikethrough()) params.push(9);

  if (params.length === 0) return RST;
  // Reset first so no stale attribute (bold/color) from a prior run leaks in,
  // then apply this cell's exact style.
  return RST + '\x1b[' + params.join(';') + 'm';
}

// ── Compositor: render the parsed buffer inside void chrome ─
// Reads buffer.active cell-by-cell (buffer.active follows the alt-screen
// automatically on ?1049h) and returns a full physical-screen ANSI string.
// voidPersistent/switchCursor: void-persistent phase-1 account-switch seam.
// Both default to null/undefined for every existing caller, so composite()'s
// output is byte-identical unless a caller explicitly opts in via
// runXtermWrapped's opts.voidPersistent (see below). Phase 2 (auto-mode)
// would extend voidPersistent with its own fields here — not started.
function composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen = false, panelSubView = null, subViewData = null, modeHint = null, voidPersistent = null, switchCursor = null, hasMessaging = false, mailListCursor = null) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  const buf = term.buffer.active;
  const width = rightM - leftM + 1;
  const contentRows = Math.max(1, botM - topM + 1);

  let s = '\x1b[?25l';        // hide cursor during repaint (kill flicker)
  s += '\x1b[r';             // drop any scroll region the child requested
  s += at(1, 1) + topBar(cols, label, modeHint);

  // vpad padding rows (top + bottom): border ─ spaces ─ border
  const padRow = SIDE_RAIL + ' '.repeat(Math.max(0, cols - 2)) + SIDE_RAIL;
  for (let r = 2; r < topM; r++) s += at(r, 1) + padRow;
  for (let r = botM + 1; r <= rows - 1; r++) s += at(r, 1) + padRow;

  const hpadStr = ' '.repeat(hpad);
  for (let y = 0; y < contentRows; y++) {
    const physRow = topM + y;
    // Full-width row: left border + hpad + content + hpad + right border.
    // Writing the whole row every repaint means no stale cells, so no 2J
    // clear is needed on steady-state repaints (that clear is the flicker
    // source in the spike).
    s += at(physRow, 1) + SIDE_RAIL + hpadStr;

    const line = buf.getLine(buf.viewportY + y);
    let body = '';
    let prevSgr = null;
    if (line) {
      for (let x = 0; x < width; x++) {
        const cell = line.getCell(x);
        if (!cell) { body += ' '; prevSgr = null; continue; }
        // Trailing cell of a wide (CJK) glyph: width 0, already covered by
        // the preceding double-width char. Emit nothing so alignment holds.
        if (cell.getWidth() === 0) continue;
        let ch = cell.getChars();
        if (ch === '') ch = ' ';
        const sgr = cellSgr(cell);
        if (sgr !== prevSgr) { body += sgr; prevSgr = sgr; }
        body += ch;
      }
    }
    // Pad content out to the interior width (in case the line was short) then
    // reset before the right padding/border.
    s += body + RST;
    s += hpadStr + SIDE_RAIL;
  }

  if (panelOpen) {
    // Multi-line sub-overlay (help / usage): a bordered box centered over the
    // content area. Drawn AFTER the per-row content loop so it overlays the
    // already-painted cells; because every repaint fully redraws all cells
    // (see the "no stale cells" comment above), the overlay disappears
    // naturally on the next repaint once panelSubView returns to null.
    if (panelSubView && Array.isArray(subViewData)) {
      const boxW = Math.min(width - 4, 70);
      const boxH = Math.min(contentRows - 4, 16, subViewData.length + 2);
      if (boxW >= 10 && boxH >= 3) {
        const boxTop  = topM + Math.max(0, Math.floor((contentRows - boxH) / 2));
        const boxLeft = leftM + Math.max(0, Math.floor((width - boxW) / 2));
        const innerW  = boxW - 2;
        const MAIL_TITLES = {
          mail: ' 메일함 ', 'mail-inbox': ' 수신함 ', 'mail-detail': ' 메시지 ',
          'mail-send': ' 받는 사람 선택 ', 'mail-send-seedtype': ' 종류 선택 ',
          'mail-send-task': ' 태그 선택 ', 'mail-send-session': ' 공유할 세션 선택 ',
          'mail-send-compose': ' 메시지 작성 ',
          'mail-accept-session': ' 이관받을 세션 선택 ', 'mail-accept-confirm': ' 메시지 수락 ',
        };
        const title   = panelSubView === 'usage' ? ' 사용량 '
          : panelSubView === 'switch' ? ' 계정 전환 '
          : MAIL_TITLES[panelSubView] ? MAIL_TITLES[panelSubView]
          : ' 도움말 ';
        const titleText = trimText(title, Math.max(1, innerW - 1));
        const ruleW = Math.max(0, innerW - 1 - textWidth(titleText));
        s += at(boxTop, boxLeft) +
          SIG_FG + '┌─' + RST + BOLD + titleText + RST +
          SIG_FG + '─'.repeat(ruleW) + '┐' + RST;
        for (let i = 0; i < boxH - 2; i++) {
          const raw = subViewData[i] != null ? String(subViewData[i]) : '';
          const lineText = trimText(raw, Math.max(0, innerW - 2));
          const pad = ' '.repeat(Math.max(0, innerW - 2 - textWidth(lineText)));
          // 'switch' subview: highlight the cursor row so the S-key list reads
          // as a selectable menu, not static text (help/usage stay plain).
          // 'mail' / 'mail-inbox' / 'mail-send' (M-key mailbox, Phase A) reuse
          // the same highlight treatment via mailListCursor, kept as a separate
          // param from switchCursor so the void-persistent switch subview's own
          // cursor state is never touched by this addition.
          const isCursorRow = (panelSubView === 'switch' && switchCursor === i)
            || (['mail', 'mail-inbox', 'mail-send', 'mail-send-seedtype', 'mail-send-session', 'mail-accept-session'].includes(panelSubView) && mailListCursor === i);
          s += at(boxTop + 1 + i, boxLeft) +
            SIG_FG + '│' + RST + (isCursorRow ? SIG_BG + BLACK : '') + ' ' + lineText + pad + ' ' + RST + SIG_FG + '│' + RST;
        }
        s += at(boxTop + boxH - 1, boxLeft) +
          SIG_FG + '└' + '─'.repeat(innerW) + '┘' + RST;
      }
    }

    // Keep controls outside the child terminal. The footer-side padding row
    // avoids shrinking or overwriting the CLI's own bottom line.
    // M-key mailbox (Phase A) sub-views each get their own hint string, same
    // treatment as 'switch'. '[a] accept' (Phase B) is wired for 'mail-inbox'
    // and 'mail-detail', which pop the 'mail-accept-confirm' double-confirm
    // subview handled just below.
    const panelLabel = panelSubView === 'switch'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 전환  ·  Esc: 패널로 복귀 '
      : panelSubView === 'mail'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 선택  ·  Esc: 패널로 복귀 '
      : panelSubView === 'mail-inbox'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Space: 선택  ·  Enter: 열기  ·  a: 승락  ·  r: 읽음  ·  d: 삭제  ·  c: 비우기  ·  Esc: 뒤로 '
      : panelSubView === 'mail-detail'
      ? ' Control Panel  ·  a: 승락  ·  d: 삭제  ·  Esc: 뒤로 '
      : panelSubView === 'mail-send'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 선택  ·  Esc: 뒤로 '
      : panelSubView === 'mail-send-seedtype'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 선택  ·  Esc: 뒤로 '
      : panelSubView === 'mail-send-task'
      ? ' Control Panel  ·  ↑/↓: 태그 순환  ·  입력: 직접 작성  ·  Enter: 확인  ·  Esc: 뒤로 '
      : panelSubView === 'mail-send-session'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 선택  ·  Esc: 뒤로 '
      : panelSubView === 'mail-send-compose'
      ? ' Control Panel  ·  Enter: 전송  ·  Esc: 취소 '
      : panelSubView === 'mail-accept-session'
      ? ' Control Panel  ·  ↑/↓: 이동  ·  Enter: 선택  ·  Esc: 취소 '
      : panelSubView === 'mail-accept-confirm'
      ? ' Control Panel  ·  Enter: 승락  ·  Esc: 취소 '
      : panelSubView
      ? ' Control Panel  ·  Esc / Enter: 패널로 복귀 '
      // voidPersistent (void-persistent, phase 1): appends the S-key hint only
      // when the caller opted in — undefined/null leaves this string unchanged.
      // hasMessaging (Phase A, first-class): appends the M-key hint whenever
      // lib/messaging loaded successfully — no void-persistent flag needed.
      : ' Control Panel  ·  H: 도움말  ·  U: 사용량  ·  Enter: 홈으로 복귀  ·  Ctrl+\\ / Esc: 패널 닫기 '
        + (voidPersistent ? '  ·  S: 계정 전환 ' : '')
        + (voidPersistent ? `  ·  X: 자동 모드 [${voidPersistent.autoMode ? 'ON' : 'OFF'}] ` : '')
        + (hasMessaging ? '  ·  M: 메시징 ' : '');
    // A one-row fieldset: its green top edge distinguishes the control area
    // without taking a second row away from the child terminal.
    const panelText = trimText(panelLabel, Math.max(1, width - 3));
    const ruleWidth = Math.max(0, width - 3 - textWidth(panelText));
    s += at(rows - 1, 1) + SIDE_RAIL + hpadStr +
      SIG_FG + '┌─' + RST + BOLD + panelText + RST +
      SIG_FG + '─'.repeat(ruleWidth) + '┐' + RST +
      hpadStr + SIDE_RAIL;
  }

  s += at(rows, 1) + bottomBar(cols, helpText);

  // Place the real hardware cursor where the child put it, mapped into the
  // interior frame, and re-show it.
  const cy = Math.min(topM + buf.cursorY, topM + contentRows - 1);
  const cx = leftM + buf.cursorX;
  s += at(cy, cx) + '\x1b[?25h';
  return s;
}

// ── Mailbox "accept" prompt builder (Phase A — legacy) ───────────
// Superseded internally by lib/messaging/resumeFork.js's acceptSeed()/
// buildMsgAcceptPrompt() (Phase B): entry.file is no longer a filesystem path
// (it's store.js's opaque `${targetId}::${entryId}` handle), so this
// path-shaped helper no longer has a meaningful input inside runXtermWrapped.
// Left in place + exported for back-compat only — nothing in this file calls
// it anymore.
function buildMailAcceptPrompt(absPath) {
  return `'${absPath}' 메시지를 읽어줘`;
}

// ── mail 'resume' accept 즉시-재시작 seam — 순수 헬퍼 ────────────────────
// req = { configDir, resumeSessionId, cwd, landingName } (resumeFork.acceptSeed()
// 의 'switch' directive 를 mail-accept-confirm 이 landingName 만 더해 감싼 것).
// originalTool/originalLabel 은 이번 세션을 처음 열 때 쓰였던 그 인자들
// (runXtermWrapped 의 최상위 클로저 변수 tool/label — 매 반복마다 다시 이걸
// 기준으로 계산해야 이전 --resume 조각이 누적되지 않는다).
//
// env 자체는 여기서 만들지 않는다 — CLAUDE_CONFIG_DIR 만 덮어쓴 얕은 복제는
// 호출부(runXtermWrapped)에서 한다(원본 env 오브젝트 전체를 이 헬퍼가 알 필요는
// 없음). node-pty/@xterm/headless 를 전혀 건드리지 않는 순수 함수라 유닛
// 테스트에서 이 파일을 그냥 require 해도(node-pty 미설치 환경이라도) 안전하다.
function buildMailRestartTool(originalTool, req) {
  if (!req) return null;
  const baseArgs = (originalTool && originalTool.args) || [];
  const args = req.resumeSessionId ? [...baseArgs, '--resume', req.resumeSessionId] : [...baseArgs];
  return { command: originalTool && originalTool.command, args };
}

function buildMailRestartLabel(originalLabel, req) {
  if (!req || !req.landingName) return originalLabel;
  return `${originalLabel}  → [${req.landingName}]`;
}

// Opt-in entry-path tracer (VOID_DEBUG_KEYS=1): logs every early-return branch
// of runXtermWrapped so we can tell whether it's even reached, vs. silently
// falling back to runWrapped/spawnSync (neither of which support PgUp/PgDn).
let entryDebugLog = null;
if (process.env.VOID_DEBUG_KEYS === '1') {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const logPath = path.join(os.tmpdir(), 'void-key-debug.log');
  entryDebugLog = msg => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
}

async function runXtermWrappedOnce(tool, env, label, opts = {}) {
  if (entryDebugLog) entryDebugLog(`runXtermWrapped ENTER tool=${tool && tool.command}`);
  const storage = require('./storage'); // used by the mail send/accept flows to list/resolve the sender's own sessions
  let pty;
  try { pty = require('node-pty'); }
  catch (e) {
    if (entryDebugLog) entryDebugLog(`EXIT: require('node-pty') failed: ${e.message}`);
    return false;
  }

  let Terminal;
  try { ({ Terminal } = require('@xterm/headless')); }
  catch (e) {
    if (entryDebugLog) entryDebugLog(`EXIT: require('@xterm/headless') failed: ${e.message}`);
    return false;
  }

  const canSetRawMode = typeof process.stdin.setRawMode === 'function';
  const hasNativeTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (entryDebugLog) {
    entryDebugLog(`isTTY stdin=${process.stdin.isTTY} stdout=${process.stdout.isTTY} canSetRawMode=${canSetRawMode}`);
  }
  if (!hasNativeTty) {
    if (entryDebugLog) entryDebugLog('EXIT: hasNativeTty=false');
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;
  const liveBars = opts.liveBars !== false;
  const toolCommand = String(tool.command || '').toLowerCase();
  // Full-screen CLIs do not all negotiate mouse input the same way. Claude
  // enables DEC mouse reporting itself, while Codex expects its host terminal
  // to provide mouse events. If Codex is left in the outer terminal's
  // alternate-scroll mode, a wheel turn is converted to Up/Down key presses
  // before the wrapper can relay it.
  const inputProfile = getInputProfile(toolCommand);
  // Ctrl+Space는 Windows 터미널/IME에서 가로채므로 실제 전달되는 Ctrl+\\만
  // 패널 호출 키로 사용한다. 홈 복귀는 패널 안에서만 가능하다.
  const helpText = 'Ctrl+\\: 컨트롤 패널';

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) {
    if (entryDebugLog) entryDebugLog(`EXIT: too small rows=${rows} cols=${cols}`);
    return false;
  }

  let panelOpen = false;
  // null | 'help' | 'usage' | 'switch' | 'mail' | 'mail-inbox' | 'mail-detail'
  // | 'mail-send' | 'mail-send-compose' | 'mail-accept-confirm'
  let panelSubView = null;
  let subViewData = null;   // string[] rendered by the active sub-overlay
  let usageEntries = null;  // parallel target list for the 'usage' overlay rows

  // ── void-persistent account switcher (phase 1 manual + phase 2 auto) ─────
  // opts.voidPersistent is undefined for every existing caller (runner.js's
  // runTool never sets it), so switchCursor/onControlAction/restartSignal stay
  // inert and composite()'s output is unchanged for those callers. Only
  // lib/void-persistent/switchProfile.js's runVoidPersistentSession opts in.
  const voidPersistent = opts.voidPersistent || null;
  const onControlAction = typeof opts.onControlAction === 'function' ? opts.onControlAction : null;
  const restartSignal = opts.restartSignal || null;
  // Mail 'resume' accept 즉시-재시작 seam. opts.voidPersistent/onControlAction/
  // restartSignal(위)과는 완전히 독립적이다 — 이 필드는 오직 이 파일 맨 아래의
  // 얇은 루프 래퍼 runXtermWrapped 만 채워 넣는다(외부 호출부인 runner.js/
  // switchProfile.js 는 이 필드의 존재조차 모른다). 매 반복마다 새 박스를
  // 넘기므로 이전 호출의 요청이 다음 호출로 새는 일도 없다.
  const mailRestartSignal = opts.__mailRestartSignal || null;
  let switchCursor = voidPersistent && typeof voidPersistent.activePoolIndex === 'number' && voidPersistent.activePoolIndex >= 0
    ? voidPersistent.activePoolIndex : 0;
  const buildSwitchOverlay = () => {
    if (!voidPersistent || !Array.isArray(voidPersistent.pool)) return ['전환 가능한 계정이 없습니다'];
    if (voidPersistent.pool.length === 0) return ['pool 이 비어 있습니다'];
    return voidPersistent.pool.map((m, i) => {
      const active = i === voidPersistent.activePoolIndex ? ' (활성)' : '';
      return `${m.name}  [${m.toolCommand || 'claude'}]${active}`;
    });
  };
  // Phase 2 (auto-mode): the 'X' key toggle lives further down alongside the
  // 'S' key handler; opts.voidPersistent.pollPendingRestart is polled from
  // barTimer below — see both call sites for the full seam.
  const pollPendingRestart = voidPersistent && typeof voidPersistent.pollPendingRestart === 'function'
    ? voidPersistent.pollPendingRestart : null;

  // ── void-to-void 메시징 (M key, Phase A) ─────────────────
  // FIRST-CLASS, not an experiment — active for every wrapped session, as
  // long as lib/messaging loads. If it fails to require for any reason
  // (missing files, unwritable storage dir, etc.), `messaging` stays null:
  // the M hint is omitted from the panel label and the M key is simply
  // unbound, exactly like any other unmatched key already falls through.
  // Nothing else about the control panel changes in that case.
  let messaging = null;
  try {
    messaging = {
      registry: require('./messaging/registry'),
      mailbox: require('./messaging/mailbox'),
      resumeFork: require('./messaging/resumeFork'),
    };
  } catch { messaging = null; }
  const selfMailId = () => (messaging ? messaging.registry.selfId() : null);

  let mailCursor = 0;          // cursor within the 'mail' top menu (0|1)
  let mailListCursor = 0;      // cursor within 'mail-inbox' / 'mail-send' / 'mail-send-seedtype' / 'mail-send-session' / 'mail-accept-session' lists
  let mailChecked = new Set(); // checked message files, 'mail-inbox' only
  let mailInboxEntries = null; // parallel array backing the active 'mail-inbox' rows
  let mailPeers = null;        // parallel array backing the active 'mail-send' rows
  let mailSendTarget = null;   // chosen recipient id, or '*' for broadcast
  let mailComposeBuf = '';     // inline compose buffer, 'mail-send-compose' only
  let mailFlash = null;        // one-shot confirmation line, consumed by buildMailMenuOverlay()
  let mailDetailFile = null;   // message file currently shown by 'mail-detail'
  // ── SEND flow additions (Phase B): seedType/task tag/own-session picker ──
  // Extends the original peer-only send flow with three more steps between
  // 'mail-send' (peer pick, unchanged) and 'mail-send-compose' (body, reused):
  //   mail-send → mail-send-seedtype → mail-send-task → [mail-send-session] → mail-send-compose
  // mail-send-session only appears for seedType resume/resume-fork.
  let mailSeedType = 'msg';      // 'msg' | 'resume' | 'resume-fork' — chosen in 'mail-send-seedtype'
  let mailTaskId = 'general';    // task tag — chosen/typed in 'mail-send-task'
  let mailTaskBuf = 'general';   // live edit buffer backing 'mail-send-task'
  let mailTaskOptions = null;    // parallel array of known task ids, for ↑/↓ cycling in 'mail-send-task'
  let mailSessions = null;       // parallel array backing 'mail-send-session' (sender's own claude sessions)
  let mailResumePointer = null;  // resumeFork.buildResumePointer() result, for resume/resume-fork sends
  // [a] accept (Phase B): confirm state for dispatching a message via
  // resumeFork.acceptSeed(). mailAcceptEntry is the full inbox record
  // (seedType/payload/body/task_id/file=handle). mailAcceptReturnView
  // remembers which mail subview to fall back to on Esc ('mail-inbox' or
  // 'mail-detail'). mailAcceptPromptText/mailAcceptDescription hold the
  // human-readable preview shown in the confirm popup — for seedType 'msg'
  // it doubles as the literal text injected into the child on Enter.
  // mailAcceptLandingSession is the receiver's OWN session (with its own
  // credentials) chosen in 'mail-accept-session', required before a
  // seedType 'resume' accept can be dispatched.
  let mailAcceptEntry = null;
  let mailAcceptPromptText = null;
  let mailAcceptReturnView = null;
  let mailAcceptLandingSession = null;
  let mailAcceptSessions = null; // parallel array backing 'mail-accept-session'

  const buildMailMenuOverlay = () => {
    if (!messaging) return ['메시징을 사용할 수 없습니다'];
    let unread = 0, total = 0;
    try {
      unread = messaging.mailbox.unreadCount(selfMailId());
      total  = messaging.mailbox.totalCount(selfMailId());
    } catch {}
    const rows = [];
    if (mailFlash) { rows.push(mailFlash); rows.push(''); mailFlash = null; }
    rows.push(`[1] 수신함 (${unread}/${total})`);
    rows.push('[2] 발송');
    return rows;
  };

  const formatMailRow = entry => {
    const box = mailChecked.has(entry.file) ? '[x]' : '[ ]';
    const dot = entry.read ? '●' : '○';
    const ts  = entry.timestamp ? String(entry.timestamp).replace('T', ' ').slice(0, 16) : '';
    // seedType/task_id 태그 — 평문 메시지(msg)+기본 태그(general)일 땐 표시하지
    // 않아 phase A 시절 행 포맷을 그대로 유지한다(additive).
    const seedTag = entry.seedType && entry.seedType !== 'msg' ? ` <${entry.seedType}>` : '';
    const taskTag = entry.task_id && entry.task_id !== 'general' ? ` #${entry.task_id}` : '';
    return `${box} ${dot} ${entry.preview || '(내용 없음)'}${seedTag}${taskTag}  ${ts}`;
  };

  const buildMailInboxOverlay = () => {
    mailInboxEntries = null;
    if (!messaging) return ['메시징을 사용할 수 없습니다'];
    let entries = [];
    try { entries = messaging.mailbox.listInbox(selfMailId()); } catch {}
    mailInboxEntries = entries;
    if (entries.length === 0) return ['받은 메시지가 없습니다'];
    return entries.map(formatMailRow);
  };

  // Naive char-count wrap (good enough for phase A: message bodies are plain
  // markdown text, no embedded SGR runs to account for like the gauge/usage
  // rows do).
  const wrapBodyText = (text, width) => {
    const w = Math.max(1, width);
    const out = [];
    for (const rawLine of String(text || '').split('\n')) {
      if (rawLine.length === 0) { out.push(''); continue; }
      let line = rawLine;
      while (textWidth(line) > w) {
        let cut = w;
        while (cut > 0 && textWidth(line.slice(0, cut)) > w) cut--;
        if (cut <= 0) cut = 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
      out.push(line);
    }
    return out;
  };

  const buildMailDetailOverlay = file => {
    if (!messaging) return ['메시징을 사용할 수 없습니다'];
    const entries = mailInboxEntries || [];
    const entry = entries.find(e => e.file === file);
    if (!entry) return ['메시지를 찾을 수 없습니다'];
    const { leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
    const width = rightM - leftM + 1;
    const boxW = Math.min(width - 4, 70);
    const innerW = Math.max(10, boxW - 2 - 2);
    const header = [
      `From: ${entry.fromLabel || entry.from || '(알 수 없음)'} (${entry.from || '?'})`,
      `Time: ${entry.timestamp || ''}`,
      '',
    ];
    return header.concat(wrapBodyText(entry.body, innerW));
  };

  const buildMailSendPickOverlay = () => {
    mailPeers = null;
    if (!messaging) return ['메시징을 사용할 수 없습니다'];
    let peers = [];
    try { peers = messaging.registry.listPeers({ includeSelf: false }); } catch {}
    mailPeers = peers;
    const rows = peers.map(p => `${p.label} #${p.pid}`);
    rows.push('[전체 broadcast]');
    return rows;
  };

  // ── SEND step (b): seedType picker ──────────────────────
  // Order/value pairs are load-bearing — mailListCursor indexes directly into
  // this array both for rendering and for the Enter handler below.
  const SEED_TYPE_CHOICES = [
    { value: 'msg', label: '일반 메시지 (msg)' },
    { value: 'resume', label: '세션 이어서 진행 요청 (resume) — 내 세션을 상대에게 이관' },
    { value: 'resume-fork', label: '세션 포크 공유 (resume-fork) — 내 세션을 복사해서 공유' },
  ];
  const buildMailSeedTypeOverlay = () => SEED_TYPE_CHOICES.map(c => c.label);

  // ── SEND step (c): task 태그 선택/입력 ───────────────────
  // Hybrid list+textbox: ↑/↓ cycles mailTaskBuf through known tags (own inbox
  // task_id's ∪ 'general'), while typing edits mailTaskBuf directly. Enter
  // confirms whatever mailTaskBuf currently holds (cycled or typed) as the tag.
  const buildMailTaskOverlay = () => {
    mailTaskOptions = null;
    let options = ['general'];
    if (messaging) {
      try { options = messaging.mailbox.listTaskIds(selfMailId()); } catch {}
    }
    mailTaskOptions = options;
    return [
      '태그 선택 (↑/↓: 기존 태그 순환, 직접 입력도 가능)',
      '',
      `> ${mailTaskBuf}▍`,
      '',
      'Enter: 확인  ·  Esc: 뒤로',
    ];
  };

  // ── SEND step (d): 공유할 내 세션 선택 (resume/resume-fork 전용) ─────────
  // switchProfile.js의 eligibleSessions()와 동일한 필터(claude 세션만)를
  // 미러링한다 — messaging과 void-persistent는 서로 다른 관심사라 결합하지 않는다
  // (resumeFork.js 헤더 주석과 동일한 근거).
  const buildMailSessionPickOverlay = () => {
    mailSessions = null;
    let sessions = [];
    try { sessions = storage.getSessions().filter(s => (s.toolCommand || 'claude').toLowerCase() === 'claude'); } catch {}
    mailSessions = sessions;
    if (sessions.length === 0) return ['공유할 세션이 없습니다 (등록된 claude 네임드 세션 없음)'];
    return sessions.map(s => `${s.name}  [${s.toolCommand || 'claude'}]`);
  };

  const buildMailComposeOverlay = () => {
    const peerMatch = (mailPeers || []).find(p => p.id === mailSendTarget);
    const targetLabel = mailSendTarget === '*'
      ? '전체 broadcast'
      : (peerMatch ? peerMatch.label : (mailSendTarget || '?'));
    const seedLabel = (SEED_TYPE_CHOICES.find(c => c.value === mailSeedType) || {}).label || mailSeedType;
    return [
      `받는 사람: ${targetLabel}  ·  종류: ${seedLabel}  ·  태그: ${mailTaskId}`,
      '',
      `> ${mailComposeBuf}▍`,
      '',
      'Enter: 전송  ·  Esc: 취소',
    ];
  };

  // ── ACCEPT (Phase B): 세션 선택 (resume 전용) ────────────
  // 'resume' 을 수락하려면 landing configDir 이 필요하다 — 크리덴셜을 가진
  // 수신자 자신의 claude 세션이어야 한다(발신측 pointer 는 크리덴셜을 담지
  // 않는다). buildMailSessionPickOverlay 와 동일한 필터를 쓰지만 상태 변수는
  // 별개(mailAcceptSessions)다 — SEND 흐름과 ACCEPT 흐름이 같은 패널 안에서
  // 동시에 열릴 일은 없지만, 개념적으로 분리해 둔다.
  const buildMailAcceptSessionOverlay = () => {
    mailAcceptSessions = null;
    let sessions = [];
    try { sessions = storage.getSessions().filter(s => (s.toolCommand || 'claude').toLowerCase() === 'claude'); } catch {}
    mailAcceptSessions = sessions;
    if (sessions.length === 0) return ['이관받을 세션이 없습니다 (등록된 claude 네임드 세션 없음)'];
    return sessions.map(s => `${s.name}  [${s.toolCommand || 'claude'}]`);
  };

  // [a] accept (Phase B) — double-confirm popup shown before dispatching a
  // message via resumeFork.acceptSeed(). description is a human-readable
  // preview of what Enter will do; for seedType 'msg' it doubles as the exact
  // text written verbatim (no trailing newline) via child.write() on Enter —
  // for 'resume'/'resume-fork' the actual acceptSeed() side effects (jsonl
  // copy, new session registration, source lock) only happen on Enter, never
  // while building this preview.
  const buildMailAcceptConfirmOverlay = description => [
    description,
    '',
    '[enter: 승락]  [esc: 취소]',
  ];

  // Pure preview-text builder — never calls resumeFork.acceptSeed() (which has
  // real side effects for resume/resume-fork: jsonl copy, session
  // registration, source lock). Safe exception: seedType 'msg' IS pure
  // (buildMsgAcceptPrompt just formats text), so calling acceptSeed() here for
  // msg is fine and lets the confirm popup show the exact text that will be
  // injected, matching the pre-existing UX.
  const describeAcceptPreview = entry => {
    if (!entry) return '';
    if (entry.seedType === 'msg') {
      try { return messaging.resumeFork.acceptSeed(entry, {}).promptText; }
      catch { return entry.body || ''; }
    }
    if (entry.seedType === 'resume-fork') {
      const p = entry.payload || {};
      return `'${entry.fromLabel || entry.from || '?'}' 님의 세션 '${p.sourceProfile || '?'}' 을(를) 포크하여 새 세션으로 등록합니다.`;
    }
    if (entry.seedType === 'resume') {
      const p = entry.payload || {};
      const landing = mailAcceptLandingSession;
      return `'${p.sourceProfile || '?'}' 세션을 '${landing ? landing.name : '(세션 미선택)'}' 프로필로 이관합니다. (원본 세션은 잠금 처리됩니다)`;
    }
    return entry.body || '';
  };

  // [a] accept 진입점 — mail-inbox/mail-detail 두 호출부가 공유한다.
  // seedType 'resume' 는 landing configDir(수신자 자신의 크리덴셜을 가진
  // claude 세션)이 반드시 필요하므로 'mail-accept-session' 피커를 먼저 거친다.
  // 'msg'/'resume-fork' 는 곧바로 이중 확인 팝업으로 간다 — 실제 acceptSeed()
  // 호출(부작용 발생)은 그 팝업의 Enter 입력에서만 일어난다.
  const beginAcceptFlow = (entry, returnView) => {
    mailAcceptEntry = entry;
    mailAcceptReturnView = returnView;
    mailAcceptLandingSession = null;
    if (entry.seedType === 'resume') {
      mailListCursor = 0;
      panelSubView = 'mail-accept-session';
      subViewData = buildMailAcceptSessionOverlay();
      return;
    }
    mailAcceptPromptText = describeAcceptPreview(entry);
    panelSubView = 'mail-accept-confirm';
    subViewData = buildMailAcceptConfirmOverlay(mailAcceptPromptText);
  };

  // ── Top-bar usage gauge (throttled, cache-only) ─────────
  // Shows the CURRENTLY RUNNING session's cached session/weekly usage as a
  // compact block-bar in topBar's otherwise-unused right slot. Recomputed at
  // most once per GAUGE_REFRESH_MS because composite() repaints many times per
  // second and opts.buildUsageOverview() reads a file + one DB row PER session.
  let gaugeText = '';
  let gaugeComputedAt = 0;
  // 1000ms: aligned with barTimer's 1-second idle repaint tick below, so the
  // gauge refreshes its cache read in sync with the footer clock. Still a
  // read-only cache lookup (no fetch), and sub-second repaint bursts from
  // child output still coalesce into at most one recompute per second.
  const GAUGE_REFRESH_MS = 1000;

  const buildGaugeText = () => {
    if (typeof opts.buildUsageOverview !== 'function') return '';
    let entries = null;
    try { entries = opts.buildUsageOverview(); } catch { return ''; }
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const cmd = (tool.command || '').toLowerCase();
    const provider = cmd === 'codex' ? 'codex' : cmd === 'agy' ? 'agy' : 'claude';
    const sessionKey = opts.sessionKey || 'default';
    const entry = entries.find(e => e && e.toolCommand === provider && e.sessionKey === sessionKey);
    const cached = entry && entry.cached;
    if (!cached || (!cached.session && !cached.weekly)) return '';

    // Budget: mirror topBar's tabsWidth math against the CURRENT cols/label.
    const plainLeft = ` Wrapper >_  ${label} `;
    const budget = Math.max(0, cols - textWidth(plainLeft) - 1);
    if (budget <= 0) return '';
    return composeGaugeText(cached, budget);
  };

  const currentGaugeText = () => {
    const now = Date.now();
    if (now - gaugeComputedAt >= GAUGE_REFRESH_MS) {
      gaugeText = buildGaugeText();
      gaugeComputedAt = now;
    }
    return gaugeText;
  };

  const currentDims = () => ptyDims(cols, rows, hpad, vpad);
  const dims0 = currentDims();
  const term = new Terminal({
    cols: dims0.ptycols,
    rows: dims0.ptyrows,
    allowProposedApi: true,
    scrollback: 1000,
  });

  // node-pty's Windows backend does not resolve the `cmd` PATH alias. Use
  // ComSpec (normally C:\\Windows\\System32\\cmd.exe) so ConPTY can create
  // the child instead of failing with "File not found" and triggering fallback.
  const ptyCmd = process.platform === 'win32'
    ? (process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
    : tool.command;
  const ptyArgs = process.platform === 'win32'
    ? ['/c', tool.command, ...(tool.args || [])]
    : (tool.args || []);

  let child;
  try {
    child = pty.spawn(ptyCmd, ptyArgs, {
      name: 'xterm-256color',
      cols: dims0.ptycols,
      rows: dims0.ptyrows,
      cwd: process.cwd(),
      env: { ...env, TERM: 'xterm-256color' },
    });
  } catch (e) {
    if (entryDebugLog) entryDebugLog(`EXIT: pty.spawn failed: ${e.message}`);
    return false;
  }
  if (entryDebugLog) entryDebugLog('pty.spawn OK, entering onStdin wiring');

  process.stdout.write('\x1b[?1049h'); // alternate screen (isolate scrollback)
  process.stdout.write('\x1b[2J\x1b[H'); // one initial clear
  if (inputProfile.wrapperMouse) process.stdout.write(inputProfile.mouseEnable);

  const prevRaw = process.stdin.isRaw;
  if (canSetRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  // ── Debounced / coalesced repaint ───────────────────────
  // A burst of child output within one tick collapses into a single repaint.
  let repaintPending = false;
  let done = false;
  function paint() {
    if (done) return;
    // Mail subviews share one highlighted-row concept across two different
    // local cursor variables ('mail' uses mailCursor, every other list-based
    // mail subview uses mailListCursor) — composite() just needs whichever
    // one is live. Text-input subviews ('mail-send-task', 'mail-send-compose')
    // have no cursor row of their own, so they fall through to null.
    const MAIL_LIST_SUBVIEWS = ['mail-inbox', 'mail-send', 'mail-send-seedtype', 'mail-send-session', 'mail-accept-session'];
    const mailCursorForPaint = panelSubView === 'mail' ? mailCursor
      : MAIL_LIST_SUBVIEWS.includes(panelSubView) ? mailListCursor
      : null;
    process.stdout.write(composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen, panelSubView, subViewData, currentGaugeText(), voidPersistent, switchCursor, Boolean(messaging), mailCursorForPaint));
  }
  function scheduleRepaint() {
    if (repaintPending || done) return;
    repaintPending = true;
    setImmediate(() => { repaintPending = false; paint(); });
  }

  // ── I/O wiring ──────────────────────────────────────────
  let closeRequested = false;
  const closeWrapper = () => {
    if (closeRequested) return;
    closeRequested = true;
    // A node-pty child owns a Windows ConPTY process tree. Killing its cmd.exe
    // host closes the launched CLI too, then normal teardown returns to VOID.
    try { child.kill(); } catch {}
  };
  const togglePanel = () => {
    panelOpen = !panelOpen;
    if (!panelOpen) {
      panelSubView = null; subViewData = null; usageEntries = null;
      // Reset transient mail UI state so reopening the panel starts clean
      // rather than resuming mid-compose or with a stale checked-set.
      mailCursor = 0; mailListCursor = 0; mailChecked = new Set();
      mailInboxEntries = null; mailPeers = null; mailSendTarget = null;
      mailComposeBuf = ''; mailFlash = null;
      mailSeedType = 'msg'; mailTaskId = 'general'; mailTaskBuf = 'general';
      mailTaskOptions = null; mailSessions = null; mailResumePointer = null;
      mailAcceptEntry = null; mailAcceptPromptText = null; mailAcceptReturnView = null;
      mailAcceptLandingSession = null; mailAcceptSessions = null;
    }
    const d = currentDims();
    term.resize(d.ptycols, d.ptyrows);
    child.resize(d.ptycols, d.ptyrows);
    scheduleRepaint();
  };

  // ── Control-panel sub-overlays (help / usage) ───────────
  // Accurate description of the keybindings actually implemented in this file.
  const buildHelpOverlay = () => [
    'Ctrl+\\        컨트롤 패널 열기/닫기',
    'PgUp/PgDn     스크롤백 스크롤 — 기본 화면 버퍼에서만 동작.',
    '              전체화면 TUI(alt-screen)에서는 앱이 직접 처리',
    'Shift+드래그  선택영역 복사 (터미널 기본 동작)',
    '',
    '── 패널이 열려 있을 때 ──',
    'H             도움말 (이 화면)',
    'U             사용량 조회',
    // M-key hint mirrors the panel bar (composite() line ~590): only shown when
    // lib/messaging loaded, since the 'M' handler is gated on `messaging` too.
    ...(messaging ? ['M             메시징 (받은 편지함 · 보내기)'] : []),
    'Enter         세션 종료 후 void 홈으로 복귀',
    'Esc           패널 닫기',
    '',
    '── 도움말/사용량 화면에서 ──',
    'Esc / Enter   패널로 복귀 (세션은 유지됨)',
  ];

  const formatUsageRow = (toolCommand, sessionKey, data) => {
    // Row budget mirrors composite()'s overlay box math against the live
    // cols/rows: boxW = min(width - 4, 70), rows trimmed to innerW - 2.
    const { leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
    const budget = Math.min((rightM - leftM + 1) - 4, 70) - 4;
    return composeUsageRow(toolCommand, sessionKey, data, Math.max(0, budget));
  };

  const buildUsageOverlaySync = () => {
    usageEntries = null;
    if (typeof opts.buildUsageOverview !== 'function') {
      return ['사용량 데이터를 사용할 수 없습니다'];
    }
    let entries = null;
    try { entries = opts.buildUsageOverview(); } catch {}
    if (!Array.isArray(entries) || entries.length === 0) {
      return ['사용량 데이터를 사용할 수 없습니다'];
    }
    usageEntries = entries;
    return entries.map(e => formatUsageRow(e.toolCommand, e.sessionKey, e.cached));
  };

  // Live refetch for the CURRENTLY RUNNING session only; the matching overlay
  // row is updated in place when it resolves (if the overlay is still open).
  let usageRefreshGen = 0;
  const startUsageRefresh = () => {
    if (typeof opts.refreshCurrentUsage !== 'function') return;
    if (!Array.isArray(usageEntries) || !Array.isArray(subViewData)) return;
    const myGen = ++usageRefreshGen;
    const cmd = (tool.command || '').toLowerCase();
    const provider = cmd === 'codex' ? 'codex' : cmd === 'agy' ? 'agy' : 'claude';
    const sessionKey = opts.sessionKey || 'default';
    const idx = usageEntries.findIndex(e => e.toolCommand === provider && e.sessionKey === sessionKey);
    if (idx < 0 || idx >= subViewData.length) return;
    subViewData[idx] += '  (갱신 중…)';
    let p;
    try {
      p = opts.refreshCurrentUsage({
        configDir: env.CLAUDE_CONFIG_DIR || env.CODEX_HOME || env.AGY_CONFIG_DIR,
        sessionKey,
      });
    } catch { return; }
    Promise.resolve(p).then(result => {
      // The user may have already closed the overlay (or the whole wrapper),
      // or reopened it — a newer refresh generation supersedes this one.
      if (done || myGen !== usageRefreshGen || panelSubView !== 'usage' || !Array.isArray(subViewData)) return;
      if (idx >= subViewData.length) return;
      subViewData[idx] = (result && (result.session || result.weekly))
        ? formatUsageRow(provider, sessionKey, result) + (result.stale ? ' (캐시)' : '')
        : `${provider}/${sessionKey}: 조회 실패`;
      scheduleRepaint();
    }).catch(() => {});
  };
  // PgUp/PgDn arrive as multi-byte escape sequences (\x1b[5~ / \x1b[6~). On
  // some platforms (observed on Linux/WSL pty relays) the bytes land split
  // across two separate 'data' events instead of one, so a naive per-chunk
  // .includes() check silently misses them. Buffer a lone partial prefix and
  // reassemble it with the next chunk; flush it as plain input after a short
  // timeout so a genuine standalone Escape keypress still passes through.
  let escBuf = '';
  let escTimer = null;
  const ESC_PREFIXES = ['\x1b', '\x1b[', '\x1b[5', '\x1b[6'];
  const flushEscBuf = () => {
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    if (!escBuf) return;
    const pending = escBuf;
    escBuf = '';
    child.write(pending);
  };
  // Same split-chunk risk, but for child->terminal mouse DECSET detection in
  // onData below; unlike escBuf this has nothing to forward, so a stale
  // partial prefix is simply dropped once its timeout fires.
  let mouseSeqBuf = '';
  let mouseSeqTimer = null;
  const MOUSE_PREFIXES = new Set();
  ['1000', '1001', '1002', '1003', '1004', '1005', '1006', '1015', '1016'].forEach(code => {
    const full = '\x1b[?' + code;
    for (let i = 1; i <= full.length; i++) MOUSE_PREFIXES.add(full.slice(0, i));
  });
  const MOUSE_PREFIX_MAXLEN = Math.max(...[...MOUSE_PREFIXES].map(p => p.length));
  // Opt-in raw-byte logging (VOID_DEBUG_KEYS=1) to diagnose terminals that send
  // a different byte sequence than the xterm-standard \x1b[5~/\x1b[6~ for
  // PgUp/PgDn. Logs only chunks containing an ESC byte, never plain typed text.
  if (entryDebugLog) entryDebugLog(`--- onStdin wired (pid=${process.pid}) ---`);
  const onStdin = data => {
    let input = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (entryDebugLog && input.includes('\x1b')) {
      entryDebugLog(`raw hex=${Buffer.from(input, 'utf8').toString('hex')} bufferType=${term.buffer.active.type}`);
    }
    if (escBuf) {
      input = escBuf + input;
      escBuf = '';
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    }
    if (inputProfile.wrapperMouse) {
      let wheelDelta = 0;
      // Codex runs with --no-alt-screen in this wrapper, so its history lives
      // in the headless terminal's normal-buffer scrollback. Consume outer
      // SGR mouse reports here and move that viewport; sending them to Codex
      // would merely insert an input sequence because Codex did not request
      // mouse capture itself. Button 64 is wheel-up and 65 is wheel-down.
      input = input.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (sequence, buttonText) => {
        const button = Number(buttonText);
        if ((button & 64) !== 0) wheelDelta += (button & 1) === 0 ? -3 : 3;
        return '';
      });
      if (wheelDelta !== 0) {
        term.scrollLines(wheelDelta);
        scheduleRepaint();
      }
      // Click/release reports are wrapper-owned too, and an input chunk may
      // consist solely of one such report.
      if (!input) return;
    }
    // The alternate screen buffer (entered by full-screen TUI children like
    // Claude Code / Codex) has no scrollback of its own — same as a real
    // terminal, PageUp/PageDown there belong to the app, not the terminal.
    // Only hijack them for our own scrollback while on the primary buffer;
    // otherwise let the child handle them (it may implement its own scroll).
    const onPrimaryBuffer = term.buffer.active.type === 'normal';
    if (onPrimaryBuffer && input.includes('\x1b[5~')) {
      term.scrollPages(-1);
      scheduleRepaint();
      return;
    }
    if (onPrimaryBuffer && input.includes('\x1b[6~')) {
      term.scrollPages(1);
      scheduleRepaint();
      return;
    }
    // Ctrl+\\ (0x1c) is the reliable control-panel shortcut on Windows.
    if (input.includes('\x1c')) {
      togglePanel();
      return;
    }
    if (panelOpen) {
      // Korean IME jamo -> QWERTY fallback (lib/hangulKeymap.js) for the bare-
      // letter command hotkeys below (vi-nav k/j, mail actions r/R/d/D/c/C/a/A,
      // base panel keys H/U/S/X/M). Never applied to the free-text compose
      // buffers (mail-send-task/mail-send-compose accumulate `input` verbatim,
      // see their per-char loops further down) or to the raw child passthrough
      // at the bottom of this handler.
      const hkInput = hangulToQwerty(input) || input;
      // 'switch' sub-overlay (void-persistent, phase 1): unlike help/usage it is
      // an actual list — Up/Down move the cursor, Enter invokes the switch
      // instead of just closing back to the panel base view. Checked before
      // the generic panelSubView branch below since its Esc/Enter semantics differ.
      if (panelSubView === 'switch') {
        if (input.includes('\x1b[A') || hkInput === 'k') {
          if (voidPersistent && Array.isArray(voidPersistent.pool) && voidPersistent.pool.length > 0) {
            switchCursor = (switchCursor - 1 + voidPersistent.pool.length) % voidPersistent.pool.length;
            scheduleRepaint();
          }
          return;
        }
        if (input.includes('\x1b[B') || hkInput === 'j') {
          if (voidPersistent && Array.isArray(voidPersistent.pool) && voidPersistent.pool.length > 0) {
            switchCursor = (switchCursor + 1) % voidPersistent.pool.length;
            scheduleRepaint();
          }
          return;
        }
        if (/^[\r\n]+$/.test(input)) {
          if (onControlAction) {
            Promise.resolve(onControlAction({ type: 'switch', poolIndex: switchCursor }))
              .then(() => {
                // restartSignal.requested is set synchronously inside
                // onControlAction on success (see switchProfile.js); close the
                // wrapper either way — the caller decides relaunch vs return-to-menu.
                closeWrapper();
              })
              .catch(() => { closeWrapper(); });
          }
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = null;
          subViewData = null;
          scheduleRepaint();
        }
        return;
      }
      // ── Mailbox subviews (M key, Phase A) ─────────────────
      // Checked before the generic panelSubView branch below (same reason as
      // 'switch' above): each mail subview is an actual list/menu/editor with
      // its own Esc/Enter semantics, not the "Esc or Enter just closes back to
      // the panel" behavior that help/usage share.
      if (panelSubView === 'mail') {
        // Only two menu items, so up and down both simply toggle between them.
        if (input.includes('\x1b[A') || hkInput === 'k' || input.includes('\x1b[B') || hkInput === 'j') {
          mailCursor = (mailCursor + 1) % 2;
          scheduleRepaint();
          return;
        }
        if (input === '1') mailCursor = 0;
        if (input === '2') mailCursor = 1;
        if (/^[\r\n]+$/.test(input) || input === '1' || input === '2') {
          if (mailCursor === 0) {
            panelSubView = 'mail-inbox';
            mailListCursor = 0;
            mailChecked = new Set();
            subViewData = buildMailInboxOverlay();
          } else {
            panelSubView = 'mail-send';
            mailListCursor = 0;
            subViewData = buildMailSendPickOverlay();
          }
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = null;
          subViewData = null;
          scheduleRepaint();
        }
        return;
      }
      if (panelSubView === 'mail-inbox') {
        const entries = mailInboxEntries || [];
        if (input.includes('\x1b[A') || hkInput === 'k') {
          if (entries.length) mailListCursor = (mailListCursor - 1 + entries.length) % entries.length;
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b[B') || hkInput === 'j') {
          if (entries.length) mailListCursor = (mailListCursor + 1) % entries.length;
          scheduleRepaint();
          return;
        }
        if (input === ' ') {
          const entry = entries[mailListCursor];
          if (entry) {
            if (mailChecked.has(entry.file)) mailChecked.delete(entry.file);
            else mailChecked.add(entry.file);
            subViewData = buildMailInboxOverlay();
          }
          scheduleRepaint();
          return;
        }
        if (input === '\x01') { // Ctrl+A: select-all / deselect-all toggle
          if (entries.length && mailChecked.size === entries.length) mailChecked.clear();
          else entries.forEach(e => mailChecked.add(e.file));
          subViewData = buildMailInboxOverlay();
          scheduleRepaint();
          return;
        }
        if (/^[\r\n]+$/.test(input)) {
          const entry = entries[mailListCursor];
          if (entry && messaging) {
            messaging.mailbox.markReadOne(entry.file);
            mailDetailFile = entry.file;
            panelSubView = 'mail-detail';
            subViewData = buildMailDetailOverlay(entry.file);
          }
          scheduleRepaint();
          return;
        }
        if (hkInput === 'r' || hkInput === 'R') {
          const targets = mailChecked.size > 0 ? [...mailChecked] : (entries[mailListCursor] ? [entries[mailListCursor].file] : []);
          if (messaging && targets.length) messaging.mailbox.markRead(targets);
          subViewData = buildMailInboxOverlay();
          scheduleRepaint();
          return;
        }
        if (hkInput === 'd' || hkInput === 'D') {
          const targets = [...mailChecked];
          if (messaging && targets.length) {
            messaging.mailbox.deleteMessages(targets);
            mailChecked.clear();
          }
          subViewData = buildMailInboxOverlay();
          const freshLen = mailInboxEntries ? mailInboxEntries.length : 0;
          if (mailListCursor >= freshLen) mailListCursor = Math.max(0, freshLen - 1);
          scheduleRepaint();
          return;
        }
        if (hkInput === 'c' || hkInput === 'C') {
          if (messaging) messaging.mailbox.cleanup(selfMailId());
          mailChecked.clear();
          mailListCursor = 0;
          subViewData = buildMailInboxOverlay();
          scheduleRepaint();
          return;
        }
        // [a] accept — PHASE B. Cursor row's message: route to the seedType-
        // appropriate accept flow (see beginAcceptFlow) before touching the
        // child's input or dispatching anything at all.
        if (hkInput === 'a' || hkInput === 'A') {
          const entry = entries[mailListCursor];
          if (entry && messaging) {
            beginAcceptFlow(entry, 'mail-inbox');
            scheduleRepaint();
          }
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = 'mail';
          mailCursor = 0;
          subViewData = buildMailMenuOverlay();
          scheduleRepaint();
        }
        return;
      }
      if (panelSubView === 'mail-detail') {
        if (hkInput === 'd' || hkInput === 'D') {
          if (messaging && mailDetailFile) {
            messaging.mailbox.deleteMessages([mailDetailFile]);
            mailChecked.delete(mailDetailFile);
          }
          mailDetailFile = null;
          panelSubView = 'mail-inbox';
          subViewData = buildMailInboxOverlay();
          const freshLen = mailInboxEntries ? mailInboxEntries.length : 0;
          if (mailListCursor >= freshLen) mailListCursor = Math.max(0, freshLen - 1);
          scheduleRepaint();
          return;
        }
        // [a] accept — PHASE B. Currently-open message: same beginAcceptFlow
        // routing as the 'mail-inbox' branch above.
        if (hkInput === 'a' || hkInput === 'A') {
          if (mailDetailFile && messaging) {
            const entry = (mailInboxEntries || []).find(e => e.file === mailDetailFile);
            if (entry) {
              beginAcceptFlow(entry, 'mail-detail');
              scheduleRepaint();
            }
          }
          return;
        }
        if (input.includes('\x1b')) {
          mailDetailFile = null;
          panelSubView = 'mail-inbox';
          subViewData = buildMailInboxOverlay();
          scheduleRepaint();
        }
        return;
      }
      // [a] accept — landing session picker, seedType 'resume' only. A
      // 'resume' payload has no credentials of its own (see resumeFork.js
      // header) — the receiver must pick one of THEIR OWN claude sessions as
      // the landing configDir before acceptSeed() can run.
      if (panelSubView === 'mail-accept-session') {
        const sessions = mailAcceptSessions || [];
        if (input.includes('\x1b[A') || hkInput === 'k') { if (sessions.length) mailListCursor = (mailListCursor - 1 + sessions.length) % sessions.length; scheduleRepaint(); return; }
        if (input.includes('\x1b[B') || hkInput === 'j') { if (sessions.length) mailListCursor = (mailListCursor + 1) % sessions.length; scheduleRepaint(); return; }
        if (/^[\r\n]+$/.test(input)) {
          const session = sessions[mailListCursor];
          if (session) {
            mailAcceptLandingSession = session;
            mailAcceptPromptText = describeAcceptPreview(mailAcceptEntry);
            panelSubView = 'mail-accept-confirm';
            subViewData = buildMailAcceptConfirmOverlay(mailAcceptPromptText);
          }
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          const returnView = mailAcceptReturnView || 'mail-inbox';
          panelSubView = returnView;
          subViewData = returnView === 'mail-detail' ? buildMailDetailOverlay(mailDetailFile) : buildMailInboxOverlay();
          mailAcceptEntry = null;
          mailAcceptReturnView = null;
          scheduleRepaint();
        }
        return;
      }
      // [a] accept — PHASE B double-confirm popup. Enter dispatches via
      // resumeFork.acceptSeed(mailAcceptEntry, ctx), branching on seedType:
      //   msg          → child.write(directive.promptText) — same UX as before
      //                   (no trailing newline; user presses Enter themselves),
      //                   then closes the panel so focus returns to the child.
      //   resume-fork  → registers a NEW named session (jsonl copied under a
      //                   fresh uuid); does NOT auto-launch. Shows a flash and
      //                   returns to the mail menu (not the child) so the user
      //                   actually sees the confirmation.
      //   resume       → copies the jsonl into the chosen landing configDir
      //                   (same uuid), acks the message, and locks the source
      //                   session — all inside acceptSeed(). Immediate-restart:
      //                   sets mailRestartSignal.requested and closeWrapper()s;
      //                   the runXtermWrapped loop wrapper (bottom of file)
      //                   relaunches into the landing configDir + `--resume`.
      // Esc cancels back to whichever mail subview opened it, dispatching
      // nothing.
      if (panelSubView === 'mail-accept-confirm') {
        if (/^[\r\n]+$/.test(input)) {
          const entry = mailAcceptEntry;
          let closeToChild = false;
          let triggerRestart = false;
          if (entry && messaging) {
            try {
              if (entry.seedType === 'msg') {
                const directive = messaging.resumeFork.acceptSeed(entry, {});
                if (directive.promptText) { try { child.write(directive.promptText); } catch {} }
                try { messaging.mailbox.markReadOne(entry.file); } catch {}
                closeToChild = true;
              } else if (entry.seedType === 'resume-fork') {
                const directive = messaging.resumeFork.acceptSeed(entry, { acceptedBy: selfMailId() });
                mailFlash = `✓ 포크된 세션 '${directive.session.name}' 생성됨 — 메뉴에서 실행`;
                try { messaging.mailbox.markReadOne(entry.file); } catch {}
              } else if (entry.seedType === 'resume') {
                const landing = mailAcceptLandingSession;
                if (!landing || !landing.configDir) {
                  mailFlash = '✗ 이관받을 세션을 선택하지 못했습니다';
                } else {
                  // acceptSeed() copies the source jsonl into landing.configDir
                  // (same uuid), acks the message, and locks the source
                  // session. directive = {kind:'switch', configDir,
                  // resumeSessionId, cwd} — configDir here is the LANDING
                  // SESSION'S OWN configDir (not the void-persistent pool's shared
                  // persistDir), which is exactly what mailRestartSignal +
                  // the runXtermWrapped loop wrapper are built to consume.
                  const directive = messaging.resumeFork.acceptSeed(entry, {
                    targetConfigDir: landing.configDir,
                    messageHandle: entry.file,
                    acceptedBy: selfMailId(),
                  });
                  try { messaging.mailbox.markReadOne(entry.file); } catch {}
                  if (mailRestartSignal) {
                    // Immediate-restart — hand the directive off to the loop
                    // wrapper and tear this child down; see runXtermWrapped
                    // (bottom of file) for the relaunch itself.
                    mailRestartSignal.requested = {
                      configDir: directive.configDir,
                      resumeSessionId: directive.resumeSessionId,
                      cwd: directive.cwd,
                      landingName: landing.name,
                    };
                    triggerRestart = true;
                  } else {
                    // Defensive fallback only — mailRestartSignal is always set
                    // by this file's own runXtermWrapped wrapper, so this path
                    // is unreachable in practice. Kept for safety in case
                    // runXtermWrappedOnce is ever invoked without it.
                    mailFlash = `✓ 세션 이관 완료 — '${landing.name}' 에서 실행하면 이어집니다`;
                  }
                }
              }
            } catch (e) {
              mailFlash = `✗ 수락 실패: ${(e && e.message) || e}`;
            }
          }
          mailAcceptEntry = null;
          mailAcceptPromptText = null;
          mailAcceptReturnView = null;
          mailAcceptLandingSession = null;
          mailAcceptSessions = null;
          if (triggerRestart) {
            closeWrapper();
          } else if (closeToChild) {
            togglePanel();
          } else {
            panelSubView = 'mail';
            mailCursor = 0;
            subViewData = buildMailMenuOverlay();
            scheduleRepaint();
          }
          return;
        }
        if (input.includes('\x1b')) {
          const returnView = mailAcceptReturnView || 'mail-inbox';
          panelSubView = returnView;
          subViewData = returnView === 'mail-detail' ? buildMailDetailOverlay(mailDetailFile) : buildMailInboxOverlay();
          mailAcceptEntry = null;
          mailAcceptPromptText = null;
          mailAcceptReturnView = null;
          mailAcceptLandingSession = null;
          scheduleRepaint();
        }
        return;
      }
      if (panelSubView === 'mail-send') {
        const peers = mailPeers || [];
        const count = peers.length + 1; // +1 for the broadcast option
        if (input.includes('\x1b[A') || hkInput === 'k') { mailListCursor = (mailListCursor - 1 + count) % count; scheduleRepaint(); return; }
        if (input.includes('\x1b[B') || hkInput === 'j') { mailListCursor = (mailListCursor + 1) % count; scheduleRepaint(); return; }
        if (/^[\r\n]+$/.test(input)) {
          mailSendTarget = mailListCursor === peers.length ? '*' : (peers[mailListCursor] ? peers[mailListCursor].id : null);
          if (mailSendTarget) {
            mailSeedType = 'msg';
            mailListCursor = 0;
            panelSubView = 'mail-send-seedtype';
            subViewData = buildMailSeedTypeOverlay();
          }
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = 'mail';
          mailCursor = 1;
          subViewData = buildMailMenuOverlay();
          scheduleRepaint();
        }
        return;
      }
      // ── SEND step (b): seedType picker ──────────────────
      if (panelSubView === 'mail-send-seedtype') {
        const count = SEED_TYPE_CHOICES.length;
        if (input.includes('\x1b[A') || hkInput === 'k') { mailListCursor = (mailListCursor - 1 + count) % count; scheduleRepaint(); return; }
        if (input.includes('\x1b[B') || hkInput === 'j') { mailListCursor = (mailListCursor + 1) % count; scheduleRepaint(); return; }
        if (/^[\r\n]+$/.test(input)) {
          mailSeedType = (SEED_TYPE_CHOICES[mailListCursor] || SEED_TYPE_CHOICES[0]).value;
          mailTaskBuf = mailTaskId || 'general';
          panelSubView = 'mail-send-task';
          subViewData = buildMailTaskOverlay();
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = 'mail-send';
          subViewData = buildMailSendPickOverlay();
          scheduleRepaint();
        }
        return;
      }
      // ── SEND step (c): task 태그 선택/입력 ────────────────
      if (panelSubView === 'mail-send-task') {
        if (input.includes('\x1b[A') || input.includes('\x1b[B')) {
          const options = (mailTaskOptions && mailTaskOptions.length) ? mailTaskOptions : ['general'];
          const curIdx = options.indexOf(mailTaskBuf);
          let idx = curIdx === -1 ? 0 : curIdx;
          idx = input.includes('\x1b[A') ? (idx - 1 + options.length) % options.length : (idx + 1) % options.length;
          mailTaskBuf = options[idx];
          subViewData = buildMailTaskOverlay();
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = 'mail-send-seedtype';
          subViewData = buildMailSeedTypeOverlay();
          scheduleRepaint();
          return;
        }
        if (/^[\r\n]+$/.test(input)) {
          mailTaskId = mailTaskBuf.trim() || 'general';
          if (mailSeedType === 'msg') {
            mailComposeBuf = '';
            mailResumePointer = null;
            panelSubView = 'mail-send-compose';
            subViewData = buildMailComposeOverlay();
          } else {
            mailListCursor = 0;
            panelSubView = 'mail-send-session';
            subViewData = buildMailSessionPickOverlay();
          }
          scheduleRepaint();
          return;
        }
        if (input === '\x7f' || input === '\b') {
          mailTaskBuf = mailTaskBuf.slice(0, -1);
          subViewData = buildMailTaskOverlay();
          scheduleRepaint();
          return;
        }
        {
          let appended = '';
          for (const ch of input) {
            const cp = ch.codePointAt(0);
            if (cp !== undefined && cp >= 0x20 && cp !== 0x7f) appended += ch;
          }
          if (appended) {
            mailTaskBuf += appended;
            subViewData = buildMailTaskOverlay();
            scheduleRepaint();
          }
        }
        return;
      }
      // ── SEND step (d): 공유할 내 세션 선택 (resume/resume-fork 전용) ──────
      if (panelSubView === 'mail-send-session') {
        const sessions = mailSessions || [];
        if (input.includes('\x1b[A') || hkInput === 'k') { if (sessions.length) mailListCursor = (mailListCursor - 1 + sessions.length) % sessions.length; scheduleRepaint(); return; }
        if (input.includes('\x1b[B') || hkInput === 'j') { if (sessions.length) mailListCursor = (mailListCursor + 1) % sessions.length; scheduleRepaint(); return; }
        if (/^[\r\n]+$/.test(input)) {
          const session = sessions[mailListCursor];
          if (session) {
            let pointer = null;
            try {
              pointer = messaging.resumeFork.buildResumePointer(session, { cwd: process.cwd() });
            } catch (e) {
              // No resumable sessionId found — abort the send with a clear
              // message rather than proceeding with a broken pointer.
              mailFlash = `✗ '${session.name}' 에서 resume 가능한 세션을 찾지 못했습니다`;
              mailSendTarget = null; mailSeedType = 'msg'; mailTaskId = 'general'; mailTaskBuf = 'general';
              mailResumePointer = null;
              panelSubView = 'mail';
              mailCursor = 0;
              subViewData = buildMailMenuOverlay();
              scheduleRepaint();
              return;
            }
            mailResumePointer = pointer;
            mailComposeBuf = mailSeedType === 'resume-fork'
              ? `세션 포크 공유: ${session.name}`
              : `이어서 진행해주세요: ${session.name}`;
            panelSubView = 'mail-send-compose';
            subViewData = buildMailComposeOverlay();
          }
          scheduleRepaint();
          return;
        }
        if (input.includes('\x1b')) {
          panelSubView = 'mail-send-task';
          subViewData = buildMailTaskOverlay();
          scheduleRepaint();
        }
        return;
      }
      if (panelSubView === 'mail-send-compose') {
        if (input.includes('\x1b')) {
          mailComposeBuf = '';
          mailSeedType = 'msg'; mailTaskId = 'general'; mailTaskBuf = 'general'; mailResumePointer = null;
          panelSubView = 'mail-send';
          subViewData = buildMailSendPickOverlay();
          scheduleRepaint();
          return;
        }
        if (/^[\r\n]+$/.test(input)) {
          if (messaging && mailSendTarget && mailComposeBuf.trim().length > 0) {
            const seedType = mailSeedType;
            const payload = seedType === 'msg' ? null : mailResumePointer;
            const task_id = mailTaskId;
            if (seedType === 'msg' || payload) {
              try {
                if (mailSendTarget === '*') messaging.mailbox.broadcast(mailComposeBuf, { registry: messaging.registry, seedType, payload, task_id });
                else messaging.mailbox.sendTo(mailSendTarget, mailComposeBuf, { registry: messaging.registry, seedType, payload, task_id });
                mailFlash = '✓ 메시지를 보냈습니다';
              } catch { mailFlash = '✗ 발송 실패'; }
            } else {
              mailFlash = '✗ 공유할 세션 정보가 없습니다';
            }
          }
          mailComposeBuf = '';
          mailSendTarget = null;
          mailSeedType = 'msg';
          mailTaskId = 'general';
          mailTaskBuf = 'general';
          mailResumePointer = null;
          panelSubView = 'mail';
          mailCursor = 0;
          subViewData = buildMailMenuOverlay();
          scheduleRepaint();
          return;
        }
        if (input === '\x7f' || input === '\b') {
          mailComposeBuf = mailComposeBuf.slice(0, -1);
          subViewData = buildMailComposeOverlay();
          scheduleRepaint();
          return;
        }
        // Accumulate printable characters only; drop other control/escape bytes.
        let appended = '';
        for (const ch of input) {
          const cp = ch.codePointAt(0);
          if (cp !== undefined && cp >= 0x20 && cp !== 0x7f) appended += ch;
        }
        if (appended) {
          mailComposeBuf += appended;
          subViewData = buildMailComposeOverlay();
          scheduleRepaint();
        }
        return;
      }
      // Sub-overlay (help/usage) active: Esc OR Enter closes JUST the overlay,
      // back to the panel base view — never terminates the session.
      if (panelSubView) {
        if (input.includes('\x1b') || /[\r\n]/.test(input)) {
          panelSubView = null;
          subViewData = null;
          usageEntries = null;
          scheduleRepaint();
        }
        return;
      }
      if (input.includes('\x1b')) { togglePanel(); return; }
      if (/^[hH]+$/.test(hkInput)) {
        panelSubView = 'help';
        subViewData = buildHelpOverlay();
        scheduleRepaint();
        return;
      }
      if (/^[uU]+$/.test(hkInput)) {
        panelSubView = 'usage';
        subViewData = buildUsageOverlaySync();
        scheduleRepaint();
        startUsageRefresh();
        return;
      }
      // 'S' (void-persistent, phase 1) — only reachable when the caller opted in
      // via opts.voidPersistent; otherwise falls through unmatched, same as
      // any other unbound key already does.
      if (voidPersistent && /^[sS]+$/.test(hkInput)) {
        panelSubView = 'switch';
        subViewData = buildSwitchOverlay();
        scheduleRepaint();
        return;
      }
      // 'X' (void-persistent, phase 2) — toggles void_persistent:switcher.autoMode.
      // Only reachable when the caller opted in via opts.voidPersistent;
      // otherwise falls through unmatched, same as the S-key above.
      if (voidPersistent && /^[xX]+$/.test(hkInput)) {
        try {
          const configDb = require('./configDb');
          const current = configDb.getVoidPersistentSwitcher();
          current.autoMode = !current.autoMode;
          configDb.setVoidPersistentSwitcher(current);
          voidPersistent.autoMode = current.autoMode;
        } catch {}
        scheduleRepaint();
        return;
      }
      // 'M' (Phase A, first-class) — only reachable when lib/messaging loaded
      // successfully; otherwise falls through unmatched like any other unbound
      // key already does, same defensive pattern as the S-key above.
      if (messaging && /^[mM]+$/.test(hkInput)) {
        panelSubView = 'mail';
        mailCursor = 0;
        subViewData = buildMailMenuOverlay();
        scheduleRepaint();
        return;
      }
      if (/^[\r\n]+$/.test(input)) { closeWrapper(); return; }
      return;
    }
    if (ESC_PREFIXES.includes(input)) {
      escBuf = input;
      escTimer = setTimeout(flushEscBuf, 25);
      return;
    }
    child.write(input);
  };
  const onData = data => {
    // The child's raw escapes only feed the virtual Terminal; nothing else
    // reaches the real terminal. Relay just the mouse-tracking mode toggles so
    // the outer terminal actually enables mouse reporting / wheel scroll.
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    // A DECSET mouse toggle can land split across two pty chunks (observed on
    // Linux/WSL, same as the ESC_PREFIXES case below); reassemble a trailing
    // partial prefix with the next chunk, purely for detection purposes.
    let detectStr = str;
    if (mouseSeqBuf) {
      detectStr = mouseSeqBuf + str;
      mouseSeqBuf = '';
      if (mouseSeqTimer) { clearTimeout(mouseSeqTimer); mouseSeqTimer = null; }
    }
    const mouseModes = detectStr.match(/\x1b\[\?(?:1000|1001|1002|1003|1004|1005|1006|1015|1016)[hl]/g);
    // Child-managed tools own their DECSET lifecycle. Wrapper-managed tools
    // must keep reporting enabled even if the child emits a disable sequence.
    if (mouseModes && !inputProfile.wrapperMouse) process.stdout.write(mouseModes.join(''));
    for (let n = Math.min(detectStr.length, MOUSE_PREFIX_MAXLEN); n > 0; n--) {
      const tail = detectStr.slice(-n);
      if (MOUSE_PREFIXES.has(tail)) {
        mouseSeqBuf = tail;
        mouseSeqTimer = setTimeout(() => { mouseSeqBuf = ''; mouseSeqTimer = null; }, 25);
        break;
      }
    }
    // term.write parses asynchronously; repaint only after the parser has
    // consumed this chunk so buffer.active is up to date.
    term.write(data, scheduleRepaint);
  };

  // ── Debounced resize (drag-resize must not spam repaints) ─
  let resizeTimer = null;
  function applyResize() {
    resizeTimer = null;
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows    || 24;
    if (nr < 8 || nc < 20) return;
    cols = nc; rows = nr;
    const d = currentDims();
    term.resize(d.ptycols, d.ptyrows);
    child.resize(d.ptycols, d.ptyrows);
    process.stdout.write('\x1b[2J\x1b[H'); // clear once at the new physical size
    scheduleRepaint();
  }
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyResize, 50);
  };

  process.stdin.on('data', onStdin);
  child.onData(onData);
  process.stdout.on('resize', onResize);

  // Keep the clock/bars alive while idle (mirrors runWrapped's barTimer).
  // Phase 2 (auto-mode): the same ~1s tick also polls for a pending
  // background auto-switch (set by lib/void-persistent/autoSwitchDriver.js from
  // the usageWarmup poller, which has no attached TTY/PTY of its own) and, if
  // present, drives it through the exact same onControlAction({type:'switch'})
  // path the manual 'S' key uses — restartSignal + closeWrapper() below make
  // runVoidPersistentSession relaunch with the new creds + --resume. Guarded by
  // autoRestartInFlight so an in-progress switch is never re-triggered by the
  // next tick before closeWrapper() actually tears this wrapper down.
  let autoRestartInFlight = false;
  const pollAutoSwitch = () => {
    if (!pollPendingRestart || !onControlAction || autoRestartInFlight) return;
    let pending;
    try { pending = pollPendingRestart(); } catch { pending = null; }
    if (!pending || typeof pending.poolIndex !== 'number') return;
    autoRestartInFlight = true;
    Promise.resolve(onControlAction({ type: 'switch', poolIndex: pending.poolIndex }))
      .then(() => { closeWrapper(); })
      .catch(() => { closeWrapper(); });
  };
  const barTimer = liveBars ? setInterval(() => { scheduleRepaint(); pollAutoSwitch(); }, 1000) : null;

  scheduleRepaint();

  await new Promise(resolve => {
    child.onExit(evt => resolve(evt || {}));
  });

  // ── Teardown (mirrors runWrapped) ───────────────────────
  done = true;
  if (barTimer) clearInterval(barTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (escTimer) clearTimeout(escTimer);
  if (mouseSeqTimer) clearTimeout(mouseSeqTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (canSetRawMode && !prevRaw) process.stdin.setRawMode(false);

  try { term.dispose(); } catch {}
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[r\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
  // Returning true means the wrapper successfully owned the child lifecycle.
  // A non-zero Codex exit is a tool result, not a wrapper startup failure;
  // returning false here would make runner.js launch Codex again directly.
  return true;
}

// ── generalized restart seam (mail 'resume' accept immediate-switch) ──────
// Thin loop wrapper around runXtermWrappedOnce (the huge, stateful function
// above). This is the ONLY exported entry point — runner.js and
// switchProfile.js both keep calling `runXtermWrapped` exactly as before,
// completely unaware this loop exists underneath.
//
// Each iteration hands runXtermWrappedOnce a fresh, private
// mailRestartSignal box via opts.__mailRestartSignal. If the mail-accept
// 'resume' confirm handler (inside runXtermWrappedOnce) sets
// `.requested = {configDir, resumeSessionId, cwd, landingName}` and tears the
// child down (closeWrapper()), this loop sees it once the call resolves and
// relaunches into CLAUDE_CONFIG_DIR=configDir + `--resume <resumeSessionId>` —
// an immediate in-place session switch instead of "land it, resume from the
// menu". Any other exit (normal quit, void-persistent-switch S-key, auto-mode
// restart) leaves .requested null, so the loop returns the boolean exactly
// like the old single-shot function did.
//
// This is INDEPENDENT of opts.voidPersistent/onControlAction/opts.restartSignal
// — lib/void-persistent/switchProfile.js owns its own external while(true) loop
// around this same exported function and never sets/reads
// opts.__mailRestartSignal, so its S-key switch flow is byte-identical to
// before this change.
//
// cwd is intentionally left alone across a relaunch (env/cwd of THIS void
// process do not change) — this mirrors switchProfile.js's existing
// convention of never chdir'ing between switches. The copied jsonl's
// project-slug directory only resolves correctly on `--resume` if the
// receiving process's cwd already matches pointer.cwd (a known, pre-existing
// limitation documented in lib/messaging/resumeFork.js's header — not
// something this pass introduces or attempts to fix).
async function runXtermWrapped(tool, env, label, opts = {}) {
  let currentTool = tool;
  let currentEnv = env;
  let currentLabel = label;
  for (;;) {
    const mailRestartSignal = { requested: null };
    const wrapped = await runXtermWrappedOnce(currentTool, currentEnv, currentLabel, { ...opts, __mailRestartSignal: mailRestartSignal });
    const req = mailRestartSignal.requested;
    if (!req) return wrapped;
    currentEnv = { ...currentEnv, CLAUDE_CONFIG_DIR: req.configDir };
    // A linked API token (lib/runner.js's applySessionEnv, session.tokenService/
    // tokenAlias) belongs to the PREVIOUS session's env, not the landing one —
    // drop it so the relaunched child falls back to the landing configDir's own
    // .credentials.json instead of silently reusing a mismatched token.
    delete currentEnv.CLAUDE_CODE_OAUTH_TOKEN;
    currentTool = buildMailRestartTool(tool, req);
    currentLabel = buildMailRestartLabel(label, req);
  }
}

function getInputProfile(toolCommand) {
  switch (toolCommand) {
    case 'codex':
      return {
        name: 'codex',
        wrapperMouse: true,
        // Button events plus SGR coordinates. SGR reports wheel turns as
        // CSI <64/65;col;row M instead of terminal-generated arrow keys.
        mouseEnable: '\x1b[?1000h\x1b[?1006h',
      };
    case 'agy':
      return {
        name: 'agy',
        wrapperMouse: true,
        mouseEnable: '\x1b[?1000h\x1b[?1006h',
      };
    case 'claude':
      return { name: 'claude', wrapperMouse: false, mouseEnable: '' };
    default:
      return { name: 'default', wrapperMouse: false, mouseEnable: '' };
  }
}

// composite/cellSgr/ptyDims are exported for the _spike evidence harness so the
// exact production render path can be validated against real programs. They are
// not part of the runner's public contract (only runXtermWrapped is called).
module.exports = {
  runXtermWrapped, composite, cellSgr, ptyDims, applyTheme, getInputProfile, buildMailAcceptPrompt,
  // 순수 헬퍼 — 유닛 테스트 전용 export(node-pty/@xterm/headless 를 require 하지
  // 않으므로 그 둘이 설치되어 있지 않은 환경에서도 안전하게 테스트 가능).
  buildMailRestartTool, buildMailRestartLabel,
  charWidth, textWidth, toolGlyph, padIconCol,
};
