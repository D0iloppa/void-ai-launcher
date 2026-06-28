'use strict';

/**
 * Parses hex color (e.g. "#ff0044" or "ff0044") to [R, G, B]
 */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
}

/**
 * Interpolates between two hex colors and returns ANSI 24-bit fg escape sequence
 */
function interpolateColor(colorAHex, colorBHex, factor) {
  const a = hexToRgb(colorAHex);
  const b = hexToRgb(colorBHex);
  const r = Math.round(a[0] + (b[0] - a[0]) * factor);
  const g = Math.round(a[1] + (b[1] - a[1]) * factor);
  const bVal = Math.round(a[2] + (b[2] - a[2]) * factor);
  return `\x1b[38;2;${r};${g};${bVal}m`;
}

/**
 * Simulates React Bits "ShinyText" in terminal
 * Sweeps a shine color across base colored text.
 */
function shimmerText(text, progress, baseHex = '#5a5a78', shineHex = '#ff4d6d', spread = 4) {
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  // Map progress to center position from -spread to length + spread
  const center = -spread + progress * (text.length + 2 * spread);
  let result = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ') {
      result += ' ';
      continue;
    }

    const dist = Math.abs(i - center);
    if (dist < spread) {
      // Linear falloff, squared for a sharper highlight peak
      const factor = Math.pow(1 - (dist / spread), 1.5);
      result += interpolateColor(baseHex, shineHex, factor) + char;
    } else {
      result += `\x1b[38;2;${hexToRgb(baseHex).join(';')}m` + char;
    }
  }

  // Restore terminal state
  result += '\x1b[0m';
  return result;
}

/**
 * Simulates React Bits "Shuffle" (text scramble/decrypt) in terminal
 */
function scrambleText(text, progress, charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+{}|:<>?-=[]\\;,./') {
  if (progress >= 1) return text;
  if (progress <= 0) {
    return text
      .split('')
      .map(char => (char === ' ' ? ' ' : charset[Math.floor(Math.random() * charset.length)]))
      .join('');
  }

  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ') {
      result += ' ';
      continue;
    }

    const charProgress = i / text.length;
    // Reveal window
    if (charProgress < progress - 0.1) {
      result += char;
    } else if (charProgress < progress + 0.1) {
      result += charset[Math.floor(Math.random() * charset.length)];
    } else {
      // Hidden or represented as subtle block/muted dot
      result += '░';
    }
  }
  return result;
}

function luminance(hex) {
  const vals = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * vals[0] + 0.7152 * vals[1] + 0.0722 * vals[2];
}

function glitchText(text, elapsed, baseColorAnsi = '\x1b[0m', glitchProbability = 0.12) {
  const cycle = elapsed % 3000;
  if (cycle > 450) {
    return text;
  }

  const glitchChars = '▖▗▘▙▚▛▜▝▞▟░▒▓█▓▒░/_*+=%#@&!?-';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === ' ') {
      result += ' ';
      continue;
    }

    if (Math.random() < glitchProbability) {
      const colors = ['\x1b[31m', '\x1b[36m', '\x1b[35m', '\x1b[33m'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const glitchChar = glitchChars[Math.floor(Math.random() * glitchChars.length)];
      result += color + glitchChar + baseColorAnsi;
    } else {
      result += char;
    }
  }
  return result;
}

module.exports = {
  shimmerText,
  scrambleText,
  hexToRgb,
  interpolateColor,
  luminance,
  glitchText
};
