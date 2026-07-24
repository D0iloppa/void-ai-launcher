'use strict';
const { spawnSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  runWrapped, runWrappedShell, runTmuxSession,
} = require('./wrapper');
const { loadTheme } = require('./theme');
const { enterAltScreen, exitAltScreen } = require('./ui');
const { storageDir, resolveToolStateDir, resolveSessionConfigDir } = require('./storage');

const isWin = process.platform === 'win32';

function logError(context, err) {
  try {
    const logPath = path.join(storageDir(), 'error.log');
    const line = `[${new Date().toISOString()}] ${context}: ${err}\n`;
    fs.appendFileSync(logPath, line, { mode: 0o600 });
  } catch {}
}

// On Windows, .cmd/.ps1 shims can't be exec'd without a shell.
// Wrap with cmd /c to avoid shell:true + args-array (Node 24 deprecation).
function spawnTool(command, args, opts) {
  if (isWin) return spawnSync('cmd', ['/c', command, ...args], opts);
  return spawnSync(command, args, opts);
}

function stripOrcaEnv(env) {
  const orcaCodexHome = env.ORCA_CODEX_HOME;
  for (const key of Object.keys(env)) {
    if (key.startsWith('ORCA_')) delete env[key];
  }
  if (env.CODEX_HOME && orcaCodexHome && env.CODEX_HOME === orcaCodexHome) {
    delete env.CODEX_HOME;
  }
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SANDBOX_NETWORK_DISABLED;
}

function isCodexCommand(command) {
  return (command || '').toLowerCase() === 'codex';
}

function toolIcon(command) {
  switch ((command || '').toLowerCase()) {
    case 'codex': return '👾';
    case 'claude': return '✳';
    case 'agy': return '🚀';
    default: return '◈';
  }
}

function buildWrappedTool(toolObj) {
  if (!isCodexCommand(toolObj.command)) return toolObj;
  if ((toolObj.args || []).includes('--no-alt-screen')) return toolObj;
  return {
    ...toolObj,
    args: [...(toolObj.args || []), '--no-alt-screen'],
  };
}

function resolveSessionProfile(tool, mode) {
  if (!mode) return null;

  if (typeof mode === 'object' && mode.type === 'session' && mode.session) {
    return mode.session;
  }

  if (typeof mode === 'string' && mode !== 'anon') {
    const cmd = (tool.command || '').toLowerCase();
    const toolCommand = cmd === 'codex' ? 'codex' : cmd === 'agy' ? 'agy' : 'claude';
    // 실제로 저장된 세션 레코드를 조회한다 — 그래야 tokenService/tokenAlias 같은
    // 저장된 필드가 보존된다. 아직 저장되지 않은 세션명(방어적 케이스)이면 기존처럼
    // 최소 구성으로 재구성한다.
    const stored = require('./storage').getSession(mode, toolCommand);
    if (stored) return stored;
    return {
      name: mode,
      toolCommand,
      configDir: resolveSessionConfigDir(toolCommand, mode),
    };
  }

  return null;
}

function ensureWritableCodexHome(env) {
  const configured = env.CODEX_HOME;
  if (configured) {
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
    fs.accessSync(configured, fs.constants.W_OK);
    return configured;
  }

  return resolveToolStateDir('codex');
}

function applySessionEnv(env, tool, session) {
  const command = (session.toolCommand || tool.command || '').toLowerCase();
  const configDir = session.configDir || resolveSessionConfigDir(command, session.name || 'default');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  if (command === 'codex') {
    env.CODEX_HOME = configDir;
    return;
  }
  if (command === 'agy') {
    env.AGY_HOME = configDir;
    env.AGY_CONFIG_DIR = configDir;
    return;
  }

  env.CLAUDE_CONFIG_DIR = configDir;

  // 토큰 연결은 완전히 선택 사항인 부가 기능이다(lib/sessions.js의 '토큰 연결').
  // 링크가 없는 세션은 여기서 아무 것도 하지 않고 기존과 동일하게 동작한다 —
  // 실제 대화형 로그인으로 발급된 .credentials.json 에만 의존한다.
  if (command === 'claude' && session.tokenService && session.tokenAlias) {
    const token = require('./config').getToken(session.tokenService, session.tokenAlias);
    if (token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  }
}

// mode: false = 일반 | 'anon' = 익명(temp HOME) | string = 세션명(CLAUDE_CONFIG_DIR)
// config: 전체 config.yml 객체 (wrapper 패딩값 읽기용)
async function runTool(tool, mode, c, config, extraArgs = []) {
  const isAnon      = mode === 'anon';
  const session     = resolveSessionProfile(tool, mode);
  const sessionName = session ? session.name : null;
  const env = { ...process.env };
  let cleanupTmp = null;

  // VOID may itself be launched inside Orca. Child AI CLIs should not inherit
  // Orca runtime/home/hook variables unless explicitly intended.
  stripOrcaEnv(env);

  if (session) {
    applySessionEnv(env, tool, session);
  } else if (isAnon) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-anon-'));
    env.HOME            = tmpDir;
    env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    env.XDG_DATA_HOME   = path.join(tmpDir, '.local', 'share');
    cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    process.once('exit', cleanupTmp);
  } else if ((tool.command || '').toLowerCase() === 'codex') {
    env.CODEX_HOME = ensureWritableCodexHome(env);
  }

  // 표시할 레이블 (상단 바용)
  const displayName = `${toolIcon(tool.command)} ${tool.name}`;
  const label = sessionName ? `${displayName}  [${sessionName}]`
    : isAnon               ? `${displayName}  [익명]`
    : displayName;

  const baseArgs = (isAnon && tool.anonymous_args) ? tool.anonymous_args : (tool.args || []);
  const args = [...baseArgs, ...extraArgs];
  const toolObj = { command: tool.command, args };
  const wrappedToolObj = buildWrappedTool(toolObj);

  // config.yml settings.wrapper_hpad / wrapper_vpad 읽기
  const settings = (config && config.settings) || {};
  const wrapOpts = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
    liveBars: isCodexCommand(tool.command) ? false : undefined,
    // 컨트롤 패널 사용량 조회(U) 지원 — xtermFrame.js 는 순수 컴포지터로 남기고,
    // 비즈니스 로직(캐시/미터) 접근은 여기서 클로저로 주입한다.
    sessionKey: sessionName || 'default',
    buildUsageOverview: () => {
      const { getWarmupTargets } = require('./usageWarmup');
      const { getUsageCacheEntry } = require('./usageDb');
      // 사용량 패널 표시 순서: provider(claude → codex → agy, 미지정은 뒤로)로
      // 먼저 묶고, 그 안에서는 sessionKey 오름차순으로 정렬한다 — 세션 생성
      // 순서로 뒤섞여 보이던 것을 provider별로 그룹핑해 가독성을 높인다.
      const providerRank = { claude: 0, codex: 1, agy: 2 };
      const rankOf = (cmd) => {
        const r = providerRank[(cmd || '').toLowerCase()];
        return r === undefined ? 3 : r;
      };
      return getWarmupTargets()
        .map(t => ({
          ...t,
          cached: getUsageCacheEntry(t.toolCommand, t.sessionKey),
        }))
        .sort((a, b) => {
          const rankDiff = rankOf(a.toolCommand) - rankOf(b.toolCommand);
          if (rankDiff !== 0) return rankDiff;
          return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''));
        });
    },
    refreshCurrentUsage: (overrides) => {
      const { getClaudeUsage, getCodexUsage, getAgyUsage } = require('./usageMeter');
      // usageMeter 의 config 인자는 실제로 사용되지 않음(_config) — null 전달.
      const command = (tool.command || '').toLowerCase();
      if (isCodexCommand(tool.command)) return getCodexUsage(null, overrides);
      if (command === 'agy') return getAgyUsage(null, overrides);
      return getClaudeUsage(null, overrides);
    },
  };

  // tmux / node-pty는 자체적으로 화면 전환을 관리하므로 exitAltScreen 불필요.
  // fallback(직접 실행)만 정상 스크린 버퍼에서 실행해야 하므로 그때만 전환한다.
  let wrapped = false;
  let wrapperAttempted = false;
  const palette = config ? loadTheme(config) : {};
  const frameToolObj = isCodexCommand(tool.command) ? wrappedToolObj : toolObj;

  // Use the xterm compositor on every OS so the frame, controls, and session
  // experience remain identical. Named CLI sessions continue to be managed by
  // their isolated config directories; they do not require tmux panes.
  wrapperAttempted = true;
  const { runXtermWrapped } = require('./xtermFrame');
  wrapped = await runXtermWrapped(frameToolObj, env, label, wrapOpts);

  // Kept for possible future multi-pane support. Do not remove this branch
  // unless tmux support is intentionally retired from the project.
  // const useTmux = !isWin || settings.windows_use_tmux === true;
  // if (!wrapped && useTmux) {
  //   wrapped = runTmuxSession(frameToolObj, env, label, { colors: palette });
  // }

  // node-pty frame
  if (!wrapped && !isCodexCommand(tool.command)) {
    wrapped = await runWrapped(toolObj, env, label, wrapOpts);
  }

  if (!wrapped) {
    exitAltScreen();
    process.stdout.write('\x1b[2J\x1b[H');
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try { process.stdin.setRawMode(false); } catch {}
    }
    try { process.stdin.pause(); } catch {}
    if (wrapperAttempted) {
      process.stdout.write(
        c.warn + '[wrapper 실행에 실패하였습니다. 직접 실행합니다.]' + c.RESET + '\n' +
        c.muted2 + '  2초 후 직접 실행으로 전환합니다...' + c.RESET + '\n\n'
      );
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const noop = () => {};
    process.on('SIGINT', noop);
    const execArgs = isCodexCommand(tool.command) ? wrappedToolObj.args : args;
    try { process.stdin.resume(); } catch {}
    const result = spawnTool(tool.command, execArgs, { env, stdio: 'inherit' });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      const msg = result.error.code === 'ENOENT'
        ? `'${tool.command}' 명령어를 찾을 수 없습니다. 도구 설정의 command 값을 확인하세요.`
        : result.error.message;
      logError(`runTool(${tool.command})`, result.error);
      process.stderr.write('\n' + c.warn + '오류: ' + msg + c.RESET + '\n\n');
      process.stderr.write(c.muted2 + `  에러 로그: ${path.join(storageDir(), 'error.log')}` + c.RESET + '\n\n');
    }
    enterAltScreen();
  }

  // anon 임시 디렉토리 정리
  if (cleanupTmp) {
    process.removeListener('exit', cleanupTmp);
    cleanupTmp();
  }

  // ※ process.exit() 없음 — void 유지, 메뉴로 복귀
}

async function runCommandLine(commandLine, c, config, label = 'svc') {
  const env = { ...process.env };
  const shell = isWin ? 'cmd' : (env.SHELL || '/bin/bash');
  const shellArgs = isWin ? ['/c', commandLine] : ['-lc', commandLine];

  const settings = (config && config.settings) || {};
  const wrapOpts = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
  };

  const wrapped = await runWrappedShell(commandLine, env, `${label}`, wrapOpts);
  if (!wrapped) {
    exitAltScreen();
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const result = spawnSync(shell, shellArgs, { env, stdio: 'inherit' });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      logError(`runCommandLine(${commandLine})`, result.error);
      process.stderr.write('\n' + c.warn + '오류: ' + result.error.message + c.RESET + '\n\n');
    }
    enterAltScreen();
  }
}

async function runHostShell(c, config, label = 'host') {
  const env = { ...process.env };
  const shell = isWin ? 'cmd' : (env.SHELL || '/bin/bash');
  const shellArgs = isWin ? [] : ['-i'];

  const settings = (config && config.settings) || {};
  const wrapOpts = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
  };

  const wrapped = await runWrappedShell('', env, label, wrapOpts);
  if (!wrapped) {
    exitAltScreen();
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const result = spawnSync(shell, shellArgs, { env, stdio: 'inherit' });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      logError(`runHostShell`, result.error);
      process.stderr.write('\n' + c.warn + '오류: ' + result.error.message + c.RESET + '\n\n');
    }
    enterAltScreen();
  }
}

module.exports = { runTool, runCommandLine, runHostShell };
