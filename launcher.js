#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

// 설정 소스는 lib/configDb.js (dJinn/SQLite) 로 통합됨 — 레거시 config.yml /
// config.json 은 configDb 최초 초기화 시 흡수 후 *.migrated 로 rename 된다.
// 다운스트림(theme/runner/cliPreflight/sessions 및 아래 config.tools 참조부)은
// 예전과 동일한 { tools, theme, settings } 모양만 읽으므로 출처는 무관하다.
const configDb = require('./lib/configDb');
const config = {
  tools:    configDb.getTools(),
  theme:    configDb.getTheme(),
  settings: configDb.getSettings(),
};

const { loadTheme, makeColors } = require('./lib/theme');
const {
  getLast, saveLast, appendHistory, getHistory,
  resolveSessionConfigDir, resolveToolStateDir, getSession,
} = require('./lib/storage');
const { runTool, runCommandLine, runHostShell } = require('./lib/runner');
const ui = require('./lib/ui');

// config.json 미존재 시 기본 스키마 자동 생성
require('./lib/config');

const palette = loadTheme(config);
const c = makeColors(palette);
ui.setColors(c, palette);
// wrapper.js/xtermFrame.js draw their own frame chrome with raw ANSI outside
// ui.js's render path and previously hardcoded void-signature green
// regardless of the active theme pack — applyTheme() lets them follow it too.
try { require('./lib/wrapper').applyTheme(palette); } catch {}
try { require('./lib/xtermFrame').applyTheme(palette); } catch {}
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

// 60/80% 경계로 녹색/황색/강조 밴드 (theme 에 별도 red 키가 없어 warn 재사용).
const bandColor = (pct) =>
  pct >= 80 ? (c.BOLD + c.warn) : pct >= 60 ? c.warn : c.ok;

// 리셋 시각 표시 — showUsageMenu 와 buildHomeDashboardLines 가 공유.
const fmtReset = (resetsAt) => {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts = d.toDateString() === now.toDateString()
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return c.muted2 + '  (리셋: ' + d.toLocaleString(undefined, opts) + ')' + c.RESET;
};

// fmtReset 의 초압축 버전 — 홈 대시보드처럼 한 줄에 두 윈도우의 리셋 시각을
// 함께 넣어야 할 때, 라벨/괄호 없이 시각만 반환한다. Links 박스는 폭이 좁아
// (보통 40컬럼 미만) toLocaleString 의 "Sun 9:00 AM" 류 가변 길이 출력 대신
// 고정 폭의 24시간제(HH:mm, 오늘이 아니면 M/D HH:mm)를 직접 포맷한다.
const fmtResetCompact = (resetsAt) => {
  if (!resetsAt) return '';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

// 고정 형식 타임스탬프: YYYY-MM-DD HH:mm:ss (로케일 비의존).
function fmtFixedTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 홈 화면 Links 박스 하단의 사용량 대시보드 위젯 라인 생성.
// 읽기 전용 — void_init 이 데워둔 캐시(lib/usageDb.js)와 init-status 마커만 읽고,
// 절대 새 조회(네트워크/PTY)를 트리거하지 않는다. 넓은 화면에서 Links 박스를
// 실제로 그릴 때만 ui.js 가 lazy 하게 호출한다.
function buildHomeDashboardLines() {
  const lines = [];

  let init = null;
  try { init = require('./lib/storage').getInitStatus(); } catch {}
  if (init && init.ranAt) {
    const t = new Date(init.ranAt).toTimeString().slice(0, 8);
    const mark = init.ok ? c.ok + '✓' + c.RESET : c.warn + '✗' + c.RESET;
    lines.push(` ${c.muted2}⚡ init${c.RESET} ${mark} ${c.muted2}${t} · 세션 ${init.sessionsWarmed || 0}개${c.RESET}`);
  } else {
    lines.push(` ${c.muted2}⚡ init · 아직 실행 전${c.RESET}`);
  }

  const last = getLast();
  const tool = last ? findTool(last.toolName) : null;
  const toolCmd = ((last && last.sessionToolCommand) || (tool && tool.command) || '').toLowerCase();
  if (!last || (toolCmd !== 'claude' && toolCmd !== 'codex')) {
    lines.push(` ${c.muted}사용량 데이터 없음${c.RESET}`);
    return lines;
  }

  let entry = null;
  try { entry = require('./lib/usageDb').getUsageCacheEntry(toolCmd, last.sessionName || 'default'); } catch {}

  const tsPart = entry && entry.timestamp ? ` - ${fmtFixedTimestamp(entry.timestamp)}` : '';
  lines.push(` ${c.signal}📊 ${describeLaunch(last)}${c.muted2}${tsPart}${c.RESET}`);

  if (!entry || (!entry.session && !entry.weekly)) {
    lines.push(`    ${c.muted}사용량 데이터 없음${c.RESET}`);
    return lines;
  }

  const pctPart = (label, win) => {
    if (!win) return c.muted2 + label + ' --%' + c.RESET;
    const pct = Math.round(win.usedPercent);
    return c.muted2 + label + ' ' + c.RESET + bandColor(pct) + pct + '%' + c.RESET;
  };
  const resetPart = (win) => {
    if (!win || !win.resetsAt) return '';
    const t = fmtResetCompact(win.resetsAt);
    return t ? c.muted2 + '(' + t + ')' + c.RESET : '';
  };
  const sessionResetStr = resetPart(entry.session);
  const weeklyResetStr = resetPart(entry.weekly);
  lines.push('    ' + pctPart('세션', entry.session) + (sessionResetStr ? ' ' + sessionResetStr : '') +
    c.muted2 + ' · ' + c.RESET + pctPart('주간', entry.weekly) + (weeklyResetStr ? ' ' + weeklyResetStr : ''));
  return lines;
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
    '   - VOID 설정: 테마와 프레임 여백을 메뉴에서 직접 바꾸고 즉시 적용합니다.',
    '   - LLM CLI 세션관리: AI 클라이언트(Claude, Codex, agy)의 개별 세션을 관리합니다.',
    '   - 토큰 및 인증 관리: API 토큰이나 외부 서비스 자격 증명을 관리합니다.',
    '   - Personal Assistant(고급 모드): 상주 AI 어시스턴트 프로필을 만들고 채팅 화면에서 대화합니다.',
    '',
    '2. 터미널 조작 방법',
    '   - ↑ / ↓ : 메뉴 항목 이동',
    '   - ← / → : 가로 캐러셀 옵션 변경 (일반 실행의 대상 모델 등)',
    '   - Enter / 단축키 : 선택한 항목 즉시 실행',
    '   - ESC / 0 : 이전 메뉴로 돌아가기',
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
  // history.json 스냅샷은 tokenService/tokenAlias 등을 담지 않으므로(당시엔
  // 없던 필드일 수도 있고, 이후 연결/변경됐을 수도 있음) — 여기서 즉석
  //재구성하지 않고 storage.getSession()으로 현재 살아있는 세션 레코드를
  // 그대로 조회한다. 세션이 그 사이 삭제됐으면(getSession이 못 찾으면) 예전과
  // 동일한 최소 재구성으로 폴백한다.
  const historyToolCommand = h.sessionToolCommand || tool?.command || 'claude';
  const liveSession = h.sessionName ? getSession(h.sessionName, historyToolCommand) : null;
  const mode = h.sessionName
    ? {
      type: 'session',
      session: liveSession || {
        name: h.sessionName,
        toolCommand: historyToolCommand,
        configDir: resolveSessionConfigDir(historyToolCommand, h.sessionName),
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

function buildQuickStartTargets(last) {
  const { getSessions } = require('./lib/storage');
  const sessionTargets = getSessions()
    .map(session => {
      const command = (session.toolCommand || 'claude').toLowerCase();
      const tool = config.tools.find(t => (t.command || '').toLowerCase() === command);
      if (!tool) return null;
      return {
        tool,
        mode: { type: 'session', session },
        label: `${tool.name} [${session.name}]`,
        matchesLast: Boolean(last && last.sessionName === session.name &&
          (last.sessionToolCommand || tool.command).toLowerCase() === command),
      };
    })
    .filter(Boolean);

  const normalTargets = config.tools.map(tool => ({
    tool,
    mode: false,
    label: tool.name,
    matchesLast: Boolean(last && !last.sessionName && !last.isAnon &&
      (last.toolName || '').toLowerCase() === tool.name.toLowerCase()),
  }));

  let assistantTargets = [];
  try {
    const assistant = require('./lib/assistant');
    assistantTargets = assistant.listAssistantProfiles().map(profile => ({
      type: 'assistant',
      profileName: profile.name,
      label: `개인비서 - ${profile.name}`,
      matchesLast: false,
    }));
  } catch {}

  const targets = [...sessionTargets, ...normalTargets, ...assistantTargets];
  const lastTargetIndex = targets.findIndex(target => target.matchesLast);
  return {
    targets,
    options: targets.map(target => target.label),
    optionIndex: lastTargetIndex >= 0 ? lastTargetIndex : 0,
  };
}

const HOME_LINKS = [
  { label: '🏠 Doil G.W', url: 'https://doil.me' },
  { label: '💻 ADMIN console', url: 'https://doil.me/admin' },
  { label: '🎫 Plane', url: 'https://plane.doil.me/' },
  { label: '📚 Doyclopedia', url: 'https://doiloppa.notion.site/' },
];

const GLOBAL_SKILLS_DIR = path.join(__dirname, '_global', 'g_skills');

function globalPluginManagerPrompt(tool, session) {
  return [
    'You are the VOID Global Plugin Manager for this named CLI profile.',
    '',
    `Selected profile: ${tool.name} [${session.name}]`,
    `Profile root: ${session.configDir || '(managed by VOID)'}`,
    `Shared skills directory: ${GLOBAL_SKILLS_DIR}`,
    '',
    'Help the user install, update, inspect, or remove reusable Skills and MCP integrations.',
    'Before changing anything, explain the target, source, affected profiles, and required authentication.',
    'Keep reusable skill files in the shared skills directory; do not duplicate them into individual profiles.',
    'Do not delete or overwrite existing skills, MCP configuration, or credentials without explicit approval.',
    'For MCP integrations, use this selected profile\'s supported configuration format and clearly state whether the change is profile-local or can be shared.',
    'Start by asking what Skill or MCP integration the user wants to manage.',
  ].join('\n');
}

async function showGlobalPluginMenu() {
  const { getSessions } = require('./lib/storage');
  const targets = getSessions()
    .map(session => ({
      session,
      tool: config.tools.find(tool =>
        (tool.command || '').toLowerCase() === (session.toolCommand || 'claude').toLowerCase()),
    }))
    .filter(target => target.tool && toolSupportsSessions(target.tool));

  if (targets.length === 0) {
    await ui.message('Global Plugin 관리는 등록된 CLI 세션이 있을 때 사용할 수 있습니다.');
    return;
  }

  const items = targets.map((target, index) => ({
    key: String(index + 1),
    label: `${target.tool.name} [${target.session.name}]`,
    desc: '이 세션의 AI로 Skills / MCP 관리',
  }));
  const selection = await ui.menu('Global Plugin 관리 — 세션 선택', items, { back: true });
  if (!selection) return;

  const target = targets[Number(selection.key) - 1];
  if (!target) return;
  fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true, mode: 0o700 });
  await launchTool(
    target.tool,
    { type: 'session', session: target.session },
    [globalPluginManagerPrompt(target.tool, target.session)],
  );
}

// ── Config 서브메뉴 ───────────────────────────────────────

// VOID 설정 — 네이티브 TUI 설정 화면. 테마 콤보 행을 좌우로 넘기면 화면
// 전체가 즉시 해당 테마로 다시 그려진다(설정 화면 자체가 프리뷰). ESC 는
// 취소이므로 프리뷰로 바뀐 테마를 원래 팔레트로 되돌린다.
async function showVoidSettingsScreen(topRows) {
  const theme = require('./lib/theme');
  const wrapper = require('./lib/wrapper');
  const xtermFrame = require('./lib/xtermFrame');

  const applyPalette = (pal, colors) => {
    ui.setColors(colors, pal);
    try { wrapper.applyTheme(pal); } catch {}
    try { xtermFrame.applyTheme(pal); } catch {}
  };

  // 취소 시 되돌릴 원본 — 프리뷰가 일어나기 전에 캡처
  const originalName    = config.theme?.name || 'void-signature';
  const originalPalette = loadTheme(config);
  const originalColors  = makeColors(originalPalette);

  const themeNames = Object.keys(theme.BUILT_IN);
  const hpadOpts   = ['0', '1', '2', '3', '4'];
  const vpadOpts   = ['0', '1', '2'];
  const emojiOpts  = ['켜짐', '꺼짐'];

  const s = config.settings || {};
  const curHpad  = typeof s.wrapper_hpad === 'number' ? s.wrapper_hpad : 2;
  const curVpad  = typeof s.wrapper_vpad === 'number' ? s.wrapper_vpad : 1;
  const curEmoji = typeof s.double_width_emoji === 'boolean' ? s.double_width_emoji : true;

  const items = [
    { key: '1', label: '테마', options: themeNames,
      optionIndex: Math.max(0, themeNames.indexOf(originalName)) },
    { key: '2', label: '프레임 가로 여백', options: hpadOpts,
      optionIndex: Math.max(0, hpadOpts.indexOf(String(curHpad))) },
    { key: '3', label: '프레임 세로 여백', options: vpadOpts,
      optionIndex: Math.max(0, vpadOpts.indexOf(String(curVpad))) },
    { key: '4', label: '이모지 2칸 폭', options: emojiOpts, optionIndex: curEmoji ? 0 : 1 },
    { key: 's', label: '저장', desc: '변경 사항 저장 및 즉시 적용' },
  ];

  const onOptionChange = (idx, item, optIdx) => {
    // 다음 루프 반복의 ui.menu() 가 이번 위치에서 이어가도록 items 에 고정
    items[idx].optionIndex = optIdx;
    if (item.key === '1') {
      const pal = loadTheme({ theme: { name: themeNames[optIdx] } });
      applyPalette(pal, makeColors(pal));
    }
  };

  while (true) {
    const sel = await ui.menu('VOID 설정', items, { back: true, topRows, onOptionChange });

    if (!sel) {
      // 취소 — 프리뷰로 테마가 바뀌었으면 원상 복구
      if (themeNames[items[0].optionIndex] !== originalName) {
        applyPalette(originalPalette, originalColors);
      }
      return;
    }

    if (sel.key === 's') {
      const name  = themeNames[items[0].optionIndex];
      const hpad  = parseInt(hpadOpts[items[1].optionIndex], 10);
      const vpad  = parseInt(vpadOpts[items[2].optionIndex], 10);
      const emoji = items[3].optionIndex === 0;

      // 기존 테마 문서를 스프레드 후 name만 덮어씀 — 그렇지 않으면 사용자가
      // 이전에 설정해둔 theme.colors 개별 오버라이드(loadTheme()이 지원하는
      // 문서화된 기능, config.yml.migrated에 예시로 남아있음)가 매 저장마다
      // 조용히 삭제됨(독립 리뷰가 발견한 should-fix).
      configDb.setTheme({ ...configDb.getTheme(), name });
      // 관리하는 3개 키만 덮어써 anonymous_home_prefix 등 나머지 필드 보존
      configDb.setSettings({
        ...configDb.getSettings(),
        wrapper_hpad: hpad, wrapper_vpad: vpad, double_width_emoji: emoji,
      });
      config.theme    = configDb.getTheme();
      config.settings = configDb.getSettings();

      // 저장된 config 기준으로 최종 팔레트 확정 적용 (colors 오버라이드 제거
      // 등으로 프리뷰 팔레트와 다를 수 있음) + frame 패딩은 재시작 없이 반영
      const pal = loadTheme(config);
      applyPalette(pal, makeColors(pal));
      ui.setFrameConfig({ hpad, vpad, double_width_emoji: emoji });

      await ui.flashMessage(c.ok + '✓ 설정이 저장되어 즉시 적용되었습니다.' + c.RESET);
      return;
    }

    // 콤보 행에서 Enter — 선택 위치만 반영하고 계속
    const i = items.findIndex(it => it.key === sel.key);
    if (i >= 0 && typeof sel.optionIndex === 'number') items[i].optionIndex = sel.optionIndex;
  }
}

async function showSettingsMenu(topRows) {
  const { cliSessionsMenu } = require('./lib/sessions');
  const { extTokensMenu } = require('./lib/extTokens');
  const { agentCliMenu } = require('./lib/cliPreflight');
  const { getSessions } = require('./lib/storage');

  while (true) {
    const items = [
      { key: '1', label: 'History', desc: '실행 이력 조회 및 재실행' },
      { key: '2', label: 'VOID 설정', desc: '테마 및 프레임 설정 (즉시 적용)' },
      { key: '3', label: 'LLM CLI 세션관리', desc: 'Claude / Codex / AGY 세션 생성 및 삭제' },
      { key: '4', label: '토큰 및 인증 관리', desc: 'API 토큰 등록, CLI 로그인 인증 및 Export' },
      {
        key: '5',
        label: 'Global Plugin 관리',
        desc: 'Skills, MCP 설치를 세션 AI에게 요청',
        disabled: getSessions().length === 0,
      },
      { key: '6', label: 'Agent CLI 관리', desc: '설치 상태 확인 및 설치' },
      { key: '7', label: '사용량 조회', desc: 'Claude/Codex 사용량 확인' },
    ];

    const sel = await ui.menu('설정 및 이력', items, { back: true, topRows });
    if (!sel) return;

    if (sel.key === '1') {
      await showHistoryMenu(false);
    } else if (sel.key === '2') {
      await showVoidSettingsScreen(topRows);
    } else if (sel.key === '3') {
      await cliSessionsMenu(config, c);
    } else if (sel.key === '4') {
      await extTokensMenu(config, c);
    } else if (sel.key === '5') {
      await showGlobalPluginMenu();
    } else if (sel.key === '6') {
      await agentCliMenu(config, c);
    } else if (sel.key === '7') {
      await showUsageMenu();
    }
  }
}

// 사용량 조회 — Claude/Codex 세션·주간 rate-limit 사용률을 읽기 전용으로 표시.
// 즉시 조회(열 때) + 수동 새로고침만 제공하며 백그라운드 폴링은 두지 않는다.
async function showUsageMenu() {
  const { getClaudeUsage, getCodexUsage } = require('./lib/usageMeter');
  const { getWarmupTargets } = require('./lib/usageWarmup');
  const { getUsageCacheEntry } = require('./lib/usageDb');

  const bar = (pct) => {
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + c.muted + '░'.repeat(width - filled) + c.RESET;
  };

  const windowLine = (label, win) => {
    if (!win) return '    ' + c.muted2 + label + ': ' + c.muted + '데이터 없음' + c.RESET;
    const pct = Math.round(win.usedPercent);
    const col = bandColor(pct);
    const pctStr = String(pct).padStart(3, ' ') + '%';
    return '    ' + c.text + label.padEnd(6) + c.RESET + ' ' +
      col + bar(pct) + '  ' + col + pctStr + c.RESET + fmtReset(win.resetsAt);
  };

  const fmtCachedAt = (ts) => {
    if (!ts) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const opts = d.toDateString() === now.toDateString()
      ? { hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  };

  // 어느 tier(API/RPC/PTY 스크래핑)가 이 데이터를 만들었는지 짧게 표기.
  const sourceLabel = (source) => {
    if (source === 'oauth' || source === 'backend') return 'API';
    if (source === 'rpc') return 'RPC';
    if (source === 'pty') return 'PTY 스크래핑';
    return null;
  };

  const providerBlock = (title, res) => {
    const lines = [c.signal + title + c.RESET];
    const hasCachedWindows = res.stale && (res.session || res.weekly);
    if (res.status === 'ok' || hasCachedWindows) {
      lines.push(windowLine('세션', res.session));
      lines.push(windowLine('주간', res.weekly));
      // 캐시 폴백인데 이번 조회 자체는 실패했을 때 — 실제 조회 결과도 함께 보여준다.
      if (res.status !== 'ok' && res.error) {
        lines.push('    ' + c.warn + res.error + c.RESET);
      }
    } else if (res.status === 'unavailable') {
      lines.push('    ' + c.muted2 + (res.error || '사용할 수 없습니다.') + c.RESET);
    } else {
      lines.push('    ' + c.warn + (res.error || '조회에 실패했습니다.') + c.RESET);
    }
    if (res.cachedAt) {
      const t = fmtCachedAt(res.cachedAt);
      const label = sourceLabel(res.source);
      if (t) {
        lines.push('    ' + c.muted2 + '(마지막 조회: ' + t +
          (label ? ', ' + label : '') + (res.stale ? ', 캐시됨' : '') + ')' + c.RESET);
      }
    }
    return lines;
  };

  const toolLabelFor = (toolCommand) => toolCommand === 'codex' ? 'Codex' : 'Claude';
  const titleFor = (target) => target.sessionKey === 'default'
    ? toolLabelFor(target.toolCommand)
    : `${toolLabelFor(target.toolCommand)} · ${target.sessionKey}`;
  const buildLines = (targets, results) => {
    const lines = [];
    targets.forEach((target, i) => {
      lines.push(...providerBlock(titleFor(target), results[i]));
      if (i < targets.length - 1) lines.push('');
    });
    return lines.join('\n');
  };

  // 이전 while 반복(새로고침)에서 남은 백그라운드 루프가 새 view 를 건드리지
  // 못하도록 하는 세대 가드.
  let refreshGen = 0;
  while (true) {
    // 캐시된 사용량을 즉시 표시하고, 라이브 조회는 백그라운드에서 순차 실행한다.
    // usageWarmup.js 의 겹침 가드와 같은 이유로 병렬 대신 순차 실행 — 세션이
    // 여럿이면 hidden PTY 폴백이 동시에 여러 개 뜨는 상황을 피한다.
    const targets = getWarmupTargets();
    const results = targets.map((t) => {
      const cached = getUsageCacheEntry(t.toolCommand, t.sessionKey);
      return cached
        ? { ...cached, stale: true, cachedAt: cached.timestamp }
        : { status: 'unavailable', session: null, weekly: null, error: '아직 조회된 적이 없습니다.', source: null, stale: false, cachedAt: null };
    });

    const view = ui.liveScrollableMessage('사용량 조회', buildLines(targets, results));
    const myGen = ++refreshGen;

    (async () => {
      for (let i = 0; i < targets.length; i++) {
        if (myGen !== refreshGen) return;
        view.setStatus(`새로고침 중 (${i + 1}/${targets.length})...`);
        const target = targets[i];
        const getUsage = target.toolCommand === 'codex' ? getCodexUsage : getClaudeUsage;
        const overrides = { configDir: target.configDir || undefined, sessionKey: target.sessionKey };
        results[i] = await getUsage(config, overrides)
          .catch(err => ({ status: 'error', error: String(err && err.message || err) }));
        if (myGen !== refreshGen) return;
        view.setLines(buildLines(targets, results));
      }
      if (myGen === refreshGen) view.setStatus(null);
    })();

    await view.done;

    const sel = await ui.menu('사용량 조회', [
      { key: '1', label: '새로고침', desc: '사용량을 다시 조회합니다.' },
    ], { back: true });

    if (!sel) return;
    // '1' (새로고침) 이면 루프를 돌아 다시 조회.
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

// ── 개인비서 ──────────────────────────────────────────────

// 마지막으로 상주 세션을 시작한 프로필명 — getActiveAssistantSession() 핸들에는
// 소유 프로필 정보가 없어서, 같은 프로필 재진입 시 재사용 판단에 이걸 쓴다.
let lastAssistantSessionName = null;

async function showAssistantChat(assistant, profile) {
  let session = null;
  // 세션 spawn 직후 1회 수신되는 meta(model/sessionId/slashCommands)와
  // 마지막 턴의 usage(토큰/비용) — view.setSessionMeta/setTurnUsage로 Agent 패널에
  // 반영되며, 여기서는 재진입/재사용 판단 등에 쓸 수 있도록 값을 보관해 둔다.
  let lastSessionMeta = null;
  let lastTurnUsage = null;

  assistant.refreshOnboardStatus(profile);

  const attach = (s) => {
    s.on('delta', chunk => view.appendDelta(chunk));
    s.on('meta', meta => {
      lastSessionMeta = meta;
      view.setSessionMeta(meta);
    });
    s.on('done', (finalText, usage) => {
      lastTurnUsage = usage;
      view.setTurnUsage(usage);
      view.finalizeTurn(finalText);
      view.setState('idle');
      const wasOnboard = profile.isOnboard === true;
      assistant.refreshOnboardStatus(profile);
      if (!wasOnboard && profile.isOnboard === true) {
        view.appendSystem('✓ 온보딩이 완료되었습니다. 이제부터 방금 정한 페르소나로 대화합니다.');
      }
    });
    s.on('error', err => {
      view.appendSystem('오류: ' + (err && err.message || err));
      view.setState('idle');
      view.setMood('error');
    });
  };

  const view = ui.assistantChatView({
    name: profile.name,
    toolCommand: profile.toolCommand || 'claude',
    tokenService: profile.tokenService,
    tokenAlias: profile.tokenAlias,
    model: profile.model,
    effort: profile.effort,
    async onTokenChange(picked) {
      profile.tokenService = picked.service;
      profile.tokenAlias = picked.alias;
      require('./lib/storage').saveAssistant(profile);
      if (session) {
        try { session.stop(); } catch {}
        session = null;
        lastAssistantSessionName = null;
      }
    },
    onSubmit(text) {
      try {
        if (!session || session.alive === false) {
          const active = assistant.getActiveAssistantSession();
          session = (active && active.alive && lastAssistantSessionName === profile.name)
            ? active
            : assistant.startAssistantSession(profile.name);
          lastAssistantSessionName = profile.name;
          attach(session);
        }
        view.setState('thinking');
        session.sendMessage(text);
      } catch (err) {
        view.appendSystem('전송 실패: ' + (err && err.message || err));
        view.setState('idle');
        view.setMood('error');
      }
      // confused 무드는 빈/파싱불가 응답을 뜻하나, 현재 done 이벤트에서
      // 이를 error 와 구분할 깔끔한 신호가 없어 이번 회차 트리거 배선은 보류.
    },
  });

  if (profile.isOnboard !== true) {
    view.appendSystem('아직 온보딩이 완료되지 않았습니다 — 대화를 통해 성격/스타일을 정하면 persona.md가 저장되고 온보딩이 완료됩니다.');
  }

  await view.done;
  if (session) {
    try { session.stop(); } catch {}
    lastAssistantSessionName = null;
  }
}

// 채팅 진입 전 이 프로필에 명시적으로 연결된(profile.tokenService/tokenAlias) 토큰이
// 일반 토큰 저장소(lib/config.js → configDb.js 의 token:<service>:<alias>, 설정 및
// 이력 → 토큰 및 인증 관리 화면에서 등록)에 실제로 존재하는지 확인한다 — 없으면
// 격리된 configDir 에 .credentials.json 이 없어 claude 가 바로 로그인 실패하는 문제를
// 미리 막는다 (기존에는 채팅 진입 후 "claude exited..." 같은 알기 어려운 오류로만
// 드러났다). 링크만 있고 실제 토큰이 나중에 삭제된 경우도 여기서 걸러진다(단순
// 링크-존재 여부가 아니라 실제 조회 결과로 판단). 반환값: 채팅 화면으로 진입해도
// 되면 true.
async function ensureAssistantAuthToken(profile) {
  const command = (profile.toolCommand || 'claude').toLowerCase();
  if (command !== 'claude') return true; // 이 토큰 확인은 현재 claude 전용

  if (profile.tokenService && profile.tokenAlias &&
      require('./lib/config').getToken(profile.tokenService, profile.tokenAlias)) {
    return true;
  }

  await ui.message(
    c.warn + `'${profile.name}' 어시스턴트에 연결된 claude 인증 토큰이 없습니다.` + c.RESET + '\n\n' +
    '  ' + c.muted2 + '이 어시스턴트 메뉴에서 \'토큰 연결\'을 선택해 등록된 토큰을 연결한 뒤 다시 시도해 주세요.' + c.RESET + '\n' +
    '  ' + c.muted2 + '등록된 토큰이 없다면 먼저 설정 및 이력 → 토큰 및 인증 관리 → 토큰 추가 에서 등록하세요.' + c.RESET
  );
  return false;
}

// lib/sessions.js의 sessionDetailMenu와 동일한 구조 — 프로필 하나를 골랐을 때
// 바로 채팅으로 들어가지 않고, 채팅 시작 / 토큰 연결(관리) 중 고르게 한다.
// 토큰 연결은 개인비서에서는 '선택'이 아니라 채팅 진입의 필수 게이트이지만
// (ensureAssistantAuthToken), 연결 자체는 언제든 다시 하거나 바꿀 수 있어야 하므로
// 이 메뉴에서 상시 제공한다.
async function assistantDetailMenu(assistant, profile) {
  const { saveAssistant } = require('./lib/storage');

  while (true) {
    const items = [
      { key: '1', label: '채팅 시작' },
      {
        key: '2', label: '토큰 연결',
        desc: profile.tokenService ? `현재: ${profile.tokenService}/${profile.tokenAlias}` : '연결 안 됨 (채팅 진입 필수)',
      },
    ];
    if (profile.tokenService) {
      items.push({ key: '3', label: '토큰 연결 해제' });
    }
    items.push({
      key: '4', label: '모델/추론 설정',
      desc: `${profile.model || 'default'} / ${profile.effort || 'default'}`,
    });

    const sel = await ui.menu(`어시스턴트: ${profile.name}`, items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      const proceed = await ensureAssistantAuthToken(profile);
      if (proceed) await showAssistantChat(assistant, profile);
      continue;
    }

    if (sel.key === '2') {
      const { pickRegisteredToken } = require('./lib/tokens');
      const picked = await pickRegisteredToken(c);
      if (picked) {
        profile.tokenService = picked.service;
        profile.tokenAlias = picked.alias;
        saveAssistant(profile);
        await ui.message(c.ok + `✓ 토큰 연결됨  ${picked.service}/${picked.alias}` + c.RESET);
      }
      continue;
    }

    if (sel.key === '3') {
      delete profile.tokenService;
      delete profile.tokenAlias;
      saveAssistant(profile);
      await ui.message('토큰 연결이 해제되었습니다.');
      continue;
    }

    if (sel.key === '4') {
      await assistantModelSettingsMenu(profile);
      continue;
    }
  }
}

const ASSISTANT_MODEL_OPTIONS = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best'];
const ASSISTANT_EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

// VOID 설정 화면(테마/여백 콤보 편집)과 동일한 콤보 행 편집 패턴 — 화살표로
// 값을 바꾸고 '저장'을 골라야 실제로 반영된다.
async function assistantModelSettingsMenu(profile) {
  const { saveAssistant } = require('./lib/storage');

  const items = [
    {
      key: '1', label: '모델', options: ASSISTANT_MODEL_OPTIONS,
      optionIndex: Math.max(0, ASSISTANT_MODEL_OPTIONS.indexOf(profile.model || 'default')),
    },
    {
      key: '2', label: '추론 강도', options: ASSISTANT_EFFORT_OPTIONS,
      optionIndex: Math.max(0, ASSISTANT_EFFORT_OPTIONS.indexOf(profile.effort || 'default')),
    },
    { key: 's', label: '저장', desc: '변경 사항 저장' },
  ];

  while (true) {
    const sel = await ui.menu(`모델/추론 설정 — ${profile.name}`, items, { back: true });
    if (!sel) return;

    if (sel.key === 's') {
      const model = ASSISTANT_MODEL_OPTIONS[items[0].optionIndex];
      const effort = ASSISTANT_EFFORT_OPTIONS[items[1].optionIndex];
      if (model === 'default') delete profile.model; else profile.model = model;
      if (effort === 'default') delete profile.effort; else profile.effort = effort;
      saveAssistant(profile);
      await ui.message(c.ok + '✓ 저장되었습니다.' + c.RESET);
      return;
    }

    const i = items.findIndex(it => it.key === sel.key);
    if (i >= 0 && typeof sel.optionIndex === 'number') items[i].optionIndex = sel.optionIndex;
  }
}

async function createAssistantFlow(assistant) {
  const supportedTools = config.tools.filter(toolSupportsSessions);
  if (supportedTools.length === 0) {
    await ui.message('어시스턴트를 만들 수 있는 도구가 없습니다.');
    return;
  }

  const toolItems = supportedTools.map((tool, i) => ({
    key: String(i + 1),
    label: tool.name,
    desc: tool.command,
  }));
  const toolSel = await ui.menu('개인비서 생성 — 도구 선택', toolItems, { back: true });
  if (!toolSel) return;
  const tool = supportedTools[Number(toolSel.key) - 1];
  if (!tool) return;

  const rawName = await ui.input('어시스턴트 이름 (영문/숫자/-): ');
  if (rawName === null) return;
  const name = rawName.trim();
  if (!name) return;

  const dup = assistant.listAssistantProfiles().find(p => p.name === name);
  if (dup) {
    await ui.message(`'${name}' 어시스턴트가 이미 존재합니다.`);
    return;
  }

  const modelItems = [
    { key: '1', label: '모델', options: ASSISTANT_MODEL_OPTIONS, optionIndex: 0 },
    { key: '2', label: '추론 강도', options: ASSISTANT_EFFORT_OPTIONS, optionIndex: 0 },
    { key: 's', label: '계속', desc: '이 설정으로 생성 (나중에 바꿀 수 있음)' },
  ];
  let chosenModel = 'default';
  let chosenEffort = 'default';
  while (true) {
    const modelSel = await ui.menu('개인비서 생성 — 모델/추론 설정', modelItems, { back: true });
    if (!modelSel) return;
    if (modelSel.key === 's') {
      chosenModel = ASSISTANT_MODEL_OPTIONS[modelItems[0].optionIndex];
      chosenEffort = ASSISTANT_EFFORT_OPTIONS[modelItems[1].optionIndex];
      break;
    }
    const i = modelItems.findIndex(it => it.key === modelSel.key);
    if (i >= 0 && typeof modelSel.optionIndex === 'number') modelItems[i].optionIndex = modelSel.optionIndex;
  }

  try {
    const record = await assistant.createAssistantProfile(name, {
      toolCommand: tool.command,
      c,
      model: chosenModel === 'default' ? undefined : chosenModel,
      effort: chosenEffort === 'default' ? undefined : chosenEffort,
    });
    const tokenLine = record.tokenService
      ? '  토큰:  ' + c.text + `${record.tokenService}/${record.tokenAlias}` + c.RESET + '\n\n'
      : '  ' + c.warn + '토큰 연결 안 됨 — 채팅 진입 전 이 어시스턴트에서 \'토큰 연결\'을 먼저 하세요.' + c.RESET + '\n\n';
    await ui.message(
      c.signal + '어시스턴트 생성됨' + c.RESET + '\n\n' +
      '  도구:  ' + c.text + tool.name + c.RESET + '\n' +
      '  이름:  ' + c.text + record.name + c.RESET + '\n' +
      '  경로:  ' + c.muted2 + record.configDir + c.RESET + '\n' +
      tokenLine +
      '  ' + c.muted2 + '첫 대화는 온보딩 — 대화로 페르소나를 설정하게 됩니다.' + c.RESET
    );
  } catch (err) {
    await ui.message(c.warn + String(err && err.message || err) + c.RESET);
  }
}

async function showAssistantMenu() {
  let assistant;
  try {
    assistant = require('./lib/assistant');
  } catch (err) {
    await ui.message(
      c.warn + '개인비서 모듈을 불러올 수 없습니다.' + c.RESET + '\n\n' +
      '  ' + c.muted2 + String(err && err.message || err) + c.RESET
    );
    return;
  }

  while (true) {
    let profiles = [];
    try { profiles = assistant.listAssistantProfiles(); } catch {}
    const items = [
      { key: 'n', label: '새 어시스턴트 만들기' },
      ...profiles.map((p, i) => ({
        key: String(i + 1),
        label: p.name,
        desc: `${p.toolCommand || 'claude'}  ${p.created_at || ''}${p.persona ? '  · ' + p.persona : ''}`,
      })),
    ];

    const sel = await ui.menu('개인비서', items, { back: true, enableDelete: true });
    if (!sel) return;

    if (sel.action === 'delete') {
      const p = profiles[Number(sel.key) - 1];
      if (p) {
        const confirmSel = await ui.menu(`어시스턴트 삭제: ${p.name}`, [
          { key: '1', label: '등록 해제', desc: 'storage에서 제거 (디렉토리 유지)' },
        ], { back: true });
        if (confirmSel) {
          try {
            assistant.removeAssistantProfile(p.name);
            await ui.message(c.signal + '삭제 완료' + c.RESET);
          } catch (err) {
            await ui.message(c.warn + String(err && err.message || err) + c.RESET);
          }
        }
      }
      continue;
    }

    if (sel.key === 'n') {
      await createAssistantFlow(assistant);
    } else {
      const p = profiles[Number(sel.key) - 1];
      if (p) await assistantDetailMenu(assistant, p);
    }
  }
}

async function showAdvancedMenu(toolNames, tokenOpts, sessionOpts, hasTokens, hasSessions, topRows) {
  const items = [
    { key: 'A', label: 'Personal Assistant', desc: '상주 AI 어시스턴트 프로필 관리 및 채팅' },
    { key: '1', label: '익명 모드', options: toolNames },
    { key: '2', label: '세션 실행', desc: '도구 선택 후 세션 선택', disabled: !hasSessions },
  ];

  while (true) {
    const sel = await ui.menu('고급 모드', items, { back: true, topRows });
    if (!sel) return;

    switch (sel.key) {
      case 'A': {
        await showAssistantMenu();
        break;
      }
      case '1': {
        const tool = config.tools.find(t => t.name === sel.selectedOption);
        if (tool) await launchTool(tool, 'anon');
        break;
      }
      case '2': {
        await showSessionLaunchMenu();
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
  // input()은 ESC(취소) 시 null을 반환 — || '' 로 감싸 null.trim() 크래시 방지.
  const command = (await ui.input(': ') || '').trim();
  if (!command) return;
  await runCommandLine(command, c, config, 'svc');
}

// ── 메인 메뉴 ─────────────────────────────────────────────

async function showMainMenu() {
  const last = getLast();
  const lastDesc = last ? `${describeLaunch(last)} · ${timeSince(last.timestamp)}` : null;
  const toolNames = config.tools.map(t => t.name);
  const tokenOpts = buildTokenOptions();
  const sessionOpts = buildSessionOptions();
  const quickStart = buildQuickStartTargets(last);
  const hasTokens = tokenOpts[0] !== '(없음)';
  const hasSessions = sessionOpts[0] !== '(없음)';

  const items = [
    {
      key: 'q',
      label: '빠른 시작',
      options: quickStart.options,
      optionIndex: quickStart.optionIndex,
      desc: lastDesc || '등록된 세션 또는 일반 실행 대상 선택',
      disabled: quickStart.targets.length === 0,
    },
    { key: '1', label: '일반 실행', options: toolNames },
    { key: '2', label: '고급 모드', desc: 'Personal Assistant / 익명 실행 / 세션 실행' },
    { key: '3', label: '설정 및 이력', desc: 'History 조회, VOID 설정 편집, CLI 세션/인증 관리' },
    { key: 'h', label: '도움말', desc: 'VOID 단축키 및 각 메뉴별 상세 도움말 확인' },
    { key: 'x', label: '종료', desc: 'VOID 종료' },
  ];

  const sel = await ui.homeMenu({
    title: '🏠 HOME',
    items,
    links: HOME_LINKS,
    dashboard: buildHomeDashboardLines,
    lastDesc,
  });
  if (!sel) return showMainMenu();

  switch (sel.key) {
    case 'q': {
      const target = quickStart.targets[sel.optionIndex];
      if (target && target.type === 'assistant') {
        let assistant;
        try { assistant = require('./lib/assistant'); } catch {}
        const profile = assistant && assistant.listAssistantProfiles().find(p => p.name === target.profileName);
        if (assistant && profile) await assistantDetailMenu(assistant, profile);
      } else if (target) {
        // 기존 빠른 시작처럼 마지막 실행 대상을 다시 고르면 인수도 함께 복원한다.
        const extraArgs = target.matchesLast ? (last?.extraArgs || []) : [];
        await launchTool(target.tool, target.mode, extraArgs);
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
    case 'x':
      return;
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

// 백그라운드 사용량 캐시 warmup — fire-and-forget, 시작 지연/실패에 영향 없음.
// 실행 흔적(시각/성공 여부/데운 세션 수)은 storage 의 init-status.json 에 남긴다.
async function void_init() {
  const startedAt = Date.now();
  let ok = true, sessionsWarmed = 0;
  try {
    const result = await require('./lib/usageWarmup').warmUsageCache(config);
    sessionsWarmed = (result && result.count) || 0;
  } catch {
    ok = false;
  }
  try {
    require('./lib/storage').saveInitStatus({ ranAt: startedAt, durationMs: Date.now() - startedAt, ok, sessionsWarmed });
  } catch {}
}

main().catch(err => {
  try {
    const { storageDir } = require('./lib/storage');
    const logPath = path.join(storageDir(), 'error.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] fatal: ${err.stack || err}\n`, { mode: 0o600 });
    process.stderr.write(c.warn + err.message + c.RESET + '\n');
    process.stderr.write(c.muted2 + '  에러 로그: ' + logPath + c.RESET + '\n');
  } catch {
    process.stderr.write(c.warn + err.message + c.RESET + '\n');
  }
  process.exit(1);
});

// void_init() is fire-and-forget and must not delay the home screen's first
// paint. ui.homeMenu()'s first real render is NOT synchronous inside main() —
// it happens via a `setInterval(draw, 50)` tick in lib/ui.js, ~50ms after
// homeMenu() is entered (clear() only blanks the terminal; it doesn't draw
// content). setImmediate's callback runs in the event loop's "check" phase,
// which is reached well under 50ms after the current script finishes — i.e.
// BEFORE that first draw() tick fires. So a setImmediate-deferred void_init()
// would still run its synchronous prefix (module load + warmUsageCache's sync
// work) ahead of the first paint and block it, reproducing the original bug.
// A short setTimeout comfortably past the 50ms tick avoids that race.
setTimeout(() => {
  void_init().catch(() => {});
}, 120);

// 30초 주기 백그라운드 사용량 재조회 폴러 — void_init()과는 별개의 독립 메커니즘
// (init-status.json 1회성 부팅 마커는 건드리지 않는다). 인터벌 등록 자체는 가벼운
// 동기 작업(첫 tick은 intervalMs 이후에나 실행)이라 첫 렌더 타이밍에 영향 없음 —
// void_init()처럼 setTimeout 으로 지연시킬 필요가 없다. 겹침 가드와 .unref()는
// lib/usageWarmup.js 의 startUsagePolling() 내부에서 처리된다.
require('./lib/usageWarmup').startUsagePolling(config);
