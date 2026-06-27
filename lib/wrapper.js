'use strict';

// ── ANSI ──────────────────────────────────────────────────
const SIG_BG = '\x1b[48;2;0;230;118m';
const SIG_FG = '\x1b[38;2;0;230;118m';
const BLACK  = '\x1b[38;2;0;0;0m';
const RED_FG = '\x1b[38;2;230;50;50m';
const BOLD   = '\x1b[1m';
const RST    = '\x1b[0m';
const BL_V   = '│';

const MAX_BUFFER = 200000;
const PREFIX_KEY = '\x01'; // Ctrl+A

// Sequences that break wrapper margin state — strip from PTY output
const RE_FRAME_BREAKERS = /\x1b\[\?6[lh]|\x1b\[\?69[lh]|\x1b\[[\d;]*r|\x1b\[\?10(?:47|49)[lh]/g;
// ED sequences (Erase Display) — bars need redrawing afterward
const RE_ERASE_DISPLAY = /\x1b\[[0-3]?J/;

function filterPtyData(data) {
  return data.replace(RE_FRAME_BREAKERS, '');
}

function at(row, col) { return `\x1b[${row};${col}H`; }

function trimText(text, width) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

function formatTabs(tabs, activeIndex, maxWidth) {
  if (!tabs || tabs.length === 0 || maxWidth <= 0) return '';

  const parts = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const rawLabel = `${i + 1}:${tab.title}${tab.exited ? 'x' : ''}`;
    const label = trimText(rawLabel, 22);
    const part = i === activeIndex ? `<${label}>` : `[${label}]`;
    parts.push(part);
  }

  const joined = parts.join(' ');
  return trimText(joined, maxWidth);
}

// ── Bar strings ───────────────────────────────────────────
function topBar(cols, label, tabs, activeIndex, modeHint) {
  const left = ` Wrapper >_  ${label} `;
  const tabsWidth = Math.max(0, cols - left.length - 1);
  const tabText = tabs && tabs.length > 0
    ? formatTabs(tabs, activeIndex, tabsWidth)
    : trimText(modeHint || '', tabsWidth);
  const body = left + tabText;
  return SIG_BG + BLACK + BOLD + body + ' '.repeat(Math.max(0, cols - body.length)) + RST;
}

function bottomBar(cols, helpText = '', svcPrompt = null) {
  const time = new Date().toTimeString().slice(0, 8);
  if (svcPrompt !== null) {
    const label = ` svc ▶  ${svcPrompt}`;
    const right = `  ^Space/ESC 닫기   Enter 실행    ${time} `;
    const avail = Math.max(0, cols - label.length - right.length - 1);
    return SIG_BG + BLACK + BOLD + label + '█' + ' '.repeat(avail) + right + RST;
  }
  const cwd   = process.cwd();
  const cwdS  = cwd.length > 40 ? '…' + cwd.slice(-39) : cwd;
  const left  = ` Workspace: ${cwdS} `;
  const right = ` ${time} `;
  const mid   = trimText(helpText || 'VOID//ai-launcher', 44);
  const avail = Math.max(0, cols - left.length - right.length);
  const lpad  = Math.max(0, Math.floor((avail - mid.length) / 2));
  const rpad  = Math.max(0, avail - mid.length - lpad);
  return SIG_BG + BLACK + BOLD
    + left + ' '.repeat(lpad) + RED_FG + mid + BLACK + ' '.repeat(rpad) + right + RST;
}

// ── Frame layout ──────────────────────────────────────────
const DEFAULT_HPAD = 2;
const DEFAULT_VPAD = 1;

function computeMargins(cols, rows, hpad, vpad) {
  const topM   = 2 + vpad;
  const botM   = rows - 1 - vpad;
  const leftM  = 2 + hpad;
  const rightM = cols - 1 - hpad;
  return { topM, botM, leftM, rightM };
}

function ptyDims(cols, rows, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  return {
    ptyrows: Math.max(1, botM - topM + 1),
    ptycols: Math.max(1, rightM - leftM + 1),
  };
}

function drawFrame(cols, rows, frame, hpad, vpad) {
  const { topM, botM } = computeMargins(cols, rows, hpad, vpad);
  let s = '';
  s += at(1, 1) + topBar(cols, frame.label, frame.tabs, frame.activeIndex, frame.modeHint);

  const padRow = SIG_FG + BL_V + RST + ' '.repeat(Math.max(0, cols - 2)) + SIG_FG + BL_V + RST;
  for (let r = 2; r < topM; r++) s += at(r, 1) + padRow;
  for (let r = botM + 1; r <= rows - 1; r++) s += at(r, 1) + padRow;

  for (let r = topM; r <= botM; r++) {
    s += at(r, 1)    + SIG_FG + BL_V + RST;
    s += at(r, cols) + SIG_FG + BL_V + RST;
  }

  s += at(rows, 1) + bottomBar(cols, frame.helpText, frame.svcPrompt);
  return s;
}

function enableMargins(cols, rows, hpad, vpad) {
  const { topM, botM, leftM, rightM } = computeMargins(cols, rows, hpad, vpad);
  return (
    `\x1b[${topM};${botM}r` +
    '\x1b[?69h' +
    `\x1b[${leftM};${rightM}s` +
    '\x1b[?6h' +
    '\x1b[H'
  );
}

function disableMargins() {
  return '\x1b[?6l' + '\x1b[?69l' + '\x1b[r';
}

function setupFrame(cols, rows, frame, hpad, vpad) {
  const out =
    disableMargins() +
    '\x1b[2J' +
    drawFrame(cols, rows, frame, hpad, vpad) +
    enableMargins(cols, rows, hpad, vpad);

  process.stdout.write(out);
  return ptyDims(cols, rows, hpad, vpad);
}

function refreshBottomBar(cols, rows, frame, hpad, vpad) {
  const { leftM, rightM } = computeMargins(cols, rows, hpad, vpad);

  // DECSTBM is NOT reset here (it was never cleared) — resetting it caused an
  // unnecessary cursor jump to physical (1,1) every tick.
  const out =
    '\x1b7' +
    '\x1b[?6l' +
    '\x1b[?69l' +
    at(1, 1) + topBar(cols, frame.label, frame.tabs, frame.activeIndex, frame.modeHint) +
    at(rows, 1) + bottomBar(cols, frame.helpText, frame.svcPrompt) +
    '\x1b[?69h' +
    `\x1b[${leftM};${rightM}s` +
    '\x1b[?6h' +
    '\x1b8';

  process.stdout.write(out);
}

function teardownFrame() {
  process.stdout.write(disableMargins() + '\x1b[2J\x1b[H\x1b[?1049l');
}

function makeFrame(label, tabs, activeIndex, modeHint, svcPrompt = null) {
  return {
    label,
    tabs,
    activeIndex,
    modeHint,
    svcPrompt,
    helpText: '^Space svc  Ctrl+A: h/l move  c shell  x close  1-9 jump',
  };
}

function appendBuffer(tab, chunk) {
  tab.buffer += chunk;
  if (tab.buffer.length > MAX_BUFFER) {
    tab.buffer = tab.buffer.slice(-MAX_BUFFER);
  }
}

function makeTitle(command, fallback) {
  const src = command && command.trim() ? command.trim() : fallback;
  return trimText(src, 20);
}

async function runWrapped(tool, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  process.stdout.write('\x1b[?1049h'); // enter alternate screen (isolates scrollback)
  const { ptycols, ptyrows } = setupFrame(cols, rows, makeFrame(label, null, 0, ''), hpad, vpad);
  const term = pty.spawn(tool.command, tool.args || [], {
    name: 'xterm-256color',
    cols: ptycols,
    rows: ptyrows,
    cwd: process.cwd(),
    env,
  });

  const prevRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdin  = data => term.write(data);
  const onResize = () => {
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows    || 24;
    if (nr < 8 || nc < 20) return;
    const d = setupFrame(nc, nr, makeFrame(label, null, 0, ''), hpad, vpad);
    term.resize(d.ptycols, d.ptyrows);
  };

  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);
  term.on('data', data => {
    const filtered = filterPtyData(data);
    process.stdout.write(filtered);
    if (RE_ERASE_DISPLAY.test(data)) {
      const c = process.stdout.columns || 80;
      const r = process.stdout.rows    || 24;
      refreshBottomBar(c, r, makeFrame(label, null, 0, ''), hpad, vpad);
    }
  });

  const barTimer = setInterval(() => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    refreshBottomBar(c, r, makeFrame(label, null, 0, ''), hpad, vpad);
  }, 1000);

  await new Promise(resolve => term.on('exit', () => resolve()));

  clearInterval(barTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);

  teardownFrame();
  return true;
}

async function runWrappedShell(commandLine, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;
  const shell = env.SHELL || '/bin/bash';

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  process.stdout.write('\x1b[?1049h'); // enter alternate screen

  const tabs = [];
  let activeIndex = 0;
  let prefixMode = false;
  let commandMode = false;
  let commandBuffer = '';
  let promptMessage = '';
  let nextId = 1;
  let settled = false;

  const prevRaw = process.stdin.isRaw;

  function currentFrame() {
    const svcPrompt = commandMode ? commandBuffer : null;
    const modeHint  = commandMode ? null : (prefixMode ? 'prefix' : promptMessage);
    return makeFrame(label, tabs, activeIndex, modeHint, svcPrompt);
  }

  function redraw() {
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows || 24;
    const d = setupFrame(nc, nr, currentFrame(), hpad, vpad);
    tabs.forEach(tab => {
      if (!tab.exited) tab.term.resize(d.ptycols, d.ptyrows);
    });
    const active = tabs[activeIndex];
    if (active && active.buffer) process.stdout.write(active.buffer);
  }

  function switchTo(index) {
    if (tabs.length === 0) return;
    activeIndex = (index + tabs.length) % tabs.length;
    promptMessage = '';
    redraw();
  }

  function removeTab(index) {
    if (index < 0 || index >= tabs.length) return;
    const [tab] = tabs.splice(index, 1);
    if (tab && !tab.exited) {
      try { tab.term.kill(); } catch {}
    }
    if (tabs.length === 0) {
      settled = true;
      return;
    }
    if (activeIndex >= tabs.length) activeIndex = tabs.length - 1;
    redraw();
  }

  function spawnTab(command, interactive = false, titleOverride = null) {
    const args = interactive ? ['-i'] : ['-lc', command];
    const dims = ptyDims(process.stdout.columns || 80, process.stdout.rows || 24, hpad, vpad);
    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: dims.ptycols,
      rows: dims.ptyrows,
      cwd: process.cwd(),
      env,
    });

    const tab = {
      id: nextId++,
      title: titleOverride || (interactive ? 'shell' : makeTitle(command, 'svc')),
      command: interactive ? shell : command,
      buffer: '',
      exited: false,
      term,
    };

    term.on('data', data => {
      const filtered = filterPtyData(data);
      appendBuffer(tab, filtered);
      if (tabs[activeIndex] === tab) {
        process.stdout.write(filtered);
        if (RE_ERASE_DISPLAY.test(data)) {
          const c = process.stdout.columns || 80;
          const r = process.stdout.rows    || 24;
          refreshBottomBar(c, r, currentFrame(), hpad, vpad);
        }
      }
    });

    term.on('exit', code => {
      tab.exited = true;
      appendBuffer(tab, `\r\n[process exited: ${code ?? 0}]\r\n`);
      const idx = tabs.indexOf(tab);
      if (idx === -1) return;
      if (tabs.length === 1) {
        tabs.splice(idx, 1);
        settled = true;
        return;
      }
      tabs.splice(idx, 1);
      if (activeIndex >= tabs.length) activeIndex = tabs.length - 1;
      promptMessage = `tab closed: ${tab.title}`;
      redraw();
    });

    tabs.push(tab);
    activeIndex = tabs.length - 1;
    promptMessage = interactive ? `new shell tab: ${tab.title}` : `new tab: ${tab.title}`;
    redraw();
  }

  function handleManagerCommand(line) {
    const input = line.trim();
    commandMode = false;
    commandBuffer = '';

    if (!input) {
      promptMessage = '';
      redraw();
      return;
    }

    if (input === 'help') {
      promptMessage = 'new <cmd> | shell | tab <n> | next | prev | close | list';
      redraw();
      return;
    }
    if (input === 'shell') {
      spawnTab('', true, 'host');
      return;
    }
    if (input === 'next') {
      switchTo(activeIndex + 1);
      return;
    }
    if (input === 'prev') {
      switchTo(activeIndex - 1);
      return;
    }
    if (input === 'close') {
      if (tabs.length === 1) {
        removeTab(0);
      } else {
        removeTab(activeIndex);
      }
      return;
    }
    if (input === 'list') {
      promptMessage = tabs.map((tab, i) => `${i + 1}:${tab.title}`).join(' ');
      redraw();
      return;
    }
    if (input.startsWith('tab ')) {
      const n = Number(input.slice(4).trim());
      if (Number.isInteger(n) && n >= 1 && n <= tabs.length) {
        switchTo(n - 1);
      } else {
        promptMessage = 'invalid tab number';
        redraw();
      }
      return;
    }
    if (input.startsWith('new ')) {
      const cmd = input.slice(4).trim();
      if (!cmd) {
        promptMessage = 'missing command';
        redraw();
        return;
      }
      spawnTab(cmd, false);
      return;
    }

    promptMessage = 'unknown command';
    redraw();
  }

  function finish() {
    if (settled) return;
    settled = true;
    tabs.forEach(tab => {
      if (!tab.exited) {
        try { tab.term.kill(); } catch {}
      }
    });
  }

  const onResize = () => {
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows    || 24;
    if (nr < 8 || nc < 20) return;
    redraw();
  };

  const onStdin = chunk => {
    if (settled) return;
    const data = chunk.toString('utf8');

    // Ctrl+Space or Ctrl+\ : toggle svc mode (VSCode captures Ctrl+Space, so Ctrl+\ is the fallback)
    if (data === '\x00' || data === '\x1c') {
      commandMode = !commandMode;
      commandBuffer = '';
      promptMessage = '';
      redraw();
      return;
    }

    if (commandMode) {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          handleManagerCommand(commandBuffer);
          return;
        }
        if (ch === '\u0003' || ch === '\x1b') {
          commandMode = false;
          commandBuffer = '';
          promptMessage = '';
          redraw();
          return;
        }
        if (ch === '\u007f') {
          commandBuffer = commandBuffer.slice(0, -1);
          redraw();
          continue;
        }
        if (ch >= ' ') {
          commandBuffer += ch;
          redraw();
        }
      }
      return;
    }

    if (prefixMode) {
      prefixMode = false;
      const key = data[0];
      if (key === ':') {
        commandMode = true;
        commandBuffer = '';
        promptMessage = '';
        redraw();
        return;
      }
      if (key === 'h') { switchTo(activeIndex - 1); return; }
      if (key === 'l') { switchTo(activeIndex + 1); return; }
      if (key === 'c') { spawnTab('', true, 'host'); return; }
      if (key === 'x') {
        removeTab(activeIndex);
        if (tabs.length === 0) settled = true;
        return;
      }
      if (key >= '1' && key <= '9') {
        const idx = Number(key) - 1;
        if (idx < tabs.length) switchTo(idx);
        return;
      }
      promptMessage = 'prefix: : cmd, h/l move, c shell, x close, 1-9 jump';
      redraw();
      return;
    }

    if (data === PREFIX_KEY) {
      prefixMode = true;
      promptMessage = '';
      redraw();
      return;
    }

    const active = tabs[activeIndex];
    if (active && !active.exited) active.term.write(chunk);
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);

  spawnTab('', true, 'host');
  if (commandLine && commandLine.trim()) {
    spawnTab(commandLine, false, makeTitle(commandLine, 'svc'));
  } else {
    activeIndex = 0;
    redraw();
  }

  const barTimer = setInterval(() => {
    if (settled) return;
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    refreshBottomBar(c, r, currentFrame(), hpad, vpad);
  }, 1000);

  await new Promise(resolve => {
    const poll = setInterval(() => {
      if (!settled) return;
      clearInterval(poll);
      resolve();
    }, 100);
  });

  clearInterval(barTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);
  finish();
  teardownFrame();
  return true;
}

// ── tmux inner frame ──────────────────────────────────────
// void bars (DECSTBM only, no DECSLRM) on host; tmux runs inside node-pty PTY.
// tmux windows = tabs shown in void top bar via polling.
async function runWrappedTmuxFrame(toolObj, env, label, opts = {}) {
  let pty;
  try { pty = require('node-pty'); } catch { return false; }
  const { spawnSync } = require('child_process');

  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') return false;

  const cols  = process.stdout.columns || 80;
  const rows  = process.stdout.rows    || 24;
  if (rows < 6 || cols < 20) return false;

  // top bar = row 1, content = rows 2..(rows-1), bottom bar = row `rows`
  const ptyrows = rows - 2;
  const ptycols = cols;
  const sock = `void${process.pid}`;

  // strip tmux detection vars so AI tools don't alter their rendering
  const cleanEnv = { ...env };
  for (const k of ['TMUX', 'TMUX_PANE', 'TMUX_PLUGIN_MANAGER_PATH']) delete cleanEnv[k];

  // build -e args for env diff (spawnSync takes separate args — no quoting needed)
  const extraE = [];
  for (const [k, v] of Object.entries(cleanEnv)) {
    if (process.env[k] !== v) extraE.push('-e', `${k}=${v}`);
  }
  // create detached tmux session on isolated socket
  // ponytail: env -u strips TMUX/TMUX_PANE that tmux injects into all child processes
  const create = spawnSync('tmux', [
    '-L', sock,
    'new-session', '-d', '-s', 'm',
    '-x', String(ptycols), '-y', String(ptyrows),
    ...extraE,
    'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'TMUX_PLUGIN_MANAGER_PATH',
    toolObj.command, ...(toolObj.args || []),
  ], { encoding: 'utf8' });
  if (create.status !== 0) return false;

  // configure: hide status bar, Ctrl+A prefix, void-style keybindings
  const cfgs = [
    ['set-option', '-t', 'm', 'status', 'off'],
    ['set-option', '-t', 'm', 'prefix', 'C-a'],
    ['set-option', '-t', 'm', 'default-terminal', 'xterm-256color'],
    ['bind-key', '-T', 'prefix', 'h', 'previous-window'],
    ['bind-key', '-T', 'prefix', 'l', 'next-window'],
    ['bind-key', '-T', 'prefix', 'c', 'new-window'],
    ['bind-key', '-T', 'prefix', 'x', 'kill-window'],
    ...['1','2','3','4','5','6','7','8','9'].map(n => ['bind-key', '-T', 'prefix', n, 'select-window', '-t', `:${n}`]),
  ];
  for (const args of cfgs) spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8' });

  process.stdout.write('\x1b[?1049h'); // alt screen

  let tabs = [];
  let activeIdx = 0;

  function makeInnerFrame() {
    return { label, tabs, activeIndex: activeIdx, modeHint: null, svcPrompt: null,
      helpText: 'Ctrl+A: h/l tab  c new  x close  1-9 jump' };
  }

  function setupBars(c, r) {
    const fr = makeInnerFrame();
    process.stdout.write(
      '\x1b[?6l\x1b[?69l\x1b[r' +
      '\x1b[2J' +
      at(1, 1) + topBar(c, fr.label, fr.tabs, fr.activeIndex, fr.modeHint) +
      at(r, 1) + bottomBar(c, fr.helpText, fr.svcPrompt) +
      `\x1b[2;${r - 1}r` +    // DECSTBM only — no DECSLRM
      '\x1b[?6h\x1b[H'
    );
  }

  function refreshBars(c, r) {
    const fr = makeInnerFrame();
    process.stdout.write(
      '\x1b7' +
      '\x1b[?6l\x1b[?69l' +
      at(1, 1) + topBar(c, fr.label, fr.tabs, fr.activeIndex, fr.modeHint) +
      at(r, 1) + bottomBar(c, fr.helpText, fr.svcPrompt) +
      '\x1b[?6h' +
      '\x1b8'
    );
  }

  setupBars(cols, rows);

  // attach via node-pty — tmux handles all AI tool escape sequences internally
  const term = pty.spawn('tmux', ['-L', sock, 'attach-session', '-t', 'm'], {
    name: 'xterm-256color',
    cols: ptycols,
    rows: ptyrows,
    cwd: process.cwd(),
    env: cleanEnv,
  });

  const prevRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdin = data => term.write(data);
  const onResize = () => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    if (r < 6 || c < 20) return;
    term.resize(c, Math.max(1, r - 2));
    setupBars(c, r);
  };

  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);

  term.on('data', data => {
    const filtered = filterPtyData(data);
    process.stdout.write(filtered);
    // tmux emits \x1b[2J on full redraws — immediately restore bars
    if (RE_ERASE_DISPLAY.test(filtered)) {
      const c = process.stdout.columns || 80;
      const r = process.stdout.rows    || 24;
      refreshBars(c, r);
    }
  });

  // poll tmux window list for void top bar tab display
  const barTimer = setInterval(() => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    const wout = spawnSync('tmux', ['-L', sock, 'list-windows', '-F', '#{window_index}|#{window_name}|#{window_active}'], { encoding: 'utf8' });
    if (wout.status === 0 && wout.stdout) {
      const lines = wout.stdout.trim().split('\n').filter(Boolean);
      tabs = lines.map(l => ({ title: l.split('|')[1] || '?', exited: false }));
      const ai = lines.findIndex(l => l.endsWith('|1'));
      activeIdx = ai >= 0 ? ai : 0;
    }
    refreshBars(c, r);
  }, 1000);

  await new Promise(resolve => term.on('exit', resolve));

  clearInterval(barTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);

  process.stdout.write('\x1b[?6l\x1b[?69l\x1b[r\x1b[2J\x1b[H\x1b[?1049l');
  spawnSync('tmux', ['-L', sock, 'kill-server'], { encoding: 'utf8' });
  return true;
}

// ── tmux 기반 래퍼 (전체화면) ─────────────────────────────
function runTmuxWrapped(toolObj, env, label) {
  const { spawnSync } = require('child_process');

  // tmux 가용 여부
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const sess    = `void-${process.pid}`;
  const cols    = process.stdout.columns || 80;
  const rows    = process.stdout.rows    || 24;

  // 3.2+ → status 2 (상+하 바)
  const verM      = (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout || '').match(/(\d+)\.(\d+)/);
  const [maj, min] = verM ? [+verM[1], +verM[2]] : [2, 0];
  const dual      = maj > 3 || (maj === 3 && min >= 2);

  // 현재 env와 다른 값만 -e 로 전달
  const extraE = [];
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] !== v) extraE.push('-e', `${k}=${v}`);
  }

  // 명령어 문자열 (shell-safe)
  const cmdStr = [toolObj.command, ...(toolObj.args || [])]
    .map(a => /[\s"'`\\$!]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)
    .join(' ');

  // 세션 생성 (detached)
  const create = spawnSync('tmux', [
    'new-session', '-d',
    '-s', sess,
    '-x', String(cols),
    '-y', String(rows),
    ...extraE,
    cmdStr,
  ], { encoding: 'utf8' });

  if (create.status !== 0) return false;

  // 상태 바 포맷 (void 그린 스타일)
  const safeLabel = label.replace(/[#"\\[\]]/g, ' ').trim();
  const topFmt = `#[fg=black,bg=green,bold,fill=green] Wrapper >_  ${safeLabel} #[align=right]#[fg=black,bg=colour28] #{pane_current_path} `;
  const botFmt = `#[fg=colour250,bg=colour235,fill=colour235] Ctrl+C 종료 #[align=right] %H:%M `;

  const setOpts = [
    ['status',          dual ? '2' : '1'],
    ['status-interval', '1'],
    ['status-format[0]', topFmt],
    ...(dual ? [['status-format[1]', botFmt]] : []),
    ['pane-border-style',        'fg=green'],
    ['pane-active-border-style', 'fg=green'],
    ['pane-border-lines',        'heavy'],
    ['prefix',                   'None'],   // Ctrl+B 충돌 방지
  ];

  for (const [opt, val] of setOpts) {
    spawnSync('tmux', ['set-option', '-t', sess, opt, val], { encoding: 'utf8' });
  }

  // 세션에 attach (블로킹)
  spawnSync('tmux', ['attach-session', '-t', sess], { stdio: 'inherit' });

  // 도구 종료 후 세션 정리
  spawnSync('tmux', ['kill-session', '-t', sess], { encoding: 'utf8' });

  return true;
}

module.exports = { runWrapped, runWrappedShell, runWrappedTmuxFrame, runTmuxWrapped };
