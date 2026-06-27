'use strict';

// ── ANSI helpers ──────────────────────────────────────────
const SIG_BG  = '\x1b[48;2;0;230;118m';   // signal green bg
const BLACK   = '\x1b[38;2;0;0;0m';
const RED_FG  = '\x1b[38;2;230;50;50m';   // void label accent
const BOLD    = '\x1b[1m';
const RST     = '\x1b[0m';

function topBarStr(cols, label) {
  const left  = ` Wrapper >_  ${label} `;
  const right = ` `;
  const pad   = ' '.repeat(Math.max(0, cols - left.length - right.length));
  return SIG_BG + BLACK + BOLD + left + pad + right + RST;
}

function bottomBarStr(cols) {
  const time  = new Date().toTimeString().slice(0, 8);
  const cwd   = process.cwd();
  const cwdTrim = cwd.length > 40 ? '…' + cwd.slice(-39) : cwd;
  const left  = ` Workspace: ${cwdTrim} `;
  const right = ` ${time} `;
  const mid   = 'VOID//ai-launcher';
  const avail = Math.max(0, cols - left.length - right.length);
  const lpad  = Math.max(0, Math.floor((avail - mid.length) / 2));
  const rpad  = Math.max(0, avail - mid.length - lpad);
  return (
    SIG_BG + BLACK + BOLD +
    left +
    ' '.repeat(lpad) + RED_FG + mid + BLACK + ' '.repeat(rpad) +
    right + RST
  );
}

// 현재 커서 위치를 저장/복원하면서 상태바 갱신
function refreshBars(cols, rows, label) {
  process.stdout.write(
    '\x1b7' +                       // DECSC  save cursor
    '\x1b[1;1H' +                   // top-left
    topBarStr(cols, label) +
    `\x1b[${rows};1H` +             // last row
    bottomBarStr(cols) +
    '\x1b8'                         // DECRC  restore cursor
  );
}

// ── Main wrapper ──────────────────────────────────────────
// node-pty로 자식 프로세스를 띄우고 void가 채널 역할을 담당한다.
// 반환값: true(성공) / false(node-pty 없음 → 호출자가 fallback)
async function runWrapped(tool, env, label) {
  let pty;
  try { pty = require('node-pty'); }
  catch { return false; }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows    || 24;

  // ── 스크롤 영역을 상태바 안쪽으로 제한 ───────────────────
  // row 1 (top bar) 과 row rows (bottom bar) 는 스크롤에서 제외
  process.stdout.write(`\x1b[2;${rows - 1}r`);
  process.stdout.write('\x1b[?25l');   // hide cursor during setup

  // 초기 상태바 그리기
  refreshBars(cols, rows, label);
  process.stdout.write('\x1b[2;1H');   // 콘텐츠 영역 시작 위치

  // ── PTY 생성 ─────────────────────────────────────────────
  // 자식 프로세스는 상태바 2행을 제외한 크기의 터미널을 받음
  const term = pty.spawn(tool.command, tool.args || [], {
    name: 'xterm-256color',
    cols,
    rows: Math.max(1, rows - 2),
    cwd:  process.cwd(),
    env,
  });

  // ── stdin raw 모드 → pty 로 전달 ─────────────────────────
  const prevRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdin  = data => term.write(data);
  const onResize = () => {
    const nc = process.stdout.columns || 80;
    const nr = process.stdout.rows    || 24;
    term.resize(nc, Math.max(1, nr - 2));
    process.stdout.write(`\x1b[2;${nr - 1}r`);
    refreshBars(nc, nr, label);
  };

  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);

  // pty 출력 → void → stdout (void가 채널)
  term.on('data', data => process.stdout.write(data));

  // 매 초 하단 시계 갱신
  const barTimer = setInterval(() => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows    || 24;
    refreshBars(c, r, label);
  }, 1000);

  // ── 자식 종료 대기 ────────────────────────────────────────
  await new Promise(resolve => term.on('exit', () => resolve()));

  // ── 정리 ─────────────────────────────────────────────────
  clearInterval(barTimer);
  process.stdin.removeListener('data', onStdin);
  process.stdout.removeListener('resize', onResize);
  if (!prevRaw) process.stdin.setRawMode(false);

  // 스크롤 영역 해제, 커서 복원
  process.stdout.write('\x1b[r');
  process.stdout.write('\x1b[?25h');
  process.stdout.write('\x1b[2J\x1b[H');  // 화면 클리어 후 void 메뉴로

  return true;
}

module.exports = { runWrapped };
