'use strict';

// Under a Korean IME (Dubeolsik layout), physical letter keys emit Hangul
// Compatibility Jamo codepoints (U+3130-U+318F) instead of ASCII — e.g.
// pressing the H key sends 'ㅗ' (U+3157), K sends 'ㅏ' (U+314F). node's
// readline keypress event still delivers these as a plain `str` with
// `key.name === undefined`, so any bare-letter hotkey compare
// (str.toLowerCase()==='h', item.key==='k', /^[hH]+$/) silently fails to
// match while the IME is active.
//
// This module is the reverse map: jamo -> the QWERTY letter that produces it
// under Dubeolsik. It is a pure leaf module (no requires of ui.js/xtermFrame.js)
// so callers can layer it onto an existing hotkey compare as a fallback:
//   const k = hangulToQwerty(str) || str;
// Shifted/tense jamo (ㄲㄸㅃㅆㅉ) map to the same base letter as their plain
// counterpart since hotkeys here are already case-insensitive. Composite
// jamo (batchim clusters like ㄳㄵ, diphthongs like ㅘㅙ) never arrive from a
// single keystroke, so they are intentionally left unmapped -> null.

const JAMO_TO_QWERTY = {
  'ㄱ': 'r', // ㄱ
  'ㄲ': 'r', // ㄲ
  'ㄴ': 's', // ㄴ
  'ㄷ': 'e', // ㄷ
  'ㄸ': 'e', // ㄸ
  'ㄹ': 'f', // ㄹ
  'ㅁ': 'a', // ㅁ
  'ㅂ': 'q', // ㅂ
  'ㅃ': 'q', // ㅃ
  'ㅅ': 't', // ㅅ
  'ㅆ': 't', // ㅆ
  'ㅇ': 'd', // ㅇ
  'ㅈ': 'w', // ㅈ
  'ㅉ': 'w', // ㅉ
  'ㅊ': 'c', // ㅊ
  'ㅋ': 'z', // ㅋ
  'ㅌ': 'x', // ㅌ
  'ㅍ': 'v', // ㅍ
  'ㅎ': 'g', // ㅎ
  'ㅏ': 'k', // ㅏ
  'ㅐ': 'o', // ㅐ
  'ㅑ': 'i', // ㅑ
  'ㅒ': 'o', // ㅒ
  'ㅓ': 'j', // ㅓ
  'ㅔ': 'p', // ㅔ
  'ㅕ': 'u', // ㅕ
  'ㅖ': 'p', // ㅖ
  'ㅗ': 'h', // ㅗ
  'ㅛ': 'y', // ㅛ
  'ㅜ': 'n', // ㅜ
  'ㅠ': 'b', // ㅠ
  'ㅡ': 'm', // ㅡ
  'ㅣ': 'l', // ㅣ
};

// Returns the lowercase latin letter that produces `ch` under Dubeolsik, or
// null when `ch` is not a single mapped compatibility jamo (including ASCII,
// composite jamo, and anything else).
function hangulToQwerty(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  return JAMO_TO_QWERTY[ch] || null;
}

module.exports = { hangulToQwerty };
