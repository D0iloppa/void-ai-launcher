#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'config.yml');
const config     = yaml.load(fs.readFileSync(configPath, 'utf8'));

const { loadTheme, makeColors } = require('./lib/theme');
const { getLast, saveLast, appendHistory, getHistory } = require('./lib/storage');
const { runTool }    = require('./lib/runner');
const ui             = require('./lib/ui');

// config.json 미존재 시 기본 스키마 자동 생성
require('./lib/config');

const palette = loadTheme(config);
const c       = makeColors(palette);
ui.setColors(c);

const argv = process.argv.slice(2);

// ── 유틸 ─────────────────────────────────────────────────

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function findTool(name) {
  return config.tools.find(t =>
    t.name.toLowerCase()    === name.toLowerCase() ||
    t.command.toLowerCase() === name.toLowerCase()
  );
}

async function launchTool(tool, isAnon) {
  saveLast({ toolName: tool.name, isAnon });
  appendHistory({ toolName: tool.name, isAnon });
  await runTool(tool, isAnon, c);
}

// ── args 직행 ─────────────────────────────────────────────

async function handleArgs(argv) {
  const [cmd, ...rest] = argv;

  switch (cmd.toLowerCase()) {
    case 'prompt': {
      const { promptMode } = require('./lib/prompt');
      await promptMode(rest.join(' '), config, c);
      return;
    }
    case 'tokens': {
      const { tokensMenu } = require('./lib/tokens');
      await tokensMenu(c);
      return;
    }
    case 'sessions': {
      const { sessionsMenu } = require('./lib/sessions');
      await sessionsMenu(config, c);
      return;
    }
    default: {
      const tool = findTool(cmd);
      if (!tool) {
        process.stderr.write(c.warn + `오류: '${cmd}' 를 찾을 수 없습니다.\n` + c.RESET);
        process.exit(1);
      }
      const isAnon = rest.includes('--anon') || rest.includes('-a');
      await launchTool(tool, isAnon);
    }
  }
}

// ── 메뉴 트리 ─────────────────────────────────────────────

async function showModeMenu(tool) {
  const { hasTmux } = require('./lib/sessions');
  const tmux = hasTmux();
  const items = [
    { key: '1', label: '일반 실행' },
    { key: '2', label: '익명 모드',  desc: 'tmp HOME, 종료시 삭제' },
    { key: '3', label: 'tmux 세션', desc: tmux ? '' : '(tmux 없음)', disabled: !tmux },
  ];
  const sel = await ui.menu(tool.name, items, { back: true });
  if (!sel) return showToolsMenu();

  if (sel.key === '3') {
    const { createSession } = require('./lib/sessions');
    await createSession(tool, c);
  } else {
    await launchTool(tool, sel.key === '2');
  }
}

async function showToolsMenu() {
  const { tools } = config;
  const items = tools.map((t, i) => ({ key: String(i + 1), label: t.name, desc: t.command }));
  const sel = await ui.menu('AI Tools', items, { back: true });
  if (!sel) return showMainMenu();
  await showModeMenu(tools[Number(sel.key) - 1]);
}

async function showHistoryMenu() {
  const history = getHistory().slice(0, 9);
  if (history.length === 0) {
    await ui.message('실행 이력이 없습니다.');
    return showMainMenu();
  }
  const items = history.map((h, i) => ({
    key: String(i + 1),
    label: `${h.toolName}${h.isAnon ? ' [익명]' : ''}`,
    desc: timeSince(h.timestamp),
  }));
  const sel = await ui.menu('History', items, { back: true });
  if (!sel) return showMainMenu();
  const h    = history[Number(sel.key) - 1];
  const tool = findTool(h.toolName);
  if (tool) await launchTool(tool, h.isAnon);
}

async function showMainMenu() {
  const last     = getLast();
  const lastDesc = last
    ? `${last.toolName}${last.isAnon ? ' [익명]' : ''} · ${timeSince(last.timestamp)}`
    : null;

  const items = [
    { key: 'q', label: 'Quick Launch', desc: lastDesc || '이력 없음', disabled: !last },
    { key: '1', label: 'AI Tools' },
    { key: '2', label: 'Prompt',   desc: 'Anthropic / OpenAI 직접 호출' },
    { key: '3', label: 'Sessions', desc: 'tmux / node-pty' },
    { key: '4', label: 'Tokens',   desc: 'API 토큰 관리' },
    { key: '5', label: 'History',  desc: '실행 이력' },
    { key: '6', label: 'Config',   desc: '$EDITOR 로 config.yml 편집' },
  ];

  const sel = await ui.menu('VOID//ai-launcher', items, { subtitle: lastDesc });
  if (!sel) return;

  switch (sel.key) {
    case 'q':
      if (last) { const tool = findTool(last.toolName); if (tool) await launchTool(tool, last.isAnon); }
      break;
    case '1': return showToolsMenu();
    case '2': {
      const { promptMode } = require('./lib/prompt');
      await promptMode('', config, c);
      return showMainMenu();
    }
    case '3': {
      const { sessionsMenu } = require('./lib/sessions');
      await sessionsMenu(config, c);
      return showMainMenu();
    }
    case '4': {
      const { tokensMenu } = require('./lib/tokens');
      await tokensMenu(c);
      return showMainMenu();
    }
    case '5': return showHistoryMenu();
    case '6': {
      const { spawnSync } = require('child_process');
      ui.clear();
      spawnSync(process.env.EDITOR || 'vi', [configPath], { stdio: 'inherit' });
      return showMainMenu();
    }
  }
}

// ── 진입점 ────────────────────────────────────────────────

async function main() {
  if (argv.length > 0) {
    await handleArgs(argv);
  } else {
    await showMainMenu();
  }
}

main().catch(err => {
  process.stderr.write(c.warn + err.message + c.RESET + '\n');
  process.exit(1);
});
