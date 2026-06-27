'use strict';

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';

const BUILT_IN = {
  'green-black': {
    bg: '#000000', panel: '#0a0a0a', panel2: '#0f0f0f',
    border: '#1a2e1a', borderHi: '#2a4a2a',
    signal: '#00e676', signalDim: '#003d1f',
    text: '#f0f0f0', muted: '#3d5c3d', muted2: '#6a8a6a',
    ok: '#4ade80', warn: '#fbbf24', info: '#60a5fa',
  },
  'red-void': {
    bg: '#090912', panel: '#13131f', panel2: '#1a1a2e',
    border: '#252538', borderHi: '#3a3a5c',
    signal: '#ff4d6d', signalDim: '#7a2233',
    text: '#e4e4f0', muted: '#5a5a78', muted2: '#888899',
    ok: '#4ade80', warn: '#fbbf24', info: '#60a5fa',
  },
  'amber-dark': {
    bg: '#0a0800', panel: '#120f00', panel2: '#1a1500',
    border: '#2e2800', borderHi: '#4a4000',
    signal: '#fbbf24', signalDim: '#4a3800',
    text: '#f0ede0', muted: '#5c5020', muted2: '#8a7a40',
    ok: '#4ade80', warn: '#f97316', info: '#60a5fa',
  },
  'cyan-deep': {
    bg: '#00080f', panel: '#001525', panel2: '#001f33',
    border: '#003355', borderHi: '#005588',
    signal: '#22d3ee', signalDim: '#003344',
    text: '#e0f0f8', muted: '#1a4a5a', muted2: '#4a8a9a',
    ok: '#4ade80', warn: '#fbbf24', info: '#818cf8',
  },
};

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
  const name = config.theme?.name || 'green-black';
  const base = BUILT_IN[name] || BUILT_IN['green-black'];
  return { ...base, ...(config.theme?.colors || {}) };
}

function makeColors(palette) {
  const c = { RESET, BOLD, DIM };
  for (const [key, hex] of Object.entries(palette)) {
    c[key] = fg(hex);
    c[key + 'Bg'] = bg(hex);
  }
  c.onSignal = fg(luminance(palette.signal) > 0.179 ? palette.bg : palette.text);
  return c;
}

module.exports = { loadTheme, makeColors, fg, bg, BUILT_IN, RESET, BOLD, DIM };
