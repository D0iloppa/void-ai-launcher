'use strict';
const readline = require('readline');

let C = {};
const W  = 52;
const IW = W - 2;

// ── VOID figlet logo ──────────────────────────────────
const VOID_LOGO = [
  '██╗   ██╗ ██████╗ ██╗██████╗',
  '██║   ██║██╔═══██╗██║██╔══██╗',
  '╚██╗ ██╔╝██║   ██║██║██║  ██║',
  ' ╚████╔╝ ╚██████╔╝██║██████╔╝',
  '  ╚═══╝   ╚═════╝ ╚═╝╚═════╝',
];
const LOGO_IW   = 33; // logo box inner width (29 max + 2+2 padding)
const LOGO_SUB  = '// ai-launcher';

function renderHeader() {
  const sig = C.signal;
  const mut = C.muted2;
  const rst = C.RESET;
  const trail = line => ' '.repeat(Math.max(0, LOGO_IW - 2 - line.length));

  out(sig + '┌' + '─'.repeat(LOGO_IW) + '┐' + rst);
  out(sig + '│' + ' '.repeat(LOGO_IW) + sig + '│' + rst);
  VOID_LOGO.forEach(line => {
    out(sig + '│  ' + sig + line + rst + trail(line) + sig + '│' + rst);
  });
  out(sig + '│' + ' '.repeat(LOGO_IW) + sig + '│' + rst);
  out(sig + '│  ' + mut + LOGO_SUB + rst + trail(LOGO_SUB) + sig + '│' + rst);
  out(sig + '└' + '─'.repeat(LOGO_IW) + '┘' + rst);
  out('');
}

// ── CJK-aware column width ────────────────────────────────

function colWidth(str) {
  let w = 0;
  for (const ch of str.replace(/\x1b\[[0-9;]*m/g, '')) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul syllables
      (cp >= 0x1100 && cp <= 0x11FF) || // Hangul Jamo
      (cp >= 0xA960 && cp <= 0xA97F) || // Hangul Jamo Extended-A
      (cp >= 0xD7B0 && cp <= 0xD7FF) || // Hangul Jamo Extended-B
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
      (cp >= 0x3040 && cp <= 0x30FF)    // Hiragana / Katakana
    ) { w += 2; } else { w += 1; }
  }
  return w;
}

function padCols(str, width) {
  const vw = colWidth(str.replace(/\x1b\[[0-9;]*m/g, ''));
  return str + ' '.repeat(Math.max(0, width - vw));
}

// ── Terminal helpers ──────────────────────────────────────

function setColors(colors) { C = colors; }
function out(str)    { process.stdout.write(str + '\n'); }
function clear()     { process.stdout.write('\x1b[2J\x1b[H'); }
function hideCursor(){ process.stdout.write('\x1b[?25l'); }
function showCursor(){ process.stdout.write('\x1b[?25h'); }

// ── Render ────────────────────────────────────────────────

const LABEL_COL = 22; // columns reserved for [key]+label section of combo rows

function renderMenu(title, items, selectedIndex, optionIndices, opts = {}) {
  const sig = C.signal;
  const rst = C.RESET;

  // Top border
  if (opts.showHeader) {
    out(sig + '┌' + '─'.repeat(IW) + '┐' + rst);
  } else {
    const titleStr = `── ${title} `;
    const topFill  = '─'.repeat(Math.max(0, IW - colWidth(titleStr)));
    out(sig + '┌' + titleStr + topFill + '┐' + rst);
  }

  // Optional subtitle (not shown when header is rendered separately)
  if (opts.subtitle && !opts.showHeader) {
    out(sig + '│' + C.muted2 + padCols('  ' + opts.subtitle, IW) + rst + sig + '│' + rst);
    out(sig + '├' + '─'.repeat(IW) + '┤' + rst);
  }

  out(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);

  items.forEach((item, i) => {
    const isSelected = i === selectedIndex;
    const keyStr     = `[${item.key}]`;

    if (item.options && item.options.length > 0) {
      // ── Combo row: label section + ◀ option ▶ ──────────
      const optIdx   = optionIndices[i] || 0;
      const optText  = item.options[optIdx] || '';
      const labelVis = `  ${keyStr} ${item.label}`;
      const labelPad = ' '.repeat(Math.max(0, LABEL_COL - colWidth(labelVis)));
      const arrows   = `◀ ${optText} ▶`;
      const trailPad = ' '.repeat(Math.max(0, IW - LABEL_COL - colWidth(arrows)));

      let row;
      if (item.disabled) {
        row = C.muted + labelVis + labelPad + arrows + trailPad + rst;
      } else if (isSelected) {
        row = C.signalBg + C.onSignal + C.BOLD +
          labelVis + labelPad + arrows + trailPad + rst;
      } else {
        const kc = item.key === 'q' ? sig : C.info;
        row = `  ${kc}${keyStr}${rst} ${C.text}${item.label}${rst}` +
          labelPad +
          C.muted2 + '◀ ' + rst + C.text + optText + rst + C.muted2 + ' ▶' + rst +
          trailPad;
      }
      out((isSelected ? sig + '├' + rst : sig + '│' + rst) + row + sig + '│' + rst);

    } else {
      // ── Regular row ────────────────────────────────────
      const descPart = item.desc ? '  ' + item.desc : '';
      const visText  = `  ${keyStr} ${item.label}${descPart}`;
      const visW     = colWidth(visText);
      const pad      = ' '.repeat(Math.max(0, IW - visW));

      let row;
      if (item.disabled) {
        row = C.muted + visText + pad + rst;
      } else if (isSelected) {
        row = C.signalBg + C.onSignal + C.BOLD + visText + pad + rst;
      } else {
        const kc = item.key === 'q' ? sig : C.info;
        const dc = item.desc ? C.muted + '  ' + item.desc + rst : '';
        row = `  ${kc}${keyStr}${rst} ${C.text}${item.label}${rst}${dc}${pad}`;
      }
      out((isSelected ? sig + '├' + rst : sig + '│' + rst) + row + sig + '│' + rst);
    }
  });

  out(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);
  out(sig + '└' + '─'.repeat(IW) + '┘' + rst);
  out('');

  const hasCombo = items.some(it => !it.disabled && it.options && it.options.length > 0);
  if (hasCombo) {
    out(C.muted2 + '  ↑↓ 이동  ←→ 옵션 변경  Enter 실행  0 뒤로' + rst);
  } else {
    out(C.muted2 + '  ↑↓ 이동  Enter/숫자 선택  0 뒤로' + rst);
  }
}

// ── Interactive Menu ──────────────────────────────────────

async function menu(title, items, opts = {}) {
  if (!process.stdin.isTTY) return fallbackMenu(title, items, opts);

  return new Promise(resolve => {
    let sel = items.findIndex(it => !it.disabled);
    if (sel === -1) sel = 0;

    // Per-item option indices, independent of caller's objects
    const optionIndices = items.map(it => it.optionIndex || 0);

    const draw = () => { clear(); if (opts.showHeader) renderHeader(); renderMenu(title, items, sel, optionIndices, opts); };

    const done = (itemIdx) => {
      cleanup();
      if (itemIdx === null || itemIdx === undefined) { resolve(null); return; }
      const item = items[itemIdx];
      if (!item) { resolve(null); return; }
      const result = { ...item };
      if (item.options && item.options.length > 0) {
        result.selectedOption = item.options[optionIndices[itemIdx]];
        result.optionIndex    = optionIndices[itemIdx];
      }
      resolve(result);
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      showCursor();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }

      if (key.name === 'up') {
        let n = sel;
        do { n = (n - 1 + items.length) % items.length; }
        while (items[n].disabled && n !== sel);
        if (!items[n].disabled) sel = n;
        draw(); return;
      }
      if (key.name === 'down') {
        let n = sel;
        do { n = (n + 1) % items.length; }
        while (items[n].disabled && n !== sel);
        if (!items[n].disabled) sel = n;
        draw(); return;
      }
      if (key.name === 'left') {
        const it = items[sel];
        if (!it.disabled && it.options && it.options.length > 1) {
          optionIndices[sel] = (optionIndices[sel] - 1 + it.options.length) % it.options.length;
          draw();
        }
        return;
      }
      if (key.name === 'right') {
        const it = items[sel];
        if (!it.disabled && it.options && it.options.length > 1) {
          optionIndices[sel] = (optionIndices[sel] + 1) % it.options.length;
          draw();
        }
        return;
      }
      if (key.name === 'return') {
        if (!items[sel].disabled) done(sel);
        return;
      }
      if (str === '0' || key.name === 'escape') { done(null); return; }
      if (!str) return;

      const lstr   = str.toLowerCase();
      const matchIdx = items.findIndex(it => !it.disabled && it.key && it.key.toLowerCase() === lstr);
      if (matchIdx >= 0) { done(matchIdx); return; }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    hideCursor();
    process.stdin.on('keypress', onKey);
    draw();
  });
}

async function fallbackMenu(title, items, opts = {}) {
  return new Promise(resolve => {
    console.log(`\n  ── ${title} ──`);
    items.forEach(it => {
      if (!it.disabled) {
        const optStr = it.options ? `  [${it.options.join('|')}]` : (it.desc ? '  ' + it.desc : '');
        console.log(`  [${it.key}] ${it.label}${optStr}`);
      }
    });
    console.log('  [0] 뒤로\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  선택: ', ans => {
      rl.close();
      const lans = ans.toLowerCase();
      if (lans === '0' || lans === '') { resolve(null); return; }
      const matchIdx = items.findIndex(it => !it.disabled && it.key && it.key.toLowerCase() === lans);
      if (matchIdx < 0) { resolve(null); return; }
      const item   = items[matchIdx];
      const result = { ...item };
      if (item.options && item.options.length > 0) result.selectedOption = item.options[0];
      resolve(result);
    });
  });
}

// ── Message / Input ───────────────────────────────────────

async function message(text) {
  clear();
  out('');
  text.split('\n').forEach(line => out('  ' + line));
  out('');
  out('  ' + C.muted2 + 'Enter 키를 눌러 계속...' + C.RESET);

  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'return' || (key.ctrl && key.name === 'c')) {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(false);
        showCursor();
        if (key.ctrl && key.name === 'c') process.exit(0);
        resolve();
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

async function input(promptText, secret = false) {
  return new Promise(resolve => {
    process.stdout.write('  ' + C.muted2 + promptText + C.RESET);

    if (secret && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let value = '';
      const onData = chunk => {
        const ch = chunk.toString();
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch === '\x03') {
          process.exit(0);
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', ans => { rl.close(); resolve(ans); });
    }
  });
}

module.exports = { setColors, menu, message, input, clear, out, W, IW, colWidth, renderHeader };
