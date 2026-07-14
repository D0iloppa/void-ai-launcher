'use strict';
/*
 * THROWAWAY evidence harness for lib/xtermFrame.js (Windows compositor).
 * Runs the REAL production render path (composite + cellSgr from the module)
 * against real programs on this Linux sandbox — the closest proxy to Windows,
 * since node-pty's VT parsing feeding @xterm/headless is OS-independent.
 *
 * Proves, programmatically (no TTY required — evidence to STDERR):
 *   (a) full SGR color fidelity (RGB + palette + attrs), not just inverse/bold
 *   (b) resize re-lays-out the buffer
 *   (c) alt-screen + erase-display survive (Phase 1 spike regression cases)
 *
 * Usage: node _spike/xtermframe-evidence.js [vim|codex|colortest]
 */
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { composite, cellSgr, ptyDims } = require('../lib/xtermFrame');

const COLS = 100, ROWS = 30, HPAD = 2, VPAD = 1;
function log(tag, obj) { process.stderr.write(`[${tag}] ${JSON.stringify(obj)}\n`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scan the parsed buffer for the first cell carrying a non-default color/attr
// and dump the SGR the production compositor would emit for it.
function firstStyledCell(term) {
  const buf = term.buffer.active;
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const styled = !cell.isFgDefault() || !cell.isBgDefault() ||
        cell.isBold() || cell.isItalic() || cell.isUnderline() ||
        cell.isInverse() || cell.isDim() || cell.isStrikethrough();
      if (styled && cell.getChars().trim() !== '') {
        return {
          x, y, ch: cell.getChars(),
          fgMode: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
          fg: cell.getFgColor(),
          bold: !!cell.isBold(), italic: !!cell.isItalic(),
          underline: !!cell.isUnderline(), inverse: !!cell.isInverse(),
          sgr: JSON.stringify(cellSgr(cell)),
        };
      }
    }
  }
  return null;
}

(async () => {
  const pick = process.argv[2] || 'colortest';

  if (pick === 'colortest') {
    // Deterministic proof of full SGR mapping — no external program needed.
    // Feed known escapes straight into a Terminal and read the composited SGR.
    const d = ptyDims(COLS, ROWS, HPAD, VPAD);
    const term = new Terminal({ cols: d.ptycols, rows: d.ptyrows, allowProposedApi: true });
    const samples = {
      'rgb-fg':     '\x1b[38;2;255;100;50mX',
      'palette196': '\x1b[38;5;196mX',
      'bg-rgb':     '\x1b[48;2;0;128;255mX',
      'bold':       '\x1b[1mX',
      'italic':     '\x1b[3mX',
      'underline':  '\x1b[4mX',
      'inverse':    '\x1b[7mX',
      'strike':     '\x1b[9mX',
      'combo':      '\x1b[1;3;4;38;2;10;20;30;48;5;21mX',
    };
    let col = 0;
    const results = {};
    for (const [name, seq] of Object.entries(samples)) {
      await new Promise(r => term.write(`\x1b[1;${col + 1}H` + seq + '\x1b[0m', r));
      const cell = term.buffer.active.getLine(0).getCell(col);
      results[name] = cellSgr(cell).replace(/\x1b/g, 'ESC');
      col++;
    }
    log('colortest', results);
    // Show the full composite for the first row is byte-producing (sanity).
    const frame = composite(term, COLS, ROWS, HPAD, VPAD, 'colortest', 'evidence');
    log('composite-bytes', { length: frame.length, hasReset: frame.includes('\x1b[0m') });
    process.exit(0);
  }

  const targets = {
    vim:   { cmd: '/usr/bin/vim',  args: ['-u', 'NONE', '-N'] },
    codex: { cmd: process.env.HOME + '/.local/bin/codex', args: [] },
  };
  const t = targets[pick];
  if (!t) { console.error('unknown', pick); process.exit(1); }

  const d = ptyDims(COLS, ROWS, HPAD, VPAD);
  const term = new Terminal({ cols: d.ptycols, rows: d.ptyrows, allowProposedApi: true });
  const child = pty.spawn(t.cmd, t.args, { name: 'xterm-256color', cols: d.ptycols, rows: d.ptyrows, cwd: process.cwd(), env: process.env });
  let bytes = 0;
  child.onData(x => { bytes += x.length; term.write(x); });

  await sleep(1500);
  log('startup', { bytes, bufType: term.buffer.active.type, termCols: term.cols, termRows: term.rows });
  log('startup-styled-cell', firstStyledCell(term));

  // Force an erase-display + redraw
  if (pick === 'vim') { child.write('ihello \x1b[31mred\x1b[0m world\x1b'); await sleep(300); child.write('\x0c'); }
  else child.write('\x1b[2J\x1b[H');
  await sleep(700);
  const frame = composite(term, COLS, ROWS, HPAD, VPAD, `${pick}`, 'evidence');
  log('after-erase', { bytes, bufType: term.buffer.active.type, compositeLen: frame.length });

  // Resize
  const NC = 80, NR = 24;
  const dz = ptyDims(NC, NR, HPAD, VPAD);
  term.resize(dz.ptycols, dz.ptyrows);
  child.resize(dz.ptycols, dz.ptyrows);
  await sleep(800);
  log('after-resize', { bytes, termCols: term.cols, termRows: term.rows, expectCols: dz.ptycols, expectRows: dz.ptyrows,
                        ok: term.cols === dz.ptycols && term.rows === dz.ptyrows });
  log('resize-styled-cell', firstStyledCell(term));

  if (pick === 'vim') child.write('\x1b:qa!\r'); else child.write('q');
  await sleep(500);
  log('after-quit', { bufType: term.buffer.active.type });
  try { child.kill(); } catch {}
  process.exit(0);
})();
