'use strict';
const { spawnSync } = require('child_process');

function hasTmux() {
  return spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
}

function listTmuxSessions() {
  const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_windows}'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [name, created, windows] = line.split('|');
    const d = new Date(parseInt(created, 10) * 1000);
    const elapsed = Math.floor((Date.now() - d) / 60000);
    return { name, elapsed: elapsed < 60 ? `${elapsed}m` : `${Math.floor(elapsed/60)}h`, windows: parseInt(windows, 10) };
  });
}

async function sessionsMenu(config, c) {
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

    const sel = await menu('Sessions (tmux)', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      await newSessionMenu(config, c);
    } else {
      const s = sessions[Number(sel.key) - 2];
      if (s) attachTmux(s.name);
    }
  }
}

async function newSessionMenu(config, c) {
  const { menu } = require('./ui');
  const { tools } = config;
  const items = tools.map((t, i) => ({ key: String(i + 1), label: t.name, desc: t.command }));
  const sel = await menu('새 세션 — 도구 선택', items, { back: true });
  if (!sel) return;
  await createSession(tools[Number(sel.key) - 1], c);
}

async function createSession(tool, c) {
  const sessionName = `void-${tool.command}-${Date.now().toString(36)}`;
  const args = tool.args || [];

  // 백그라운드 세션 생성
  spawnSync('tmux', ['new-session', '-d', '-s', sessionName, tool.command, ...args]);

  // 포그라운드 attach (void 가 사라지고 tmux 가 전면에 뜸, detach 하면 void 도 종료)
  attachTmux(sessionName);
}

function attachTmux(name) {
  spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
}

async function tryNodePtyFallback(c) {
  const { message } = require('./ui');
  let nodeptyAvailable = false;
  try { require('node-pty'); nodeptyAvailable = true; } catch {}

  const lines = [
    c.warn + 'tmux 를 찾을 수 없습니다.' + c.RESET,
    '',
    '  설치 방법:',
    '  ' + c.muted2 + 'brew install tmux' + c.RESET + '       (macOS)',
    '  ' + c.muted2 + 'sudo apt install tmux' + c.RESET + '   (Ubuntu/Debian)',
    '',
    nodeptyAvailable
      ? '  ' + c.muted + 'node-pty 감지됨 — 향후 버전에서 지원 예정' + c.RESET
      : '  ' + c.muted + 'node-pty 대안: npm install node-pty' + c.RESET,
  ];

  await message(lines.join('\n'));
}

module.exports = { hasTmux, sessionsMenu, createSession };
