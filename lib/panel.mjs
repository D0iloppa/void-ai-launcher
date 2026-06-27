import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
function TabMode({ onNewTab, onHome, onExit }) {
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
    e(Footer, { text: '↑↓ move  Enter: select  n: new  x: close tab  h: home  q: back' })
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
      if (t) {
        tmux('new-window', '-n', t.name,
          'env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'TMUX_PLUGIN_MANAGER_PATH',
          t.command, ...t.args
        );
      }
      onExit();
    }
    if (input === 'q' || key.escape) onBack();
  });

  return e(Box, { flexDirection: 'column' },
    e(Header, { title: 'New Tab' }),
    ...TOOLS.map((t, i) =>
      e(Item, { key: t.name, label: `${t.name}  (${t.command})`, active: i === cursor })
    ),
    e(Footer, { text: '↑↓ move  Enter: open  q/Esc: back' })
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
  return e(TabMode, { onNewTab: () => setMode('tools'), onHome: goHome, onExit: exit });
}

const { waitUntilExit } = render(e(Panel));
await waitUntilExit();
