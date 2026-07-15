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
const SIG_BG = '\x1b[48;2;0;230;118m';
const SIG_FG = '\x1b[38;2;0;230;118m';
const BLACK  = '\x1b[38;2;0;0;0m';
const RED_FG = '\x1b[38;2;230;50;50m';
const ORANGE_FG = '\x1b[38;2;249;115;22m';
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

function textWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

function trimText(text, width) {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  if (width === 1) return '…';
  let result = '';
  let used = 0;
  for (const char of text) {
    const charCells = charWidth(char);
    if (used + charCells > width - 1) break;
    result += char;
    used += charCells;
  }
  return result + '…';
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
  const body = left + tabText;
  const plainBody = plainLeft + tabText;
  return SIG_BG + BLACK + BOLD + body + ' '.repeat(Math.max(0, cols - textWidth(plainBody))) + RST;
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
function composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen = false) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  const buf = term.buffer.active;
  const width = rightM - leftM + 1;
  const contentRows = Math.max(1, botM - topM + 1);

  let s = '\x1b[?25l';        // hide cursor during repaint (kill flicker)
  s += '\x1b[r';             // drop any scroll region the child requested
  s += at(1, 1) + topBar(cols, label, null);

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
    // Keep controls outside the child terminal. The footer-side padding row
    // avoids shrinking or overwriting the CLI's own bottom line.
    const panelLabel = ' Control Panel  ·  H / Enter: 홈으로 복귀  ·  Ctrl+\\ / Esc: 패널 닫기 ';
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

async function runXtermWrapped(tool, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }

  let Terminal;
  try { ({ Terminal } = require('@xterm/headless')); }
  catch { return false; }

  const canSetRawMode = typeof process.stdin.setRawMode === 'function';
  const hasNativeTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!hasNativeTty) {
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;
  const liveBars = opts.liveBars !== false;
  // Ctrl+Space는 Windows 터미널/IME에서 가로채므로 실제 전달되는 Ctrl+\\만
  // 패널 호출 키로 사용한다. 홈 복귀는 패널 안에서만 가능하다.
  const helpText = 'PgUp/PgDn: 스크롤  Ctrl+\\: 컨트롤 패널  Shift+드래그: 선택영역 복사';

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  let panelOpen = false;
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
  } catch {
    return false;
  }

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
    process.stdout.write(composite(term, cols, rows, hpad, vpad, label, helpText, panelOpen));
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
    const d = currentDims();
    term.resize(d.ptycols, d.ptyrows);
    child.resize(d.ptycols, d.ptyrows);
    scheduleRepaint();
  };
  const onStdin = data => {
    const input = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (input.includes('\x1b[5~')) {
      term.scrollPages(-1);
      scheduleRepaint();
      return;
    }
    if (input.includes('\x1b[6~')) {
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
      if (input.includes('\x1b')) togglePanel();
      else if (/^[hH\r\n]+$/.test(input)) closeWrapper();
      return;
    }
    child.write(input);
  };
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
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (canSetRawMode && !prevRaw) process.stdin.setRawMode(false);

  try { term.dispose(); } catch {}
  process.stdout.write('\x1b[r\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
  // Returning true means the wrapper successfully owned the child lifecycle.
  // A non-zero Codex exit is a tool result, not a wrapper startup failure;
  // returning false here would make runner.js launch Codex again directly.
  return true;
}

// composite/cellSgr/ptyDims are exported for the _spike evidence harness so the
// exact production render path can be validated against real programs. They are
// not part of the runner's public contract (only runXtermWrapped is called).
module.exports = { runXtermWrapped, composite, cellSgr, ptyDims };
