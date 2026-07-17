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

// Fixed-width ASCII tags — NOT the Unicode dingbat/emoji icons an earlier
// round used (✳ claude, 👾 codex, 🚀 agy, ◈ default) with a width-1-vs-2
// padding compensation based on charWidth()'s own classification. Checked
// against Unicode's authoritative EastAsianWidth.txt before changing this:
// ✳ U+2733 is actually class 'N' Neutral (2729..273C ; N — not ambiguous),
// but ◈ U+25C8 IS class 'A' Ambiguous (25C6..25C8 ; A). Ambiguous-class
// characters are, by long-standing terminal convention, rendered at DOUBLE
// width in CJK-locale-aware terminals/fonts (this app's UI is predominantly
// Korean per CLAUDE.md, and this whole module is the Windows-ConPTY-only
// path, where we don't control the user's font/locale ambiguous-width
// policy). That is a real, spec-confirmed mismatch between what charWidth()
// assumes (1 cell, matching '◈'s pre-fix compensation) and what some real
// terminal fonts draw (2 cells) — a plausible root cause of the reported
// misalignment. Patching charWidth()'s table to call '◈' wide would only
// swap one guess for another (and could misalign the OPPOSITE way for a
// terminal that treats ambiguous glyphs as narrow). Fixed ASCII bracket tags
// sidestep the whole class of bug: every Basic Latin codepoint is
// unconditionally Narrow on every terminal/font/locale, so there is no
// ambiguous case left to get wrong, and all four tags are the same width
// (no per-icon padding compensation needed in composeUsageRow below).
const toolGlyph = (command) => {
  switch ((command || '').toLowerCase()) {
    case 'codex': return '[CX]';
    case 'claude': return '[CL]';
    case 'agy': return '[AG]';
    default: return '[??]';
  }
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
  // All four tags are the same fixed width (4 ASCII chars) — no per-icon
  // padding compensation needed (see toolGlyph's comment above).
  const prefix = `${icon} ${toolCommand}/${sessionKey}`;
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
  const sesCore = sPct != null ? seg('SES', sPct) : '';
  const wkCore  = wPct != null ? seg('WK', wPct) : '';
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
  const left  = ` Workspace: ${cwdS} `;
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
function composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen = false, panelSubView = null, subViewData = null, modeHint = null) {
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
        const title   = panelSubView === 'usage' ? ' 사용량 ' : ' 도움말 ';
        const titleText = trimText(title, Math.max(1, innerW - 1));
        const ruleW = Math.max(0, innerW - 1 - textWidth(titleText));
        s += at(boxTop, boxLeft) +
          SIG_FG + '┌─' + RST + BOLD + titleText + RST +
          SIG_FG + '─'.repeat(ruleW) + '┐' + RST;
        for (let i = 0; i < boxH - 2; i++) {
          const raw = subViewData[i] != null ? String(subViewData[i]) : '';
          const lineText = trimText(raw, Math.max(0, innerW - 2));
          const pad = ' '.repeat(Math.max(0, innerW - 2 - textWidth(lineText)));
          s += at(boxTop + 1 + i, boxLeft) +
            SIG_FG + '│' + RST + ' ' + lineText + pad + ' ' + SIG_FG + '│' + RST;
        }
        s += at(boxTop + boxH - 1, boxLeft) +
          SIG_FG + '└' + '─'.repeat(innerW) + '┘' + RST;
      }
    }

    // Keep controls outside the child terminal. The footer-side padding row
    // avoids shrinking or overwriting the CLI's own bottom line.
    const panelLabel = panelSubView
      ? ' Control Panel  ·  Esc / Enter: 패널로 복귀 '
      : ' Control Panel  ·  H: 도움말  ·  U: 사용량  ·  Enter: 홈으로 복귀  ·  Ctrl+\\ / Esc: 패널 닫기 ';
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

async function runXtermWrapped(tool, env, label, opts = {}) {
  if (entryDebugLog) entryDebugLog(`runXtermWrapped ENTER tool=${tool && tool.command}`);
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
  let panelSubView = null;  // null | 'help' | 'usage'
  let subViewData = null;   // string[] rendered by the active sub-overlay
  let usageEntries = null;  // parallel target list for the 'usage' overlay rows

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
    const provider = (tool.command || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
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

  const prevRaw = process.stdin.isRaw;
  if (canSetRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  // ── Debounced / coalesced repaint ───────────────────────
  // A burst of child output within one tick collapses into a single repaint.
  let repaintPending = false;
  let done = false;
  function paint() {
    if (done) return;
    process.stdout.write(composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen, panelSubView, subViewData, currentGaugeText()));
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
    if (!panelOpen) { panelSubView = null; subViewData = null; usageEntries = null; }
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
    const provider = (tool.command || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
    const sessionKey = opts.sessionKey || 'default';
    const idx = usageEntries.findIndex(e => e.toolCommand === provider && e.sessionKey === sessionKey);
    if (idx < 0 || idx >= subViewData.length) return;
    subViewData[idx] += '  (갱신 중…)';
    let p;
    try {
      p = opts.refreshCurrentUsage({
        configDir: env.CLAUDE_CONFIG_DIR || env.CODEX_HOME,
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
      if (/^[hH]+$/.test(input)) {
        panelSubView = 'help';
        subViewData = buildHelpOverlay();
        scheduleRepaint();
        return;
      }
      if (/^[uU]+$/.test(input)) {
        panelSubView = 'usage';
        subViewData = buildUsageOverlaySync();
        scheduleRepaint();
        startUsageRefresh();
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
    if (mouseModes) process.stdout.write(mouseModes.join(''));
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
  const barTimer = liveBars ? setInterval(scheduleRepaint, 1000) : null;

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

// composite/cellSgr/ptyDims are exported for the _spike evidence harness so the
// exact production render path can be validated against real programs. They are
// not part of the runner's public contract (only runXtermWrapped is called).
module.exports = { runXtermWrapped, composite, cellSgr, ptyDims, applyTheme };
