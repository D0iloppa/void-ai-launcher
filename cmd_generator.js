#!/usr/bin/env node
// VOID//ai-launcher — cross-platform install script
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const isWin    = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';
const DIR      = __dirname;
const NODE_MIN   = 18;
const NODE_BIN   = process.execPath;
const NONI       = process.env.VOID_BUILD_NONINTERACTIVE === '1';
const NPM_CACHE  = process.env.VOID_NPM_CACHE_DIR || path.join(os.tmpdir(), 'void-npm-cache');
const RUNTIME_PKGS = ['@anthropic-ai/sdk', '@google/generative-ai', 'node-pty', 'openai'];

// ── ANSI ───────────────────────────────────────────────────────────────────
const G = '\x1b[38;2;0;230;118m', Y = '\x1b[38;2;251;191;36m',
      M = '\x1b[38;2;106;138;106m', R = '\x1b[0;31m',
      B = '\x1b[1m', RST = '\x1b[0m';

const ok   = msg => console.log(`  ${G}✓${RST} ${msg}`);
const step = msg => console.log(`\n${G}${B}──${RST}${B} ${msg}${RST}`);
const warn = msg => console.log(`  ${Y}⚠${RST}  ${msg}`);
const die  = msg => { console.error(`  ${R}✗${RST}  ${msg}`); process.exit(1); };

const canWriteDir = dir => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

// 대화형 stdin (GUI 설치 창처럼 스크립트가 직접 제어할 수 없는 작업을 사용자가
// 끝낸 뒤 Enter로 알려주는 용도). fd 0는 npm/셸 wrapper를 거치며 TTY 판정이나
// non-blocking 상태가 꼬일 수 있어, 컨트롤링 터미널을 직접 여는 /dev/tty로 읽는다.
// 컨트롤링 터미널이 없는 비대화형 빌드(NONI)/CI에서는 open 자체가 실패해 빈 값 반환.
const promptSync = question => {
  process.stdout.write(question);
  if (NONI) return '';
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { return ''; }
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return buf.toString('utf8', 0, n).trim();
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
};
const askYesNo  = question => /^y(es)?$/i.test(promptSync(`  ${Y}?${RST}  ${question} [y/N] `));
const waitEnter = message  => promptSync(`  ${M}${message}${RST}`);

// ── Header ─────────────────────────────────────────────────────────────────
console.log(`\n${G}${B}┌── VOID//ai-launcher ─ 설치 스크립트 ──────────┐${RST}`);
console.log(`${G}${B}│${RST}  cmd_generator.js                              ${G}${B}│${RST}`);
console.log(`${G}${B}└────────────────────────────────────────────────┘${RST}\n`);

// ── 1. Node.js version ─────────────────────────────────────────────────────
step('Node.js 확인');
const nodeVer = parseInt(process.versions.node, 10);
if (nodeVer < NODE_MIN) die(`Node.js v${NODE_MIN}+ 필요 (현재: v${nodeVer})`);
ok(`Node.js v${process.versions.node}  →  ${M}${NODE_BIN}${RST}`);
if (NODE_BIN.includes('nvm')) warn('nvm 경로 감지됨. sudo void 사용 시 wrapper가 절대 경로를 사용합니다.');

// ── 2. sudo preflight (Unix only, before npm) ──────────────────────────────
if (!isWin && !canWriteDir('/usr/local/bin')) {
  step('sudo 권한 확인');
  const r = spawnSync('sudo', NONI ? ['-n', '-v'] : ['-v'], { stdio: 'inherit' });
  if (r.status !== 0) die('sudo 권한이 없습니다.');
  ok('sudo 권한 확인 완료');
}

// ── 3. npm install ─────────────────────────────────────────────────────────
const npmOpts = { cwd: DIR, env: { ...process.env, npm_config_cache: NPM_CACHE }, stdio: 'inherit', shell: isWin };

step('의존성 설치');
spawnSync('npm', ['install', '--silent'], npmOpts);
ok('js-yaml 설치 완료');

step('런타임 의존성 설치');
spawnSync('npm', ['install', '--no-save', '--silent', ...RUNTIME_PKGS], npmOpts);
ok('Claude / Codex / Gemini / Wrapper 의존성 설치 완료');

// ── 4. tmux check (macOS only — Big Sur+ ships without it) ─────────────────
// tmux는 void의 풀스크린/서브쉘 wrapper에 필수이므로, 확보하지 못하면 설치를
// 여기서 중단한다 (die). 재실행 시 이미 tmux가 있으면 이 블록은 바로 통과된다.
if (isDarwin) {
  step('tmux 확인 (macOS)');
  const hasTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
  if (hasTmux) {
    ok('tmux 설치 확인됨 — 풀스크린 wrapper 사용 가능');
  } else {
    warn('tmux가 설치되어 있지 않습니다 (macOS는 Big Sur 이후 tmux 기본 미포함)');
    const hasBrew = spawnSync('which', ['brew'], { encoding: 'utf8' }).status === 0;
    const retryGuide = 'Command Line Tools 설치를 완료한 뒤 npm run build를 다시 실행하세요.';

    if (!hasBrew) {
      die(`Homebrew가 없어 tmux를 자동 설치할 수 없습니다. Homebrew 설치 후 다시 실행하세요: ${B}brew install tmux${RST}`);
    }

    // xcode-select -p만으로는 부족함: 경로가 남아있어도 실제 툴체인이 깨져있을 수 있음
    // (macOS 업데이트 후 흔한 케이스 — xcrun이 "invalid active developer path"로 실패)
    const hasCLT = spawnSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).status === 0;

    if (!hasCLT) {
      warn('Xcode Command Line Tools가 없거나 손상되어 있어 brew install을 건너뜁니다.');
      if (!askYesNo('손상된 Command Line Tools를 삭제하고 재설치할까요? (sudo 필요)')) {
        die(`Command Line Tools 없이는 tmux를 설치할 수 없습니다. ${retryGuide}\n  ${M}수동 복구: ${B}sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install${RST}`);
      }
      console.log(`  ${M}sudo rm -rf /Library/Developer/CommandLineTools 실행 중...${RST}`);
      const rmR = spawnSync('sudo', ['rm', '-rf', '/Library/Developer/CommandLineTools'], { stdio: 'inherit' });
      if (rmR.status !== 0) die(`Command Line Tools 삭제에 실패했습니다. ${retryGuide}`);

      console.log(`  ${M}xcode-select --install 실행 중 (macOS GUI 설치 창이 열립니다)...${RST}`);
      spawnSync('xcode-select', ['--install'], { stdio: 'inherit' });
      const MAX_ATTEMPTS = 5;
      let recovered = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !recovered; attempt++) {
        waitEnter(`GUI 설치 창에서 설치를 완료한 뒤 Enter를 눌러주세요. (${attempt}/${MAX_ATTEMPTS}) `);
        recovered = spawnSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).status === 0;
        if (!recovered) warn(`아직 Command Line Tools 설치가 확인되지 않았습니다. (${attempt}/${MAX_ATTEMPTS})`);
      }
      if (!recovered) die(`${MAX_ATTEMPTS}번 확인했지만 Command Line Tools 설치를 확인하지 못했습니다. ${retryGuide}`);
      ok('Command Line Tools 복구 확인됨 — brew install tmux 진행합니다.');
    }

    console.log(`  ${M}brew install tmux 실행 중...${RST}`);
    const r = spawnSync('brew', ['install', '--yes', 'tmux'], { stdio: 'inherit' });
    if (r.status !== 0) die(`brew install tmux 실패. 수동으로 설치 후 npm run build를 다시 실행하세요: ${B}brew install tmux${RST}`);
    ok('tmux 설치 완료 — 풀스크린 wrapper 사용 가능');
  }
}

// ── 5. Register command ────────────────────────────────────────────────────
if (isWin) installWindows();
else installUnix();

// ── 완료 ──────────────────────────────────────────────────────────────────
console.log(`\n${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}`);
console.log(`${G}${B}  VOID//ai-launcher 설치 완료${RST}`);
console.log(`${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n`);
console.log(`  ${G}void${RST}                    메인 메뉴`);
console.log(`  ${G}void --help${RST}             도움말 보기\n`);
if (!isWin) console.log(`  ${M}sudo void 도 동일하게 동작합니다.${RST}\n`);

// ─────────────────────────────────────────────────────────────────────────

function installUnix() {
  const bin = '/usr/local/bin/void';

  step('실행 권한 설정');
  fs.chmodSync(path.join(DIR, 'launcher.js'), 0o755);
  ok('launcher.js +x');

  step(`void 명령어 설치  →  ${bin}`);
  const wrapper = `#!/usr/bin/env bash\nexport _VOID_BIN="${bin}"\nexec "${NODE_BIN}" "${DIR}/launcher.js" "$@"\n`;

  if (canWriteDir('/usr/local/bin')) {
    fs.writeFileSync(bin, wrapper, { mode: 0o755 });
  } else {
    const tmp = path.join(os.tmpdir(), 'void-wrapper-tmp');
    fs.writeFileSync(tmp, wrapper);
    const sudoRun = args => spawnSync('sudo', [...(NONI ? ['-n'] : []), ...args], { stdio: 'inherit' });
    sudoRun(['cp', tmp, bin]);
    sudoRun(['chmod', '+x', bin]);
    fs.unlinkSync(tmp);
  }
  ok(`void 설치됨  →  ${bin}`);

  step('설치 확인');
  const which = spawnSync('which', ['void'], { encoding: 'utf8' });
  if (which.status === 0) ok(`which void → ${which.stdout.trim()}`);
  else {
    warn("'void' 를 PATH 에서 찾을 수 없습니다.");
    console.log(`  ${M}터미널 재시작 또는: source ~/.bashrc / source ~/.zshrc${RST}`);
  }
}

function installWindows() {
  step('void 명령어 설치 (Windows)');

  // npm global prefix → e.g. C:\Users\<user>\AppData\Roaming\npm
  const npmPrefix = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', shell: true }).stdout.trim();
  const launcherAbs = path.win32.join(DIR, 'launcher.js');

  // .cmd for cmd.exe / bat, .ps1 for PowerShell
  const cmdContent = `@echo off\r\n"${NODE_BIN}" "${launcherAbs}" %*\r\n`;
  const ps1Content = `#!/usr/bin/env pwsh\n& "${NODE_BIN}" "${launcherAbs}" @args\n`;

  try {
    fs.writeFileSync(path.join(npmPrefix, 'void.cmd'), cmdContent);
    fs.writeFileSync(path.join(npmPrefix, 'void.ps1'), ps1Content);
    ok(`void.cmd / void.ps1 설치됨  →  ${npmPrefix}`);
  } catch (e) {
    warn(`설치 실패 (권한 부족?): ${e.message}`);
    console.log(`  ${M}대안: 관리자 권한 터미널에서 npm run build 재실행${RST}`);
  }

  step('설치 확인');
  const where = spawnSync('where', ['void'], { encoding: 'utf8', shell: true });
  if (where.status === 0) ok(`where void → ${where.stdout.trim()}`);
  else {
    warn("'void' 를 PATH 에서 찾을 수 없습니다.");
    console.log(`  ${M}터미널 재시작 또는 npm global bin 경로를 PATH에 추가하세요.${RST}`);
  }
}
