'use strict';
const readline = require('readline');
const { scrambleText, shimmerText, luminance, glitchText } = require('./animation');
const { contrastRatio } = require('./theme');

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
    } else if (
      (cp >= 0x1F000 && cp <= 0x1FFFF) || // Emoji (Misc Symbols, Pictographs, Emoticons …)
      cp === 0x2699 || // ⚙ gear
      cp === 0x26A1 || // ⚡ high voltage — was falling through to width 1, causing box-border
                       // misalignment on any line starting with it (e.g. the home dashboard's
                       // "⚡ init" row) since terminals render it emoji-wide (2 cols).
      cp === 0x2705 || // ✅ white heavy check mark
      cp === 0x270F    // ✏ pencil
    ) {
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

function makeLinksBox(innerWidth, links, targetHeight, dashboardLines) {
  const lines = [
    '',
    ...links.map(link => {
      const name = `${C.signal}- ${link.label}${C.RESET}`;
      return truncateCols(` ${name}  ${C.muted2}${link.url}${C.RESET}`, innerWidth);
    }),
    '',
  ];
  if (dashboardLines && dashboardLines.length > 0) {
    // 박스가 targetHeight 를 넘지 않도록 남은 여유 줄 수만큼만 넣는다
    // (makeBox 는 부족한 줄은 채우지만 넘치는 줄은 자르지 않으므로).
    const slack = Math.max(0, (targetHeight - 2) - lines.length);
    lines.push(...dashboardLines.slice(0, slack));
  }
  return makeBox(innerWidth, lines, { title: 'Links', height: targetHeight });
}

// 홈 모델의 dashboard(함수 또는 배열)를 lazy 하게 평가해 캐시한다.
// renderHome 은 애니메이션 때문에 50ms 마다 다시 그리므로, 매 틱마다 재계산하지
// 않고 DASHBOARD_REFRESH_MS 간격으로만 재평가한다 (그 사이에는 캐시 재사용).
// 이렇게 해야 void_init 의 백그라운드 워밍업이 첫 렌더 이후에 끝나도, 홈 화면이
// "아직 실행 전" 같은 오래된 상태에 영구히 고정되지 않고 스스로 갱신된다.
const DASHBOARD_REFRESH_MS = 1500;
function resolveHomeDashboard(model) {
  if (!model) return null;
  const now = Date.now();
  const stale = !('_dashboardComputedAt' in model) || (now - model._dashboardComputedAt) >= DASHBOARD_REFRESH_MS;
  if (stale) {
    let lines = null;
    try {
      lines = typeof model.dashboard === 'function' ? model.dashboard() : (model.dashboard || null);
    } catch { lines = null; }
    model._dashboardLines = Array.isArray(lines) && lines.length > 0 ? lines : null;
    model._dashboardComputedAt = now;
  }
  return model._dashboardLines;
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
    // theme.js의 makeColors()와 동일한 대비비 비교 — signal 배경 위에서 bg/text
    // 중 대비가 더 큰 쪽을 고른다. 예전 luminance(signal) > 0.179 휴리스틱은
    // 다크테마(bg=어두움, text=밝음) 전제로 고정돼 있어 라이트 테마(white-black
    // 등)에서 signal=text=검정이면 onSignal/shine 색이 둘 다 검정이 되어
    // shimmer 텍스트가 signal 배경 위에서 안 보이는 문제가 있었다.
    const sigLum = luminance(PALETTE.signal);
    const bgContrast = contrastRatio(sigLum, luminance(PALETTE.bg));
    const textContrast = contrastRatio(sigLum, luminance(PALETTE.text));
    const onSignalHex = bgContrast >= textContrast ? PALETTE.bg : PALETTE.text;
    const shineHex = onSignalHex === PALETTE.bg ? '#ffffff' : PALETTE.signal;

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

  if (cleanTitle.includes('개인비서') || cleanTitle.includes('어시스턴트')) return '🤖 ';
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
    const linkBox = makeLinksBox(rightWidth - 2, ACTIVE_HOME_MODEL.links, targetHeight, resolveHomeDashboard(ACTIVE_HOME_MODEL));

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
  const linkBox = makeLinksBox(rightWidth - 2, model.links, targetHeight, resolveHomeDashboard(model));
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
// Read accessor for low-level frame modules (wrapper.js/xtermFrame.js/
// miniShell.js) that draw raw ANSI outside ui.js's own render path and can't
// import the module-private `C`/`PALETTE` any other way — lets them pull the
// active theme pack's hex values instead of hardcoding a color.
function getPalette() { return PALETTE; }
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
          if (typeof opts.onOptionChange === 'function') opts.onOptionChange(sel, it, optionIndices[sel]);
          draw();
        }
        return;
      }
      if (key.name === 'right') {
        const it = items[sel];
        if (!it.disabled && it.options && it.options.length > 1) {
          optionIndices[sel] = (optionIndices[sel] + 1) % it.options.length;
          if (typeof opts.onOptionChange === 'function') opts.onOptionChange(sel, it, optionIndices[sel]);
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

// 브래킷 붙여넣기(bracketed paste) 마커. 대부분의 최신 터미널(WSL2/Windows
// Terminal 포함)은 raw-mode stdin에 대해 기본값으로 붙여넣기 내용을
// START...END 사이에 감싸서 보낸다. 길게 붙여넣을 경우 이 마커와 내용이
// 여러 개의 개별 'data' 이벤트로 쪼개져 도착할 수 있다(예: START 마커
// 자체가 청크 경계에서 반으로 잘리는 경우도 있음).
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// 실제 ESC 단독 입력과 "START 마커의 첫 바이트만 도착한 상태"는 첫 바이트만
// 보면 구분이 불가능하다 — 둘 다 '\x1b' 하나로 시작한다. 그래서 마커일지도
// 모르는 꼬리 바이트는 즉시 해석하지 않고 짧게 보류했다가, 이 시간 안에
// 후속 바이트가 안 오면 "마커가 아니었다"고 판단해 원래 문자로 처리한다.
// 로컬 pty에서 마커의 나머지 바이트는 사실상 동시에(수 ms 이내) 도착하므로
// 사용자가 체감하는 지연은 없다.
const PASTE_MARKER_TIMEOUT_MS = 50;

// buf의 "끝부분"이 marker의 앞부분과 얼마나 겹치는지 계산한다. 예를 들어
// buf가 '...\x1b[20'로 끝나고 marker가 '\x1b[200~'이면 4를 반환한다.
// (marker 전체 길이와 같은 완전한 일치는 호출부에서 이미 indexOf로 걸러진
// 뒤이므로, 여기서는 marker.length - 1 이하의 부분 일치만 찾는다.)
function partialMarkerOverlap(buf, marker) {
  const maxLen = Math.min(buf.length, marker.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (buf.slice(buf.length - len) === marker.slice(0, len)) return len;
  }
  return 0;
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
      // 이 input() 호출 동안에는 터미널의 기본 설정과 무관하게 브래킷
      // 붙여넣기 모드를 명시적으로 켠다 — 지원하지 않는 터미널에서는 무시되는
      // 무해한 이스케이프 시퀀스이고, 이미 켜져 있는 터미널에서는 멱등이다.
      // 종료 시 반드시 꺼서(모든 반환 경로에서) 다음 input() 호출이나 이후의
      // menu() 등 다른 raw-mode 소비자에 영향을 주지 않게 한다. input()이
      // 연달아 여러 번 호출되는 흔한 패턴(서비스명 → 별칭 → 토큰값)에서도
      // 매 호출마다 켰다 끄는 것이라 문제 없다.
      process.stdout.write('\x1b[?2004h');

      let settled = false;
      let inPaste = false;
      // 마커가 청크 경계에서 잘렸을 가능성이 있는 꼬리 바이트를 다음
      // data 이벤트까지 들고 있기 위한 버퍼.
      let pending = '';
      let markerTimer = null;

      const clearMarkerTimer = () => {
        if (markerTimer) { clearTimeout(markerTimer); markerTimer = null; }
      };

      const cleanupTerminal = () => {
        clearMarkerTimer();
        process.stdin.setRawMode(wasRaw);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\x1b[?2004l');
        showCursor();
      };

      const finish = () => { settled = true; cleanupTerminal(); resolve(value); };
      const cancel = () => { settled = true; cleanupTerminal(); resolve(null); };

      // 페이스트 마커와 무관한 "일반" 텍스트 조각(원래 코드가 청크 전체에
      // 대해 하던 것과 동일한 단일 비교)을 처리한다. pending이 비어 있는
      // 흔한 경우(마커 프리픽스와 우연히 겹치지 않는 보통 타이핑)에는 이
      // text가 원래 청크 전체와 정확히 같으므로, 기존 동작이 한 글자도
      // 다르지 않게 보존된다. 입력을 종료(Enter/ESC)시켰으면 true를 반환해
      // 호출부가 남은 버퍼 처리를 멈추게 한다.
      const processNormalChunk = text => {
        if (text.length === 0) return false;
        if (text === '\r' || text === '\n') {
          finish();
          return true;
        } else if (text === '\x1b') {
          cancel();
          return true;
        } else if (text === '\x7f' || text === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            drawInput();
          }
          return false;
        } else if (text === '\x03') {
          cleanupTerminal();
          process.exit(0);
          return true;
        } else if (text >= ' ') {
          value += text;
          drawInput();
          return false;
        }
        // 그 외(예: 화살표 키 등 다른 이스케이프 시퀀스)는 원래 코드처럼
        // 그냥 무시한다.
        return false;
      };

      // markerTimer가 만료되면 pending은 마커가 아니었던 것으로 판단하고,
      // 원래 문맥(붙여넣기 도중이었는지 여부)에 맞게 있는 그대로 흘려보낸다.
      const flushPendingAsLiteral = () => {
        markerTimer = null;
        if (settled) return;
        const text = pending;
        pending = '';
        if (!text) return;
        if (inPaste) {
          value += text;
          drawInput();
        } else {
          const done = processNormalChunk(text);
          if (!done) drawInput();
        }
      };

      const armMarkerTimer = () => {
        clearMarkerTimer();
        markerTimer = setTimeout(flushPendingAsLiteral, PASTE_MARKER_TIMEOUT_MS);
      };

      const onData = chunk => {
        clearMarkerTimer();
        let buf = pending + chunk.toString();
        pending = '';

        while (buf.length > 0 && !settled) {
          if (inPaste) {
            const idx = buf.indexOf(PASTE_END);
            if (idx !== -1) {
              // 붙여넣기 구간 내부 — 이스케이프/엔터/백스페이스/Ctrl+C로
              // 해석하지 않고 있는 그대로 값에 붙인다.
              value += buf.slice(0, idx);
              buf = buf.slice(idx + PASTE_END.length);
              inPaste = false;
              continue;
            }
            const overlap = partialMarkerOverlap(buf, PASTE_END);
            const safeLen = buf.length - overlap;
            if (safeLen > 0) value += buf.slice(0, safeLen);
            pending = buf.slice(safeLen);
            buf = '';
            if (pending) armMarkerTimer();
            break;
          } else {
            const idx = buf.indexOf(PASTE_START);
            if (idx !== -1) {
              if (idx > 0) {
                const done = processNormalChunk(buf.slice(0, idx));
                if (done) { buf = ''; break; }
              }
              inPaste = true;
              buf = buf.slice(idx + PASTE_START.length);
              continue;
            }
            const overlap = partialMarkerOverlap(buf, PASTE_START);
            const safeLen = buf.length - overlap;
            let done = false;
            if (safeLen > 0) done = processNormalChunk(buf.slice(0, safeLen));
            if (done) { buf = ''; break; }
            pending = buf.slice(safeLen);
            buf = '';
            if (pending) armMarkerTimer();
            break;
          }
        }

        if (!settled) drawInput();
      };
      process.stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', ans => { rl.close(); resolve(ans); });
    }
  });
}

// 공용 스크롤 뷰 구현. scrollableMessage(닫힐 때까지 대기)와
// liveScrollableMessage(열린 상태에서 setLines/setStatus로 내용 갱신)가 공유한다.
function openScrollable(title, initialText) {
  let lines = initialText.split('\n');
  let statusText = null;
  let closed = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  if (!process.stdin.isTTY) {
    closed = true;
    resolveDone();
    return { setLines() {}, setStatus() {}, done };
  }

  let scrollTop = 0;
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  readline.emitKeypressEvents(process.stdin);

  const availRows = () => {
    const rows = process.stdout.rows || 32;
    const vpad = FRAME.vpad;
    // Subtract 2 for top/bottom bar, vpad*2 for padding, 2 for border lines, and 2 for spacing/footer
    // (상태 표시줄이 있으면 그만큼 한 줄 더 뺀다)
    return Math.max(1, rows - 2 - (vpad * 2) - 4 - (statusText ? 1 : 0));
  };

  const draw = () => {
    const cols = process.stdout.columns || 120;
    const hpad = FRAME.hpad;
    const innerContentWidth = cols - (hpad * 2);
    const availableRows = availRows();

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
    // 콘텐츠 박스/스크롤 힌트와 구분되는 별도 상태 영역(예: 백그라운드 새로고침 진행 표시).
    if (statusText) {
      displayLines.push(C.muted2 + '  ' + statusText + C.RESET);
    }

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

    const availableRows = availRows();
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
      resolveDone();
    }
  };

  const cleanup = () => {
    closed = true;
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('keypress', onKey);
    process.stdin.setRawMode(wasRaw);
    showCursor();
  };

  hideCursor();
  process.stdin.on('keypress', onKey);
  draw();

  return {
    setLines(text) {
      if (closed) return;
      lines = text.split('\n');
      scrollTop = Math.min(scrollTop, Math.max(0, lines.length - availRows()));
      draw();
    },
    setStatus(text) {
      if (closed) return;
      statusText = text || null;
      scrollTop = Math.min(scrollTop, Math.max(0, lines.length - availRows()));
      draw();
    },
    done,
  };
}

async function scrollableMessage(title, text) {
  return openScrollable(title, text).done;
}

// ── 개인비서 채팅 뷰 ──────────────────────────────────────

function wrapCols(str, width) {
  const w = Math.max(1, width);
  const lines = [];
  for (const raw of String(str).replace(ANSI_RE, '').split('\n')) {
    if (raw === '') { lines.push(''); continue; }
    let cur = '';
    let used = 0;
    for (const ch of raw) {
      const cw = colWidth(ch);
      if (used + cw > w && cur) { lines.push(cur); cur = ''; used = 0; }
      cur += ch;
      used += cw;
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

const AVATAR_MOODS = {
  idle:     { mk: 'def', eL: 'def', eR: 'def', mo: 'flat' },
  thinking: { mk: 'def', eL: 'def', eR: '.', mo: 'dots' },
  happy:    { mk: 'def', eL: '^', eR: '^', mo: 'smile' },
  error:    { mk: 'err', eL: 'x', eR: 'x', mo: 'jag' },
  confused: { mk: 'q', eL: 'def', eR: '?', mo: 'squig' },
  focused:  { mk: 'def', eL: '-', eR: '-', mo: 'line' },
  sleepy:   { mk: 'z', eL: '_', eR: '_', mo: 'yawn' },
  alert:    { mk: 'star', eL: 'O', eR: 'O', mo: 'open' },
};

const AVATAR_CHARS = {
  claude: {
    defEye: 'o',
    markers: { def: '.^.', err: '!!!', q: '?', z: 'z', star: '*' },
    mouths: { flat: ' ~ ', dots: '...', smile: '\\_/', jag: '/\\/', squig: '._~', line: '___', yawn: ' o ', open: ' o ' },
    build: (mk, eL, eR, m) => [mk, '/   \\', '( ' + eL + ' ' + eR + ' )', '( ' + m + ' )', '\\___/', '_/ \\_', '/     \\', '/_______\\'],
  },
  codex: {
    defEye: 'o',
    markers: { def: '[===]', err: '[!!!]', q: '[?]', z: '[z]', star: '[*]' },
    mouths: { flat: '[_]', dots: '...', smile: '\\_/', jag: '/\\/', squig: '._~', line: '___', yawn: ' o ', open: ' o ' },
    build: (mk, eL, eR, m) => [mk, '/-----\\', '|[' + eL + '][' + eR + ']|', '| ' + m + ' |', '\\-----/', '|___|', '/     \\', '[_______]'],
  },
  agy: {
    defEye: '*',
    markers: { def: '*', err: '!!!', q: '?', z: 'z', star: '*' },
    mouths: { flat: '  ~  ', dots: ' ... ', smile: ' \\_/ ', jag: ' /\\/ ', squig: ' ._~ ', line: ' ___ ', yawn: '  o  ', open: '  o  ' },
    build: (mk, eL, eR, m) => [mk, '.`````.', '( ' + eL + '   ' + eR + ' )', '( ' + m + ' )', '`.___.`', ':   :', '/     \\', '<_______>'],
  },
};

function centerAvatarLine(shape) {
  const pad = Math.max(0, 6 - Math.floor((shape.length - 1) / 2));
  return ' '.repeat(pad) + shape;
}

function getAvatarFrame(character, mood) {
  const c = AVATAR_CHARS[String(character || '').toLowerCase()] || AVATAR_CHARS.claude;
  const m = AVATAR_MOODS[mood] || AVATAR_MOODS.idle;
  const eL = m.eL === 'def' ? c.defEye : m.eL;
  const eR = m.eR === 'def' ? c.defEye : m.eR;
  const mk = c.markers[m.mk] || c.markers.def;
  const mouth = c.mouths[m.mo] || c.mouths.flat;
  return c.build(mk, eL, eR, mouth).map(centerAvatarLine);
}

// 좌측 대화 + 입력줄, 우측 아바타/상태 패널의 분할 채팅 화면.
// liveScrollableMessage 처럼 열린 채로 갱신 가능한 핸들을 반환한다:
// { appendDelta, finalizeTurn, appendSystem, setState, done }.
// 세션 자체는 호출자(launcher)가 소유하고, 이 뷰는 렌더링/입력만 담당한다.
function assistantChatView(model) {
  const entries = [];
  let inputValue = '';
  let state = 'idle';
  let mood = 'idle';
  let scrollBack = 0;
  let streamingEntry = null;
  let closed = false;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  let tokenService = model.tokenService || null;
  let tokenAlias = model.tokenAlias || null;
  let sessionMeta = null;
  let turnUsage = null;

  if (!process.stdin.isTTY) {
    closed = true;
    resolveDone();
    return { appendDelta() {}, finalizeTurn() {}, appendSystem() {}, setState() {}, setMood() {}, setSessionMeta() {}, setTurnUsage() {}, done };
  }

  const buildChatLines = (width) => {
    const flat = [];
    entries.forEach((e, i) => {
      if (i > 0) flat.push('');
      let label, lc;
      if (e.who === 'user') { label = 'You'; lc = C.info; }
      else if (e.who === 'assistant') { label = model.name; lc = C.signal; }
      else { label = '!'; lc = C.warn; }
      const labelW = colWidth(label) + 2;
      const prefix = lc + label + ': ' + C.RESET;
      const indent = ' '.repeat(Math.min(Math.max(0, width - 1), labelW));
      const bodyText = e.text || (e.who === 'assistant' && !e.done ? '…' : '');
      const body = wrapCols(bodyText, Math.max(1, width - labelW));
      if (body.length === 0) body.push('');
      flat.push(prefix + body[0]);
      for (let j = 1; j < body.length; j++) flat.push(indent + body[j]);
    });
    return flat;
  };

  const draw = () => {
    if (closed) return;
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 32;
    const hpad = FRAME.hpad;
    const vpad = FRAME.vpad;
    const innerContentWidth = Math.max(20, cols - (hpad * 2));
    const compact = cols < 88 || rows < 24;
    const boxHeight = Math.max(8, rows - 2 - (vpad * 2) - 2);

    const gap = 3;
    const avatarWidth = 28;
    const chatWidth = compact
      ? innerContentWidth
      : Math.max(30, innerContentWidth - avatarWidth - gap);
    const chatInner = chatWidth - 2;
    const chatRows = Math.max(1, boxHeight - 4);

    const flat = buildChatLines(chatInner);
    const maxScroll = Math.max(0, flat.length - chatRows);
    if (scrollBack > maxScroll) scrollBack = maxScroll;
    const end = flat.length - scrollBack;
    const visible = flat.slice(Math.max(0, end - chatRows), end);
    while (visible.length < chatRows) visible.unshift('');

    const promptLine = state === 'thinking'
      ? C.muted2 + '… 응답 대기 중' + C.RESET
      : C.signal + '> ' + C.RESET + C.text + inputValue + C.RESET + '█';

    const stateText = state === 'thinking' ? 'thinking...' : 'idle';
    const title = compact
      ? `${model.name} · ${model.toolCommand || ''} · ${stateText}`
      : `대화 — ${model.name}`;
    const chatBox = makeBox(chatInner, [
      ...visible,
      C.muted + repeatChar('─', chatInner) + C.RESET,
      promptLine,
    ], { title, height: boxHeight });

    let lines;
    if (compact) {
      lines = chatBox;
    } else {
      const avatarInner = avatarWidth - 2;
      const stateLine = state === 'thinking'
        ? C.warn + '● thinking...' + C.RESET
        : C.ok + '● idle' + C.RESET;
      const modelLabel = sessionMeta && sessionMeta.model ? sessionMeta.model : (model.model || 'default');
      const effortLabel = model.effort || 'default';
      const avatarBody = [
        '',
        ...getAvatarFrame(model.toolCommand, mood).map(l => C.signal + l + C.RESET),
        '',
        ' ' + C.text + truncateCols(model.name || '', avatarInner - 2) + C.RESET,
        ' ' + C.muted2 + truncateCols(model.toolCommand || '', avatarInner - 2) + C.RESET,
        '',
        ' ' + stateLine,
        '',
        ' ' + C.muted2 + 'Token: ' + C.RESET + (tokenService
          ? C.text + truncateCols(`${tokenService}/${tokenAlias}`, avatarInner - 9) + C.RESET
          : C.warn + '연결 안 됨' + C.RESET),
        ' ' + C.muted2 + 'Model: ' + C.RESET + C.text + truncateCols(modelLabel, avatarInner - 9) + C.RESET,
        ' ' + C.muted2 + 'Effort: ' + C.RESET + C.text + truncateCols(effortLabel, avatarInner - 10) + C.RESET,
        ...(turnUsage ? [
          ' ' + C.muted2 + 'Tokens: ' + C.RESET + C.text +
          truncateCols(`in ${turnUsage.inputTokens}/out ${turnUsage.outputTokens} · $${Number(turnUsage.totalCostUsd || 0).toFixed(4)}`, avatarInner - 9) +
          C.RESET,
        ] : []),
      ];
      const avatarBox = makeBox(avatarInner, avatarBody, { title: 'Agent', height: boxHeight });
      lines = [];
      for (let i = 0; i < boxHeight; i++) {
        lines.push((chatBox[i] || ' '.repeat(chatWidth)) + ' '.repeat(gap) + (avatarBox[i] || ''));
      }
    }

    lines.push('');
    const scrollHint = scrollBack > 0 ? `  (스크롤: -${scrollBack})` : '';
    lines.push(C.muted2 + '  ↑↓ 스크롤  Enter 전송  Ctrl+\\ 토큰 변경  ESC 뒤로  /model /effort /mcp 사용 가능' + scrollHint + C.RESET);
    renderFramedScreen('개인비서', lines, { noTopPanels: true });
  };

  const wasRaw = process.stdin.isRaw;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  hideCursor();

  const onResize = () => { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; draw(); };

  const cleanup = () => {
    closed = true;
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('keypress', onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    showCursor();
  };

  let pickingToken = false;
  const openTokenPicker = async () => {
    if (pickingToken || closed) return;
    pickingToken = true;
    process.stdin.removeListener('keypress', onKey);
    process.stdout.removeListener('resize', onResize);
    try {
      const { pickRegisteredToken } = require('./tokens');
      const picked = await pickRegisteredToken(C);
      if (picked) {
        tokenService = picked.service;
        tokenAlias = picked.alias;
        if (typeof model.onTokenChange === 'function') {
          try { await model.onTokenChange(picked); } catch {}
        }
      }
    } finally {
      pickingToken = false;
      if (!closed) {
        process.stdin.setRawMode(true);
        hideCursor();
        process.stdin.on('keypress', onKey);
        process.stdout.on('resize', onResize);
        draw();
      }
    }
  };

  const onKey = (str, key) => {
    if (key && key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
    if (key && key.name === 'escape') { cleanup(); resolveDone(); return; }
    // Ctrl+\ (0x1c) rather than key.ctrl/key.name — readline's keypress parser
    // doesn't reliably name this control byte, same reasoning as xtermFrame.js's
    // control-panel shortcut.
    if (str === '\x1c') { openTokenPicker(); return; }
    if (key && key.name === 'up') { scrollBack++; draw(); return; }
    if (key && key.name === 'down') { if (scrollBack > 0) scrollBack--; draw(); return; }
    if (key && key.name === 'return') {
      const text = inputValue.trim();
      if (!text || state === 'thinking') return;
      inputValue = '';
      entries.push({ who: 'user', text });
      scrollBack = 0;
      draw();
      try { if (model.onSubmit) model.onSubmit(text); } catch {}
      draw();
      return;
    }
    if (key && key.name === 'backspace') {
      if (inputValue.length > 0) { inputValue = inputValue.slice(0, -1); draw(); }
      return;
    }
    if (typeof str === 'string' && str >= ' ' && !(key && (key.ctrl || key.meta))) {
      inputValue += str;
      draw();
    }
  };

  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', onResize);
  draw();

  return {
    appendDelta(text) {
      if (closed || !text) return;
      if (!streamingEntry || streamingEntry.done) {
        streamingEntry = { who: 'assistant', text: '', done: false };
        entries.push(streamingEntry);
      }
      streamingEntry.text += String(text);
      draw();
    },
    finalizeTurn(finalText) {
      if (closed) return;
      if (streamingEntry && !streamingEntry.done) {
        // done 이벤트의 최종 텍스트가 있으면 델타 누적본 대신 그것을 신뢰한다.
        if (typeof finalText === 'string' && finalText.trim()) streamingEntry.text = finalText;
        streamingEntry.done = true;
      } else if (typeof finalText === 'string' && finalText.trim()) {
        entries.push({ who: 'assistant', text: finalText, done: true });
      }
      streamingEntry = null;
      mood = 'happy';
      draw();
    },
    appendSystem(text) {
      if (closed) return;
      entries.push({ who: 'system', text: String(text) });
      draw();
    },
    setState(next) {
      if (closed) return;
      state = next === 'thinking' ? 'thinking' : 'idle';
      if (next === 'thinking') mood = 'thinking';
      else if (mood === 'thinking') mood = 'idle';
      draw();
    },
    setMood(next) {
      if (closed) return;
      mood = next;
      draw();
    },
    setSessionMeta(meta) {
      if (closed) return;
      sessionMeta = meta;
      draw();
    },
    setTurnUsage(usage) {
      if (closed) return;
      turnUsage = usage;
      draw();
    },
    done,
  };
}

// 열린 채로 내용을 갱신할 수 있는 스크롤 뷰. { setLines, setStatus, done } 핸들 반환.
function liveScrollableMessage(title, initialText) {
  return openScrollable(title, initialText);
}

module.exports = { setColors, getPalette, setFrameConfig, menu, homeMenu, message, scrollableMessage, liveScrollableMessage, flashMessage, assistantChatView, input, clear, out, W, IW, colWidth, renderHeader, enterAltScreen, exitAltScreen, showCursor };
