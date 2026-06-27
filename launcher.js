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
  const tool = findTool(history[Number(sel.key) - 1].toolName);
  if (tool) await launchTool(tool, history[Number(sel.key) - 1].isAnon);
}

// ── 토큰 alias 목록 빌드 ("service/alias" 형태) ──────────

function buildTokenOptions() {
  const { getAllTokens } = require('./lib/config');
  const all = getAllTokens();
  const opts = [];
  for (const [svc, aliases] of Object.entries(all)) {
    for (const alias of Object.keys(aliases)) {
      opts.push(`${svc}/${alias}`);
    }
  }
  return opts.length > 0 ? opts : ['(없음)'];
}

async function showMainMenu() {
  const last      = getLast();
  const lastDesc  = last
    ? `${last.toolName}${last.isAnon ? ' [익명]' : ''} · ${timeSince(last.timestamp)}`
    : null;
  const toolNames   = config.tools.map(t => t.name);
  const tokenOpts   = buildTokenOptions();
  const hasTokens   = tokenOpts[0] !== '(없음)';

  const items = [
    { key: 'q', label: '빠른 시작',  desc: lastDesc || '이력 없음', disabled: !last },
    { key: '1', label: '일반 실행',  options: toolNames },
    { key: '2', label: '익명 모드',  options: toolNames },
    { key: '3', label: '토큰 실행',  options: tokenOpts, disabled: !hasTokens },
    { key: '4', label: 'Prompt',    desc: 'Anthropic / OpenAI' },
    { key: '5', label: 'Sessions',  desc: 'tmux / node-pty' },
    { key: '6', label: 'Tokens',    desc: 'API 토큰 관리' },
    { key: '7', label: 'History',   desc: '실행 이력' },
    { key: '8', label: 'Config',    desc: '$EDITOR 로 편집' },
  ];

  const sel = await ui.menu('VOID//ai-launcher', items, { subtitle: lastDesc, showHeader: true });
  if (!sel) return;

  switch (sel.key) {
    case 'q': {
      if (last) { const tool = findTool(last.toolName); if (tool) await launchTool(tool, last.isAnon); }
      return showMainMenu();
    }
    case '1': {
      const tool = config.tools.find(t => t.name === sel.selectedOption);
      if (tool) await launchTool(tool, false);
      break;
    }
    case '2': {
      const tool = config.tools.find(t => t.name === sel.selectedOption);
      if (tool) await launchTool(tool, true);
      break;
    }
    case '3': {
      // "service/alias" → Prompt 모드에 해당 토큰 주입
      const [service, alias] = (sel.selectedOption || '').split('/');
      const { getToken } = require('./lib/config');
      const apiKey = getToken(service, alias);
      if (apiKey) {
        const { promptMode } = require('./lib/prompt');
        await promptMode('', config, c, { service, alias, apiKey });
      }
      return showMainMenu();
    }
    case '4': {
      const { promptMode } = require('./lib/prompt');
      await promptMode('', config, c);
      return showMainMenu();
    }
    case '5': {
      const { sessionsMenu } = require('./lib/sessions');
      await sessionsMenu(config, c);
      return showMainMenu();
    }
    case '6': {
      const { tokensMenu } = require('./lib/tokens');
      await tokensMenu(c);
      return showMainMenu();
    }
    case '7': return showHistoryMenu();
    case '8': {
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
