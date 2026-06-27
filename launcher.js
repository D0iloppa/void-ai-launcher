#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'config.yml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const { loadTheme, makeColors } = require('./lib/theme');
const { getLast, saveLast, appendHistory, getHistory } = require('./lib/storage');
const { runTool, runCommandLine, runHostShell } = require('./lib/runner');
const ui = require('./lib/ui');

// config.json 미존재 시 기본 스키마 자동 생성
require('./lib/config');

const palette = loadTheme(config);
const c = makeColors(palette);
ui.setColors(c);
ui.setFrameConfig({
  hpad: typeof config.settings?.wrapper_hpad === 'number' ? config.settings.wrapper_hpad : 2,
  vpad: typeof config.settings?.wrapper_vpad === 'number' ? config.settings.wrapper_vpad : 1,
});

const argv = process.argv.slice(2);
const SESSION_CAPABLE_COMMANDS = new Set(['claude', 'codex']);

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

function printHelp() {
  const toolList = config.tools.map(t => `  void ${t.command} [args...]`).join('\n');
  const text = [
    'VOID//ai-launcher',
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
    'Menu keys:',
    '  q 빠른 시작',
    '  1 일반 실행',
    '  2 고급 모드',
    '  3 Config',
    '  h Host Shell',
    '  : svc command mode',
  ].join('\n');

  process.stdout.write(text + '\n');
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
        configDir: path.join(require('os').homedir(), `.${h.sessionToolCommand || tool?.command || 'claude'}-${h.sessionName}`),
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
  { label: '🖥️ ADMIN console', url: 'https://doil.me/admin' },
  { label: '📗 Wiki', url: 'https://www.doil.me/wiki/' },
  { label: '🎫 Plane', url: 'https://plane.doil.me/' },
  { label: '📚 Doyclopedia', url: 'https://doiloppa.notion.site/' },
];

// ── Config 서브메뉴 ───────────────────────────────────────

async function showConfigMenu() {
  const { cliSessionsMenu } = require('./lib/sessions');
  const { extTokensMenu } = require('./lib/extTokens');
  const { spawnSync } = require('child_process');

  while (true) {
    const items = [
      { key: '1', label: 'YAML 편집', desc: '$EDITOR config.yml' },
      { key: '2', label: 'CLI 세션', desc: 'Claude / Codex 세션 생성 / 삭제' },
      { key: '3', label: '외부 토큰', desc: 'API Key export 명령어' },
    ];

    const sel = await ui.menu('Config', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      ui.clear();
      spawnSync(process.env.EDITOR || 'vi', [configPath], { stdio: 'inherit' });
    } else if (sel.key === '2') {
      await cliSessionsMenu(config, c);
    } else if (sel.key === '3') {
      await extTokensMenu(c);
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

async function showAdvancedMenu(toolNames, tokenOpts, sessionOpts, hasTokens, hasSessions) {
  const items = [
    { key: '1', label: '익명 모드', options: toolNames },
    { key: '2', label: '세션 실행', desc: '도구 선택 후 세션 선택', disabled: !hasSessions },
    { key: '3', label: '토큰 실행', options: tokenOpts, disabled: !hasTokens },
    { key: '4', label: 'Prompt', desc: 'Anthropic / OpenAI / Google' },
    { key: '5', label: '터미널 세션', desc: 'tmux / node-pty' },
    { key: '6', label: 'Tokens', desc: 'API 토큰 관리' },
    { key: '7', label: 'Chat', desc: '대화형 AI 프롬프트 (claude / codex / ...)' },
  ];

  while (true) {
    const sel = await ui.menu('고급 모드', items, { back: true });
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
        const [service, alias] = (sel.selectedOption || '').split('/');
        const { getToken } = require('./lib/config');
        const { promptMode } = require('./lib/prompt');
        const apiKey = getToken(service, alias);
        if (apiKey) await promptMode('', config, c, { service, alias, apiKey });
        break;
      }
      case '4': {
        const { promptMode } = require('./lib/prompt');
        await promptMode('', config, c);
        break;
      }
      case '5': {
        const { terminalSessionsMenu } = require('./lib/sessions');
        await terminalSessionsMenu(config, c);
        break;
      }
      case '6': {
        const { tokensMenu } = require('./lib/tokens');
        await tokensMenu(c);
        break;
      }
      case '7': {
        await showChatMenu();
        break;
      }
    }
  }
}

async function showSettingsMenu() {
  while (true) {
    const items = [
      { key: '1', label: 'History', desc: '실행 이력' },
      { key: '2', label: 'Config', desc: '설정 편집 / 세션 / 토큰' },
    ];

    const sel = await ui.menu('Config', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      await showHistoryMenu(false);
    } else if (sel.key === '2') {
      await showConfigMenu();
    }
  }
}

async function showChatMenu() {
  const os = require('os');
  const { getSessions } = require('./lib/storage');

  // step 1: binary
  const toolItems = config.tools.map((t, i) => ({
    key: String(i + 1), label: t.name, desc: t.command,
  }));
  const toolSel = await ui.menu('Chat — 도구 선택', toolItems, { back: true });
  if (!toolSel) return;
  const tool = config.tools[Number(toolSel.key) - 1];
  const binary = tool.command;

  // step 2: session / config dir
  const namedSessions = getSessions().filter(s => (s.toolCommand || 'claude') === binary);
  const anonDir = path.join(os.homedir(), `.${binary}-anon`);
  const sessionItems = [
    { key: '0', label: '기본', desc: '기본 설정 경로 (~/.claude 등)' },
    { key: 'a', label: '익명 (anon)', desc: anonDir },
    ...namedSessions.map((s, i) => ({ key: String(i + 1), label: s.name, desc: s.configDir })),
  ];
  const sessionSel = await ui.menu(`Chat — ${tool.name} 세션`, sessionItems, { back: true });
  if (!sessionSel) return;

  let configDir = '';
  let sessionName = 'default';
  if (sessionSel.key === 'a') {
    configDir = anonDir; sessionName = 'anon';
  } else if (sessionSel.key !== '0') {
    const s = namedSessions[Number(sessionSel.key) - 1];
    if (s) { configDir = s.configDir; sessionName = s.name; }
  }

  // step 3: model
  const MODEL_PRESETS = {
    claude: ['', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    codex: ['', 'codex-mini-latest', 'o4-mini'],
  };
  const presets = MODEL_PRESETS[binary] || [''];
  const modelItems = [
    ...presets.map((m, i) => ({ key: String(i + 1), label: m || '기본 모델', desc: m ? '' : '바이너리 기본값' })),
    { key: 'm', label: '직접 입력' },
  ];
  const modelSel = await ui.menu(`Chat — ${tool.name} 모델`, modelItems, { back: true });
  if (!modelSel) return;

  let model = '';
  if (modelSel.key === 'm') {
    model = (await ui.input('모델명: ')).trim();
  } else {
    model = presets[Number(modelSel.key) - 1] || '';
  }

  // launch
  const q = s => `'${s.replace(/'/g, "'\\''")}'`;
  const chatPath = path.join(__dirname, 'lib', 'chat-runner.js');
  const runArgs = [
    `--binary ${q(binary)}`,
    model ? `--model ${q(model)}` : '',
    configDir ? `--config-dir ${q(configDir)}` : '',
    `--session-name ${q(sessionName)}`,
  ].filter(Boolean).join(' ');

  const shortModel = model ? ' · ' + model.split('-').slice(-2).join('-') : '';
  const label = `chat · ${binary}${shortModel} [${sessionName}]`;
  await runCommandLine(`node ${q(chatPath)} ${runArgs}`, c, config, label);
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
    { key: '2', label: '고급 모드', desc: '세션 / 토큰 / Prompt / 터미널 / Tokens' },
    { key: '3', label: 'Config', desc: 'History 및 설정 관련' },
    { key: 'h', label: 'Host Shell', desc: '호스트 로그인 셸 탭 열기' },
    { key: ':', label: 'Command', desc: 'svc 스타일 셸 명령 실행' },
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
              configDir: path.join(require('os').homedir(), `.${last.sessionToolCommand || tool?.command || 'claude'}-${last.sessionName}`),
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
      await showAdvancedMenu(toolNames, tokenOpts, sessionOpts, hasTokens, hasSessions);
      return showMainMenu();
    }
    case '3': {
      await showSettingsMenu();
      return showMainMenu();
    }
    case 'h':
      await runHostShell(c, config);
      return showMainMenu();
    case ':':
      await showCommandMode();
      return showMainMenu();
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
