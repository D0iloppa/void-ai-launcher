'use strict';

// System clipboard helper for short strings (API keys, export lines, etc).
// Deliberately dependency-free — no npm clipboard package — and FAIL-OPEN:
// every path here is wrapped so a missing binary / unsupported terminal /
// write error never throws up into the caller. Two strategies are tried in
// order, stopping at the first that plausibly worked:
//
//   1. OSC 52 — an escape sequence the terminal itself interprets to set its
//      clipboard. No external binary, works over SSH and in most modern
//      terminals (incl. Windows Terminal). This is the PRIMARY path because
//      it works even when the process has no OS clipboard tool available at
//      all (e.g. a bare WSL/container shell) — the terminal emulator on the
//      other end of the pty is what actually owns the clipboard.
//   2. OS command fallback — best-effort spawnSync into whatever native
//      clipboard binary exists (clip.exe / wl-copy / xclip / xsel / pbcopy).
//
// NOTE: this repo's dev/CI environment has none of the OS clipboard tools
// installed, so OSC 52 is the path that actually does something here; the
// OS-command fallback exists for machines that do have one of those tools.

const { spawnSync } = require('child_process');

// Builds the raw OSC 52 "set clipboard" escape sequence for `text`.
// Pure function (no I/O) so it's unit-testable in isolation.
//
// Bare form:      ESC ] 52 ; c ; <base64> BEL
// Inside tmux, a bare OSC sequence written to the pty is captured by tmux
// itself rather than forwarded to the real terminal, so it has to be
// wrapped in a tmux DCS passthrough sequence (`ESC P tmux; ... ESC \`) with
// any literal ESC bytes in the payload doubled — tmux un-escapes `ESC ESC`
// back to a single `ESC` when it forwards the passthrough body, and a lone
// ESC inside the body would otherwise be read as the end of the DCS itself.
// GNU screen uses the same doubling trick with a plain DCS passthrough
// (`ESC P ... ESC \`, no `tmux;` prefix).
function buildOsc52(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const osc = `\x1b]52;c;${b64}\x07`;

  if (process.env.TMUX) {
    const escaped = osc.replace(/\x1b/g, '\x1b\x1b');
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (typeof process.env.TERM === 'string' && process.env.TERM.startsWith('screen')) {
    const escaped = osc.replace(/\x1b/g, '\x1b\x1b');
    return `\x1bP${escaped}\x1b\\`;
  }
  return osc;
}

function tryOsc52(text) {
  try {
    process.stdout.write(buildOsc52(text));
    return true;
  } catch (_) {
    return false;
  }
}

// Feeds `text` on stdin to `cmd args...`; true only on a clean exit.
// Any spawn failure (binary missing, non-zero exit, etc) resolves to false
// rather than throwing — a missing binary must never crash the caller.
function tryCmd(cmd, args, text) {
  try {
    const res = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return !res.error && res.status === 0;
  } catch (_) {
    return false;
  }
}

// Best-effort native clipboard binary, tried in order. clip.exe is tried
// first unconditionally (covers both real win32 and WSL, where clip.exe is
// commonly on PATH) — tryCmd already no-ops to false when it isn't present,
// so this reduces to "on win32 or if clip.exe resolves" without a separate
// existence check.
function tryOsCommand(text) {
  if (tryCmd('clip.exe', [], text)) return 'clip.exe';
  if (tryCmd('wl-copy', [], text)) return 'wl-copy';
  if (tryCmd('xclip', ['-selection', 'clipboard'], text)) return 'xclip';
  if (tryCmd('xsel', ['--clipboard', '--input'], text)) return 'xsel';
  if (tryCmd('pbcopy', [], text)) return 'pbcopy';
  return null;
}

// copyToClipboard(text) -> { ok, method }. Never throws.
function copyToClipboard(text) {
  try {
    if (tryOsc52(text)) return { ok: true, method: 'osc52' };
  } catch (_) { /* fail-open */ }

  try {
    const method = tryOsCommand(text);
    if (method) return { ok: true, method };
  } catch (_) { /* fail-open */ }

  return { ok: false, method: null };
}

module.exports = { copyToClipboard, buildOsc52 };
