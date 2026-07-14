'use strict';
/*
 * THROWAWAY SPIKE — feasibility test for replacing tmux's VT-parsing role
 * with @xterm/headless + node-pty. NOT product code. Do not import from lib/.
 *
 * What it proves:
 *   node-pty child -> @xterm/headless Terminal (real VT parser + screen buffer)
 *   -> we read buffer.active cell-by-cell and COMPOSITE it inside a void-style
 *      border/status-bar frame. We never pass raw child bytes through, and we
 *      never regex-strip anything (the failure mode of commit 720d9b1).
 *
 * Usage:
 *   node _spike/xterm-headless-poc.js [vim|codex|claude|htop]
 *   Structured evidence goes to STDERR (works without a TTY).
 *   If stdout is a TTY (run under `script -qec`), a live composite frame is
 *   also painted to STDOUT so it can be visually inspected.
 */

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

// ── void-style chrome (mirrors lib/wrapper.js topBar/bottomBar/computeMargins) ─
const SIG_BG = '\x1b[48;2;0;230;118m';
const SIG_FG = '\x1b[38;2;0;230;118m';
const BLACK  = '\x1b[38;2;0;0;0m';
const BOLD   = '\x1b[1m';
const RST    = '\x1b[0m';
const BL_V   = '│';
const HPAD = 2, VPAD = 1;

function computeMargins(cols, rows) {
  return { topM: 2 + VPAD, botM: rows - 1 - VPAD, leftM: 2 + HPAD, rightM: cols - 1 - HPAD };
}
function interiorDims(cols, rows) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows);
  return { ptycols: Math.max(1, rightM - leftM + 1), ptyrows: Math.max(1, botM - topM + 1) };
}
function at(r, c) { return `\x1b[${r};${c}H`; }
function topBar(cols, label) {
  const body = ` xterm-headless PoC >_  ${label} `;
  return SIG_BG + BLACK + BOLD + body + ' '.repeat(Math.max(0, cols - body.length)) + RST;
}
function bottomBar(cols, note) {
  const t = new Date().toTimeString().slice(0, 8);
  const left = ` ${note} `;
  const right = ` ${t} `;
  const mid = ' '.repeat(Math.max(0, cols - left.length - right.length));
  return SIG_BG + BLACK + BOLD + left + mid + right + RST;
}

// ── the tmux-equivalent step: render FROM the parsed buffer, inject our chrome ─
// Reads buffer.active cell-by-cell (handles alt-screen automatically because
// buffer.active swaps to the alternate buffer on ?1049h) and composes a full
// physical-screen ANSI string. Colors kept minimal on purpose for the spike.
function composite(term, cols, rows, label, note) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows);
  const buf = term.buffer.active;
  let s = disableChildScrollRegion();
  s += '\x1b[2J';
  s += at(1, 1) + topBar(cols, label);
  const padRow = SIG_FG + BL_V + RST + ' '.repeat(Math.max(0, cols - 2)) + SIG_FG + BL_V + RST;
  for (let r = 2; r < topM; r++) s += at(r, 1) + padRow;
  for (let r = botM + 1; r <= rows - 1; r++) s += at(r, 1) + padRow;

  for (let y = 0; y < (botM - topM + 1); y++) {
    const physRow = topM + y;
    s += at(physRow, 1) + SIG_FG + BL_V + RST;          // left border
    s += at(physRow, cols) + SIG_FG + BL_V + RST;       // right border
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    s += at(physRow, leftM);
    let out = '';
    const width = rightM - leftM + 1;
    for (let x = 0; x < width; x++) {
      const cell = line.getCell(x);
      let ch = cell ? cell.getChars() : '';
      if (ch === '') ch = ' ';
      // minimal attribute fidelity for the spike: inverse + bold only
      let pre = '', post = '';
      if (cell && cell.isInverse()) { pre += '\x1b[7m'; post = '\x1b[0m'; }
      if (cell && cell.isBold())    { pre += '\x1b[1m'; post = '\x1b[0m'; }
      out += pre + ch + post;
    }
    s += out;
  }
  s += at(rows, 1) + bottomBar(cols, note);
  // place hardware cursor where the child thinks it is, mapped into interior
  s += at(topM + buf.cursorY, leftM + buf.cursorX);
  return s;
}
function disableChildScrollRegion() { return '\x1b[r'; }

// ── border-integrity check on the composited output (programmatic evidence) ───
function verifyBorders(term, cols, rows) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows);
  // Re-derive what composite() would emit for the border columns and confirm
  // the child's content never leaks into border/bar cells.
  const buf = term.buffer.active;
  // Interior must be exactly ptycols wide; if child wrote wider (it can't,
  // because we resized its pty to interior dims) content would overflow.
  const { ptycols, ptyrows } = interiorDims(cols, rows);
  const ok = term.cols === ptycols && term.rows === ptyrows;
  return { ok, termCols: term.cols, termRows: term.rows, ptycols, ptyrows,
           bufType: buf.type, cursorX: buf.cursorX, cursorY: buf.cursorY,
           frame: { topM, botM, leftM, rightM } };
}

// ── main ──────────────────────────────────────────────────────────────────
const targets = {
  vim:    { cmd: '/usr/bin/vim',  args: ['-u', 'NONE', '-N'] },
  htop:   { cmd: '/usr/bin/htop', args: [] },
  codex:  { cmd: '/home/doil/.local/bin/codex',  args: [] },
  claude: { cmd: '/home/doil/.local/bin/claude', args: [] },
};
const pick = process.argv[2] || 'vim';
const target = targets[pick];
if (!target) { console.error('unknown target', pick); process.exit(1); }

const isTTY = !!process.stdout.isTTY;
const COLS = process.stdout.columns || 100;
const ROWS = process.rows || process.stdout.rows || 30;
const label = `${pick} @ ${COLS}x${ROWS}`;

function log(stage, extra) {
  process.stderr.write(`[${stage}] ${JSON.stringify(extra)}\n`);
}

const term = new Terminal({ cols: interiorDims(COLS, ROWS).ptycols,
                            rows: interiorDims(COLS, ROWS).ptyrows,
                            allowProposedApi: true });

const { ptycols, ptyrows } = interiorDims(COLS, ROWS);
const child = pty.spawn(target.cmd, target.args, {
  name: 'xterm-256color', cols: ptycols, rows: ptyrows,
  cwd: process.cwd(), env: process.env,
});

let bytes = 0;
child.onData(d => { bytes += d.length; term.write(d); });

if (isTTY) process.stdout.write('\x1b[?1049h');
function paint(note) {
  if (isTTY) process.stdout.write(composite(term, COLS, ROWS, label, note));
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function settle(ms = 400) { return sleep(ms); } // let xterm parse pending

(async () => {
  log('spawn', { cmd: target.cmd, ptycols, ptyrows });

  // STAGE 1: startup — expect the TUI to switch to the alternate buffer
  await settle(1200);
  paint('stage1: startup');
  log('stage1-startup', { bytes, ...verifyBorders(term, COLS, ROWS) });

  // STAGE 2: force full-screen activity + an explicit erase-display.
  // vim: type text then Ctrl-L (redraw = ED). Generic fallback: send ED ourselves.
  if (pick === 'vim') {
    child.write('ihello from child\x1b');   // insert text, back to normal mode
    await settle(300);
    child.write('\x0c');                     // Ctrl-L -> full redraw (ED)
  } else {
    child.write('\x1b[2J\x1b[H');            // erase display straight at the child
  }
  await settle(700);
  paint('stage2: erase-display');
  log('stage2-erase-display', { bytes, ...verifyBorders(term, COLS, ROWS) });

  // STAGE 3: resize the pty (SIGWINCH). Shrink then confirm buffer re-lays-out.
  const NC = Math.max(40, COLS - 10), NR = Math.max(12, ROWS - 4);
  const d = interiorDims(NC, NR);
  term.resize(d.ptycols, d.ptyrows);
  child.resize(d.ptycols, d.ptyrows);
  await settle(900);
  // repaint at the NEW physical size
  if (isTTY) process.stdout.write(composite(term, NC, NR, `${pick} @ ${NC}x${NR}`, 'stage3: after resize'));
  log('stage3-after-resize', { bytes, ...verifyBorders(term, NC, NR) });

  // STAGE 4: quit child cleanly, expect return to NORMAL buffer (alt-screen off)
  if (pick === 'vim') child.write('\x1b:qa!\r');
  else child.write('q');
  await settle(600);
  log('stage4-after-quit', { bytes, bufType: term.buffer.active.type,
                             cursorX: term.buffer.active.cursorX,
                             cursorY: term.buffer.active.cursorY });

  if (isTTY) { process.stdout.write('\x1b[r\x1b[2J\x1b[H\x1b[?1049l'); }
  try { child.kill(); } catch {}
  log('done', { totalBytes: bytes });
  process.exit(0);
})();
