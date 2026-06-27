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

// mode: false = 일반 | 'anon' = 익명 | string = 세션명
async function launchTool(tool, mode) {
  const isAnon      = mode === 'anon';
  const sessionName = (mode && typeof mode === 'string' && mode !== 'anon') ? mode : null;
  saveLast({ toolName: tool.name, isAnon, sessionName });
  appendHistory({ toolName: tool.name, isAnon, sessionName });
  await runTool(tool, mode, c);
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
      const { terminalSessionsMenu } = require('./lib/sessions');
      await terminalSessionsMenu(config, c);
      return;
    }
    default: {
      const tool = findTool(cmd);
      if (!tool) {
        process.stderr.write(c.warn + `오류: '${cmd}' 를 찾을 수 없습니다.\n` + c.RESET);
        process.exit(1);
      }
      const isAnon = rest.includes('--anon') || rest.includes('-a');
      await launchTool(tool, isAnon ? 'anon' : false);
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
  const items = history.map((h, i) => {
    const tag = h.sessionName ? ` [${h.sessionName}]` : (h.isAnon ? ' [익명]' : '');
    return { key: String(i + 1), label: `${h.toolName}${tag}`, desc: timeSince(h.timestamp) };
  });
  const sel = await ui.menu('History', items, { back: true });
  if (!sel) return showMainMenu();
  const h    = history[Number(sel.key) - 1];
  const tool = findTool(h.toolName);
  const mode = h.sessionName || (h.isAnon ? 'anon' : false);
  if (tool) await launchTool(tool, mode);
}

// ── 옵션 목록 빌드 ────────────────────────────────────────

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

function buildSessionOptions() {
  const { getSessions } = require('./lib/storage');
  const sessions = getSessions();
  return sessions.length > 0 ? sessions.map(s => s.name) : ['(없음)'];
}

// ── Config 서브메뉴 ───────────────────────────────────────

async function showConfigMenu() {
  const { claudeSessionsMenu }  = require('./lib/sessions');
  const { extTokensMenu }       = require('./lib/extTokens');
  const { spawnSync }           = require('child_process');

  while (true) {
    const items = [
      { key: '1', label: 'YAML 편집',      desc: '$EDITOR config.yml' },
      { key: '2', label: 'Claude 세션',    desc: '네임드 세션 생성 / 삭제' },
      { key: '3', label: '외부 토큰',      desc: 'API Key export 명령어' },
    ];

    const sel = await ui.menu('Config', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      ui.clear();
      spawnSync(process.env.EDITOR || 'vi', [configPath], { stdio: 'inherit' });
    } else if (sel.key === '2') {
      await claudeSessionsMenu(c);
    } else if (sel.key === '3') {
      await extTokensMenu(c);
    }
  }
}

// ── 메인 메뉴 ─────────────────────────────────────────────

async function showMainMenu() {
  const last        = getLast();
  const lastTag     = last
    ? last.sessionName ? ` [${last.sessionName}]` : (last.isAnon ? ' [익명]' : '')
    : '';
  const lastDesc    = last ? `${last.toolName}${lastTag} · ${timeSince(last.timestamp)}` : null;
  const toolNames   = config.tools.map(t => t.name);
  const tokenOpts   = buildTokenOptions();
  const sessionOpts = buildSessionOptions();
  const hasTokens   = tokenOpts[0]   !== '(없음)';
  const hasSessions = sessionOpts[0] !== '(없음)';

  const items = [
    { key: 'q', label: '빠른 시작',   desc: lastDesc || '이력 없음', disabled: !last },
    { key: '1', label: '일반 실행',   options: toolNames },
    { key: '2', label: '익명 모드',   options: toolNames },
    { key: '3', label: '세션 실행',   options: sessionOpts, disabled: !hasSessions },
    { key: '4', label: '토큰 실행',   options: tokenOpts,   disabled: !hasTokens },
    { key: '5', label: 'Prompt',     desc: 'Anthropic / OpenAI / Google' },
    { key: '6', label: '터미널 세션', desc: 'tmux / node-pty' },
    { key: '7', label: 'Tokens',     desc: 'API 토큰 관리' },
    { key: '8', label: 'History',    desc: '실행 이력' },
    { key: '9', label: 'Config',     desc: '설정 →' },
  ];

  const sel = await ui.menu('VOID//ai-launcher', items, { subtitle: lastDesc, showHeader: true });
  if (!sel) return;

  switch (sel.key) {
    case 'q': {
      if (last) {
        const tool = findTool(last.toolName);
        const mode = last.sessionName || (last.isAnon ? 'anon' : false);
        if (tool) await launchTool(tool, mode);
      }
      return showMainMenu(); // tool 종료 후에도 메뉴 복귀
    }
    case '1': {
      const tool = config.tools.find(t => t.name === sel.selectedOption);
      if (tool) await launchTool(tool, false);
      return showMainMenu();
    }
    case '2': {
      const tool = config.tools.find(t => t.name === sel.selectedOption);
      if (tool) await launchTool(tool, 'anon');
      return showMainMenu();
    }
    case '3': {
      // 세션 실행: CLAUDE_CONFIG_DIR=$HOME/.claude-{name} claude
      const { getSessions } = require('./lib/storage');
      const session = getSessions().find(s => s.name === sel.selectedOption);
      if (session) {
        const tool = config.tools.find(t => t.command === 'claude') || config.tools[0];
        if (tool) await launchTool(tool, session.name);
      }
      return showMainMenu();
    }
    case '4': {
      // 토큰 실행: "service/alias" → Prompt 모드에 토큰 주입
      const [service, alias] = (sel.selectedOption || '').split('/');
      const { getToken }   = require('./lib/config');
      const { promptMode } = require('./lib/prompt');
      const apiKey = getToken(service, alias);
      if (apiKey) await promptMode('', config, c, { service, alias, apiKey });
      return showMainMenu();
    }
    case '5': {
      const { promptMode } = require('./lib/prompt');
      await promptMode('', config, c);
      return showMainMenu();
    }
    case '6': {
      const { terminalSessionsMenu } = require('./lib/sessions');
      await terminalSessionsMenu(config, c);
      return showMainMenu();
    }
    case '7': {
      const { tokensMenu } = require('./lib/tokens');
      await tokensMenu(c);
      return showMainMenu();
    }
    case '8': return showHistoryMenu();
    case '9': {
      await showConfigMenu();
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
