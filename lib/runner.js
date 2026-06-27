'use strict';
const { spawnSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

// mode: false = 일반 | 'anon' = 익명(temp HOME) | string = 세션명(CLAUDE_CONFIG_DIR)
async function runTool(tool, mode, c) {
  const isAnon      = mode === 'anon';
  const sessionName = (mode && typeof mode === 'string' && mode !== 'anon') ? mode : null;
  const env = { ...process.env };

  if (sessionName) {
    const configDir = path.join(os.homedir(), `.claude-${sessionName}`);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    env.CLAUDE_CONFIG_DIR = configDir;
    process.stdout.write(
      '\n' + c.signal + `[세션: ${sessionName}]` + c.RESET +
      ' CLAUDE_CONFIG_DIR=' + c.muted2 + configDir + c.RESET + '\n\n'
    );
  } else if (isAnon) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-anon-'));
    env.HOME            = tmpDir;
    env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    env.XDG_DATA_HOME   = path.join(tmpDir, '.local', 'share');

    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    process.on('exit',    cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    process.stdout.write(
      '\n' + c.signal + '[익명모드]' + c.RESET +
      ' HOME=' + c.muted2 + tmpDir + c.RESET + '\n\n'
    );
  }

  process.stdout.write('\x1b[2J\x1b[H');

  const cmd  = tool.command;
  const args = (isAnon && tool.anonymous_args) ? tool.anonymous_args : (tool.args || []);
  const result = spawnSync(cmd, args, { env, stdio: 'inherit', shell: false });

  if (result.error) {
    const msg = result.error.code === 'ENOENT'
      ? `'${cmd}' 명령어를 찾을 수 없습니다. config.yml의 command를 확인하세요.`
      : result.error.message;
    process.stderr.write('\n' + c.warn + '오류: ' + msg + c.RESET + '\n');
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

module.exports = { runTool };
