'use strict';
const readline = require('readline');

let C = {};
const W  = 52;
const IW = W - 2;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
let FRAME = { hpad: 2, vpad: 1 };
function at(row, col) { return `\x1b[${row};${col}H`; }

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
  for (const ch of str.replace(ANSI_RE, '')) {
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
  const vw = colWidth(str.replace(ANSI_RE, ''));
  return str + ' '.repeat(Math.max(0, width - vw));
}

function truncateCols(str, width) {
  if (colWidth(str) <= width) return str;

  let out = '';
  let used = 0;
  const plain = str.replace(ANSI_RE, '');
  for (const ch of plain) {
    const next = colWidth(ch);
    if (used + next >= width) break;
    out += ch;
    used += next;
  }
  return out + '…';
}

function repeatChar(ch, width) {
  return ch.repeat(Math.max(0, width));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setFrameConfig(frame) {
  FRAME = {
    hpad: typeof frame?.hpad === 'number' ? frame.hpad : 2,
    vpad: typeof frame?.vpad === 'number' ? frame.vpad : 1,
  };
}

function makeBox(innerWidth, bodyLines, opts = {}) {
  const sig = opts.borderColor || C.signal;
  const rst = C.RESET;
  const title = opts.title ? ` ${opts.title} ` : '';
  const topFill = repeatChar('─', Math.max(0, innerWidth - colWidth(title)));
  const lines = [sig + '┌' + title + topFill + '┐' + rst];

  bodyLines.forEach(line => {
    const safeLine = truncateCols(line, innerWidth);
    lines.push(sig + '│' + rst + padCols(safeLine, innerWidth) + sig + '│' + rst);
  });

  lines.push(sig + '└' + repeatChar('─', innerWidth) + '┘' + rst);
  return lines;
}

function makeHomeLogoBox(innerWidth) {
  const sig = C.signal;
  const mut = C.muted2;
  const lines = [
    '',
    `  ${sig}██╗   ██╗ ██████╗ ██╗██████╗${C.RESET}`,
    `  ${sig}██║   ██║██╔═══██╗██║██╔══██╗${C.RESET}`,
    `  ${sig}╚██╗ ██╔╝██║   ██║██║██║  ██║${C.RESET}`,
    `  ${sig} ╚████╔╝ ╚██████╔╝██║██████╔╝${C.RESET}`,
    `  ${sig}  ╚═══╝   ╚═════╝ ╚═╝╚═════╝${C.RESET}`,
    '',
    `  ${mut}// ai-launcher${C.RESET}`,
    '',
  ];
  return makeBox(innerWidth, lines);
}

function makeLinksBox(innerWidth, links) {
  const lines = [
    '',
    ...links.map(link => {
      const name = `${C.text}- ${link.label}${C.RESET}`;
      return truncateCols(` ${name}  ${C.muted2}${link.url}${C.RESET}`, innerWidth);
    }),
    '',
  ];
  return makeBox(innerWidth, lines, { title: 'Links', borderColor: C.info });
}

function makeHomeMenuBox(innerWidth, items, selectedIndex, optionIndices, footerText) {
  const lines = [''];

  items.forEach((item, i) => {
    const isSelected = i === selectedIndex;
    const keyPart = `[${item.key}]`;
    let content = ` ${keyPart} ${item.label}`;

    if (item.options && item.options.length > 0) {
      const optText = item.options[optionIndices[i] || 0] || '';
      const leftWidth = clamp(Math.floor(innerWidth * 0.46), 16, innerWidth - 14);
      const left = padCols(truncateCols(content, leftWidth), leftWidth);
      const right = truncateCols(`◀ ${optText} ▶`, innerWidth - leftWidth);
      content = left + C.muted2 + right + C.RESET;
    } else if (item.desc) {
      const leftWidth = clamp(Math.floor(innerWidth * 0.34), 12, innerWidth - 8);
      content = padCols(truncateCols(content, leftWidth), leftWidth)
        + C.muted2 + truncateCols(item.desc, innerWidth - leftWidth) + C.RESET;
    }

    let row;
    if (item.disabled) {
      row = C.muted + content + C.RESET;
    } else if (isSelected) {
      row = C.signalBg + C.onSignal + C.BOLD + padCols(content, innerWidth) + C.RESET;
    } else {
      row = `${C.info}${keyPart}${C.RESET} ${C.text}${item.label}${C.RESET}`;
      if (item.options && item.options.length > 0) {
        const optText = item.options[optionIndices[i] || 0] || '';
        const leftWidth = clamp(Math.floor(innerWidth * 0.46), 16, innerWidth - 14);
        row = padCols(truncateCols(row, leftWidth), leftWidth)
          + C.muted2 + '◀ ' + C.RESET + C.text + truncateCols(optText, innerWidth - leftWidth - 4) + C.RESET + C.muted2 + ' ▶' + C.RESET;
      } else if (item.desc) {
        const leftWidth = clamp(Math.floor(innerWidth * 0.34), 12, innerWidth - 8);
        row = padCols(truncateCols(row, leftWidth), leftWidth) + C.muted2 + truncateCols(item.desc, innerWidth - leftWidth) + C.RESET;
      }
      row = padCols(row, innerWidth);
    }

    lines.push(row);
  });

  lines.push('');
  lines.push(C.muted2 + footerText + C.RESET);
  return makeBox(innerWidth, lines, { title: 'Menu' });
}

function makeHomeFrameBar(cols, left, center = '') {
  const time = new Date().toTimeString().slice(0, 8);
  const right = center ? ` ${time} ` : '';
  const mid = center || '';
  const avail = Math.max(0, cols - colWidth(left) - colWidth(right));
  const lpad = Math.max(0, Math.floor((avail - colWidth(mid)) / 2));
  const rpad = Math.max(0, avail - colWidth(mid) - lpad);
  return C.signalBg + C.onSignal + C.BOLD + left + repeatChar(' ', lpad) + mid + repeatChar(' ', rpad) + right + C.RESET;
}

function renderFramedScreen(label, contentLines, opts = {}) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const hpad = typeof opts.hpad === 'number' ? opts.hpad : FRAME.hpad;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : FRAME.vpad;
  const innerWidth = Math.max(1, cols - 2);
  const innerContentWidth = Math.max(1, innerWidth - (hpad * 2));
  const availableRows = Math.max(0, rows - 2 - (vpad * 2));
  const topPadRows = Math.max(0, vpad);
  const bottomPadRows = Math.max(0, rows - 2 - topPadRows - availableRows);
  const bodyLines = contentLines.slice(0, availableRows);
  while (bodyLines.length < availableRows) bodyLines.push('');
  const screenRows = [];
  screenRows.push(makeHomeFrameBar(cols, ` Wrapper >_  ${label} `));

  const emptyInner = repeatChar(' ', innerWidth);
  for (let i = 0; i < topPadRows; i++) {
    screenRows.push(C.signal + '│' + C.RESET + emptyInner + C.signal + '│' + C.RESET);
  }

  for (const line of bodyLines) {
    const framed = repeatChar(' ', hpad) + padCols(truncateCols(line, innerContentWidth), innerContentWidth) + repeatChar(' ', hpad);
    screenRows.push(C.signal + '│' + C.RESET + padCols(framed, innerWidth) + C.signal + '│' + C.RESET);
  }

  for (let i = 0; i < bottomPadRows; i++) {
    screenRows.push(C.signal + '│' + C.RESET + emptyInner + C.signal + '│' + C.RESET);
  }

  const cwd = process.cwd();
  const cwdLabel = cwd.length > 40 ? '…' + cwd.slice(-39) : cwd;
  screenRows.push(makeHomeFrameBar(cols, ` Workspace: ${cwdLabel} `, 'VOID//ai-launcher'));
  while (screenRows.length < rows) {
    screenRows.push(' '.repeat(cols));
  }
  paintRows(screenRows.slice(0, rows));
}

function renderHome(model, selectedIndex, optionIndices) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const minCols = 88;
  if (cols < minCols || rows < 24) {
    const contentWidth = cols - 2;
    const menuWidth = clamp(Math.floor(contentWidth * 0.58), 54, 78);
    const menuBox = makeHomeMenuBox(
      menuWidth - 2,
      model.items, selectedIndex, optionIndices,
      '↑↓ 이동   ←→ 옵션 변경   Enter 실행   : command   0 종료'
    );
    const lines = [...menuBox];
    if (model.lastDesc) lines.push('  ' + C.muted2 + `최근 실행: ${model.lastDesc}` + C.RESET);
    renderFramedScreen(model.title, lines, model);
    return;
  }

  const gap = 3;
  const contentWidth = cols - 2;
  const leftWidth = clamp(Math.floor(contentWidth * 0.34), 36, 52);
  const rightWidth = Math.max(28, contentWidth - leftWidth - gap);
  const menuWidth = clamp(Math.floor(contentWidth * 0.58), 54, 78);

  const logoBox = makeHomeLogoBox(leftWidth - 2);
  const linkBox = makeLinksBox(rightWidth - 2, model.links);
  const menuBox = makeHomeMenuBox(
    menuWidth - 2,
    model.items,
    selectedIndex,
    optionIndices,
    '↑↓ 이동   ←→ 옵션 변경   Enter 실행   : command   0 종료'
  );

  const lines = [];
  const topHeight = Math.max(logoBox.length, linkBox.length);
  for (let i = 0; i < topHeight; i++) {
    const left = logoBox[i] || ' '.repeat(leftWidth);
    const right = linkBox[i] || ' '.repeat(rightWidth);
    lines.push(left + ' '.repeat(gap) + right);
  }

  lines.push('');
  menuBox.forEach(line => lines.push(line));
  lines.push('');

  if (model.lastDesc) lines.push('  ' + C.muted2 + `최근 실행: ${model.lastDesc}` + C.RESET);
  lines.push('  ' + C.muted2 + '고급 모드에는 세션 실행, 토큰 실행, Prompt, 터미널, Tokens를 묶어뒀다.' + C.RESET);

  renderFramedScreen(model.title, lines, model);
}

// ── Terminal helpers ──────────────────────────────────────

function setColors(colors) { C = colors; }
function out(str)    { process.stdout.write(str + '\n'); }
function clear()     { process.stdout.write('\x1b[2J\x1b[H'); }
function hideCursor(){ process.stdout.write('\x1b[?25l'); }
function showCursor(){ process.stdout.write('\x1b[?25h'); }
function enterAltScreen() { process.stdout.write('\x1b[?1049h'); }
function exitAltScreen()  { process.stdout.write('\x1b[?1049l'); }

function paintRows(rows) {
  let buf = '\x1b[2J\x1b[H';
  for (let i = 0; i < rows.length; i++) {
    buf += at(i + 1, 1) + rows[i];
  }
  process.stdout.write(buf);
}

// ── Render ────────────────────────────────────────────────

const LABEL_COL = 22; // columns reserved for [key]+label section of combo rows

function buildMenuLines(title, items, selectedIndex, optionIndices, opts = {}) {
  const sig = C.signal;
  const rst = C.RESET;
  const lines = [];

  if (opts.showHeader) {
    lines.push(sig + '┌' + '─'.repeat(IW) + '┐' + rst);
  } else {
    const titleStr = `── ${title} `;
    const topFill  = '─'.repeat(Math.max(0, IW - colWidth(titleStr)));
    lines.push(sig + '┌' + titleStr + topFill + '┐' + rst);
  }

  if (opts.subtitle && !opts.showHeader) {
    lines.push(sig + '│' + C.muted2 + padCols('  ' + opts.subtitle, IW) + rst + sig + '│' + rst);
    lines.push(sig + '├' + '─'.repeat(IW) + '┤' + rst);
  }

  lines.push(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);

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
      lines.push((isSelected ? sig + '├' + rst : sig + '│' + rst) + row + sig + '│' + rst);

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
      lines.push((isSelected ? sig + '├' + rst : sig + '│' + rst) + row + sig + '│' + rst);
    }
  });

  lines.push(sig + '│' + ' '.repeat(IW) + sig + '│' + rst);
  lines.push(sig + '└' + '─'.repeat(IW) + '┘' + rst);
  lines.push('');

  const hasCombo = items.some(it => !it.disabled && it.options && it.options.length > 0);
  if (hasCombo) {
    lines.push(C.muted2 + '  ↑↓ 이동  ←→ 옵션 변경  Enter 실행  0 뒤로' + rst);
  } else {
    lines.push(C.muted2 + '  ↑↓ 이동  Enter/숫자 선택  0 뒤로' + rst);
  }
  return lines;
}

function renderMenu(title, items, selectedIndex, optionIndices, opts = {}) {
  const lines = buildMenuLines(title, items, selectedIndex, optionIndices, opts);
  renderFramedScreen(title, lines, opts);
}

// ── Interactive Menu ──────────────────────────────────────

async function menu(title, items, opts = {}) {
  if (!process.stdin.isTTY) return fallbackMenu(title, items, opts);

  return new Promise(resolve => {
    let sel = items.findIndex(it => !it.disabled);
    if (sel === -1) sel = 0;

    // Per-item option indices, independent of caller's objects
    const optionIndices = items.map(it => it.optionIndex || 0);

    const HEADER_ROWS = 11;
    const draw = () => {
      clear();
      const menuRows      = items.length + 7;
      const canShowHeader = opts.showHeader &&
        (process.stdout.rows >= HEADER_ROWS + menuRows);
      renderMenu(title, items, sel, optionIndices, { ...opts, showHeader: canShowHeader });
    };

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
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      showCursor();
    };

    const onResize = () => draw();

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
    process.stdout.on('resize', onResize);
    draw();
  });
}

async function homeMenu(model) {
  if (!process.stdin.isTTY) {
    return fallbackMenu(model.title, model.items, { subtitle: model.lastDesc });
  }

  return new Promise(resolve => {
    let sel = model.items.findIndex(it => !it.disabled);
    if (sel === -1) sel = 0;
    const optionIndices = model.items.map(it => it.optionIndex || 0);

    const draw = () => {
      clear();
      renderHome(model, sel, optionIndices);
    };

    const done = (itemIdx, extra = {}) => {
      cleanup();
      if (itemIdx === null || itemIdx === undefined) { resolve(extra.result || null); return; }
      const item = model.items[itemIdx];
      if (!item) { resolve(extra.result || null); return; }
      const result = { ...item, ...extra };
      if (item.options && item.options.length > 0) {
        result.selectedOption = item.options[optionIndices[itemIdx]];
        result.optionIndex = optionIndices[itemIdx];
      }
      resolve(result);
    };

    const cleanup = () => {
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      showCursor();
    };

    const onResize = () => draw();

    const moveSelection = direction => {
      let next = sel;
      do { next = (next + direction + model.items.length) % model.items.length; }
      while (model.items[next].disabled && next !== sel);
      if (!model.items[next].disabled) sel = next;
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }

      if (key.name === 'up') {
        moveSelection(-1);
        draw();
        return;
      }
      if (key.name === 'down') {
        moveSelection(1);
        draw();
        return;
      }
      if (key.name === 'left') {
        const it = model.items[sel];
        if (!it.disabled && it.options && it.options.length > 1) {
          optionIndices[sel] = (optionIndices[sel] - 1 + it.options.length) % it.options.length;
          draw();
        }
        return;
      }
      if (key.name === 'right') {
        const it = model.items[sel];
        if (!it.disabled && it.options && it.options.length > 1) {
          optionIndices[sel] = (optionIndices[sel] + 1) % it.options.length;
          draw();
        }
        return;
      }
      if (key.name === 'return') {
        if (!model.items[sel].disabled) done(sel);
        return;
      }
      if (str === ':') {
        done(null, { result: { action: 'command', key: ':' } });
        return;
      }
      if (str === '0' || key.name === 'escape') { done(null); return; }
      if (!str) return;

      const lstr = str.toLowerCase();
      if (lstr === ':') {
        done(null, { result: { action: 'command', key: ':' } });
        return;
      }

      const matchIdx = model.items.findIndex(it => !it.disabled && it.key && it.key.toLowerCase() === lstr);
      if (matchIdx >= 0) { done(matchIdx); }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    hideCursor();
    process.stdin.on('keypress', onKey);
    process.stdout.on('resize', onResize);
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

module.exports = { setColors, setFrameConfig, menu, homeMenu, message, input, clear, out, W, IW, colWidth, renderHeader, enterAltScreen, exitAltScreen };
