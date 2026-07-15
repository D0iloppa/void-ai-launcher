'use strict';

/*
 * xtermFrame.js — Windows-only framed terminal built on @xterm/headless.
 *
 * On Linux/macOS the launcher frames child AI tools with real tmux
 * (lib/wrapper.js runTmuxSession). tmux cannot run natively on Windows
 * (no ConPTY backend). This module reproduces tmux's role using a real
 * VT100/xterm parser (@xterm/headless): a node-pty child's raw output is
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
const SIG_BG = '\x1b[48;2;0;230;118m';
const SIG_FG = '\x1b[38;2;0;230;118m';
const BLACK  = '\x1b[38;2;0;0;0m';
const RED_FG = '\x1b[38;2;230;50;50m';
const BOLD   = '\x1b[1m';
const RST    = '\x1b[0m';
const BL_V   = '│';

function at(row, col) { return `\x1b[${row};${col}H`; }

function trimText(text, width) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

// ── Bar strings (identical output to lib/wrapper.js) ──────
function topBar(cols, label, modeHint) {
  const left = ` Wrapper >_  ${label} `;
  const tabsWidth = Math.max(0, cols - left.length - 1);
  const tabText = trimText(modeHint || '', tabsWidth);
  const body = left + tabText;
  return SIG_BG + BLACK + BOLD + body + ' '.repeat(Math.max(0, cols - body.length)) + RST;
}

function bottomBar(cols, helpText = '') {
  const time = new Date().toTimeString().slice(0, 8);
  const cwd   = process.cwd();
  const cwdS  = cwd.length > 40 ? '…' + cwd.slice(-39) : cwd;
  const left  = ` Workspace: ${cwdS} `;
  const right = ` ${time} `;
  const mid   = trimText(helpText || 'VOID//ai-launcher', 44);
  const avail = Math.max(0, cols - left.length - right.length);
  const lpad  = Math.max(0, Math.floor((avail - mid.length) / 2));
  const rpad  = Math.max(0, avail - mid.length - lpad);
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
function composite(term, cols, rows, hpad, vpad, label, helpText) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  const buf = term.buffer.active;
  const width = rightM - leftM + 1;

  let s = '\x1b[?25l';        // hide cursor during repaint (kill flicker)
  s += '\x1b[r';             // drop any scroll region the child requested
  s += at(1, 1) + topBar(cols, label, null);

  // vpad padding rows (top + bottom): border ─ spaces ─ border
  const padRow = SIG_FG + BL_V + RST + ' '.repeat(Math.max(0, cols - 2)) + SIG_FG + BL_V + RST;
  for (let r = 2; r < topM; r++) s += at(r, 1) + padRow;
  for (let r = botM + 1; r <= rows - 1; r++) s += at(r, 1) + padRow;

  const hpadStr = ' '.repeat(hpad);
  for (let y = 0; y < (botM - topM + 1); y++) {
    const physRow = topM + y;
    // Full-width row: left border + hpad + content + hpad + right border.
    // Writing the whole row every repaint means no stale cells, so no 2J
    // clear is needed on steady-state repaints (that clear is the flicker
    // source in the spike).
    s += at(physRow, 1) + SIG_FG + BL_V + RST + hpadStr;

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
    s += hpadStr + SIG_FG + BL_V + RST;
  }

  s += at(rows, 1) + bottomBar(cols, helpText);

  // Place the real hardware cursor where the child put it, mapped into the
  // interior frame, and re-show it.
  const cy = topM + buf.cursorY;
  const cx = leftM + buf.cursorX;
  s += at(cy, cx) + '\x1b[?25h';
  return s;
}

async function runXtermWrapped(tool, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }

  let Terminal;
  try { ({ Terminal } = require('@xterm/headless')); }
  catch { return false; }

  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;
  const liveBars = opts.liveBars !== false;
  const helpText = 'VOID//ai-launcher';

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  const dims0 = ptyDims(cols, rows, hpad, vpad);
  const term = new Terminal({
    cols: dims0.ptycols,
    rows: dims0.ptyrows,
    allowProposedApi: true,
    scrollback: 1000,
  });

  const ptyCmd = process.platform === 'win32' ? 'cmd' : tool.command;
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
      env,
    });
  } catch {
    return false;
  }

  process.stdout.write('\x1b[?1049h'); // alternate screen (isolate scrollback)
  process.stdout.write('\x1b[2J\x1b[H'); // one initial clear

  const prevRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // ── Debounced / coalesced repaint ───────────────────────
  // A burst of child output within one tick collapses into a single repaint.
  let repaintPending = false;
  let done = false;
  function paint() {
    if (done) return;
    process.stdout.write(composite(term, cols, rows, hpad, vpad, label, helpText));
  }
  function scheduleRepaint() {
    if (repaintPending || done) return;
    repaintPending = true;
    setImmediate(() => { repaintPending = false; paint(); });
  }

  // ── I/O wiring ──────────────────────────────────────────
  const onStdin = data => child.write(data);
  const onData = data => {
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
    const d = ptyDims(cols, rows, hpad, vpad);
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

  const exitInfo = await new Promise(resolve => {
    child.onExit(evt => resolve(evt || {}));
  });

  // ── Teardown (mirrors runWrapped) ───────────────────────
  done = true;
  if (barTimer) clearInterval(barTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);

  try { term.dispose(); } catch {}
  process.stdout.write('\x1b[r\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
  return (exitInfo.exitCode ?? 0) === 0;
}

// composite/cellSgr/ptyDims are exported for the _spike evidence harness so the
// exact production render path can be validated against real programs. They are
// not part of the runner's public contract (only runXtermWrapped is called).
module.exports = { runXtermWrapped, composite, cellSgr, ptyDims };
