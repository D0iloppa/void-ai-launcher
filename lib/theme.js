'use strict';

const fs = require('fs');
const path = require('path');

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';

// Theme packs live in themes/ (repo root) — one file per pack, exporting a flat
// 13-key hex palette. Adding a pack = dropping a new .js file there; prefer
// metaphorical names (e.g. void-signature) over literal color descriptions.
const THEMES_DIR = path.join(__dirname, '..', 'themes');
const BUILT_IN = {};
for (const file of fs.readdirSync(THEMES_DIR)) {
  if (!file.endsWith('.js')) continue;
  BUILT_IN[path.basename(file, '.js')] = require(path.join(THEMES_DIR, file));
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function fg(hex) {
  const [r,g,b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg(hex) {
  const [r,g,b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function luminance(hex) {
  const vals = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * vals[0] + 0.7152 * vals[1] + 0.0722 * vals[2];
}

function loadTheme(config) {
  const name = config.theme?.name || 'void-signature';
  const base = BUILT_IN[name] || BUILT_IN['void-signature'];
  return { ...base, ...(config.theme?.colors || {}) };
}

// WCAG 스타일 대비비 — 두 휘도 중 밝은 쪽/어두운 쪽을 정해 비율로 환산.
function contrastRatio(lumA, lumB) {
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function makeColors(palette) {
  const c = { RESET, BOLD, DIM };
  for (const [key, hex] of Object.entries(palette)) {
    c[key] = fg(hex);
    c[key + 'Bg'] = bg(hex);
  }
  // signal 배경 위에 얹을 글자색 선택 — bg/text 중 signal과 대비비가 더 큰
  // 쪽을 고른다. 예전엔 "signal이 밝으면 bg, 어두우면 text"라는 다크테마
  // 전제(bg=어두움, text=밝음)로 고정돼 있었는데, 라이트 테마(bg=밝음,
  // text=어두움, 예: white-black)에서는 이 전제가 뒤집혀 정반대로 낮은
  // 대비를 골라버린다. 대비비를 직접 비교하면 테마의 명암 극성과
  // 무관하게 항상 올바른 쪽을 고른다(기존 다크 테마 8개 전부에서
  // 결과가 예전 공식과 동일함을 확인함).
  const sigLum = luminance(palette.signal);
  const bgContrast = contrastRatio(sigLum, luminance(palette.bg));
  const textContrast = contrastRatio(sigLum, luminance(palette.text));
  c.onSignal = fg(bgContrast >= textContrast ? palette.bg : palette.text);
  return c;
}

module.exports = { loadTheme, makeColors, fg, bg, BUILT_IN, RESET, BOLD, DIM, contrastRatio, luminance };
