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

  let cleanupTmp = null;

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

    cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    // void 자체가 종료될 때를 대비한 fallback (정상 종료 시에는 아래에서 명시적으로 호출)
    process.once('exit', cleanupTmp);

    process.stdout.write(
      '\n' + c.signal + '[익명모드]' + c.RESET +
      ' HOME=' + c.muted2 + tmpDir + c.RESET + '\n\n'
    );
  }

  process.stdout.write('\x1b[2J\x1b[H');

  const cmd  = tool.command;
  const args = (isAnon && tool.anonymous_args) ? tool.anonymous_args : (tool.args || []);

  // 자식 프로세스 실행 중 SIGINT를 void에서 무시 (자식이 직접 처리)
  // 기본 동작(프로세스 종료)을 막기 위해 no-op 핸들러 등록
  const noop = () => {};
  process.on('SIGINT', noop);

  const result = spawnSync(cmd, args, { env, stdio: 'inherit', shell: false });

  // 자식 종료 후 SIGINT 핸들러 제거 (이후 Ctrl+C는 정상 동작)
  process.removeListener('SIGINT', noop);

  // anon 임시 디렉토리 정리
  if (cleanupTmp) {
    process.removeListener('exit', cleanupTmp);
    cleanupTmp();
  }

  if (result.error) {
    const msg = result.error.code === 'ENOENT'
      ? `'${cmd}' 명령어를 찾을 수 없습니다. config.yml의 command를 확인하세요.`
      : result.error.message;
    process.stderr.write('\n' + c.warn + '오류: ' + msg + c.RESET + '\n\n');
    // process.exit 하지 않고 반환 → 호출자(launcher.js)가 메뉴 재표시
  }

  // ※ process.exit() 하지 않음 — void 프로세스 유지, 메뉴로 복귀
}

module.exports = { runTool };
