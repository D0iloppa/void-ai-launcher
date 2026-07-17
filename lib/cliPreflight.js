'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── OS 감지 ───────────────────────────────────────────────
// WSL 은 process.platform === 'linux' 로 잡히므로 별도 분기 불필요.
function platformFamily() {
  return process.platform === 'win32' ? 'win' : 'unix';
}

function osLabel() {
  switch (process.platform) {
    case 'win32':  return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux':  return 'Linux / WSL';
    default:       return process.platform;
  }
}

// ── 설치 스크립트 정의 (tool.command × platform family) ────
// OS 확인 후 어떤 설치 스크립트를 실행할지 함수 레벨에서 정의.
// URL/명령어는 공식 문서 기준의 고정 상수이며, 사용자 입력을 절대 끼워넣지 않는다.
function installSpecFor(toolCommand) {
  const TABLE = {
    claude: {
      unix: { url: 'https://claude.ai/install.sh',            runner: 'bash' },
      win:  { psCommand: 'irm https://claude.ai/install.ps1 | iex' },
    },
    codex: {
      unix: { url: 'https://chatgpt.com/codex/install.sh',    runner: 'sh' },
      win:  { psCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
    },
    agy: {
      unix: { url: 'https://antigravity.google/cli/install.sh', runner: 'bash' },
      win:  { psCommand: 'irm https://antigravity.google/cli/install.ps1 | iex' },
    },
  };
  const cmd = (toolCommand || '').toLowerCase();
  const entry = TABLE[cmd];
  if (!entry) return null;
  return entry[platformFamily()] || null;
}

// ── PATH 설치 여부 확인 ───────────────────────────────────
function isInstalled(cmd) {
  if (!cmd) return false;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { encoding: 'utf8' });
  return r.status === 0;
}

// ── 설치 스크립트 실행 ────────────────────────────────────
// 파이프(curl | bash) 금지: unix 는 임시 디렉토리로 내려받아 별도 실행.
// windows 는 PowerShell 로만 실행 (bash 스크립트 실행 시도 금지).
function runInstaller(toolCommand, spec) {
  if (!spec) return { ok: false, note: '이 OS 에서는 설치 스크립트를 지원하지 않습니다.' };

  if (platformFamily() === 'win') {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', spec.psCommand], {
      stdio: 'inherit',
    });
    if (run.error) return { ok: false, note: 'PowerShell 실행 실패: ' + run.error.message };
    if (run.status !== 0) return { ok: false, note: `설치 스크립트가 코드 ${run.status} 로 종료되었습니다.` };
    return { ok: true };
  }

  // unix (macOS / Linux / WSL)
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-cli-'));
  } catch (err) {
    return { ok: false, note: '임시 디렉토리 생성 실패: ' + err.message };
  }
  const tmpfile = path.join(dir, 'install.sh');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  try {
    const dl = spawnSync('curl', ['-fsSL', spec.url, '-o', tmpfile], { stdio: 'inherit' });
    if (dl.error) return { ok: false, note: 'curl 실행 실패: ' + dl.error.message };
    if (dl.status !== 0) return { ok: false, note: `다운로드 실패 (curl 코드 ${dl.status}).` };

    const run = spawnSync(spec.runner, [tmpfile], { stdio: 'inherit', env: process.env });
    if (run.error) return { ok: false, note: `${spec.runner} 실행 실패: ` + run.error.message };
    if (run.status !== 0) return { ok: false, note: `설치 스크립트가 코드 ${run.status} 로 종료되었습니다.` };
    return { ok: true };
  } finally {
    cleanup();
  }
}

// ── 메뉴 ──────────────────────────────────────────────────
async function agentCliMenu(config, c) {
  const { menu, message, exitAltScreen, enterAltScreen } = require('./ui');
  const tools = (config.tools || []).filter(t => t && t.command);

  if (tools.length === 0) {
    await message('등록된 도구가 없습니다.');
    return;
  }

  const statusLabel = cmd =>
    isInstalled(cmd)
      ? c.ok + '[설치됨]' + c.RESET
      : c.warn + '[미설치]' + c.RESET;

  while (true) {
    const items = tools.map((t, i) => ({
      key: String(i + 1),
      label: `${t.name} (${t.command})`,
      desc: statusLabel(t.command),
    }));

    const sel = await menu(`Agent CLI 관리 — ${osLabel()}`, items, { back: true });
    if (!sel) return;

    const tool = tools[Number(sel.key) - 1];
    if (!tool) continue;

    if (isInstalled(tool.command)) {
      await message(
        c.ok + `${tool.name} (${tool.command}) 은(는) 이미 설치되어 있습니다.` + c.RESET
      );
      continue;
    }

    const spec = installSpecFor(tool.command);
    if (!spec) {
      await message(
        c.warn + `${tool.name} (${tool.command}) 의 ${osLabel()} 용 설치 스크립트가 정의되어 있지 않습니다.` + c.RESET
      );
      continue;
    }

    const confirm = await menu(
      `${tool.name} 설치 — ${osLabel()}`,
      [
        { key: '1', label: '예', desc: '공식 설치 스크립트를 내려받아 실행합니다.' },
        { key: '2', label: '아니오', desc: '취소' },
      ],
      { back: true }
    );
    if (!confirm || confirm.key !== '1') continue;

    exitAltScreen();
    process.stdout.write('\x1b[2J\x1b[H');
    const result = runInstaller(tool.command, spec);
    enterAltScreen();

    // 설치 후 PATH 재확인 (설치 스크립트 exit code 만 신뢰하지 않음).
    const nowInstalled = isInstalled(tool.command);
    const statusLine = nowInstalled
      ? c.ok + '[설치됨]' + c.RESET
      : c.warn + '[미설치]' + c.RESET;

    const lines = [
      c.signal + `${tool.name} (${tool.command}) 설치 결과` + c.RESET,
      '',
      '  갱신된 상태:  ' + statusLine,
    ];
    if (!result.ok) {
      lines.push('', c.warn + '  ' + result.note + c.RESET);
    }
    if (!nowInstalled) {
      lines.push(
        '',
        c.muted2 + '  PATH 에서 아직 찾을 수 없습니다. 새 셸을 열거나' + c.RESET,
        c.muted2 + '  PATH 를 다시 로드한 뒤 확인하세요.' + c.RESET
      );
    }
    await message(lines.join('\n'));
  }
}

module.exports = { agentCliMenu, isInstalled, installSpecFor, osLabel };
