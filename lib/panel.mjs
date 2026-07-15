import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mailbox = require('./mcp-hub.js'); // pure require — no MCP SDK touched

// ── args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const sockIdx = args.indexOf('--sock');
const sock = sockIdx >= 0 ? args[sockIdx + 1] : null;
if (!sock) { process.stderr.write('panel: --sock required\n'); process.exit(1); }

// ── tmux helpers ──────────────────────────────────────────
function tmux(...a) {
  return spawnSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
}

function listWindows() {
  const r = tmux('list-windows', '-F', '#{window_index}|#{window_name}|#{window_active}');
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(l => {
    const [idx, name, active] = l.split('|');
    return { idx: parseInt(idx), name: name || '?', active: active === '1' };
  });
}

// ── config: tool list ─────────────────────────────────────
function loadTools() {
  try {
    const cfg = yaml.load(readFileSync(join(__dirname, '..', 'config.yml'), 'utf8'));
    return (cfg.tools || []).map(t => ({ name: t.name, command: t.command, args: t.args || [] }));
  } catch { return []; }
}

const TOOLS = loadTools();
const isWin = process.platform === 'win32';
const cmdExe = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';

function quoteCmdArg(arg) {
  const value = String(arg);
  return /[\s&|<>()^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ── tab spawning ──────────────────────────────────────────
function hubUp() {
  return existsSync(join(mailbox.mailboxDir(sock), 'hub.port'));
}

// Open a tool in its native fullscreen TUI. When the MCP hub is running and the
// tool is claude/codex, wrap it so the pane self-injects a voidhub connection;
// otherwise keep the original plain launch (unchanged for agy and no-hub cases).
function openFullscreen(t) {
  const mcpExec = hubUp() ? mailbox.buildMcpExec({ command: t.command, args: t.args }, sock, mailbox.mailboxDir(sock)) : null;
  if (mcpExec && !isWin) {
    tmux('new-window', '-n', t.name, 'bash', '-c', mcpExec);
  } else if (isWin) {
    // tmux-windows hosts native console apps through cmd.exe. Avoid the Unix
    // env/bash launch path so new Claude/Codex tabs work on the host CMD.
    // tmux injects TMUX variables into every pane; remove them for AI CLIs.
    const commandLine = [t.command, ...t.args].map(quoteCmdArg).join(' ');
    const clearTmuxEnv = 'set "TMUX=" && set "TMUX_PANE=" && set "TMUX_PLUGIN_MANAGER_PATH="';
    tmux('new-window', '-n', t.name, cmdExe, '/d', '/c', `${clearTmuxEnv} && ${commandLine}`);
  } else {
    tmux('new-window', '-n', t.name,
      'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'TMUX_PLUGIN_MANAGER_PATH',
      t.command, ...t.args);
  }
}

// Open a tool as a chat-runner mailbox tab. TMUX_PANE is intentionally left
// inherited so chat-runner can self-detect its window index.
function openChat(t) {
  tmux('new-window', '-n', `chat:${t.name}`,
    process.execPath, join(__dirname, 'chat-runner.js'),
    '--binary', t.command, '--sock', sock);
}

// ── components ────────────────────────────────────────────
const e = React.createElement;

function Header({ title }) {
  return e(Box, { flexDirection: 'column' },
    e(Box, { backgroundColor: 'green' },
      e(Text, { color: 'black', bold: true }, ` ▸ void  ${title} `)
    ),
    e(Text, null, '')
  );
}

function Item({ label, active, hint }) {
  return e(Box, null,
    e(Text,
      active ? { color: 'black', backgroundColor: 'green', bold: true } : { color: 'white' },
      ` ${active ? '▶' : ' '} ${label} `
    ),
    hint ? e(Text, { color: 'gray' }, `  ${hint}`) : null
  );
}

function Footer({ text }) {
  return e(Box, { flexDirection: 'column' },
    e(Text, null, ''),
    e(Text, { color: 'gray' }, ` ${text} `)
  );
}

// ── Tab mode ──────────────────────────────────────────────
function TabMode({ onNewTab, onSend, onHome, onExit }) {
  const [windows, setWindows] = useState(() => listWindows());
  const [cursor, setCursor] = useState(() => {
    const ws = listWindows();
    const ai = ws.findIndex(w => w.active);
    return ai >= 0 ? ai : 0;
  });

  useEffect(() => {
    const t = setInterval(() => setWindows(listWindows()), 1000);
    return () => clearInterval(t);
  }, []);

  // synthetic items: windows + new tab + home
  const items = [
    ...windows.map(w => ({ type: 'window', ...w })),
    { type: 'new',  idx: -1, name: '＋  new tab' },
    { type: 'home', idx: -2, name: '⌂   home (exit to launcher)' },
  ];

  useInput((input, key) => {
    if (key.upArrow)   setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(items.length - 1, c + 1));
    if (key.return) {
      const item = items[cursor];
      if (!item) return;
      if (item.type === 'window') { tmux('select-window', '-t', String(item.idx)); onExit(); }
      else if (item.type === 'new')  onNewTab();
      else if (item.type === 'home') onHome();
    }
    if (input === 'n') onNewTab();
    if (input === 'm') onSend();
    if (input === 'h') onHome();
    if (input === 'x') {
      const item = items[cursor];
      if (item?.type === 'window') {
        tmux('kill-window', '-t', String(item.idx));
        setWindows(listWindows());
        setCursor(c => Math.max(0, c - 1));
      }
    }
    if (input === 'q' || key.escape) onExit();
  });

  return e(Box, { flexDirection: 'column' },
    e(Header, { title: 'Control Panel' }),
    ...items.map((item, i) =>
      e(Item, { key: item.idx, label: item.name, active: i === cursor,
        hint: item.type === 'window' && item.active ? '(current)' : null })
    ),
    e(Footer, { text: '↑↓ move  Enter: select  n: new  m: message  x: close  h: home  q: back' })
  );
}

// ── Send-message mode ─────────────────────────────────────
// Deliver a message to a tab that has a mailbox (chat-runner tab, or a
// claude/codex tab connected to the hub). Minimal controlled text input built
// on Ink useInput — no extra dependencies.
function SendMode({ onBack, onExit }) {
  const windows = listWindows();
  const mset = new Set(mailbox.mailboxWindows(sock));
  const targets = windows.filter(w => mset.has(String(w.idx)));

  const [phase, setPhase]   = useState('pick'); // 'pick' | 'type'
  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState(null);
  const [text, setText]     = useState('');

  useInput((input, key) => {
    if (phase === 'pick') {
      if (targets.length === 0) { if (key.escape || input === 'q' || key.return) onBack(); return; }
      if (key.upArrow)   setCursor(c => Math.max(0, c - 1));
      if (key.downArrow) setCursor(c => Math.min(targets.length - 1, c + 1));
      if (key.escape || input === 'q') { onBack(); return; }
      if (key.return && targets[cursor]) { setTarget(targets[cursor]); setPhase('type'); }
      return;
    }
    // phase === 'type'
    if (key.escape) { onBack(); return; }
    if (key.return) {
      if (text.trim() && target) {
        mailbox.appendMessage(
          mailbox.mailboxFile(sock, target.idx),
          { from: 'panel', text: text.trim(), ts: Date.now() },
        );
      }
      onExit();
      return;
    }
    if (key.backspace || key.delete) { setText(t => t.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) setText(t => t + input);
  });

  if (phase === 'pick') {
    return e(Box, { flexDirection: 'column' },
      e(Header, { title: 'Send Message' }),
      targets.length === 0
        ? e(Text, { color: 'gray' }, ' 메시지를 받을 수 있는 탭이 없습니다 (채팅/MCP 탭 필요) ')
        : null,
      ...targets.map((w, i) =>
        e(Item, { key: w.idx, label: `${w.idx}: ${w.name}`, active: i === cursor })
      ),
      e(Footer, { text: targets.length === 0 ? 'Esc/q: back' : '↑↓ move  Enter: pick target  q/Esc: back' })
    );
  }

  return e(Box, { flexDirection: 'column' },
    e(Header, { title: `Send → ${target.idx}: ${target.name}` }),
    e(Box, null,
      e(Text, { color: 'green' }, ' > '),
      e(Text, null, text),
      e(Text, { color: 'gray' }, '▌')
    ),
    e(Footer, { text: 'type message  Enter: send  Esc: cancel' })
  );
}

// ── Tool mode ─────────────────────────────────────────────
function ToolMode({ onBack, onExit }) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow)   setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(TOOLS.length - 1, c + 1));
    if (key.return) {
      const t = TOOLS[cursor];
      if (t) openFullscreen(t);
      onExit();
    }
    if (input === 'c') {
      const t = TOOLS[cursor];
      if (t) openChat(t);
      onExit();
    }
    if (input === 'q' || key.escape) onBack();
  });

  return e(Box, { flexDirection: 'column' },
    e(Header, { title: 'New Tab' }),
    ...TOOLS.map((t, i) =>
      e(Item, { key: t.name, label: `${t.name}  (${t.command})`, active: i === cursor })
    ),
    e(Footer, { text: '↑↓ move  Enter: fullscreen  c: chat tab  q/Esc: back' })
  );
}

// ── Root ──────────────────────────────────────────────────
function Panel() {
  const { exit } = useApp();
  const [mode, setMode] = useState('tabs');

  function goHome() {
    tmux('kill-server');
    exit();
  }

  if (mode === 'tools') {
    return e(ToolMode, { onBack: () => setMode('tabs'), onExit: exit });
  }
  if (mode === 'send') {
    return e(SendMode, { onBack: () => setMode('tabs'), onExit: exit });
  }
  return e(TabMode, { onNewTab: () => setMode('tools'), onSend: () => setMode('send'), onHome: goHome, onExit: exit });
}

const { waitUntilExit } = render(e(Panel));
await waitUntilExit();
