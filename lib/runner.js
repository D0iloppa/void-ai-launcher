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
const { resolveToolStateDir, resolveSessionConfigDir } = require('./storage');

function isCodexCommand(command) {
  return (command || '').toLowerCase() === 'codex';
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
}

// mode: false = 일반 | 'anon' = 익명(temp HOME) | string = 세션명(CLAUDE_CONFIG_DIR)
// config: 전체 config.yml 객체 (wrapper 패딩값 읽기용)
async function runTool(tool, mode, c, config, extraArgs = []) {
  const isAnon      = mode === 'anon';
  const session     = resolveSessionProfile(tool, mode);
  const sessionName = session ? session.name : null;
  const env = { ...process.env };
  let cleanupTmp = null;

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
  const label = sessionName ? `${tool.name}  [${sessionName}]`
    : isAnon               ? `${tool.name}  [익명]`
    : tool.name;

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
  };

  exitAltScreen();

  let wrapped = false;
  // tmux fullscreen
  const palette = config ? loadTheme(config) : {};
  wrapped = runTmuxSession(toolObj, env, label, { colors: palette });

  // node-pty frame
  if (!wrapped && !isCodexCommand(tool.command)) {
    wrapped = await runWrapped(toolObj, env, label, wrapOpts);
  }

  if (!wrapped) {
    // node-pty 없을 때 fallback: 직접 실행 (void는 살아있음)
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const execArgs = isCodexCommand(tool.command) ? wrappedToolObj.args : args;
    const result = spawnSync(tool.command, execArgs, { env, stdio: 'inherit', shell: false });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      const msg = result.error.code === 'ENOENT'
        ? `'${tool.command}' 명령어를 찾을 수 없습니다. config.yml의 command를 확인하세요.`
        : result.error.message;
      process.stderr.write('\n' + c.warn + '오류: ' + msg + c.RESET + '\n\n');
    }
  }
  enterAltScreen();

  // anon 임시 디렉토리 정리
  if (cleanupTmp) {
    process.removeListener('exit', cleanupTmp);
    cleanupTmp();
  }

  // ※ process.exit() 없음 — void 유지, 메뉴로 복귀
}

async function runCommandLine(commandLine, c, config, label = 'svc') {
  const env = { ...process.env };
  const shell = env.SHELL || '/bin/bash';

  const settings = (config && config.settings) || {};
  const wrapOpts = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
  };

  exitAltScreen();
  const wrapped = await runWrappedShell(commandLine, env, `${label}`, wrapOpts);
  if (!wrapped) {
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const result = spawnSync(shell, ['-lc', commandLine], { env, stdio: 'inherit', shell: false });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      process.stderr.write('\n' + c.warn + '오류: ' + result.error.message + c.RESET + '\n\n');
    }
  }
  enterAltScreen();
}

async function runHostShell(c, config, label = 'host') {
  const env = { ...process.env };
  const shell = env.SHELL || '/bin/bash';

  const settings = (config && config.settings) || {};
  const wrapOpts = {
    hpad: typeof settings.wrapper_hpad === 'number' ? settings.wrapper_hpad : undefined,
    vpad: typeof settings.wrapper_vpad === 'number' ? settings.wrapper_vpad : undefined,
  };

  exitAltScreen();
  const wrapped = await runWrappedShell('', env, label, wrapOpts);
  if (!wrapped) {
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const result = spawnSync(shell, ['-i'], { env, stdio: 'inherit', shell: false });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      process.stderr.write('\n' + c.warn + '오류: ' + result.error.message + c.RESET + '\n\n');
    }
  }
  enterAltScreen();
}

module.exports = { runTool, runCommandLine, runHostShell };
