'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── tmux helpers ──────────────────────────────────────────

function hasTmux() {
  return spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
}

function listTmuxSessions() {
  const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_windows}'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [name, created, windows] = line.split('|');
    const elapsed = Math.floor((Date.now() - parseInt(created, 10) * 1000) / 60000);
    return { name, elapsed: elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed/60)}h`, windows: parseInt(windows, 10) };
  });
}

function attachTmux(name) {
  const { exitAltScreen, enterAltScreen } = require('./ui');
  exitAltScreen();
  spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
  enterAltScreen();
}

async function createSession(tool, c) {
  const sessionName = `void-${tool.command}-${Date.now().toString(36)}`;
  spawnSync('tmux', ['new-session', '-d', '-s', sessionName, tool.command, ...(tool.args || [])]);
  attachTmux(sessionName);
}

// ── 터미널 세션 (tmux) ────────────────────────────────────

async function terminalSessionsMenu(config, c) {
  const { menu, message } = require('./ui');

  if (!hasTmux()) {
    await tryNodePtyFallback(c);
    return;
  }

  while (true) {
    const sessions = listTmuxSessions();
    const items = [
      { key: '1', label: '새 세션 시작' },
      ...sessions.map((s, i) => ({
        key: String(i + 2),
        label: s.name,
        desc: `${s.windows}창  ${s.elapsed} 전`,
      })),
    ];

    const sel = await menu('터미널 세션 (tmux)', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      const tools = config.tools;
      const toolItems = tools.map((t, i) => ({ key: String(i + 1), label: t.name, desc: t.command }));
      const toolSel = await menu('새 세션 — 도구 선택', toolItems, { back: true });
      if (!toolSel) continue;
      await createSession(tools[Number(toolSel.key) - 1], c);
    } else {
      const s = sessions[Number(sel.key) - 2];
      if (s) attachTmux(s.name);
    }
  }
}

async function tryNodePtyFallback(c) {
  const { message } = require('./ui');
  let nodeptyAvailable = false;
  try { require('node-pty'); nodeptyAvailable = true; } catch {}

  await message([
    c.warn + 'tmux 를 찾을 수 없습니다.' + c.RESET,
    '',
    '  설치 방법:',
    '  ' + c.muted2 + 'brew install tmux' + c.RESET + '       (macOS)',
    '  ' + c.muted2 + 'sudo apt install tmux' + c.RESET + '   (Ubuntu/Debian)',
    '',
    nodeptyAvailable
      ? '  ' + c.muted + 'node-pty 감지됨 — 향후 버전에서 지원 예정' + c.RESET
      : '  ' + c.muted + 'node-pty 대안: npm install node-pty' + c.RESET,
  ].join('\n'));
}

// ── Claude 네임드 세션 관리 ───────────────────────────────

function fmtNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sessionDirForTool(toolCommand, name) {
  return path.join(os.homedir(), `.${toolCommand}-${name}`);
}

function sessionCapableTools(config) {
  return (config.tools || []).filter(tool => ['claude', 'codex'].includes((tool.command || '').toLowerCase()));
}

async function cliSessionsMenu(config, c) {
  const { menu, message, input } = require('./ui');
  const { getSessions, saveSession, deleteSession } = require('./storage');

  while (true) {
    const sessions = getSessions().map(s => ({ ...s, toolCommand: s.toolCommand || 'claude' }));
    const items = [
      { key: 'n', label: '새 세션 만들기' },
      ...sessions.map((s, i) => ({
        key: String(i + 1),
        label: `${s.name}`,
        desc: `${s.toolCommand}  ${s.created_at}`,
      })),
    ];

    const sel = await menu('CLI 세션 관리', items, { back: true });
    if (!sel) return;

    if (sel.key === 'n') {
      await createCliSession(config, c);
    } else {
      const s = sessions[Number(sel.key) - 1];
      if (s) await sessionDetailMenu(s, c);
    }
  }
}

async function createCliSession(config, c) {
  const { input, message } = require('./ui');
  const { getSessions, saveSession } = require('./storage');
  const tools = sessionCapableTools(config);

  if (tools.length === 0) {
    await message('세션 생성 가능한 도구가 없습니다.');
    return;
  }

  const toolItems = tools.map((tool, i) => ({
    key: String(i + 1),
    label: tool.name,
    desc: tool.command,
  }));
  const toolSel = await require('./ui').menu('세션 생성 — 도구 선택', toolItems, { back: true });
  if (!toolSel) return;

  const tool = tools[Number(toolSel.key) - 1];
  const toolCommand = (tool.command || '').toLowerCase();

  const raw = (await input('세션명 (영문/숫자/-): ')).trim();
  if (!raw) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(raw)) {
    await message('유효하지 않은 세션명입니다.\n\n' + c.muted2 + '  영문/숫자/-만 사용, 영문 또는 숫자로 시작' + c.RESET);
    return;
  }

  const existing = getSessions().find(s => s.name === raw && (s.toolCommand || 'claude') === toolCommand);
  if (existing) {
    await message(`'${raw}' 세션이 이미 존재합니다. (${tool.name})`);
    return;
  }

  const configDir = sessionDirForTool(toolCommand, raw);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  saveSession({ name: raw, toolCommand, configDir, created_at: fmtNow() });

  await message(
    c.signal + '세션 생성됨' + c.RESET + '\n\n' +
    '  도구:  ' + c.text + tool.name + c.RESET + '\n' +
    '  이름:  ' + c.text + raw + c.RESET + '\n' +
    '  경로:  ' + c.muted2 + configDir + c.RESET + '\n\n' +
    c.muted + '  첫 실행 시 로그인이 필요합니다.' + c.RESET
  );
}

async function sessionDetailMenu(session, c) {
  const { menu, message } = require('./ui');
  const { deleteSession } = require('./storage');

  const dirExists = fs.existsSync(session.configDir);
  const items = [
    { key: '1', label: '세션 등록 해제',  desc: 'sessions.json에서 제거 (디렉토리 유지)' },
    { key: '2', label: '완전 삭제',       desc: '등록 해제 + 디렉토리 삭제' },
  ];

  const sel = await menu(`세션: ${session.name}`, items, { back: true });
  if (!sel) return;

  deleteSession(session.name, session.toolCommand || 'claude');

  if (sel.key === '2' && dirExists) {
    try { fs.rmSync(session.configDir, { recursive: true, force: true }); } catch {}
  }

  await message(
    `'${session.toolCommand || 'claude'}:${session.name}' 세션 ${sel.key === '2' ? '완전 삭제됨' : '등록 해제됨'}`
  );
}

module.exports = { hasTmux, terminalSessionsMenu, cliSessionsMenu, createSession };
