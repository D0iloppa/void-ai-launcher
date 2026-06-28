#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'config.yml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const { loadTheme, makeColors } = require('./lib/theme');
const {
  getLast, saveLast, appendHistory, getHistory,
  resolveSessionConfigDir, resolveToolStateDir,
} = require('./lib/storage');
const { runTool, runCommandLine, runHostShell } = require('./lib/runner');
const ui = require('./lib/ui');

// config.json 미존재 시 기본 스키마 자동 생성
require('./lib/config');

const palette = loadTheme(config);
const c = makeColors(palette);
ui.setColors(c, palette);
ui.setFrameConfig({
  hpad: typeof config.settings?.wrapper_hpad === 'number' ? config.settings.wrapper_hpad : 2,
  vpad: typeof config.settings?.wrapper_vpad === 'number' ? config.settings.wrapper_vpad : 1,
  double_width_emoji: typeof config.settings?.double_width_emoji === 'boolean' ? config.settings.double_width_emoji : true,
});

const argv = process.argv.slice(2);
const SESSION_CAPABLE_COMMANDS = new Set(['claude', 'codex', 'agy']);

// ── --sudo 재실행 ─────────────────────────────────────────
// void --sudo 를 실행하면 sudo 권한으로 void 를 재시작한다.
// void 바이너리는 /usr/local/bin/void (cmd_generator.sh 기준)
if (argv.includes('--sudo')) {
  if (process.getuid && process.getuid() !== 0) {
    const { spawnSync: _sx } = require('child_process');
    const voidBin = process.env._VOID_BIN || '/usr/local/bin/void';
    const rest = argv.filter(a => a !== '--sudo');
    const res = _sx('sudo', [voidBin, ...rest], { stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }
  // 이미 root이면 --sudo 플래그만 제거하고 계속 진행
  argv.splice(argv.indexOf('--sudo'), 1);
}

// ── 유틸 ─────────────────────────────────────────────────

function timeSince(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function findTool(name) {
  return config.tools.find(t =>
    t.name.toLowerCase() === name.toLowerCase() ||
    t.command.toLowerCase() === name.toLowerCase()
  );
}

function toolSupportsSessions(tool) {
  return SESSION_CAPABLE_COMMANDS.has((tool.command || '').toLowerCase());
}

function describeLaunch(entry) {
  const parts = [entry.toolName];
  if (entry.sessionName) parts.push(`[${entry.sessionName}]`);
  else if (entry.isAnon) parts.push('[익명]');
  if (entry.extraArgs && entry.extraArgs.length > 0) parts.push(entry.extraArgs.join(' '));
  return parts.join(' ');
}

function getHelpText() {
  const toolList = config.tools.map(t => `  void ${t.command} [args...]`).join('\n');
  return [
    'VOID//ai-launcher 도움말',
    '',
    'Usage:',
    '  void',
    '  void --help',
    '  void host',
    '  void prompt',
    '  void tokens',
    '  void sessions',
    '  void <tool> [args...] [--anon]',
    '',
    'Configured tools:',
    toolList,
    '',
    'Examples:',
    '  void codex --help',
    '  void codex exec "review this repo"',
    '  void claude --anon',
    '  void host',
    '',
    '1. 주요 메뉴 설명',
    '   - History: 최근에 실행했던 도구와 인수들을 간편하게 재실행합니다.',
    '   - VOID 설정: 현재 설정된 config.yml 파일을 기본 에디터($EDITOR)로 엽니다.',
    '   - LLM CLI 세션관리: AI 클라이언트(Claude, Codex, agy)의 개별 세션을 관리합니다.',
    '   - 토큰 및 인증 관리: API 토큰이나 외부 서비스 자격 증명을 관리합니다.',
    '',
    '2. 터미널 조작 방법',
    '   - ↑ / ↓ : 메뉴 항목 이동',
    '   - ← / → : 가로 캐러셀 옵션 변경 (일반 실행의 대상 모델 등)',
    '   - Enter / 단축키 : 선택한 항목 즉시 실행',
    '   - ESC / 0 : 이전 메뉴로 돌아가기 또는 종료',
    '   - : (콜론) : svc 스타일의 셸 명령어 모드로 즉시 진입',
    '   - Ctrl + C : 언제든지 런처 강제 종료',
    '   - Ctrl + D (또는 exit 입력) : tmux 세션이나 호스트 셸 실행 중 런처 메뉴(svc)로 안전하게 복귀',
    '',
    '3. 텍스트 복사 (클립보드)',
    '   - tmux 세션 내에서는 mouse on 모드로 인해 마우스 드래그 선택이 tmux 내부 버퍼로 들어갑니다.',
    '   - Shift + 마우스 드래그 : tmux를 우회하여 터미널이 직접 선택 → OS 클립보드에 복사',
  ].join('\n');
}

function printHelp() {
  process.stdout.write(getHelpText() + '\n');
}

// mode: false = 일반 | 'anon' = 익명 | string = 세션명
async function launchTool(tool, mode, extraArgs = []) {
  const isAnon = mode === 'anon';
  const session = (mode && typeof mode === 'object' && mode.type === 'session') ? mode.session : null;
  const sessionName = session ? session.name : ((mode && typeof mode === 'string' && mode !== 'anon') ? mode : null);
  const sessionToolCommand = session ? session.toolCommand : null;
  saveLast({ toolName: tool.name, isAnon, sessionName, sessionToolCommand, extraArgs });
  appendHistory({ toolName: tool.name, isAnon, sessionName, sessionToolCommand, extraArgs });
  await runTool(tool, mode, c, config, extraArgs);
}

// ── args 직행 ─────────────────────────────────────────────

async function handleArgs(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }

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
    case 'host': {
      await runHostShell(c, config);
      return;
    }
    default: {
      const tool = findTool(cmd);
      if (!tool) {
        process.stderr.write(c.warn + `오류: '${cmd}' 를 찾을 수 없습니다.\n` + c.RESET);
        process.exit(1);
      }
      const isAnon = rest.includes('--anon') || rest.includes('-a');
      const extraArgs = rest.filter(arg => arg !== '--anon' && arg !== '-a');
      await launchTool(tool, isAnon ? 'anon' : false, extraArgs);
    }
  }
}

// ── 메뉴 트리 ─────────────────────────────────────────────

async function showHistoryMenu(returnToMain = true) {
  const history = getHistory().slice(0, 9);
  if (history.length === 0) {
    await ui.message('실행 이력이 없습니다.');
    if (returnToMain) return showMainMenu();
    return;
  }
  const items = history.map((h, i) => {
    return { key: String(i + 1), label: describeLaunch(h), desc: timeSince(h.timestamp) };
  });
  const sel = await ui.menu('History', items, { back: true });
  if (!sel) {
    if (returnToMain) return showMainMenu();
    return;
  }
  const h = history[Number(sel.key) - 1];
  const tool = findTool(h.toolName);
  const mode = h.sessionName
    ? {
      type: 'session',
      session: {
        name: h.sessionName,
        toolCommand: h.sessionToolCommand || tool?.command || 'claude',
        configDir: resolveSessionConfigDir(h.sessionToolCommand || tool?.command || 'claude', h.sessionName),
      },
    }
    : (h.isAnon ? 'anon' : false);
  if (tool) await launchTool(tool, mode, h.extraArgs || []);
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
  return sessions.length > 0 ? sessions.map(s => `${s.toolCommand || 'claude'}:${s.name}`) : ['(없음)'];
}

const HOME_LINKS = [
  { label: '🏠 Doil G.W', url: 'https://doil.me' },
  { label: '💻 ADMIN console', url: 'https://doil.me/admin' },
  { label: '📗 Wiki', url: 'https://www.doil.me/wiki/' },
  { label: '🎫 Plane', url: 'https://plane.doil.me/' },
  { label: '📚 Doyclopedia', url: 'https://doiloppa.notion.site/' },
];

// ── Config 서브메뉴 ───────────────────────────────────────

async function showSettingsMenu(topRows) {
  const { cliSessionsMenu } = require('./lib/sessions');
  const { extTokensMenu } = require('./lib/extTokens');
  const { spawnSync } = require('child_process');

  while (true) {
    const items = [
      { key: '1', label: 'History', desc: '실행 이력 조회 및 재실행' },
      { key: '2', label: 'VOID 설정', desc: 'config.yml 파일 직접 편집 ($EDITOR)' },
      { key: '3', label: 'LLM CLI 세션관리', desc: 'Claude / Codex / AGY 세션 생성 및 삭제' },
      { key: '4', label: '토큰 및 인증 관리', desc: 'API 토큰 등록, CLI 로그인 인증 및 Export' },
    ];

    const sel = await ui.menu('설정 및 이력', items, { back: true, topRows });
    if (!sel) return;

    if (sel.key === '1') {
      await showHistoryMenu(false);
    } else if (sel.key === '2') {
      ui.clear();
      spawnSync(process.env.EDITOR || 'vi', [configPath], { stdio: 'inherit' });
    } else if (sel.key === '3') {
      await cliSessionsMenu(config, c);
    } else if (sel.key === '4') {
      await extTokensMenu(config, c);
    }
  }
}

async function showSessionLaunchMenu() {
  const { getSessions } = require('./lib/storage');
  const sessions = getSessions();
  const supportedTools = config.tools.filter(toolSupportsSessions);

  if (supportedTools.length === 0) {
    await ui.message('세션 실행을 지원하는 도구가 없습니다.');
    return;
  }

  const toolItems = supportedTools.map((tool, i) => ({
    key: String(i + 1),
    label: tool.name,
    desc: tool.command,
  }));
  const toolSel = await ui.menu('세션 실행 — 도구 선택', toolItems, { back: true });
  if (!toolSel) return;

  const tool = supportedTools[Number(toolSel.key) - 1];
  const toolSessions = sessions.filter(s => (s.toolCommand || 'claude') === tool.command);
  if (toolSessions.length === 0) {
    await ui.message(`${tool.name} 세션이 없습니다.`);
    return;
  }

  const sessionItems = toolSessions.map((s, i) => ({
    key: String(i + 1),
    label: s.name,
    desc: s.created_at || s.configDir,
  }));
  const sessionSel = await ui.menu(`세션 실행 — ${tool.name}`, sessionItems, { back: true });
  if (!sessionSel) return;

  const session = toolSessions[Number(sessionSel.key) - 1];
  if (!session) return;
  await launchTool(tool, { type: 'session', session });
}

async function showAdvancedMenu(toolNames, tokenOpts, sessionOpts, hasTokens, hasSessions, topRows) {
  const items = [
    { key: '1', label: '익명 모드', options: toolNames },
    { key: '2', label: '세션 실행', desc: '도구 선택 후 세션 선택', disabled: !hasSessions },
    { key: '3', label: '터미널 세션', desc: 'tmux / node-pty' },
  ];

  while (true) {
    const sel = await ui.menu('고급 모드', items, { back: true, topRows });
    if (!sel) return;

    switch (sel.key) {
      case '1': {
        const tool = config.tools.find(t => t.name === sel.selectedOption);
        if (tool) await launchTool(tool, 'anon');
        break;
      }
      case '2': {
        await showSessionLaunchMenu();
        break;
      }
      case '3': {
        const { terminalSessionsMenu } = require('./lib/sessions');
        await terminalSessionsMenu(config, c);
        break;
      }
    }
  }
}



async function showCommandMode() {
  ui.clear();
  ui.out('');
  ui.out('  ' + c.muted2 + 'svc 스타일 커맨드 모드. 빈 입력이면 홈으로 돌아갑니다.' + c.RESET);
  ui.out('  ' + c.muted2 + '예: ls, git status, claude, codex --help' + c.RESET);
  ui.out('');
  const command = (await ui.input(': ')).trim();
  if (!command) return;
  await runCommandLine(command, c, config, 'svc');
}

// ── 메인 메뉴 ─────────────────────────────────────────────

async function showMainMenu() {
  const last = getLast();
  const lastTag = last
    ? last.sessionName ? ` [${last.sessionName}]` : (last.isAnon ? ' [익명]' : '')
    : '';
  const lastDesc = last ? `${describeLaunch(last)} · ${timeSince(last.timestamp)}` : null;
  const toolNames = config.tools.map(t => t.name);
  const tokenOpts = buildTokenOptions();
  const sessionOpts = buildSessionOptions();
  const hasTokens = tokenOpts[0] !== '(없음)';
  const hasSessions = sessionOpts[0] !== '(없음)';

  const items = [
    { key: 'q', label: '빠른 시작', desc: lastDesc || '이력 없음', disabled: !last },
    { key: '1', label: '일반 실행', options: toolNames },
    { key: '2', label: '고급 모드', desc: '익명 실행 / 세션 실행 / 터미널 세션' },
    { key: '3', label: '설정 및 이력', desc: 'History 조회, VOID 설정 편집, CLI 세션/인증 관리' },
    { key: 'h', label: '도움말', desc: 'VOID 단축키 및 각 메뉴별 상세 도움말 확인' },
  ];

  const sel = await ui.homeMenu({
    title: '🏠 HOME',
    items,
    links: HOME_LINKS,
    lastDesc,
  });
  if (!sel) return;

  switch (sel.key) {
    case 'q': {
      if (last) {
        const tool = findTool(last.toolName);
        const mode = last.sessionName
          ? {
            type: 'session',
            session: {
              name: last.sessionName,
              toolCommand: last.sessionToolCommand || tool?.command || 'claude',
              configDir: resolveSessionConfigDir(last.sessionToolCommand || tool?.command || 'claude', last.sessionName),
            },
          }
          : (last.isAnon ? 'anon' : false);
        if (tool) await launchTool(tool, mode, last.extraArgs || []);
      }
      return showMainMenu(); // tool 종료 후에도 메뉴 복귀
    }
    case '1': {
      const tool = config.tools.find(t => t.name === sel.selectedOption);
      if (tool) await launchTool(tool, false);
      return showMainMenu();
    }
    case '2': {
      await showAdvancedMenu(toolNames, tokenOpts, sessionOpts, hasTokens, hasSessions, sel.panelRows);
      return showMainMenu();
    }
    case '3': {
      await showSettingsMenu(sel.panelRows);
      return showMainMenu();
    }
    case 'h': {
      await ui.scrollableMessage('도움말', getHelpText());
      return showMainMenu();
    }
  }
}

// ── 진입점 ────────────────────────────────────────────────

async function main() {
  if (argv.length > 0) {
    await handleArgs(argv);
  } else {
    ui.enterAltScreen();
    process.on('exit', ui.exitAltScreen);
    await showMainMenu();
    ui.exitAltScreen();
  }
}

main().catch(err => {
  process.stderr.write(c.warn + err.message + c.RESET + '\n');
  process.exit(1);
});
