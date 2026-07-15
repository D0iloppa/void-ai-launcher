'use strict';
const readline = require('readline');
const { scrambleText, shimmerText, luminance, glitchText } = require('./animation');

let C = {};
const W  = 52;
const IW = W - 2;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
let FRAME = { hpad: 2, vpad: 1 };
let DOUBLE_WIDTH_EMOJI = true;
let ACTIVE_HOME_MODEL = null;
let menuStartTime = Date.now();
let LAST_PAINTED_ROWS = null;
let LAST_PAINTED_COLS = 0;
let SCREEN_WAS_CLEARED = false;
let PALETTE = {
  signal: '#00e676',
  text: '#f0f0f0',
  muted2: '#6a8a6a'
};
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
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue; // variation selectors: zero-width
    if (
      (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul syllables
      (cp >= 0x1100 && cp <= 0x11FF) || // Hangul Jamo
      (cp >= 0xA960 && cp <= 0xA97F) || // Hangul Jamo Extended-A
      (cp >= 0xD7B0 && cp <= 0xD7FF) || // Hangul Jamo Extended-B
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
      (cp >= 0x3040 && cp <= 0x30FF) || // Hiragana / Katakana
      (cp >= 0xFF01 && cp <= 0xFF60)    // Fullwidth Forms
    ) {
      w += 2;
    } else if (cp >= 0x1F000 && cp <= 0x1FFFF) { // Emoji (Misc Symbols, Pictographs, Emoticons …)
      w += DOUBLE_WIDTH_EMOJI ? 2 : 1;
    } else {
      w += 1;
    }
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
  if (typeof frame?.double_width_emoji === 'boolean') {
    DOUBLE_WIDTH_EMOJI = frame.double_width_emoji;
  }
}

function makeBox(innerWidth, bodyLines, opts = {}) {
  const sig = opts.borderColor || C.signal;
  const panelBg = opts.bgColor || '';
  const rst = C.RESET;
  const title = opts.title ? ` ${opts.title} ` : '';
  const topFill = repeatChar('─', Math.max(0, innerWidth - colWidth(title)));
  const lines = [sig + '┌' + title + topFill + '┐' + rst];

  const targetBodyHeight = typeof opts.height === 'number' ? opts.height - 2 : bodyLines.length;
  const paddedLines = [...bodyLines];
  while (paddedLines.length < targetBodyHeight) {
    paddedLines.push('');
  }

  paddedLines.forEach(line => {
    const safeLine = truncateCols(line, innerWidth);
    lines.push(sig + '│' + rst + panelBg + padCols(safeLine, innerWidth) + rst + sig + '│' + rst);
  });

  lines.push(sig + '└' + repeatChar('─', innerWidth) + '┘' + rst);
  return lines;
}

function makeHomeLogoBox(innerWidth, targetHeight) {
  const sig = C.signal;
  const mut = C.muted2;
  const time = new Date().toTimeString().slice(0, 8);
  const cwd = process.cwd();
  const maxPathLen = Math.max(10, innerWidth - 15);
  const cwdLabel = cwd.length > maxPathLen ? '…' + cwd.slice(-maxPathLen + 1) : cwd;

  const elapsed = Date.now() - menuStartTime;
  const progress = Math.min(1, elapsed / 800);

  const VOID_LOGO = [
    '██╗   ██╗ ██████╗ ██╗██████╗',
    '██║   ██║██╔═══██╗██║██╔══██╗',
    '╚██╗ ██╔╝██║   ██║██║██║  ██║',
    ' ╚████╔╝ ╚██████╔╝██║██████╔╝',
    '  ╚═══╝   ╚═════╝ ╚═╝╚═════╝',
  ];

  let logoLines = [];
  const charset = '██╔╝╚═║01 ';
  
  if (progress < 1) {
    logoLines = VOID_LOGO.map(line => `  ${sig}${scrambleText(line, progress, charset)}${C.RESET}`);
  } else {
    const cycle = (elapsed - 800) % 3500;
    if (cycle < 1200) {
      const shuffleProgress = cycle / 1200;
      logoLines = VOID_LOGO.map(line => `  ${sig}${scrambleText(line, shuffleProgress, charset)}${C.RESET}`);
    } else {
      logoLines = VOID_LOGO.map(line => `  ${sig}${line}${C.RESET}`);
    }
  }

  const glitchedSub = glitchText('// ai-launcher', elapsed, mut);
  const subtextLine = `  ${mut}${glitchedSub}   ${time}${C.RESET}`;

  const cwdLine = `  ${C.BOLD}${C.text}Workspace: ${C.RESET}${mut}${cwdLabel}${C.RESET}`;

  const lines = [
    '',
    ...logoLines,
    '',
    subtextLine,
    cwdLine,
    '',
  ];
  return makeBox(innerWidth, lines, { height: targetHeight });
}

function makeLinksBox(innerWidth, links, targetHeight) {
  const lines = [
    '',
    ...links.map(link => {
      const name = `${C.signal}- ${link.label}${C.RESET}`;
      return truncateCols(` ${name}  ${C.muted2}${link.url}${C.RESET}`, innerWidth);
    }),
    '',
  ];
  return makeBox(innerWidth, lines, { title: 'Links', height: targetHeight });
}

function makeHomeMenuBox(innerWidth, items, selectedIndex, optionIndices, footerText) {
  const lines = [''];

  items.forEach((item, i) => {
    const isSelected = i === selectedIndex;
    const keyPart = `[${item.key}]`;
    let content = `  ${keyPart} ${item.label}`;

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
      row = `  ${C.info}${keyPart}${C.RESET} ${C.text}${item.label}${C.RESET}`;
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

  let shimmeryLeft = left;
  const elapsed = Date.now() - menuStartTime;
  const cycle = (elapsed - 800) % 3500;

  if (left.includes('VOID') && elapsed > 800 && cycle < 1200) {
    const shimmerProgress = cycle / 1200;
    const onSignalHex = luminance(PALETTE.signal) > 0.179 ? PALETTE.bg : PALETTE.text;
    const shineHex = luminance(PALETTE.signal) > 0.179 ? '#ffffff' : PALETTE.signal;

    // Split the 'left' text around 'VOID' to shimmer only 'VOID'
    const parts = left.split('VOID');
    const prefix = parts[0];
    const suffix = parts.slice(1).join('VOID');

    const shimmeryWord = shimmerText('VOID', shimmerProgress, onSignalHex, shineHex, 3);
    shimmeryLeft = C.onSignal + C.BOLD + prefix + C.BOLD + shimmeryWord + C.signalBg + C.onSignal + C.BOLD + suffix;
  } else {
    shimmeryLeft = C.onSignal + C.BOLD + left;
  }

  const avail = Math.max(0, cols - colWidth(left) - colWidth(right));
  const lpad = Math.max(0, Math.floor((avail - colWidth(mid)) / 2));
  const rpad = Math.max(0, avail - colWidth(mid) - lpad);

  return C.signalBg + shimmeryLeft + C.signalBg + C.onSignal + C.BOLD + repeatChar(' ', lpad) + mid + repeatChar(' ', rpad) + right + C.RESET;
}

function getMenuIcon(title) {
  const cleanTitle = title.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const hasEmoji = /^[^\x00-\x7F]/u.test(cleanTitle) && !/^[ㄱ-ㅎㅏ-ㅣ가-힣]/u.test(cleanTitle);
  if (hasEmoji) return '';

  if (cleanTitle.includes('History') || cleanTitle.includes('이력')) return '📜 ';
  if (cleanTitle.includes('설정') || cleanTitle.includes('Config')) return '⚙️ ';
  if (cleanTitle.includes('세션')) return '🔑 ';
  if (cleanTitle.includes('고급')) return '💎 ';
  if (cleanTitle.includes('토큰') || cleanTitle.includes('인증') || cleanTitle.includes('Tokens')) return '🪙 ';
  if (cleanTitle.includes('입력')) return '✏️ ';
  if (cleanTitle.includes('알림') || cleanTitle.includes('경고')) return '🔔 ';
  if (cleanTitle.includes('도움말') || cleanTitle.includes('Help')) return '📖 ';
  if (cleanTitle.includes('서비스')) return '🛠️ ';
  if (cleanTitle.includes('삭제')) return '🗑️ ';
  if (cleanTitle.includes('성공') || cleanTitle.includes('완료')) return '✅ ';

  return '📂 ';
}

function renderFramedScreen(label, contentLines, opts = {}) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const hpad = typeof opts.hpad === 'number' ? opts.hpad : FRAME.hpad;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : FRAME.vpad;
  const innerWidth = cols;
  const innerContentWidth = Math.max(1, innerWidth - (hpad * 2));
  const availableRows = Math.max(0, rows - 2 - (vpad * 2));
  const topPadRows = Math.max(0, vpad);
  const bottomPadRows = Math.max(0, rows - 2 - topPadRows - availableRows);

  let finalContentLines = [...contentLines];
  const minCols = 88;
  if (ACTIVE_HOME_MODEL && cols >= minCols && rows >= 24 && !opts.noTopPanels) {
    const gap = 3;
    const leftWidth = clamp(Math.floor(innerContentWidth * 0.34), 36, 52);
    const rightWidth = Math.max(28, innerContentWidth - leftWidth - gap);

    const logoLinesCount = 10;
    const linksLinesCount = 2 + (ACTIVE_HOME_MODEL.links ? ACTIVE_HOME_MODEL.links.length : 0);
    const targetHeight = Math.max(logoLinesCount, linksLinesCount) + 2;

    const logoBox = makeHomeLogoBox(leftWidth - 2, targetHeight);
    const linkBox = makeLinksBox(rightWidth - 2, ACTIVE_HOME_MODEL.links, targetHeight);

    const topLines = [];
    for (let i = 0; i < targetHeight; i++) {
      const left = logoBox[i] || ' '.repeat(leftWidth);
      const right = linkBox[i] || ' '.repeat(rightWidth);
      topLines.push(left + ' '.repeat(gap) + right);
    }

    finalContentLines = [...topLines, '', ...contentLines];
  }

  const bodyLines = finalContentLines.slice(0, availableRows);
  while (bodyLines.length < availableRows) bodyLines.push('');
  const screenRows = [];
  const icon = getMenuIcon(label);
  screenRows.push(makeHomeFrameBar(cols, ` VOID >_  ${icon}${label} `));

  const emptyInner = repeatChar(' ', innerWidth);
  for (let i = 0; i < topPadRows; i++) {
    screenRows.push(emptyInner);
  }

  for (const line of bodyLines) {
    const framed = repeatChar(' ', hpad) + padCols(truncateCols(line, innerContentWidth), innerContentWidth) + repeatChar(' ', hpad);
    screenRows.push(padCols(framed, cols));
  }

  for (let i = 0; i < bottomPadRows; i++) {
    screenRows.push(emptyInner);
  }

  // Bottom Status Bar
  const bottomBarText = '  VOID // ai-launcher v2.0.0  ·  Press Ctrl+C to exit';
  const bottomBar = C.signalBg + C.onSignal + C.BOLD + padCols(bottomBarText, cols) + C.RESET;
  screenRows.push(bottomBar);

  while (screenRows.length < rows) {
    screenRows.push(' '.repeat(cols));
  }
  paintRows(screenRows.slice(0, rows), { skipFirst: opts.keepTopRows || 0 });
}

function renderHome(model, selectedIndex, optionIndices) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 32;
  const minCols = 88;
  const hpad = typeof model?.hpad === 'number' ? model.hpad : FRAME.hpad;

  if (cols < minCols || rows < 24) {
    const contentWidth = Math.max(1, cols - 2 - (hpad * 2));
    const menuWidth = clamp(Math.floor(contentWidth * 0.58), 54, 78);
    const menuBox = makeHomeMenuBox(
      menuWidth - 2,
      model.items, selectedIndex, optionIndices,
      '↑↓ 이동   ←→ 옵션 변경   Enter 실행   : command   0 종료'
    );
    const lines = [...menuBox];
    if (model.lastDesc) lines.push('  ' + C.muted2 + `최근 실행: ${model.lastDesc}` + C.RESET);
    renderFramedScreen(model.title, lines, { ...model, noTopPanels: true });
    return 0;
  }

  const gap = 3;
  const contentWidth = Math.max(1, cols - 2 - (hpad * 2));
  const leftWidth = clamp(Math.floor(contentWidth * 0.34), 36, 52);
  const rightWidth = Math.max(28, contentWidth - leftWidth - gap);
  const menuWidth = contentWidth;

  const logoLinesCount = 10;
  const linksLinesCount = 2 + (model.links ? model.links.length : 0);
  const targetHeight = Math.max(logoLinesCount, linksLinesCount) + 2;

  const logoBox = makeHomeLogoBox(leftWidth - 2, targetHeight);
  const linkBox = makeLinksBox(rightWidth - 2, model.links, targetHeight);
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

  renderFramedScreen(model.title, lines, { ...model, noTopPanels: true });
  return topHeight;
}

// ── Terminal helpers ──────────────────────────────────────

function setColors(colors, palette) {
  C = colors;
  if (palette) PALETTE = palette;
}
function out(str)    { process.stdout.write(str + '\n'); }
function clear()     { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; SCREEN_WAS_CLEARED = true; process.stdout.write('\x1b[2J\x1b[H'); }
function hideCursor(){ process.stdout.write('\x1b[?25l'); }
function showCursor(){ process.stdout.write('\x1b[?25h'); }
function enterAltScreen() { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; SCREEN_WAS_CLEARED = true; process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H'); }
function exitAltScreen()  { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; SCREEN_WAS_CLEARED = true; process.stdout.write('\x1b[2J\x1b[H\x1b[?1049l'); }

function paintRows(rows, { skipFirst = 0 } = {}) {
  const cols = process.stdout.columns || 120;
  const firstPaint = !LAST_PAINTED_ROWS || LAST_PAINTED_COLS !== cols ||
    LAST_PAINTED_ROWS.length !== rows.length;
  let buf = firstPaint && !skipFirst && !SCREEN_WAS_CLEARED ? '\x1b[2J\x1b[H' : '';
  for (let i = skipFirst; i < rows.length; i++) {
    if (firstPaint || LAST_PAINTED_ROWS[i] !== rows[i]) {
      buf += at(i + 1, 1) + rows[i] + '\x1b[K';
    }
  }
  if (buf) process.stdout.write(buf);
  LAST_PAINTED_ROWS = [...rows];
  LAST_PAINTED_COLS = cols;
  SCREEN_WAS_CLEARED = false;
}

// ── Render ────────────────────────────────────────────────

const LABEL_COL = 22; // columns reserved for [key]+label section of combo rows

function buildMenuLines(title, items, selectedIndex, optionIndices, innerWidth, opts = {}) {
  const sig = C.signal;
  const rst = C.RESET;
  const lines = [];

  if (opts.showHeader) {
    lines.push(sig + '┌' + '─'.repeat(innerWidth) + '┐' + rst);
  } else {
    const titleStr = `── ${title} `;
    const topFill  = '─'.repeat(Math.max(0, innerWidth - colWidth(titleStr)));
    lines.push(sig + '┌' + titleStr + topFill + '┐' + rst);
  }

  if (opts.subtitle && !opts.showHeader) {
    lines.push(sig + '│' + C.muted2 + padCols('  ' + opts.subtitle, innerWidth) + rst + sig + '│' + rst);
    lines.push(sig + '├' + '─'.repeat(innerWidth) + '┤' + rst);
  }

  lines.push(sig + '│' + ' '.repeat(innerWidth) + sig + '│' + rst);

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
      const trailPad = ' '.repeat(Math.max(0, innerWidth - LABEL_COL - colWidth(arrows)));

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
      const pad      = ' '.repeat(Math.max(0, innerWidth - visW));

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

  lines.push(sig + '│' + ' '.repeat(innerWidth) + sig + '│' + rst);
  lines.push(sig + '└' + '─'.repeat(innerWidth) + '┘' + rst);
  lines.push('');

  const hasCombo = items.some(it => !it.disabled && it.options && it.options.length > 0);
  let helpStr = hasCombo
    ? '  ↑↓ 이동  ←→ 옵션 변경  Enter 실행  0 뒤로'
    : '  ↑↓ 이동  Enter/숫자 선택  0 뒤로';
  if (opts.enableDelete) {
    helpStr += '  d 삭제';
  }
  lines.push(C.muted2 + helpStr + rst);
  return lines;
}

function renderMenu(title, items, selectedIndex, optionIndices, opts = {}) {
  const cols = process.stdout.columns || 120;
  const hpad = typeof opts.hpad === 'number' ? opts.hpad : FRAME.hpad;
  const contentWidth = Math.max(1, cols - 2 - (hpad * 2));
  const innerWidth = contentWidth - 2;

  const menuLines = buildMenuLines(title, items, selectedIndex, optionIndices, innerWidth, opts);
  renderFramedScreen(title, menuLines, opts);
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
      const menuRows      = items.length + 7;
      const canShowHeader = opts.showHeader &&
        (process.stdout.rows >= HEADER_ROWS + menuRows);
      renderMenu(title, items, sel, optionIndices, { ...opts, showHeader: canShowHeader });
    };

    const onResize = () => { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; draw(); };

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
      clearInterval(timer);
      process.stdout.removeListener('resize', onResize);
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
      if ((str === 'd' || str === 'D') && opts.enableDelete) {
        const item = items[sel];
        if (item && !item.disabled && item.key !== 'd' && item.key !== 'n') {
          cleanup();
          resolve({ ...item, action: 'delete' });
          return;
        }
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
    menuStartTime = Date.now();
    const timer = setInterval(draw, 50);
    draw();
  });
}

async function homeMenu(model) {
  ACTIVE_HOME_MODEL = model;
  if (!process.stdin.isTTY) {
    return fallbackMenu(model.title, model.items, { subtitle: model.lastDesc });
  }

  // A child CLI may have used the normal or alternate screen. Always start a
  // new home session from a clean canvas, then rely on row diffs thereafter.
  clear();

  return new Promise(resolve => {
    let sel = model.items.findIndex(it => !it.disabled);
    if (sel === -1) sel = 0;
    const optionIndices = model.items.map(it => it.optionIndex || 0);
    let panelRows = 0;

    menuStartTime = Date.now();
    const draw = () => {
      panelRows = renderHome(model, sel, optionIndices) || 0;
    };

    const timer = setInterval(draw, 50);

    const done = (itemIdx, extra = {}) => {
      cleanup();
      if (itemIdx === null || itemIdx === undefined) { resolve(extra.result || null); return; }
      const item = model.items[itemIdx];
      if (!item) { resolve(extra.result || null); return; }
      const result = { ...item, ...extra, panelRows: panelRows + 1 };
      if (item.options && item.options.length > 0) {
        result.selectedOption = item.options[optionIndices[itemIdx]];
        result.optionIndex = optionIndices[itemIdx];
      }
      resolve(result);
    };

    const cleanup = () => {
      clearInterval(timer);
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      showCursor();
    };

    const onResize = () => { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; draw(); };

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
      if (str === '0' || key.name === 'escape') { done(null); return; }
      if (!str) return;

      const lstr = str.toLowerCase();
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
  const lines = text.split('\n');
  const cols = process.stdout.columns || 120;
  const hpad = FRAME.hpad;
  const innerContentWidth = cols - (hpad * 2);

  const boxedLines = makeBox(innerContentWidth - 2, lines, { title: '알림' });
  boxedLines.push('');
  boxedLines.push(C.muted2 + '  Enter 키를 눌러 계속...' + C.RESET);

  renderFramedScreen('알림', boxedLines, { noTopPanels: true });

  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'return' || (key.ctrl && key.name === 'c')) {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(wasRaw);
        if (key.ctrl && key.name === 'c') process.exit(0);
        resolve();
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

async function flashMessage(text, ms = 900) {
  const lines = text.split('\n');
  const cols = process.stdout.columns || 120;
  const hpad = FRAME.hpad;
  const innerContentWidth = cols - (hpad * 2);

  const boxedLines = makeBox(innerContentWidth - 2, lines, { title: '알림' });

  renderFramedScreen('알림', boxedLines, { noTopPanels: true });
  await new Promise(r => setTimeout(r, ms));
}

async function input(promptText, secret = false) {
  return new Promise(resolve => {
    let value = '';
    const drawInput = () => {
      const displayValue = secret ? '*'.repeat(value.length) : value;
      const innerLines = [
        '',
        '  ' + C.text + promptText + C.RESET + C.info + displayValue + C.RESET + '█',
        '',
      ];
      const cols = process.stdout.columns || 120;
      const hpad = FRAME.hpad;
      const innerContentWidth = cols - (hpad * 2);

      const boxedLines = makeBox(innerContentWidth - 2, innerLines, { title: '입력' });
      boxedLines.push('');
      boxedLines.push('  ' + C.muted2 + 'ESC: 취소하고 뒤로가기  |  Enter: 입력 완료' + C.RESET);

      renderFramedScreen('입력', boxedLines, { noTopPanels: true });
    };

    if (process.stdin.isTTY) {
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      hideCursor();
      drawInput();

      const onData = chunk => {
        const ch = chunk.toString();
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(wasRaw);
          process.stdin.removeListener('data', onData);
          showCursor();
          resolve(value);
        } else if (ch === '\x1b') {
          process.stdin.setRawMode(wasRaw);
          process.stdin.removeListener('data', onData);
          showCursor();
          resolve(null);
        } else if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            drawInput();
          }
        } else if (ch === '\x03') {
          process.exit(0);
        } else if (ch >= ' ') {
          value += ch;
          drawInput();
        }
      };
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', ans => { rl.close(); resolve(ans); });
    }
  });
}

async function scrollableMessage(title, text) {
  const lines = text.split('\n');

  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }

    let scrollTop = 0;
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);

    const draw = () => {
      const rows = process.stdout.rows || 32;
      const cols = process.stdout.columns || 120;
      const vpad = FRAME.vpad;
      const hpad = FRAME.hpad;
      const innerContentWidth = cols - (hpad * 2);

      // Subtract 2 for top/bottom bar, vpad*2 for padding, 2 for border lines, and 2 for spacing/footer
      const availableRows = Math.max(1, rows - 2 - (vpad * 2) - 4);

      const visibleLines = lines.slice(scrollTop, scrollTop + availableRows);
      const boxedLines = makeBox(innerContentWidth - 2, visibleLines, { title });
      const displayLines = [...boxedLines];
      displayLines.push('');

      let scrollProgress = '';
      if (lines.length > availableRows) {
        const current = scrollTop + 1;
        const total = Math.max(1, lines.length - availableRows + 1);
        scrollProgress = `  (위치: ${current}/${total})`;
      }
      displayLines.push(C.muted2 + '  ↑/↓: 스크롤  |  Enter: 닫기' + scrollProgress + C.RESET);

      clear();
      renderFramedScreen(title, displayLines, { noTopPanels: true });
    };

    const onResize = () => draw();
    process.stdout.on('resize', onResize);

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }

      const rows = process.stdout.rows || 32;
      const vpad = FRAME.vpad;
      const availableRows = Math.max(1, rows - 2 - (vpad * 2) - 4);
      const maxScroll = Math.max(0, lines.length - availableRows);

      if (key.name === 'up') {
        if (scrollTop > 0) {
          scrollTop--;
          draw();
        }
      } else if (key.name === 'down') {
        if (scrollTop < maxScroll) {
          scrollTop++;
          draw();
        }
      } else if (key.name === 'return' || key.name === 'escape') {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      process.stdout.removeListener('resize', onResize);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(wasRaw);
      showCursor();
    };

    hideCursor();
    process.stdin.on('keypress', onKey);
    draw();
  });
}

module.exports = { setColors, setFrameConfig, menu, homeMenu, message, scrollableMessage, flashMessage, input, clear, out, W, IW, colWidth, renderHeader, enterAltScreen, exitAltScreen };
