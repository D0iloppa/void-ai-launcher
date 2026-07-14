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
if (isDarwin) {
  step('tmux 확인 (macOS)');
  const hasTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
  if (hasTmux) {
    ok('tmux 설치 확인됨 — 풀스크린 wrapper 사용 가능');
  } else {
    warn('tmux가 설치되어 있지 않습니다 (macOS는 Big Sur 이후 tmux 기본 미포함)');
    console.log(`  ${M}풀스크린 wrapper(멀티탭/border)를 쓰려면: ${RST}${B}brew install tmux${RST}`);
    console.log(`  ${M}tmux 없이도 crash 없이 단순 실행 경로로 자동 폴백됩니다.${RST}`);
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
