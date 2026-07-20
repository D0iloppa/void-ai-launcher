'use strict';
const readline = require('readline');
const { scrambleText, shimmerText, luminance, glitchText } = require('./animation');
const { contrastRatio } = require('./theme');
const pet = require('./pet');
// 개인비서 채팅 컴포저(assistantChatView) 전용 — 순수 텍스트/커서 모델과
// 프로필별 제출 히스토리 링(dJinn). 둘 다 이 파일의 raw-mode 렌더링/키 처리와
// 분리된 별도 모듈이라 여기선 그냥 얇게 가져다 쓴다(상세 설계는 각 파일 헤더 참고).
const composerModel = require('./composerModel');
const assistantHistoryDb = require('./assistantHistoryDb');
// 설정 패널(Ctrl+\)의 model/effort 옵션 목록 — lib/assistant.js가 소유(그쪽
// module.exports 주석 참고), 그리고 패널의 순수 로직(옵션 인덱스 초기화/순환,
// 재시작 필요 여부, thinking 필터)은 assistantSettingsPanel.js에 둔다.
const { ASSISTANT_MODEL_OPTIONS, ASSISTANT_EFFORT_OPTIONS } = require('./assistant');
const settingsPanel = require('./assistantSettingsPanel');
const assistantCommands = require('./assistantCommands');
// Korean IME emits Hangul Compatibility Jamo (U+3130-U+318F) for physical
// letter keys instead of ASCII — see lib/hangulKeymap.js header. Applied only
// at bare-letter hotkey compares below, never to free-text input.
const { hangulToQwerty } = require('./hangulKeymap');

let C = {};
const W  = 52;
const IW = W - 2;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Split-preserving / token-matching variants of ANSI_RE — used by truncateCols
// and the takeCols/dropCols overlay helpers below to walk a string while
// keeping embedded SGR codes intact (rather than stripping them like ANSI_RE
// does for width measurement).
const ANSI_SPLIT_RE = /(\x1b\[[0-9;]*m)/g;
const ANSI_TOKEN_RE = /^\x1b\[[0-9;]*m$/;
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
  // Array.from (not a plain char-index loop) so surrogate-pair codepoints
  // (emoji outside the BMP) are visited once each, matching the for..of
  // iteration this function used before — needed below because ZWJ handling
  // has to look ahead to the *next* codepoint, which a for..of loop body
  // can't do on its own.
  const chars = Array.from(str.replace(ANSI_RE, ''));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue; // variation selectors: zero-width
    if (cp === 0x200D) {
      // ZERO WIDTH JOINER: glues surrounding emoji into a single rendered
      // glyph cluster (e.g. 👨‍👩‍👧‍👦 family, 🏳️‍🌈 flag). The joiner itself
      // is zero-width, and terminals draw the whole joined run as ONE
      // double-width cell — not width-per-codepoint. So the joiner AND the
      // codepoint immediately after it (already fused onto the previous
      // glyph, whose width was counted on the prior iteration) both add 0.
      if (i + 1 < chars.length) i++;
      continue;
    }
    if (
      (cp >= 0x0300 && cp <= 0x036F) || // Combining Diacritical Marks
      (cp >= 0x1AB0 && cp <= 0x1AFF) || // Combining Diacritical Marks Extended
      (cp >= 0x1DC0 && cp <= 0x1DFF) || // Combining Diacritical Marks Supplement
      (cp >= 0x20D0 && cp <= 0x20FF) || // Combining Diacritical Marks for Symbols
      (cp >= 0xFE20 && cp <= 0xFE2F)    // Combining Half Marks
    ) {
      // Combining marks stack onto the previous base character instead of
      // advancing the cursor — zero-width, same treatment as variation
      // selectors above. Unconstrained chat/user text (e.g. pasted diacritic
      // combos) is the realistic source of these, not our own UI strings.
      continue;
    }
    if (cp === 0x09) {
      // TAB: give it one explicit, documented width rather than letting it
      // silently fall through to the generic "else" branch below. This is
      // NOT terminal tab-stop expansion (that would desync colWidth's count
      // from what padCols/truncateCols actually emit) — just a single
      // deterministic column so box math never disagrees with itself if a
      // raw tab slips into chat/user text.
      w += 1;
    } else if (
      (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul syllables
      (cp >= 0x1100 && cp <= 0x11FF) || // Hangul Jamo
      (cp >= 0x3130 && cp <= 0x318F) || // Hangul Compatibility Jamo (standalone ㄱ/ㅏ/ㅇ — East Asian Wide; missing here caused single-jamo input to shift)
      (cp >= 0xA960 && cp <= 0xA97F) || // Hangul Jamo Extended-A
      (cp >= 0xD7B0 && cp <= 0xD7FF) || // Hangul Jamo Extended-B
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
      (cp >= 0x3000 && cp <= 0x303F) || // CJK Symbols and Punctuation (、。「」…)
      (cp >= 0x3040 && cp <= 0x30FF) || // Hiragana / Katakana
      (cp >= 0xFF01 && cp <= 0xFF60)    // Fullwidth Forms (verified against
                                        // Unicode East Asian Width "Wide": this
                                        // range is correct as-is — Halfwidth
                                        // Forms, FF61+, are Narrow/width 1 and
                                        // correctly fall through to the plain
                                        // "else" branch below already)
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
  // Walk str.split(ANSI_SPLIT_RE) — text run, SGR code, text run, … — instead
  // of iterating the ANSI-stripped `plain` copy the old implementation built.
  // The old version discarded every embedded color/RESET code once it decided
  // to truncate, so a color set mid-string (before the cut point) never made
  // it into the output — the very next thing drawn after this string (e.g.
  // another box's border) would inherit whatever color was left active on the
  // real terminal, reading as color "bleeding" across a box boundary. Keeping
  // the codes verbatim, plus always appending C.RESET at the end, means the
  // cut can never leak color past itself.
  for (const tok of str.split(ANSI_SPLIT_RE)) {
    if (tok === '') continue;
    if (ANSI_TOKEN_RE.test(tok)) { out += tok; continue; }
    for (const ch of tok) {
      const next = colWidth(ch);
      if (used + next >= width) return out + '…' + C.RESET;
      out += ch;
      used += next;
    }
  }
  return out + '…' + C.RESET;
}

// Column-exact substring helpers backing the chat view's control-panel
// overlay (assistantChatView, below): splice a centered bordered popup into
// rows that are already fully composed (chat + avatar text), by cutting each
// affected row into left/box/right column windows and concatenating them.
// Unlike truncateCols these never append an ellipsis — the cut point is a
// structural window boundary (where the popup box starts/ends), not "this
// text was too long to fit" — but both still preserve embedded ANSI codes for
// the same bleed-prevention reason as the truncateCols fix above.
function takeCols(str, width) {
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  for (const tok of str.split(ANSI_SPLIT_RE)) {
    if (tok === '') continue;
    if (ANSI_TOKEN_RE.test(tok)) { out += tok; continue; }
    for (const ch of tok) {
      const w = colWidth(ch);
      if (used + w > width) return padCols(out, width) + C.RESET;
      out += ch;
      used += w;
    }
  }
  return padCols(out, width) + C.RESET;
}

function dropCols(str, width) {
  if (width <= 0) return str;
  let out = '';
  let used = 0;
  let skipping = true;
  let lastAnsi = ''; // most recent SGR code seen while skipping — reapplied
                      // right after the cut so color state that was active
                      // there continues into the kept tail instead of
                      // silently resetting to default.
  for (const tok of str.split(ANSI_SPLIT_RE)) {
    if (tok === '') continue;
    if (ANSI_TOKEN_RE.test(tok)) {
      if (skipping) lastAnsi = tok; else out += tok;
      continue;
    }
    for (const ch of tok) {
      const w = colWidth(ch);
      if (skipping) {
        used += w;
        if (used >= width) { skipping = false; out += lastAnsi; }
        continue;
      }
      out += ch;
    }
  }
  return out;
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

// makeBox() 는 부족한 줄은 채우지만(padding) 넘치는 줄은 절대 자르지 않는다 —
// bodyLines 가 opts.height 보다 길면 그만큼 lines.length 도 늘어난다. 이 함수를
// 부른 쪽(assistantChatView 의 아바타 박스처럼, 폭이 아니라 "몇 줄짜리 배열을
// 다른 배열과 같은 줄 수로 옆에 붙이는" 조립부)이 그 결과를 maxRows 개로 단순
// slice(0, maxRows) 해버리면, 넘친 만큼 뒤쪽(맨 마지막 줄 = 하단 테두리)이
// 통째로 잘려나가 박스가 "안 닫힌" 것처럼 보인다. 항상 첫 줄(상단 테두리)과
// 마지막 줄(하단 테두리)은 보존하고, 중간 콘텐츠 줄만 잘라서 정확히 maxRows
// 줄에 맞춘다 — 세로 공간이 부족하면 데이터가 가려지는 건 괜찮지만 테두리가
// 사라지는 건 안 된다는 요구사항.
function clampBoxKeepingBorders(lines, maxRows) {
  if (maxRows <= 0) return [];
  if (lines.length <= maxRows) return lines;
  if (maxRows === 1) return [lines[0]];
  const top = lines[0];
  const bottom = lines[lines.length - 1];
  const middleBudget = Math.max(0, maxRows - 2);
  const middle = lines.slice(1, lines.length - 1).slice(0, middleBudget);
  return [top, ...middle, bottom];
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
      const qwertyStr = hangulToQwerty(str) || str;
      if ((qwertyStr === 'd' || qwertyStr === 'D') && opts.enableDelete) {
        const item = items[sel];
        if (item && !item.disabled && item.key !== 'd' && item.key !== 'n') {
          cleanup();
          resolve({ ...item, action: 'delete' });
          return;
        }
      }
      if (str === '0' || key.name === 'escape') { done(null); return; }
      if (!str) return;

      const lstr   = qwertyStr.toLowerCase();
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

      const lstr = (hangulToQwerty(str) || str).toLowerCase();
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
      const lans = (hangulToQwerty(ans) || ans).toLowerCase();
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
  // ANSI-preserving: renderInlineMarkdown() (below) emits SGR codes (bold/
  // dim+color for `**bold**`/`` `code` ``) into chat body text BEFORE this
  // runs, so a styled span can straddle a wrap point. Walk each raw line via
  // ANSI_SPLIT_RE (same technique truncateCols/takeCols/dropCols already use)
  // instead of stripping ANSI up front: text runs count toward the visible
  // width, SGR tokens don't and are tracked in `openCodes` so that if a wrap
  // happens while a style is still open, the finished line gets a trailing
  // C.RESET (no bleed into whatever renders after it, e.g. the avatar panel)
  // and the continuation line re-opens the same codes (no vanishing style).
  // When str carries no ANSI at all this reduces to the exact same
  // char-by-char wrapping as before.
  for (const raw of String(str).split('\n')) {
    if (raw === '') { lines.push(''); continue; }
    let cur = '';
    let used = 0;
    let openCodes = [];
    for (const tok of raw.split(ANSI_SPLIT_RE)) {
      if (tok === '') continue;
      if (ANSI_TOKEN_RE.test(tok)) {
        cur += tok;
        if (tok === C.RESET) openCodes = [];
        else openCodes.push(tok);
        continue;
      }
      for (const ch of tok) {
        const cw = colWidth(ch);
        if (used > 0 && used + cw > w) {
          lines.push(cur + (openCodes.length ? C.RESET : ''));
          cur = openCodes.join('');
          used = 0;
        }
        cur += ch;
        used += cw;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

// ── Lightweight inline markdown for assistant/user chat bubbles ──────────
// Deliberately NOT a full markdown engine (nested lists, tables, links,
// blockquotes, fenced code blocks are all explicitly out of scope) — just
// enough that `**bold**` and `` `code` `` render styled instead of leaking
// literal asterisks/backticks into the transcript, plus a trivial leading
// #/##/### header and -/* bullet.
//
// Streaming safety: entries accumulate raw markdown across deltas and
// buildChatLines() re-runs this on every draw(), including mid-stream. Both
// regexes below only match a COMPLETE, balanced marker pair — a `**` or `` ` ``
// that has opened but not yet closed (the exact state right after a delta
// lands mid-span) simply fails to match and is left as literal text for that
// frame. Once the closing marker arrives in a later delta the whole span
// matches and renders styled retroactively. So there is never an unterminated
// SGR code emitted mid-stream that could bleed bold/color into later text —
// every code this function emits is always paired with a C.RESET in the same
// call. (Single `*italic*` is deliberately NOT handled: disambiguating it from
// `**bold**` without misparsing "**bold** *and* *italic*" needs real
// tokenization, not a regex pass — skipped rather than risk breaking bold.)
function renderInlineSpans(str) {
  // Code spans first, so a `**` that happens to sit inside `` `like **this` ``
  // isn't also touched by the bold pass below.
  let out = str.replace(/`([^`\n]+)`/g, (m, code) => C.DIM + C.info + code + C.RESET);
  out = out.replace(/\*\*([^\n]+?)\*\*/g, (m, inner) => C.BOLD + inner + C.RESET);
  return out;
}

function renderInlineMarkdown(text) {
  if (!text) return text;
  return String(text).split('\n').map(line => {
    const header = /^#{1,3}\s+(.+)$/.exec(line);
    if (header) {
      // Bold the whole line, but deliberately WITHOUT recursing through
      // renderInlineSpans first: a nested "**word**" inside a header would
      // emit its own C.RESET, which on a real terminal clears ALL active SGR
      // state (not just the inner span) — so the header's outer bold would
      // die partway through the line. Headers are rare enough in chat
      // replies that giving up nested spans inside them is the trivial/
      // low-risk call here.
      return C.BOLD + header[1] + C.RESET;
    }
    const bullet = /^([*-]) (.*)$/.exec(line);
    if (bullet) return '• ' + renderInlineSpans(bullet[2]);
    return renderInlineSpans(line);
  }).join('\n');
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

// value/max 비율을 채움(█)/빈칸(░) 막대로 그린다 — lib/pet 의 vitals(0~100)를
// 표시하는 용도. 색은 여기서 입히지 않는다(호출자가 좋음/부족 색을 고른다).
function makeGaugeBar(value, max, width) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return repeatChar('█', filled) + repeatChar('░', Math.max(0, width - filled));
}

const PET_VITALS_LABELS = { satiety: '만족', energy: '활력', mood: '기분', bond: '유대' };
const PET_VITALS_ORDER = ['satiety', 'energy', 'mood', 'bond'];
const PET_VITALS_LABEL_WIDTH = 4; // 만족/활력/기분/유대 전부 2-CJK-글자(colWidth 4) — padCols로 고정폭 보장
const PET_VITALS_BAR_WIDTH = 10;

// vitals(4종) 을 "라벨 [████░░░░░░]  72%" 형태의 줄 4개로, 한 줄에 라벨·바·퍼센트가
// 나란히 정렬되도록 그린다. 라벨은 padCols(CJK 폭 인식)로 고정폭 — 4글자 라벨이
// 섞여도 바 시작 위치가 항상 같은 칸에 오도록. 바는 대괄호로 감싸 경계를 눈에
// 띄게 하고, 퍼센트는 3자리 폭으로 우측 정렬. 30 미만이면 경고색(C.warn), 그 외엔
// 정상색(C.ok). makeBox 가 truncate/pad 하지만 이 줄은 이미 avatarInner(26) 안에
// 넉넉히 들어가는 고정 폭이라 잘릴 일이 없다.
function buildPetVitalsLines(vitals) {
  if (!vitals) return [];
  return PET_VITALS_ORDER.map(key => {
    const val = Math.round(Math.max(0, Math.min(100, vitals[key] || 0)));
    const barColor = val < 30 ? C.warn : C.ok;
    const label = padCols(PET_VITALS_LABELS[key], PET_VITALS_LABEL_WIDTH);
    const bar = makeGaugeBar(val, 100, PET_VITALS_BAR_WIDTH);
    const pct = String(val).padStart(3, ' ') + '%';
    return ' ' + C.muted2 + label + C.RESET + ' ' +
      C.muted2 + '[' + C.RESET + barColor + bar + C.RESET + C.muted2 + ']' + C.RESET +
      '  ' + C.text + pct + C.RESET;
  });
}

// Ctrl+\ 로 토글되는 컨트롤 패널(이제 "설정" 패널)의 각 행 렌더러 — menu()의
// combo-row/selected-row 스타일(lib/ui.js 의 buildMenuLines, 이 파일 위쪽)을
// 그대로 흉내낸다: 포커스된 행은 배경색을 innerWidth 끝까지 칠하기 위해
// padCols가 아니라 padding 을 RESET *이전에* 붙인다(menu()의 trailPad 와 동일
// 이유 — RESET 뒤에 붙은 공백은 배경색이 적용되지 않는다).
const PANEL_LABEL_COL = 12;
function panelComboRow(label, valueText, focused, innerWidth) {
  const labelVis = ' ' + label;
  const labelPad = ' '.repeat(Math.max(0, PANEL_LABEL_COL - colWidth(labelVis)));
  const valueVis = '‹ ' + valueText + ' ›';
  if (focused) {
    const trailPad = ' '.repeat(Math.max(0, innerWidth - colWidth(labelVis + labelPad + valueVis)));
    return C.signalBg + C.onSignal + C.BOLD + labelVis + labelPad + valueVis + trailPad + C.RESET;
  }
  return C.muted2 + labelVis + C.RESET + labelPad +
    C.muted2 + '‹ ' + C.RESET + C.text + valueText + C.RESET + C.muted2 + ' ›' + C.RESET;
}
function panelCheckboxRow(label, checked, focused, innerWidth) {
  const labelVis = ' ' + label;
  const labelPad = ' '.repeat(Math.max(0, PANEL_LABEL_COL - colWidth(labelVis)));
  const valueVis = checked ? '[x]' : '[ ]';
  if (focused) {
    const trailPad = ' '.repeat(Math.max(0, innerWidth - colWidth(labelVis + labelPad + valueVis)));
    return C.signalBg + C.onSignal + C.BOLD + labelVis + labelPad + valueVis + trailPad + C.RESET;
  }
  return C.muted2 + labelVis + C.RESET + labelPad + C.text + valueVis + C.RESET;
}

// '/'-자동완성 팝업 후보 한 줄 — 설정 패널의 포커스 행(panelComboRow 위)과
// 같은 강조 스타일(C.signalBg+C.onSignal+C.BOLD, 박스 폭 끝까지 배경색을
// 채움)을 재사용한다. width 는 채팅 박스 innerWidth(chatInner) 와 같은 값을
// draw() 가 넘겨준다.
function popupCommandRow(cmd, selected, width) {
  const plain = truncateCols(' ' + cmd.name + '  ' + cmd.desc, Math.max(1, width));
  if (selected) {
    const trailPad = ' '.repeat(Math.max(0, width - colWidth(plain)));
    return C.signalBg + C.onSignal + C.BOLD + plain + trailPad + C.RESET;
  }
  return C.signal + ' ' + cmd.name + C.RESET + C.muted2 + '  ' + cmd.desc + C.RESET;
}

// Ctrl+\ 설정 패널의 본문(makeBox 로 감싸질 body lines) — Model/Effort(콤보,
// ←→로 순환)와 Reasoning(체크박스, Space/Enter로 토글) 3행 + 푸터 힌트.
// 펫/다마고치 콘텐츠는 의도적으로 없다 — 아바타는 우측 사이드바에 이미 있고,
// 이 패널은 순수 설정 전용이다(사용자 결정). innerWidth 는 overlayCenteredBox
// 가 계산하는 boxW-2 와 같은 값을 draw() 호출부에서 미리 계산해 넘긴다(포커스
// 행 배경색을 박스 폭 끝까지 정확히 칠하기 위해 필요).
function buildAssistantSettingsPanelBody(focus, modelIdx, effortIdx, showThinking, innerWidth) {
  const modelVal = ASSISTANT_MODEL_OPTIONS[modelIdx] || 'default';
  const effortVal = ASSISTANT_EFFORT_OPTIONS[effortIdx] || 'default';
  return [
    '',
    panelComboRow('Model:', modelVal, focus === 0, innerWidth),
    panelComboRow('Effort:', effortVal, focus === 1, innerWidth),
    panelCheckboxRow('Reasoning:', showThinking, focus === 2, innerWidth),
    '',
    C.muted2 + '↑↓ 이동  ←→ 변경  Space 토글  K 토큰변경  L 이전대화  Esc 닫기' + C.RESET,
  ];
}

// 컨트롤 패널을 화면 중앙에 뜨는 모달 오버레이로 그린다 — xtermFrame.js 의
// 컨트롤 패널(subViewData 를 topM/leftM 기준 중앙 정렬 박스로 얹는 방식, 전체
// 콘텐츠를 다 그린 "뒤에" 덧그림)과 같은 기법을 그대로 따라가되, 저쪽은 raw
// terminal 셀에 직접 커서를 이동해 쓰는 반면 이 화면은 문자열 배열(lines)을
// 조립해 renderFramedScreen 에 넘기는 구조라 "덧그림"이 아니라 "이미 조립된
// 각 행을 좌/박스/우 세 구간으로 잘라 이어붙이는" 방식으로 구현한다. lines 를
// in-place 로 수정하며, 다음 draw() 가 항상 lines 를 처음부터 다시 조립하므로
// (=== full repaint) 별도 정리 없이도 패널이 닫히면 자동으로 사라진다.
function overlayCenteredBox(lines, totalWidth, title, bodyLines) {
  const contentRows = lines.length;
  // xtermFrame.js:511-513 과 동일한 clamp 스타일: 콘텐츠 영역보다 커지지
  // 않도록, 그리고 body 줄 수보다 불필요하게 커지지 않도록 둘 다 죈다.
  const boxW = Math.min(totalWidth - 4, 30);
  const boxH = Math.min(contentRows - 2, bodyLines.length + 2);
  if (boxW < 10 || boxH < 3) return; // terminal too small — skip, don't throw/garble
  const boxTop = Math.max(0, Math.floor((contentRows - boxH) / 2));
  const boxLeft = Math.max(0, Math.floor((totalWidth - boxW) / 2));
  const box = makeBox(boxW - 2, bodyLines, { title, height: boxH });
  for (let i = 0; i < box.length; i++) {
    const rowIdx = boxTop + i;
    if (rowIdx < 0 || rowIdx >= lines.length) continue;
    const row = lines[rowIdx] || '';
    lines[rowIdx] = takeCols(row, boxLeft) + box[i] + dropCols(row, boxLeft + boxW);
  }
}

// 좌측 대화 + 입력줄, 우측 아바타/상태 패널의 분할 채팅 화면.
// liveScrollableMessage 처럼 열린 채로 갱신 가능한 핸들을 반환한다:
// { appendDelta, finalizeTurn, appendSystem, setState, done }.
// 세션 자체는 호출자(launcher)가 소유하고, 이 뷰는 렌더링/입력만 담당한다.
// tool_use / tool_result / thinking blocks are rendered as compact one-line
// fold cards, not full chat bubbles. These helpers flatten a block down to a
// single sanitized, length-capped summary string (newlines collapsed so a
// multi-line arg/result can never break the one-line card layout).
function summarizeToolUse(name, input) {
  let inner = '';
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const parts = [];
    for (const [k, v] of Object.entries(input)) {
      let sv = typeof v === 'string' ? v : JSON.stringify(v);
      sv = String(sv == null ? '' : sv).replace(/\s+/g, ' ').trim();
      if (sv.length > 60) sv = sv.slice(0, 60) + '…';
      parts.push(k + ': ' + sv);
      if (parts.length >= 2) break;
    }
    inner = parts.join(', ');
  }
  return (name || 'tool') + '(' + inner + ')';
}

function summarizeToolResult(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    s = content.map(b => (b && typeof b.text === 'string') ? b.text : '').join(' ');
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length > 60) s = s.slice(0, 60) + '…';
  return s;
}

function assistantChatView(model) {
  const entries = [];
  let inputValue = '';
  // 컴포저 커서 — inputValue 안의 코드포인트 인덱스(lib/composerModel.js 의
  // 좌표계). 삽입/삭제/이동은 전부 composerModel 의 순수 함수를 거친다.
  let cursorPos = 0;
  // 제출 히스토리 링 상태 — model.name(= profile.name, launcher.js 가 이미
  // 넘겨주는 프로필 고유 키)별로 dJinn 에서 최근 최대 10개를 읽어온다.
  // historyIndex === null 이면 "현재 편집 중인 draft" 상태, 아니면
  // historyList[historyIndex] 를 보고 있는 중(readline 관례).
  let historyList = model.name ? assistantHistoryDb.getHistory(model.name) : [];
  let historyIndex = null;
  let historyDraft = '';
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
  // 펫 스킨이 없는 모델(model.skinId 미지정)은 기존 getAvatarFrame 경로를 그대로 쓴다 —
  // pet 은 additive/primary 이지 필수가 아니다.
  let petVitals = model.petVitals || null;
  // 에이전트가 embodiment MCP 의 set_expression 으로 직접 지정한 표정(TTL 있는
  // { emotion, expiresAt } 오버레이) — deriveEmotion 에 그대로 흘려보내면 그
  // 함수가 우선순위/만료를 판단한다. launcher.js 의 done 핸들러가 매 턴 후
  // setAgentEmotion() 으로 최신값을 밀어준다.
  let agentEmotion = model.agentEmotion || null;
  const skin = model.skinId ? pet.getSkin(model.skinId) : null;
  // idle 애니메이션(눈 깜빡임 + 숨쉬기) — PetSkin 인터페이스(lib/pet/index.js)
  // 의 drawSprite animPhase 인자로만 스킨에 전달된다. 이 뷰는 그 값이 특정
  // 스킨(예: space-invader)에서 어떤 셀로 표현되는지 전혀 모른다 — 스킨을
  // 바꿔도 이 상태/타이머는 그대로 재사용된다(다형성). cadence(깜빡임 간격/
  // 숨쉬기 주기)는 스킨이 idleAnim 으로 오버라이드할 수 있고, 없으면
  // getIdleAnimConfig 가 기본값을 채운다. idleAnimCfg.enabled===false 거나
  // 스킨 자체가 없으면(getAvatarFrame 폴백 경로) 애니메이션을 아예 계산하지
  // 않는다 — 아래 animTick 참고.
  const idleAnimCfg = skin ? pet.getIdleAnimConfig(skin) : null;
  let animPhase = { blink: false, breathe: 0 };
  let animTickCount = 0; // 250ms 틱 카운터 — breathe 주기 계산 + blink 리셋에 씀
  let blinkResetAtTick = -1; // blink 를 다시 끌 목표 틱(한 틱만 유지)
  // 컨트롤 패널(Ctrl+\ 토글) — 이 화면은 프레임 wrapper(xtermFrame) 밖의 독립
  // raw-mode 화면이라 프레임 컨트롤 패널을 재사용할 수 없어, 이 안에 모아 넣는다.
  // 펫/다마고치 콘텐츠는 여기서 뺐다(우측 사이드바 아바타에 이미 있음, 중복
  // 금지 — 사용자 결정) — 이제 model/effort/reasoning 3개 설정 행만 보여준다.
  // 열려 있는 동안은 onKey 가 다른 어떤 분기보다 먼저 이 상태를 확인해 채팅
  // 입력으로 새지 않게 한다.
  let panelOpen = false;
  // panelFocus: 0=Model, 1=Effort, 2=Reasoning — ↑/↓ 로 이동.
  let panelFocus = 0;
  let panelModelIdx = settingsPanel.initOptionIndex(ASSISTANT_MODEL_OPTIONS, model.model);
  let panelEffortIdx = settingsPanel.initOptionIndex(ASSISTANT_EFFORT_OPTIONS, model.effort);
  // Reasoning = 트랜스크립트의 '사고 과정'(thinking) fold-card 표시 여부 —
  // 화면 전용 토글(CLI 플래그/세션 재시작 없음). 기본 ON, profile.reasoning
  // 이 명시적으로 false 일 때만 꺼진 채로 시작한다.
  let showThinking = model.reasoning !== false;
  // '/'-슬래시 명령 자동완성 팝업 — lib/assistantCommands.js 의 순수
  // filterCommands/parseLeadingToken 을 그려질 후보 계산에만 쓰고, 상태(선택
  // 인덱스/닫힘 여부)는 panelOpen 과 같은 이유로 여기 렌더링 클로저에 둔다.
  // popupIndex: 현재 강조된 후보 인덱스(↑/↓). popupDismissed: Esc 로 닫혔는지
  // (같은 토큰을 계속 타이핑하는 동안은 다시 뜨지 않음 — 아래서 글자를 더
  // 치거나 지우면 false 로 리셋). lastPopupToken: 토큰이 바뀌면(글자 추가/삭제)
  // popupIndex 를 0 으로 되돌리기 위한 비교 기준.
  let popupIndex = 0;
  let popupDismissed = false;
  let lastPopupToken = null;

  if (!process.stdin.isTTY) {
    closed = true;
    resolveDone();
    return { appendDelta() {}, finalizeTurn() {}, appendSystem() {}, appendToolEvent() {}, appendThinking() {}, setState() {}, setMood() {}, setSessionMeta() {}, setTurnUsage() {}, setPetVitals() {}, setAgentEmotion() {}, loadHistory() {}, done };
  }

  const buildChatLines = (width) => {
    const flat = [];
    // Reasoning 토글(showThinking) — OFF 면 'think' 엔트리를 트랜스크립트에서
    // 통째로 건너뛴다(순수 판정은 assistantSettingsPanel.shouldShowEntry, 여기선
    // 필터링 후 남은 엔트리끼리만 구분선을 넣는다 — 숨겨진 think 엔트리 자리에
    // 빈 구분줄이 남지 않도록 필터를 먼저 적용).
    const visibleEntries = entries.filter(e => settingsPanel.shouldShowEntry(e, showThinking));
    visibleEntries.forEach((e, i) => {
      if (i > 0) flat.push('');
      // Folded tool/thinking cards: a single dim, truncated summary line rather
      // than a labelled bubble — keeps them visually subordinate to real turns.
      if (e.who === 'tool' || e.who === 'think') {
        const lc = e.who === 'think' ? C.muted2 : (e.isError ? C.warn : C.muted);
        flat.push(lc + truncateCols(e.text || '', Math.max(1, width - 1)) + C.RESET);
        return;
      }
      let label, lc;
      if (e.who === 'user') { label = 'You'; lc = C.info; }
      else if (e.who === 'assistant') { label = model.name; lc = C.signal; }
      else { label = '!'; lc = C.warn; }
      const labelW = colWidth(label) + 2;
      const prefix = lc + label + ': ' + C.RESET;
      const indent = ' '.repeat(Math.min(Math.max(0, width - 1), labelW));
      const bodyText = e.text || (e.who === 'assistant' && !e.done ? '…' : '');
      // Applies to both assistant/domi replies and the "You:" user echo (user
      // input rarely contains markdown, but sharing one code path is simpler
      // and harmless — the transform is a no-op on plain text). Tool-call/
      // thinking fold cards ('tool'/'think', above) already returned before
      // reaching here, so they're untouched.
      const body = wrapCols(renderInlineMarkdown(bodyText), Math.max(1, width - labelW));
      if (body.length === 0) body.push('');
      flat.push(prefix + body[0]);
      for (let j = 1; j < body.length; j++) flat.push(indent + body[j]);
    });
    return flat;
  };

  // 화면 크기로부터 채팅/아바타 박스 폭을 계산 — draw() 와 onKey() (커서 이동/
  // Home/End 계산) 양쪽이 반드시 같은 값을 써야 하므로 공용 헬퍼로 뺐다.
  const frameLayout = () => {
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
    // 컴포저(입력창) 폭은 chatInner 보다 1칸 좁게 잡는다 — 시각적 줄이 폭에
    // 딱 맞게 줄바꿈됐을 때도, 그 뒤(또는 그 안)에 커서 글리프('█') 한 칸을
    // 더 그릴 여유를 항상 남겨 makeBox 의 truncateCols 에 잘리지 않게 한다.
    const composerWidth = Math.max(1, chatInner - 1);
    return { cols, rows, hpad, vpad, compact, boxHeight, gap, avatarWidth, chatWidth, chatInner, composerWidth };
  };

  // 컴포저의 시각적 줄 레이아웃(오토그로우 1~4줄) + 뷰포트(4줄 넘으면 스크롤,
  // 커서를 따라감). draw() 의 렌더링과 onKey() 의 위/아래 이동 판단이 항상
  // 같은 레이아웃을 보도록 여기 한 곳에서만 계산한다.
  const composerLayout = () => {
    const { composerWidth } = frameLayout();
    const lines = composerModel.layoutVisualLines(inputValue, composerWidth, colWidth);
    const { row: cursorRow, col: cursorCol } = composerModel.cursorRowCol(lines, inputValue, cursorPos);
    const displayRows = Math.min(4, Math.max(1, lines.length));
    const viewportTop = composerModel.computeViewportTop(lines.length, displayRows, cursorRow);
    return { composerWidth, lines, cursorRow, cursorCol, displayRows, viewportTop };
  };

  // '/'-자동완성 팝업의 현재 후보 목록 — draw()(렌더)와 onKey()(키 처리) 둘 다
  // 반드시 같은 계산을 봐야 하므로 composerLayout() 처럼 한 곳에 모은다.
  // popupToken 이 바뀌면(사용자가 글자를 더 치거나 지웠으면) 강조 인덱스를
  // 0으로 되돌린다 — 순수 계산 함수(assistantCommands)에는 이 리셋 판단을
  // 두지 않고, side-effect(popupIndex 대입)는 여기 호출부에서만 한다.
  const popupState = () => {
    const popupToken = assistantCommands.parseLeadingToken(inputValue);
    if (popupToken !== lastPopupToken) {
      lastPopupToken = popupToken;
      popupIndex = 0;
    }
    const matches = popupToken ? assistantCommands.filterCommands(popupToken) : [];
    const popupVisible = !!popupToken && !popupDismissed && matches.length > 0;
    return { popupToken, matches, popupVisible };
  };

  const draw = () => {
    if (closed) return;
    const { compact, boxHeight, gap, avatarWidth, chatWidth, chatInner } = frameLayout();
    const { lines: composerLines, cursorRow, cursorCol, displayRows, viewportTop } = composerLayout();
    // '/'-자동완성 팝업 — 'thinking' 중엔(컴포저 자체가 대기 안내 한 줄로
    // 대체되므로) 절대 뜨지 않는다. 최대 5개 후보만 보여준다.
    const { matches: popupMatches, popupVisible } = state === 'thinking'
      ? { matches: [], popupVisible: false }
      : popupState();
    const popupRows = popupVisible ? Math.min(5, popupMatches.length) : 0;
    // 'thinking' 중엔 기존 동작대로 컴포저 대신 대기 안내 한 줄만 보여준다
    // (입력 자체는 여전히 되지만 — 원래도 그랬음 — 응답이 오기 전엔 화면에
    // 반영하지 않고 조용히 큐잉만 됨. 이번 변경의 범위 밖이라 그대로 둔다).
    const composerRows = state === 'thinking' ? 1 : displayRows;
    // popupRows 를 예산에 포함시켜, 팝업이 뜨는 순간 채팅 박스가 boxHeight 를
    // 넘어가지 않게 한다(아바타 박스가 clampBoxKeepingBorders 로 지키는 것과
    // 같은 오버플로 규율 — 여기선 애초에 예산에서 빼는 쪽으로 지킨다).
    const chatRows = Math.max(1, boxHeight - 3 - composerRows - popupRows);

    const flat = buildChatLines(chatInner);
    const maxScroll = Math.max(0, flat.length - chatRows);
    if (scrollBack > maxScroll) scrollBack = maxScroll;
    const end = flat.length - scrollBack;
    const visible = flat.slice(Math.max(0, end - chatRows), end);
    while (visible.length < chatRows) visible.unshift('');

    let promptLines;
    if (state === 'thinking') {
      promptLines = [C.muted2 + '… 응답 대기 중' + C.RESET];
    } else {
      // 뷰포트에 보이는 displayRows 개의 시각적 줄을 그린다. 첫 번째 "논리적"
      // 줄(row===0)에만 '> ' 프롬프트를 붙이고 — 스크롤돼서 0번 줄이 안 보이는
      // 동안엔(4줄 넘는 입력 도중 위쪽으로 스크롤한 상태) 어떤 보이는 줄에도
      // 안 붙는다, 이어지는 줄들은 정렬을 위한 빈 들여쓰기('  '). 커서가 있는
      // 줄에는 그 칼럼 위치에 '█' 글리프를 끼워 넣는다(실제 터미널 커서를
      // 옮기는 대신 — 이 파일의 다른 단일행 input() 이 이미 쓰는 것과 같은
      // "가짜 블록 커서" 관례를 그대로 따름).
      promptLines = [];
      // 앵커된 typeahead — 화면 중앙 오버레이(overlayCenteredBox)가 아니라
      // '> ' 입력 줄 바로 위에 붙는 후보 목록. 강조된 행(popupIndex)은
      // popupCommandRow 가 설정 패널 포커스 행과 같은 스타일로 그린다.
      if (popupVisible) {
        const shown = popupMatches.slice(0, popupRows);
        const idx = Math.min(popupIndex, shown.length - 1);
        shown.forEach((cmd, i) => promptLines.push(popupCommandRow(cmd, i === idx, chatInner)));
      }
      for (let i = 0; i < displayRows; i++) {
        const row = viewportTop + i;
        const ln = composerLines[row];
        const prefix = row === 0 ? (C.signal + '> ' + C.RESET) : '  ';
        const text = ln ? ln.text : '';
        const chars = composerModel.toChars(text);
        let body;
        if (row === cursorRow) {
          const col = Math.max(0, Math.min(cursorCol, chars.length));
          const before = chars.slice(0, col).join('');
          const after = chars.slice(col).join('');
          body = C.text + before + C.RESET + C.signal + '█' + C.RESET + C.text + after + C.RESET;
        } else {
          body = C.text + text + C.RESET;
        }
        promptLines.push(prefix + body);
      }
    }

    const stateText = state === 'thinking' ? 'thinking...' : 'idle';
    const title = compact
      ? `${model.name} · ${model.toolCommand || ''} · ${stateText}`
      : `대화 — ${model.name}`;
    const chatBox = makeBox(chatInner, [
      ...visible,
      C.muted + repeatChar('─', chatInner) + C.RESET,
      ...promptLines,
    ], { title, height: boxHeight });

    let lines;
    if (compact) {
      // 좁은 터미널엔 아바타 칼럼이 아예 없다 — 패널은 (아래에서) 이 chatBox
      // 위에 중앙 정렬된 오버레이 팝업으로 얹힌다(자리를 통째로 바꿔치기하지
      // 않음: 채팅이 팝업 아래 그대로 남아 있음).
      lines = chatBox;
    } else {
      const avatarInner = avatarWidth - 2;
      const stateLine = state === 'thinking'
        ? C.warn + '● thinking...' + C.RESET
        : C.ok + '● idle' + C.RESET;
      const modelLabel = sessionMeta && sessionMeta.model ? sessionMeta.model : (model.model || 'default');
      const effortLabel = model.effort || 'default';
      // 펫 스킨이 있으면 emotion(mood+vitals 로 derive) 스프라이트 + vitals 게이지 +
      // 상호작용 힌트를, 없으면 기존 getAvatarFrame 8-mood 아바타를 그린다.
      // idle 애니메이션(눈 깜빡임 + 숨쉬기)은 animPhase 로 흘러든다 — 계산은
      // 아래 setup 블록의 animTick 이 250ms 마다 하고, 값이 바뀔 때만 draw() 를
      // 다시 부른다(diff 기반 paintRows 라 바뀐 두 줄만 다시 그려짐). 이 뷰는
      // animPhase 가 스킨 안에서 어떤 셀로 표현되는지 모른다 — PetSkin 인터페이스
      // (lib/pet/index.js drawSprite) 를 통해서만 넘긴다(다형성).
      const emotion = skin ? pet.deriveEmotion({ moodState: mood, vitals: petVitals, agentEmotion }) : null;
      const spriteSection = skin
        ? [
            // 스킨은 lib/pet 이 소유한 고정 그리드(PET_GRID)만 채우는 책임을 진다 —
            // 어떤 스킨이든 이 자리에 똑같이 맞도록, 계약 위반(줄 수/폭이 다름)까지도
            // padToGrid() 가 안전망으로 정확히 cols x rows 로 강제한다. 그 다음 이
            // 고정폭 블록을 avatarInner 안에서 좌우로 중앙 정렬한다(과거 getAvatarFrame
            // 의 centerAvatarLine 과 같은 역할, 다만 스킨 폭이 아니라 그리드 폭 기준).
            ...pet.padToGrid(skin.drawSprite({ emotion, vitals: petVitals, animPhase }))
              .map(l => ' '.repeat(Math.max(0, Math.floor((avatarInner - pet.PET_GRID.cols) / 2))) + C.signal + l + C.RESET),
            '',
            ...buildPetVitalsLines(petVitals),
            '',
            ' ' + C.muted2 + 'Ctrl+\\ 컨트롤 패널' + C.RESET,
          ]
        : getAvatarFrame(model.toolCommand, mood).map(l => C.signal + l + C.RESET);
      const avatarBody = [
        '',
        ...spriteSection,
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
      // 아바타 영역은 패널이 열려 있어도 항상 정상적으로("Agent" 박스) 그린다
      // — 패널은 (아래에서) 이 조립된 화면 전체 위에 얹히는 별도의 중앙 정렬
      // 오버레이 팝업이라, 아바타 박스는 팝업 "아래"에 그대로 보여야 한다.
      // makeBox 는 avatarBody 가 boxHeight-2 줄보다 길면(펫 스킨/vitals 로
      // 콘텐츠가 세로로 넘칠 때) 자르지 않고 그대로 더 긴 배열을 반환한다 —
      // 아래 for 루프가 boxHeight 개까지만 취하면 넘친 뒤쪽, 즉 마지막 줄(하단
      // 테두리 '└───┘')이 통째로 잘려 박스가 안 닫힌 것처럼 보인다. 그래서
      // 여기서 항상 상단/하단 테두리를 보존한 채 중간 콘텐츠만 잘라 정확히
      // boxHeight 줄로 맞춘다.
      const avatarBox = clampBoxKeepingBorders(
        makeBox(avatarInner, avatarBody, { title: 'Agent', height: boxHeight }),
        boxHeight
      );
      lines = [];
      for (let i = 0; i < boxHeight; i++) {
        lines.push((chatBox[i] || ' '.repeat(chatWidth)) + ' '.repeat(gap) + (avatarBox[i] || ''));
      }
    }

    // Ctrl+\ 컨트롤 패널: 채팅(+아바타)을 다 조립한 "뒤에" 화면 중앙에 뜨는
    // 모달 팝업으로 덧그린다 — xtermFrame.js:504-551 의 오버레이 기법과 같은
    // 구조(전체 콘텐츠 조립 → 그 위에 중앙 정렬 박스 덧그림). 닫힘은 별도
    // 정리가 필요 없다: draw() 는 매번 lines 를 처음부터 다시 조립하는 full
    // repaint라 panelOpen 이 false 가 되는 순간 다음 draw() 에서 팝업이 그냥
    // 그려지지 않을 뿐, 화면에 남는 잔여 셀이 없다.
    if (panelOpen) {
      const totalWidth = compact ? chatWidth : (chatWidth + gap + avatarWidth);
      // overlayCenteredBox 내부의 boxW/innerWidth 계산(그 함수 본문 참고)과 반드시
      // 같은 공식이어야 포커스 행의 배경색이 박스 폭 끝까지 정확히 칠해진다.
      const panelInnerWidth = Math.max(0, Math.min(totalWidth - 4, 30) - 2);
      overlayCenteredBox(lines, totalWidth, '설정', buildAssistantSettingsPanelBody(
        panelFocus, panelModelIdx, panelEffortIdx, showThinking, panelInnerWidth
      ));
    }

    lines.push('');
    const scrollHint = scrollBack > 0 ? `  (스크롤: -${scrollBack})` : '';
    lines.push(C.muted2 + '  Enter 전송  Ctrl+J/Alt+Enter 줄바꿈  ←→↑↓ 커서·스크롤  Ctrl+↑↓ 히스토리  Ctrl+\\ 패널  ESC 뒤로  /model /effort /mcp' + scrollHint + C.RESET);
    renderFramedScreen('개인비서', lines, { noTopPanels: true });
  };

  const wasRaw = process.stdin.isRaw;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  hideCursor();

  const onResize = () => { LAST_PAINTED_ROWS = null; LAST_PAINTED_COLS = 0; draw(); };

  const cleanup = () => {
    closed = true;
    clearInterval(animTimer);
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('keypress', onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    showCursor();
  };

  // "이전 대화" 목록 오버레이 — 토큰 피커(openTokenPicker, 바로 아래)와 완전히
  // 같은 패턴: 이 화면 자체의 raw-mode 키 리스너를 잠시 떼어내고, 별도 화면
  // (launcher.js의 onLoadConversation이 ui.menu로 그리는 목록)이 그 사이 자유롭게
  // 자기 raw-mode를 쓰게 한 뒤 돌아오면 리스너를 되붙이고 다시 그린다.
  let pickingConversation = false;
  const openConversationPicker = async () => {
    if (pickingConversation || closed) return;
    pickingConversation = true;
    process.stdin.removeListener('keypress', onKey);
    process.stdout.removeListener('resize', onResize);
    try {
      if (typeof model.onLoadConversation === 'function') {
        await model.onLoadConversation();
      }
    } catch {
    } finally {
      pickingConversation = false;
      if (!closed) {
        process.stdin.setRawMode(true);
        hideCursor();
        process.stdin.on('keypress', onKey);
        process.stdout.on('resize', onResize);
        draw();
      }
    }
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

  // 제출 한 건에 필요한 공통 절차(히스토리 기록/유저 말풍선 추가/렌더/
  // onSubmit 호출) — 일반 Enter 제출과 '/'-자동완성 팝업의 Enter(완성+실행)
  // 양쪽이 공유한다. 호출자가 inputValue/cursorPos 를 이미 비운 뒤 불러야
  // 한다(어느 쪽 호출부든 이 함수 자체는 컴포저 상태를 건드리지 않음).
  const submitText = (text) => {
    if (!text || state === 'thinking') return;
    if (model.name) {
      try {
        assistantHistoryDb.pushHistory(model.name, text);
        historyList = assistantHistoryDb.getHistory(model.name);
      } catch {}
    }
    historyIndex = null;
    historyDraft = '';
    entries.push({ who: 'user', text });
    scrollBack = 0;
    draw();
    try { if (model.onSubmit) model.onSubmit(text); } catch {}
    draw();
  };

  const onKey = (str, key) => {
    if (key && key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
    // Ctrl+\ (0x1c) rather than key.ctrl/key.name — readline's keypress parser
    // doesn't reliably name this control byte, same reasoning as xtermFrame.js's
    // control-panel shortcut. 이 화면은 프레임 wrapper(xtermFrame) 밖의 독립
    // raw-mode 화면이라 그쪽 컨트롤 패널을 재사용할 수 없어 이 화면 전용
    // 오버레이를 새로 둔다 — 토글이므로 패널 열림/닫힘 상태와 무관하게 항상
    // 가장 먼저 처리한다.
    if (str === '\x1c') { panelOpen = !panelOpen; draw(); return; }

    // 패널이 열려 있는 동안은 다른 어떤 분기보다 먼저 여기서 키를 소비한다 —
    // 채팅 입력('k' 로 시작하는 메시지 등)이나 스크롤/Esc(채팅 종료)로 새지
    // 않게 하기 위함. 그 외 키는 전부 무시(패널 밖으로 새지 않음).
    if (panelOpen) {
      if (key && key.name === 'escape') { panelOpen = false; draw(); return; }
      const lower = typeof str === 'string' ? (hangulToQwerty(str) || str).toLowerCase() : '';
      // [K] 토큰 변경 — 3개 설정 행과는 별개의 단축키로 유지한다. 채팅 도중
      // 토큰을 바꿔야 하는 경우(예: 토큰 만료)를 위한 유일한 진입점이라
      // 설정 패널 재설계와 무관하게 남겨둔다(어시스턴트 상세 메뉴에서도 할 수
      // 있지만, 그러려면 채팅을 나가야 한다).
      if (lower === 'k') {
        panelOpen = false;
        openTokenPicker();
        return;
      }

      // [L] 이전 대화 — 설정 패널 본문에 목록을 욱여넣지 않고, k(토큰 변경)와
      // 같은 패턴으로 별도 화면(launcher.js의 onLoadConversation → ui.menu 목록
      // 오버레이)을 띄운다(사용자 확정 결정: 설정 패널은 설정 전용으로 유지).
      if (lower === 'l') {
        panelOpen = false;
        openConversationPicker();
        return;
      }

      const notifySettingsChange = () => {
        if (typeof model.onSettingsChange !== 'function') return;
        try {
          model.onSettingsChange({
            model: ASSISTANT_MODEL_OPTIONS[panelModelIdx],
            effort: ASSISTANT_EFFORT_OPTIONS[panelEffortIdx],
            reasoning: showThinking,
          });
        } catch {}
      };

      if (key && key.name === 'up') { panelFocus = Math.max(0, panelFocus - 1); draw(); return; }
      if (key && key.name === 'down') { panelFocus = Math.min(2, panelFocus + 1); draw(); return; }

      if (key && (key.name === 'left' || key.name === 'right')) {
        const delta = key.name === 'left' ? -1 : 1;
        if (panelFocus === 0) {
          panelModelIdx = settingsPanel.cycleOptionIndex(ASSISTANT_MODEL_OPTIONS, panelModelIdx, delta);
          draw();
          notifySettingsChange();
        } else if (panelFocus === 1) {
          panelEffortIdx = settingsPanel.cycleOptionIndex(ASSISTANT_EFFORT_OPTIONS, panelEffortIdx, delta);
          draw();
          notifySettingsChange();
        }
        return;
      }

      // Space/Enter — Reasoning 체크박스 토글(포커스가 그 행일 때만). 즉시
      // 다시 그려 사고 과정 fold-card 가 그 자리에서 나타나거나 사라지게 한다
      // (세션 재시작 없음 — 순수 화면 토글).
      if (str === ' ' || (key && (key.name === 'space' || key.name === 'return'))) {
        if (panelFocus === 2) {
          showThinking = !showThinking;
          draw();
          notifySettingsChange();
        }
        return;
      }
      return;
    }

    // ── '/'-슬래시 자동완성 팝업 ───────────────────────────────────────
    // panelOpen 과 같은 차폐 패턴 — 팝업이 보이는 동안은 여기서 먼저 몇몇
    // 키(Esc/↑/↓/Tab/Enter)를 소비해 히스토리 링·스크롤백·Esc(채팅 종료)·
    // 일반 전송으로 새지 않게 한다. state==='thinking' 중엔 draw() 가 팝업
    // 자체를 그리지 않으므로(컴포저가 대기 안내 한 줄로 바뀜) 여기서도
    // "안 보이는" 것으로 취급해 그 어떤 키도 가로채지 않는다. 그 외
    // 키(일반 문자 입력, Backspace, 커서 이동 등)는 이 블록 어떤 if 에도
    // 걸리지 않고 그대로 아래로 흘러가 기존 처리(입력/삭제/이동)를 그대로
    // 탄다 — popupDismissed 리셋은 그 아래 backspace/문자 삽입 분기에서 한다.
    {
      const { matches: popupMatches, popupVisible } = state === 'thinking'
        ? { matches: [], popupVisible: false }
        : popupState();
      if (popupVisible) {
        if (key && key.name === 'escape') { popupDismissed = true; draw(); return; }
        if (key && key.name === 'up') { popupIndex = Math.max(0, popupIndex - 1); draw(); return; }
        if (key && key.name === 'down') { popupIndex = Math.min(popupMatches.length - 1, popupIndex + 1); draw(); return; }
        const selected = popupMatches[Math.min(popupIndex, popupMatches.length - 1)];
        if (key && key.name === 'tab') {
          inputValue = selected.name + ' ';
          cursorPos = composerModel.length(inputValue);
          popupDismissed = true;
          draw();
          return;
        }
        if (key && key.name === 'return') {
          popupDismissed = true;
          inputValue = '';
          cursorPos = 0;
          submitText(selected.name);
          return;
        }
      }
    }

    if (key && key.name === 'escape') { cleanup(); resolveDone(); return; }

    // ── 히스토리 리콜 (Ctrl+Up / Ctrl+Down) — readline 관례. 처음 Ctrl+Up 은
    // 지금 편집 중이던 텍스트를 historyDraft 에 잠시 보관해두고 가장 최근
    // 제출 항목부터 보여준다. 계속 Ctrl+Up 하면 더 오래된 항목으로, Ctrl+Down
    // 은 반대 방향으로 이동하다 draft 로 돌아온다. 양쪽 끝(가장 오래된 항목
    // 에서 더 위로, 또는 이미 draft 상태에서 더 아래로)에서는 그냥 멈춘다 —
    // 순환하지 않는다. 실제 xterm(modifyOtherKeys)에서는 Ctrl+Up/Down 이
    // `\x1b[1;5A` / `\x1b[1;5B` 로 오고 node 의 readline 키 파서가 이를
    // { name: 'up'|'down', ctrl: true } 로 정확히 분해해준다(직접 확인함) —
    // 다만 이 조합키를 다른 이름으로 보내는 터미널도 있을 수 있어(미검증) 그
    // 경우엔 이 분기가 안 타고 아래의 "일반 위/아래" 로 떨어질 수 있다.
    if (key && key.ctrl && (key.name === 'up' || key.name === 'down')) {
      if (historyList.length === 0) return;
      if (key.name === 'up') {
        if (historyIndex === null) {
          historyDraft = inputValue;
          historyIndex = historyList.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        } else {
          return; // 이미 가장 오래된 항목 — 더 못 감
        }
        inputValue = historyList[historyIndex];
      } else {
        if (historyIndex === null) return; // 이미 draft 상태 — 더 못 감
        if (historyIndex < historyList.length - 1) {
          historyIndex++;
          inputValue = historyList[historyIndex];
        } else {
          historyIndex = null;
          inputValue = historyDraft;
        }
      }
      cursorPos = composerModel.length(inputValue);
      draw();
      return;
    }

    // ── 위/아래 화살표(Ctrl 없이): 입력이 오토그로우로 여러 시각적 줄이 됐으면
    // 그 안에서 커서를 위/아래 줄로 옮긴다(뷰포트는 draw() 의 composerLayout()
    // 이 알아서 커서를 따라간다). 이미 컴포저의 첫/마지막 시각적 줄이라 더
    // 옮길 데가 없으면(moveVisualRow 가 커서를 그대로 돌려줌) 기존 동작인
    // 채팅 스크롤백으로 폴백한다 — 흔한 경우(한 줄짜리 입력)에는 항상 이
    // 폴백 경로를 타므로 기존 "↑↓ 스크롤" 이 그대로 살아있다.
    if (key && !key.ctrl && (key.name === 'up' || key.name === 'down')) {
      const { composerWidth } = frameLayout();
      const delta = key.name === 'up' ? -1 : 1;
      const moved = composerModel.moveVisualRow(inputValue, cursorPos, composerWidth, colWidth, delta);
      if (moved !== cursorPos) {
        cursorPos = moved;
        draw();
        return;
      }
      if (key.name === 'up') scrollBack++;
      else if (scrollBack > 0) scrollBack--;
      draw();
      return;
    }

    if (key && key.name === 'left') { cursorPos = composerModel.moveLeft(inputValue, cursorPos); draw(); return; }
    if (key && key.name === 'right') { cursorPos = composerModel.moveRight(inputValue, cursorPos); draw(); return; }
    if (key && key.name === 'home') {
      const { composerWidth } = frameLayout();
      cursorPos = composerModel.moveHome(inputValue, cursorPos, composerWidth, colWidth);
      draw();
      return;
    }
    if (key && key.name === 'end') {
      const { composerWidth } = frameLayout();
      cursorPos = composerModel.moveEnd(inputValue, cursorPos, composerWidth, colWidth);
      draw();
      return;
    }

    // ── 줄바꿈 vs 전송 ───────────────────────────────────────────────────
    // 일반 Enter(바이트 \r) 는 key.name === 'return' 으로, 별다른 수정자 없이
    // 들어온다 — 아래에서 전송으로 처리한다. Shift+Enter 는 검증 결과 대부분의
    // 터미널이 일반 Enter 와 완전히 같은 바이트(\r)를 보내 raw mode 에서
    // 구분이 원천적으로 불가능하다(node readline 키 파서가 별도 신호를 주지
    // 않는 한 서로 다른 이벤트가 오지 않음 — 실제로 emitKeypressEvents 에
    // '\r' 만 흘려보내 재현·확인함). 그래서 줄바꿈 삽입은 raw mode 에서
    // "확실히 구분되는" 아래 세 대체 바인딩으로만 보장한다:
    //   • Ctrl+J (바이트 \n)        → key.name === 'enter' (return 과 다른
    //     이름으로 옴 — 확인함)
    //   • Alt+Enter (바이트 \x1b\r) → key.name === 'return' && key.meta === true
    //     (확인함)
    //   • kitty 키보드 프로토콜의 Shift+Enter(\x1b[13;2u) — node의 readline
    //     파서가 이 시퀀스를 알려진 키로 해석하지 못해 key.name 이 문자열
    //     "undefined" 로 나온다(확인함). 그래서 이름 대신 원시 코드
    //     (key.code === '[13;2u')를 직접 매칭한다 — kitty 프로토콜을 켠
    //     터미널에서만 해당되고, 그 외 대다수 터미널에선 이 분기가 아예 안 탄다.
    const isAltEnter = key && key.name === 'return' && key.meta === true;
    const isCtrlJNewline = key && key.name === 'enter';
    const isKittyShiftEnter = key && key.code === '[13;2u';
    if (isAltEnter || isCtrlJNewline || isKittyShiftEnter) {
      const r = composerModel.insertText(inputValue, cursorPos, '\n');
      inputValue = r.value;
      cursorPos = r.cursor;
      draw();
      return;
    }

    if (key && key.name === 'return') {
      const text = inputValue.trim();
      if (!text || state === 'thinking') return;
      inputValue = '';
      cursorPos = 0;
      submitText(text);
      return;
    }
    if (key && key.name === 'backspace') {
      const r = composerModel.deleteBackward(inputValue, cursorPos);
      inputValue = r.value;
      cursorPos = r.cursor;
      // 지우다가 다시 '/'-토큰 형태로 돌아올 수 있으므로, 한 번 Esc 로
      // 닫았던 팝업도 편집이 재개되면 다시 뜰 수 있게 리셋한다.
      popupDismissed = false;
      draw();
      return;
    }
    if (typeof str === 'string' && str >= ' ' && !(key && (key.ctrl || key.meta))) {
      const r = composerModel.insertText(inputValue, cursorPos, str);
      inputValue = r.value;
      // 더 타이핑하면(닫혔던 팝업이라도) 다시 뜰 수 있게 리셋 — 아래
      // cursorPos 대입/draw() 는 원래 흐름 그대로.
      popupDismissed = false;
      cursorPos = r.cursor;
      draw();
    }
  };

  // idle 애니메이션 틱 — 250ms 마다 blink/breathe 위상을 갱신하고, 실제로
  // 바뀐 틱에만 draw() 를 부른다(diff 기반 paintRows 라 어차피 싸지만, 불필요한
  // 재도장 자체를 피한다). 'thinking' 중이거나(state !== 'idle') 이 화면이
  // 다른 raw-mode 오버레이(대화 불러오기/토큰 피커)에 잠시 자리를 내준
  // 동안엔 절대 손대지 않는다 — draw() 자체는 closed 만 확인하므로, 그 두
  // 상태는 여기서 직접 걸러야 그 화면 위에 겹쳐 그리지 않는다. 스킨이 없거나
  // (getAvatarFrame 폴백) idleAnimCfg.enabled 가 false 면 아예 no-op.
  const ANIM_TICK_MS = 250;
  const animTick = () => {
    if (!skin || !idleAnimCfg || !idleAnimCfg.enabled) return;
    if (closed || state !== 'idle' || pickingConversation || pickingToken) return;

    animTickCount++;

    // Breathe: 고정 주기로 0/1 토글.
    const breatheTicks = Math.max(1, Math.round(idleAnimCfg.breathePeriodMs / ANIM_TICK_MS));
    const nextBreathe = Math.floor(animTickCount / breatheTicks) % 2;

    // Blink: 평소엔 false, 매 틱 작은 확률로 한 틱만 true 로 켰다가 자동으로
    // 끈다. 확률은 idleAnimCfg 의 min~max 구간 평균을 목표 간격으로 삼아
    // 역산한다 — 스킨이 idleAnim 으로 다른 cadence 를 주면 그대로 반영된다.
    let nextBlink = animPhase.blink;
    if (nextBlink && animTickCount >= blinkResetAtTick) {
      nextBlink = false;
    } else if (!nextBlink) {
      const avgIntervalMs = (idleAnimCfg.blinkMinMs + idleAnimCfg.blinkMaxMs) / 2;
      const p = ANIM_TICK_MS / avgIntervalMs;
      if (Math.random() < p) {
        nextBlink = true;
        blinkResetAtTick = animTickCount + 1; // 정확히 한 틱만 유지
      }
    }

    if (nextBlink !== animPhase.blink || nextBreathe !== animPhase.breathe) {
      animPhase = { blink: nextBlink, breathe: nextBreathe };
      draw();
    }
  };
  const animTimer = setInterval(animTick, ANIM_TICK_MS);

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
    appendToolEvent(evt) {
      if (closed || !evt) return;
      let text, isError = false;
      if (evt.kind === 'result') {
        isError = evt.isError === true;
        const preview = summarizeToolResult(evt.content);
        text = (isError ? '⚠ ' : '↳ ') + '결과' + (preview ? ' · ' + preview : '');
      } else {
        text = '🔧 ' + summarizeToolUse(evt.name, evt.input);
      }
      entries.push({ who: 'tool', text, isError });
      draw();
    },
    appendThinking(text) {
      if (closed) return;
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      entries.push({ who: 'think', text: '💭 ' + t });
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
    setPetVitals(next) {
      if (closed) return;
      petVitals = next;
      draw();
    },
    setAgentEmotion(next) {
      if (closed) return;
      agentEmotion = next;
      draw();
    },
    // "이전 대화" 재개(launcher.js의 onLoadConversation)가 트랜스크립트를 다
    // 읽은 뒤 화면에 통째로 시드할 때 쓴다 — appendSystem 등 기존 메서드와
    // 달리 누적(additive)이 아니라 지금까지의 entries를 완전히 대체한다.
    // newEntries는 [{who:'user'|'assistant', text}, ...] (assistantTranscript.js
    // 의 parseTranscript 반환 형태) — 스트리밍 중이던 항목이 있었다면 폐기한다.
    loadHistory(newEntries) {
      if (closed) return;
      entries.length = 0;
      if (Array.isArray(newEntries)) {
        for (const e of newEntries) {
          if (e && (e.who === 'user' || e.who === 'assistant') && typeof e.text === 'string') {
            entries.push({ who: e.who, text: e.text, done: true });
          }
        }
      }
      streamingEntry = null;
      scrollBack = 0;
      draw();
    },
    done,
  };
}

// 열린 채로 내용을 갱신할 수 있는 스크롤 뷰. { setLines, setStatus, done } 핸들 반환.
function liveScrollableMessage(title, initialText) {
  return openScrollable(title, initialText);
}

module.exports = { setColors, getPalette, setFrameConfig, menu, homeMenu, message, scrollableMessage, liveScrollableMessage, flashMessage, assistantChatView, input, clear, out, W, IW, colWidth, truncateCols, makeBox, clampBoxKeepingBorders, renderHeader, enterAltScreen, exitAltScreen, showCursor, renderInlineMarkdown, wrapCols };
