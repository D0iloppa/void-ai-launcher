'use strict';

// ── ANSI ──────────────────────────────────────────────────
const SIG_BG = '\x1b[48;2;0;230;118m';
const SIG_FG = '\x1b[38;2;0;230;118m';
const BLACK  = '\x1b[38;2;0;0;0m';
const RED_FG = '\x1b[38;2;230;50;50m';
const BOLD   = '\x1b[1m';
const RST    = '\x1b[0m';
const BL_V   = '│';

function at(row, col) { return `\x1b[${row};${col}H`; }

// ── Bar strings ───────────────────────────────────────────
function topBar(cols, label) {
  const left = ` Wrapper >_  ${label} `;
  return SIG_BG + BLACK + BOLD + left + ' '.repeat(Math.max(0, cols - left.length)) + RST;
}

function bottomBar(cols) {
  const cwd   = process.cwd();
  const time  = new Date().toTimeString().slice(0, 8);
  const cwdS  = cwd.length > 40 ? '…' + cwd.slice(-39) : cwd;
  const left  = ` Workspace: ${cwdS} `;
  const right = ` ${time} `;
  const mid   = 'VOID//ai-launcher';
  const avail = Math.max(0, cols - left.length - right.length);
  const lpad  = Math.max(0, Math.floor((avail - mid.length) / 2));
  const rpad  = Math.max(0, avail - mid.length - lpad);
  return SIG_BG + BLACK + BOLD
    + left + ' '.repeat(lpad) + RED_FG + mid + BLACK + ' '.repeat(rpad) + right + RST;
}

// ── Frame layout ──────────────────────────────────────────
//
//   row 1            top green bar (full width)
//   rows 2..1+vpad   padding rows  │ ··········│
//   rows ..N-vpad    pty content   │  TUI here │
//   rows N-vpad..N-1 padding rows  │ ··········│
//   row N            bottom green bar (full width)
//
//   col 1            left border │
//   cols 2..1+hpad   left padding
//   cols ..M-hpad    pty content
//   cols M-hpad..M-1 right padding
//   col M            right border │
//
// DECOM  + DECSTBM protects top/bottom bar rows from child writes.
// DECLRMM + DECSLRM protects left/right border cols from child writes.

// Default padding if not provided via opts
const DEFAULT_HPAD = 2;
const DEFAULT_VPAD = 1;

function computeMargins(cols, rows, hpad, vpad) {
  const topM   = 2 + vpad;          // first content row
  const botM   = rows - 1 - vpad;   // last content row
  const leftM  = 2 + hpad;          // first content col
  const rightM = cols - 1 - hpad;   // last content col
  return { topM, botM, leftM, rightM };
}

function ptyDims(cols, rows, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  return {
    ptyrows: Math.max(1, botM - topM + 1),
    ptycols: Math.max(1, rightM - leftM + 1),
  };
}

// ── Static frame draw ─────────────────────────────────────
// Called once per setup/resize. Draws every border char.
function drawFrame(cols, rows, label, hpad, vpad) {
  const { topM, botM } = computeMargins(cols, rows, hpad, vpad);
  let s = '';
  s += at(1, 1) + topBar(cols, label);

  // padding rows (rows 2..topM-1 and botM+1..rows-1)
  const padRow = SIG_FG + BL_V + RST + ' '.repeat(Math.max(0, cols - 2)) + SIG_FG + BL_V + RST;
  for (let r = 2; r < topM; r++) s += at(r, 1) + padRow;
  for (let r = botM + 1; r <= rows - 1; r++) s += at(r, 1) + padRow;

  // vertical borders for all inner rows (rows 2..rows-1)
  for (let r = topM; r <= botM; r++) {
    s += at(r, 1)    + SIG_FG + BL_V + RST;
    s += at(r, cols) + SIG_FG + BL_V + RST;
  }

  s += at(rows, 1) + bottomBar(cols);
  return s;
}

// ── Terminal state management ─────────────────────────────

function enableMargins(cols, rows, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  return (
    `\x1b[${topM};${botM}r` +   // DECSTBM: vertical scroll region
    '\x1b[?69h' +                // enable DECLRMM (left-right margin mode)
    `\x1b[${leftM};${rightM}s` + // DECSLRM: set LR margins
    '\x1b[?6h' +                 // DECOM: cursor addressing relative to margins
    '\x1b[H'                     // cursor to content home (top-left of content area)
  );
}

function disableMargins() {
  return (
    '\x1b[?6l' +   // disable DECOM
    '\x1b[?69l' +  // disable DECLRMM (also clears LR margins)
    '\x1b[r'       // reset scroll region to full screen
  );
}

// ── Setup (called at launch + resize) ────────────────────
function setupFrame(cols, rows, label, hpad, vpad) {
  const out =
    disableMargins() +
    '\x1b[2J' +
    drawFrame(cols, rows, label, hpad, vpad) +
    enableMargins(cols, rows, hpad, vpad);

  process.stdout.write(out);
  return ptyDims(cols, rows, hpad, vpad);
}

// ── 1-second refresh: only redraw bottom bar (clock) ─────
// The frame borders are protected by margins; only the clock changes.
function refreshBottomBar(cols, rows, label, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);

  const out =
    '\x1b[?6l' +
    '\x1b[?69l' +
    '\x1b7' +
    at(rows, 1) + bottomBar(cols) +
    '\x1b8' +
    `\x1b[${topM};${botM}r` +
    '\x1b[?69h' +
    `\x1b[${leftM};${rightM}s` +
    '\x1b[?6h';

  process.stdout.write(out);
}

// ── Teardown ──────────────────────────────────────────────
function teardownFrame() {
  process.stdout.write(
    disableMargins() +
    '\x1b[2J\x1b[H'
  );
}

// ── Main entry point ──────────────────────────────────────
// opts.hpad / opts.vpad from config.yml settings.wrapper_hpad / wrapper_vpad
// Returns true on success, false if node-pty unavailable (caller should fallback).
async function runWrapped(tool, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  const { ptycols, ptyrows } = setupFrame(cols, rows, label, hpad, vpad);

  const term = pty.spawn(tool.command, tool.args || [], {
    name: 'xterm-256color',
    cols: ptycols,
    rows: ptyrows,
    cwd:  process.cwd(),
    env,
  });

  const prevRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdin  = data => term.write(data);
  const onResize = () => {
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows    || 24;
    if (nr < 8 || nc < 20) return;
    const d = setupFrame(nc, nr, label, hpad, vpad);
    term.resize(d.ptycols, d.ptyrows);
  };

  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);

  // void as channel: pty output → void → user's terminal
  term.on('data', data => process.stdout.write(data));

  // refresh clock on bottom bar every second
  const barTimer = setInterval(() => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    refreshBottomBar(c, r, label, hpad, vpad);
  }, 1000);

  await new Promise(resolve => term.on('exit', () => resolve()));

  clearInterval(barTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);

  teardownFrame();
  return true;
}

module.exports = { runWrapped };
