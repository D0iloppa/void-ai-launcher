'use strict';
const { spawnSync } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { runWrapped } = require('./wrapper');

// mode: false = 일반 | 'anon' = 익명(temp HOME) | string = 세션명(CLAUDE_CONFIG_DIR)
async function runTool(tool, mode, c) {
  const isAnon      = mode === 'anon';
  const sessionName = (mode && typeof mode === 'string' && mode !== 'anon') ? mode : null;
  const env = { ...process.env };
  let cleanupTmp = null;

  if (sessionName) {
    const configDir = path.join(os.homedir(), `.claude-${sessionName}`);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    env.CLAUDE_CONFIG_DIR = configDir;
  } else if (isAnon) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-anon-'));
    env.HOME            = tmpDir;
    env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    env.XDG_DATA_HOME   = path.join(tmpDir, '.local', 'share');
    cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    process.once('exit', cleanupTmp);
  }

  // 표시할 레이블 (상단 바용)
  const label = sessionName ? `${tool.name}  [${sessionName}]`
    : isAnon               ? `${tool.name}  [익명]`
    : tool.name;

  const args = (isAnon && tool.anonymous_args) ? tool.anonymous_args : (tool.args || []);
  const toolObj = { command: tool.command, args };

  // ── node-pty wrapper 시도 ─────────────────────────────────
  const wrapped = await runWrapped(toolObj, env, label);

  if (!wrapped) {
    // node-pty 없을 때 fallback: 직접 실행 (void는 살아있음)
    process.stdout.write('\x1b[2J\x1b[H');
    const noop = () => {};
    process.on('SIGINT', noop);
    const result = spawnSync(tool.command, args, { env, stdio: 'inherit', shell: false });
    process.removeListener('SIGINT', noop);

    if (result.error) {
      const msg = result.error.code === 'ENOENT'
        ? `'${tool.command}' 명령어를 찾을 수 없습니다. config.yml의 command를 확인하세요.`
        : result.error.message;
      process.stderr.write('\n' + c.warn + '오류: ' + msg + c.RESET + '\n\n');
    }
  }

  // anon 임시 디렉토리 정리
  if (cleanupTmp) {
    process.removeListener('exit', cleanupTmp);
    cleanupTmp();
  }

  // ※ process.exit() 없음 — void 유지, 메뉴로 복귀
}

module.exports = { runTool };
