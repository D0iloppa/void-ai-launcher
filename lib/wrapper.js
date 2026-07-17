'use strict';

// ── ANSI ──────────────────────────────────────────────────
// SIG_BG/SIG_FG default to void-signature's green but are reassigned by
// applyTheme() (called once from launcher.js at boot, alongside
// ui.setColors()) so this module's frame chrome follows the active theme
// pack instead of staying hardcoded — every existing usage site below is
// unchanged since these stay plain string bindings, just no longer const.
let SIG_BG = '\x1b[48;2;0;230;118m';
let SIG_FG = '\x1b[38;2;0;230;118m';
function applyTheme(palette) {
  if (!palette || !palette.signal) return;
  try {
    const { fg, bg } = require('./theme');
    SIG_FG = fg(palette.signal);
    SIG_BG = bg(palette.signal);
  } catch {}
}
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

// Shares void-key-debug.log with xtermFrame.js's runXtermWrapped tracer so a
// VOID_DEBUG_KEYS=1 run shows which wrapper path actually handled the session —
// this plain fallback forwards raw bytes to the child with no PgUp/PgDn handling.
const keyDebugLog = process.env.VOID_DEBUG_KEYS === '1'
  ? (() => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const logPath = path.join(os.tmpdir(), 'void-key-debug.log');
      return msg => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
    })()
  : null;

async function runWrapped(tool, env, label, opts = {}) {
  if (keyDebugLog) keyDebugLog(`runWrapped (plain, no PgUp handling) ENTER tool=${tool && tool.command}`);
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return false;
  }

  const hpad = typeof opts.hpad === 'number' ? opts.hpad : DEFAULT_HPAD;
  const vpad = typeof opts.vpad === 'number' ? opts.vpad : DEFAULT_VPAD;
  const liveBars = opts.liveBars !== false;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;
  if (rows < 8 || cols < 20) return false;

  process.stdout.write('\x1b[?1049h'); // enter alternate screen (isolates scrollback)
  const { ptycols, ptyrows } = setupFrame(cols, rows, makeFrame(label, null, 0, ''), hpad, vpad);
  // On Windows, npm-global commands are .cmd shims — ConPTY can't exec them directly.
  // Wrap with cmd.exe so CreateProcess gets a real executable.
  const ptyCmd  = process.platform === 'win32' ? 'cmd' : tool.command;
  const ptyArgs = process.platform === 'win32'
    ? ['/c', tool.command, ...(tool.args || [])]
    : (tool.args || []);

  let term;
  try {
    term = pty.spawn(ptyCmd, ptyArgs, {
      name: 'xterm-256color',
      cols: ptycols,
      rows: ptyrows,
      cwd: process.cwd(),
      env,
    });
  } catch (e) {
    process.stdout.write('\x1b[?1049l'); // exit alt screen before giving up
    return false;
  }

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

  const barTimer = liveBars ? setInterval(() => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    refreshBottomBar(c, r, makeFrame(label, null, 0, ''), hpad, vpad);
  }, 1000) : null;

  await new Promise(resolve => term.on('exit', () => resolve()));

  if (barTimer) clearInterval(barTimer);
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
    let term;
    try {
      term = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: dims.ptycols,
        rows: dims.ptyrows,
        cwd: process.cwd(),
        env,
      });
    } catch {
      return null;
    }

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

  const firstTab = spawnTab('', true, 'host');
  if (!firstTab && tabs.length === 0) {
    // node-pty spawn failed (e.g. missing native binary) — fall back to plain exec
    process.stdin.removeListener('data', onStdin);
    process.stdout.removeListener('resize', onResize);
    if (!prevRaw) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?1049l');
    return false;
  }
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

// ── tmux 풀스크린 세션 (display-popup 패널 지원) ──────────────
function runTmuxSession(toolObj, env, label, opts = {}) {
const { spawnSync, spawn } = require('child_process');

  const path = require('path');
  const fs   = require('fs');
  const hub  = require('./mcp-hub'); // pure require — never touches the MCP SDK
  const { storageDir } = require('./storage');
  const isWin = process.platform === 'win32';
  const dbgPath = path.join(storageDir(), 'tmux-debug.log');
  const dbgLog = msg => { try { fs.appendFileSync(dbgPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

  // TMUX 환경변수 제거 — AI 툴이 tmux 감지하지 못하도록
  const cleanEnv = { ...env };
  for (const k of ['TMUX', 'TMUX_PANE', 'TMUX_PLUGIN_MANAGER_PATH']) delete cleanEnv[k];

  const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8', env: cleanEnv });
  dbgLog(`START tool=${toolObj.command} isWin=${isWin} isTTY=${process.stdin.isTTY}/${process.stdout.isTTY}`);
  dbgLog(`tmux -V status=${tmuxVersion.status} out=${(tmuxVersion.stdout || '').trim()} err=${(tmuxVersion.stderr || '').trim()}`);
  if (tmuxVersion.status !== 0) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const sock = `void${process.pid}`;
  const mboxDir = hub.mailboxDir(sock);
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;

  const statusRows = 1;

  const extraE = [];
  for (const [k, v] of Object.entries(cleanEnv)) {
    if (process.env[k] !== v) extraE.push('-e', `${k}=${v}`);
  }

  // attach 전에 tool이 먼저 시작되면 터미널 쿼리([6n 등)에 응답할 클라이언트가 없어
  // 렌더링이 안 됨(레이스). 고정 sleep 대신 wait-for 채널로 동기화한다: pane은 채널이
  // 신호될 때까지 블록하고, attach 클라이언트 연결이 확인된 뒤에만 tool이 시작된다.
  const safeCmd = [
    'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'TMUX_PLUGIN_MANAGER_PATH',
    toolObj.command, ...(toolObj.args || []),
  ].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

  // MCP hub: if the SDK is installed, start a local HTTP hub (separate process)
  // and let claude/codex panes self-inject a connection to it. The hub loads
  // its SDK lazily, so it boots in parallel with the tmux session. If the SDK
  // is absent we skip the hub entirely — chat-runner mailbox tabs still work.
  let hubProc = null;
  let mcpExec = null;
  try {
    require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
    fs.mkdirSync(mboxDir, { recursive: true });
    hubProc = spawn(process.execPath, [path.join(__dirname, 'mcp-hub.js'), '--sock', sock], { stdio: 'ignore' });
    hubProc.unref();
    mcpExec = hub.buildMcpExec(toolObj, sock, mboxDir); // null for agy/unsupported
  } catch { /* SDK not installed → graceful fallback, mailbox-only */ }

  const chan = `void_ready_${process.pid}`;
  const paneRun = mcpExec ? mcpExec : `exec ${safeCmd}`;
  const paneCmd = `tmux -L ${sock} wait-for ${chan}; ${paneRun}`;

  // Windows: cmd.exe separator (&) instead of bash (;), no 'env -u', no 'exec'.
  // mcpExec is a bash-only script — skip it on Windows and run the tool directly.
  let createPaneArgs;
  if (isWin) {
    const winToolArgs = (toolObj.args || []).map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');
    const winPaneRun = `${toolObj.command}${winToolArgs ? ' ' + winToolArgs : ''}`;
    // Do not launch a nested `cmd /k` for Codex: it leaves a bare command
    // prompt in the pane when Codex fails to start. tmux injects TMUX/TMUX_PANE
    // for every pane even when its server was started from cleanEnv, so clear
    // them immediately before launching the AI CLI.
    const clearTmuxEnv = 'set "TMUX=" && set "TMUX_PANE=" && set "TMUX_PLUGIN_MANAGER_PATH="';
    const winPaneCmd = `tmux -L ${sock} wait-for ${chan} && ${clearTmuxEnv} && ${winPaneRun}`;
    createPaneArgs = [process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', '/d', '/c', winPaneCmd];
  } else {
    createPaneArgs = ['bash', '-c', paneCmd];
  }

  const create = spawnSync('tmux', [
    '-L', sock,
    'new-session', '-d', '-s', 'm',
    '-x', String(cols), '-y', String(rows - statusRows),
    ...extraE,
    ...createPaneArgs,
  ], { encoding: 'utf8', env: cleanEnv });
  dbgLog(`new-session paneArgs=${JSON.stringify(createPaneArgs)} extraE_count=${extraE.length}`);
  dbgLog(`new-session status=${create.status} stdout=${(create.stdout || '').trim()} stderr=${(create.stderr || '').trim()}`);

  if (create.status !== 0) {
    // tmux 세션 생성 실패 시에도 이미 띄운 허브/메일함은 정리한다.
    if (hubProc) { try { hubProc.kill('SIGTERM'); } catch {} }
    try { fs.rmSync(mboxDir, { recursive: true, force: true }); } catch {}
    return false;
  }

  // 이 시점부터 detached 서버가 살아있다. attach 이전에 중단(SIGINT/크래시 등)되어도
  // 고아 서버가 남지 않도록 정리를 보장한다. sock은 이번 실행 고유(void<pid>)이므로
  // 사용자의 기존 tmux 서버/세션은 절대 건드리지 않는다.
  let cleaned = false;
  const killServer = () => {
    if (cleaned) return;
    cleaned = true;
    spawnSync('tmux', ['-L', sock, 'kill-server'], { encoding: 'utf8', env: cleanEnv });
    if (hubProc) { try { hubProc.kill('SIGTERM'); } catch {} }
    try { fs.rmSync(mboxDir, { recursive: true, force: true }); } catch {}
  };
  const onSignal = () => { killServer(); process.exit(130); };
  // SIGHUP: 터미널/탭이 닫히면 attach 클라이언트와 함께 이 프로세스도 받는다. 핸들러가
  // 없으면 기본 동작으로 즉시 종료돼 finally가 못 돌고 서버가 고아로 남는다.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', killServer);

  try {
    const panelPath = path.join(__dirname, 'panel.mjs');

    const colors = opts.colors || {};
    const sig    = colors.signal    || '#00e676';
    const sigDim = colors.signalDim || '#003d1f';
    const black  = colors.bg        || '#000000';

    // void >_  |  ▪ TabName |  ...  Workspace: /path
    // Ink's control panel needs Node raw mode, which tmux-windows panes do
    // not expose. Use tmux's own window picker on Windows instead: it runs
    // inside tmux, never creates a child pane, and Escape cleanly closes it.
    const panelBind = isWin
      ? ['bind-key', '-n', 'C-Space', 'choose-tree', '-w']
      : ['bind-key', '-n', 'C-Space', `split-window -v -l 14 '${process.execPath} "${panelPath}" --sock ${sock}'`];
    const homeBind = isWin
      ? ['bind-key', '-n', 'C-\\', 'detach-client']
      : null;

    const cfgs = [
      ['set-option', 'remain-on-exit', 'on'],
      ['set-option', 'status',                       'on'],
      ['set-option', 'status-position',              'top'],
      ['set-option', 'status-interval',              '1'],
      ['set-option', 'status-style',                 `fg=${black},bg=${sig},bold`],
      ['set-option', 'status-left',                  ' void >_  | '],
      ['set-option', 'status-left-length',           '40'],
      ['set-option', 'status-right',                 ' Workspace: #{pane_current_path} '],
      ['set-option', 'status-right-length',          '80'],
      ['set-option', 'window-status-separator',      ''],
      ['set-option', 'window-status-format',         ` #[fg=${sigDim}]▪ #[fg=${black}]#W |`],
      ['set-option', 'window-status-current-format', ` #[fg=${sig}]▪ #[fg=${black}]#W |`],
      ['set-option', 'window-status-current-style',  `fg=${black},bg=${sigDim},bold`],
      ['set-option', 'prefix',  'None'],
      ['set-option', 'prefix2', 'None'],
      ['set-option', 'default-terminal', 'xterm-256color'],
      panelBind,
      ...(homeBind ? [homeBind] : []),
    ];

    for (const a of cfgs) spawnSync('tmux', ['-L', sock, ...a], { encoding: 'utf8', env: cleanEnv });

    // 클라이언트 연결을 폴링해 확인되면 wait-for -S로 pane 블록을 해제한다. 백그라운드로
    // 돌면서 아래 blocking attach와 병행. 5초 내 미확인 시에도 신호를 보내(fallback) tool이
    // 영구 블록되지 않게 한다.
    // Poller: signals the pane's wait-for once a client has attached.
    // On Windows bash is unreliable — use a Node.js child process instead.
    let poller;
    if (isWin) {
      // tmux-windows reports its final client dimensions shortly after attach.
      // Starting a full-screen TUI before that resize completes makes Claude
      // render for the initial small pane and leaves its layout scrambled.
      const settleMs = 1500;
      const pollerCode = `const {spawnSync}=require('child_process'),sock=${JSON.stringify(sock)},chan=${JSON.stringify(chan)},settleMs=${JSON.stringify(settleMs)},sa=new Int32Array(new SharedArrayBuffer(4));for(let i=0;i<100;i++){const r=spawnSync('tmux',['-L',sock,'list-clients','-t','m'],{encoding:'utf8'});if(r.status===0&&r.stdout.trim()){if(settleMs>0)Atomics.wait(sa,0,0,settleMs);break;}Atomics.wait(sa,0,0,50);}spawnSync('tmux',['-L',sock,'wait-for','-S',chan]);`;
      poller = spawn(process.execPath, ['--eval', pollerCode], { stdio: 'ignore', env: cleanEnv });
    } else {
      poller = spawn('bash', ['-c',
        `for i in $(seq 1 100); do ` +
          `if tmux -L ${sock} list-clients -t m 2>/dev/null | grep -q .; then break; fi; ` +
          `sleep 0.05; ` +
        `done; ` +
        `tmux -L ${sock} wait-for -S ${chan} 2>/dev/null`,
      ], { stdio: 'ignore' });
    }
    poller.unref();

    // 풀스크린 attach (블로킹)
    const attachResult = spawnSync('tmux', ['-L', sock, 'attach-session', '-t', 'm'], { stdio: 'inherit', env: cleanEnv });
    dbgLog(`attach-session status=${attachResult.status}`);
    if (attachResult.status !== 0) {
      try {
        dbgLog(`attach failed: tool=${toolObj.command} status=${attachResult.status}`);
        const sessionsDump = spawnSync('tmux', ['-L', sock, 'list-sessions'], { encoding: 'utf8', env: cleanEnv });
        dbgLog(`list-sessions status=${sessionsDump.status} out=${(sessionsDump.stdout || '').trim()} err=${(sessionsDump.stderr || '').trim()}`);
        const panesDump = spawnSync('tmux', ['-L', sock, 'list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index} dead=#{pane_dead} pid=#{pane_pid} cmd=#{pane_current_command} path=#{pane_current_path}'], { encoding: 'utf8', env: cleanEnv });
        dbgLog(`list-panes status=${panesDump.status} out=${(panesDump.stdout || '').trim()} err=${(panesDump.stderr || '').trim()}`);
        const paneDump = spawnSync('tmux', ['-L', sock, 'capture-pane', '-e', '-p', '-S', '-200', '-t', 'm:0.0'], { encoding: 'utf8', env: cleanEnv });
        dbgLog(`capture-pane status=${paneDump.status} err=${(paneDump.stderr || '').trim()}`);
        if (paneDump.stdout) {
          fs.appendFileSync(dbgPath, `[${new Date().toISOString()}] attach-failed pane dump start\n${paneDump.stdout}\n[${new Date().toISOString()}] attach-failed pane dump end\n`);
        }
      } catch {}
      return false;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    process.removeListener('exit', killServer);
    killServer();
  }
  return true;
}

module.exports = {
  runWrapped,
  runWrappedShell,
  runTmuxSession,
  applyTheme,
};
