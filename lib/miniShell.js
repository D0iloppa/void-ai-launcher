'use strict';

// 재사용 가능한 임베디드 미니 셸 — 터미널 하단 밴드에 실제 대화형 셸을
// 띄워, 사용자가 다른 터미널 창을 열지 않고도 `claude setup-token` 같은 명령을
// 직접 실행할 수 있게 하는 순수 편의 기능이다.
//
// 상호 통신되는 구조가 아니다 — void 는 이 셸의 출력을 캡처하거나 파싱하지
// 않는다(스크립트화된 실행이 아니라 사람이 보고 타이핑하는 진짜 셸). 사용자가
// Ctrl+X 를 누르면 셸 프로세스를 종료하고 호출 이전의 터미널 상태(스크롤 영역,
// raw 모드)를 복원한 뒤 promise 를 resolve 한다 — 그 외의 반환값은 없다.
//
// ── 왜 좌우 테두리(│ 레일)가 없는가 ──────────────────────────────────
// 이전 버전은 lib/wrapper.js 의 enableMargins() 와 동일한 DECSLRM(?69h +
// `\x1b[l;rs`) + DECOM(?6h) 으로 셸 출력을 │ 레일 안쪽에 가두려 했다.
// 그러나 실사용 환경(WSL2 + Windows Terminal, ConPTY 경유)에서 테두리가
// 깨진다는 실제 리포트가 있었고, 검증 결과 DECSLRM 은 신뢰할 수 없다:
//   - ConPTY(WSL2/Windows Terminal 경로의 중간 계층)는 VT 스트림을 자체
//     버퍼로 재렌더링하는데 좌우 마진을 구현하지 않는다.
//   - xterm.js(이 프로젝트가 xtermFrame.js 의 Windows 경로에서 직접 쓰는
//     엔진이자 VS Code 터미널 엔진)도 미지원 — DECRQM(?69$p) 질의에
//     `\x1b[?69;0$y`("모드 인식 불가")로 응답하고, 마진 설정 후 출력이
//     1열부터 시작해 좌측 레일을 그대로 덮어쓰는 것을 실측으로 확인했다.
// 마진이 무시되는 터미널에서 셸의 모든 줄 시작(CR)이 물리 1열로 가므로,
// │ 를 "출력 후 다시 그려 덮는" 방식도 불가능하다 — 1열에 레일을 칠하면
// 셸 프롬프트의 첫 글자를 파괴한다. 좌우 레일을 지키는 유일한 방법은
// 출력 스트림을 해석·변환하는 것뿐인데, 이는 이 파일의 무해석 원칙에
// 반한다. 따라서 밴드는 상/하단 가로줄만 두고 콘텐츠는 전체 너비를 쓴다.
//
// 반면 DECSTBM(상/하 스크롤 영역)은 VT100 시절부터의 시퀀스로 ConPTY·
// xterm.js·모든 주요 터미널이 지원하며, 같은 실측에서 스크롤이 밴드 행에
// 정확히 갇히고 영역 밖의 상/하단 테두리 행이 보존됨을 확인했다. DECOM 도
// 쓰지 않는다 — 미지원 터미널에서 ?6h 후의 `\x1b[H` 는 물리 (1,1)로 튀는
// 최악의 실패 모드가 되므로, 커서 배치는 절대좌표로만 한다(지원 여부와
// 무관하게 동일하게 동작).

const CTRL_X = 0x18;

// wrapper.js/xtermFrame.js는 signal 색을 상수로 하드코딩하는 관례를 쓰지만
// (그 두 파일은 이번 세션 다른 작업 때문에 손대지 않음), 그러면 테마팩을
// 바꿔도 미니셸 테두리 색은 그대로 남는다 — 테마팩 시스템의 취지에 안 맞음.
// 대신 ui.js의 getPalette()(현재 활성 테마 팔레트 read accessor)로 매 호출
// 시점에 실제 signal 색을 읽어와 theme.js의 fg()로 이스케이프를 만든다.
function sigFg() {
  try {
    const { getPalette } = require('./ui');
    const { fg } = require('./theme');
    const palette = getPalette();
    if (palette && palette.signal) return fg(palette.signal);
  } catch {}
  return '\x1b[38;2;0;230;118m'; // getPalette/theme 로드 실패 시에만 폴백(void-signature 기본값)
}
const RST = '\x1b[0m';

const TITLE = '미니 터미널 (Ctrl+X로 닫기)';

function at(row, col) {
  return `\x1b[${row};${col}H`;
}

// 밴드 레이아웃 — `miniRows` 는 셸 콘텐츠 행 수(content-only)로 해석한다.
// 즉 실제로 예약되는 물리 행은 miniRows + 2 (상단 테두리 1 + 콘텐츠 N +
// 하단 테두리 1)이다. 기본값 3 이면 밴드 전체는 5행. 유일한 기존 호출자
// (lib/tokens.js 의 runMiniShell())는 인자 없이 호출하므로 셸 가용 행 수는
// 변하지 않고 화면 점유만 2행 늘어난다 — 테두리를 총 높이에 포함시키면
// 기본 3행에서 콘텐츠가 1행만 남아 지나치게 좁아지기 때문에 이 해석을 택했다.
function computeBandLayout(cols, rows, miniRows) {
  const content = Math.max(1, Math.min(miniRows, rows - 2));
  const botBorder = rows;                  // 하단 테두리 행(화면 맨 아래)
  const topBorder = rows - content - 1;    // 상단 테두리 행
  const topM = topBorder + 1;              // DECSTBM 스크롤 영역(콘텐츠 행들)
  const botM = botBorder - 1;
  return { topBorder, botBorder, topM, botM };
}

// 상/하단 테두리 — 좌우 레일이 없으므로(파일 상단 주석 참고) ┌┐└┘ 모서리
// 없이 전체 너비 가로줄(─)을 긋고, 상단 줄에 제목을 매립한다:
// `── 미니 터미널 (Ctrl+X로 닫기) ────…──`. CJK 폭 계산은 ui.js makeBox 와
// 동일하게 ui.colWidth 를 재사용한다. 콘텐츠 행은 \x1b[2K 로 비운다 —
// 이제 그 행들엔 지켜야 할 테두리 문자가 없으므로 안전하다.
function drawBorder(cols, layout) {
  const { colWidth } = require('./ui');
  const sig = sigFg();

  let title = ` ${TITLE} `;
  if (colWidth(title) > cols - 4) title = ''; // 너무 좁으면 제목 생략
  const lead = title ? '──' : '';
  const fill = '─'.repeat(Math.max(0, cols - colWidth(title) - lead.length));

  let s = '';
  s += at(layout.topBorder, 1) + '\x1b[2K' + sig + lead + title + fill + RST;
  for (let r = layout.topM; r <= layout.botM; r++) {
    s += at(r, 1) + '\x1b[2K';
  }
  s += at(layout.botBorder, 1) + '\x1b[2K' + sig + '─'.repeat(cols) + RST;
  return s;
}

// DECSTBM 만 사용한다(콘텐츠 행들로 스크롤 영역 축소) — DECSLRM/DECOM 을
// 쓰지 않는 이유는 파일 상단 주석 참고. 커서는 절대좌표로 콘텐츠 좌상단에
// 놓는다. 테두리는 스크롤 영역 밖(위/아래)이므로 셸이 아무리 스크롤해도
// 침범하지 못한다.
function enableBand(layout) {
  return `\x1b[${layout.topM};${layout.botM}r` + at(layout.topM, 1);
}

// 방어적 전체 복원 — DECOM 해제(?6l) → DECSLRM 해제(?69l) → DECSTBM 전체
// 화면 복원(\x1b[r). 우리는 이제 ?6/?69 를 켜지 않지만, 밴드 안에서 돈
// 셸(또는 그 안에서 실행된 프로그램)이 켜 놓고 죽었을 수 있으므로 해제
// 시퀀스는 그대로 유지한다(wrapper.js disableMargins() 와 바이트 단위 동일).
function disableBand() {
  return '\x1b[?6l' + '\x1b[?69l' + '\x1b[r';
}

// opts: { rows?: number } — 셸 콘텐츠 행 수, 기본 3(테두리 제외 — 위의
// computeBandLayout 주석 참고). 반환값은 없다(resolve(undefined)) —
// 이 컴포넌트는 셸의 출력을 읽거나 해석하지 않는다.
async function runMiniShell(opts = {}) {
  const miniRows = typeof opts.rows === 'number' && opts.rows > 0 ? opts.rows : 3;

  let pty;
  try {
    pty = require('node-pty');
  } catch {
    return; // node-pty 없음 — 조용히 아무것도 하지 않고 리턴
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return;
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  // 테두리 2행 + 콘텐츠 최소 1행 = 밴드 최소 3행, 그 위에 기존 화면 최소 1행.
  if (rows < 4 || cols < 10) return;

  const layout = computeBandLayout(cols, rows, miniRows);
  const ptyRows = Math.max(1, layout.botM - layout.topM + 1);
  const ptyCols = cols; // 좌우 레일이 없으므로 콘텐츠는 전체 너비

  const prevRaw = process.stdin.isRaw;
  let restored = false;
  // 방어적 정리 — spawn 실패를 포함해 어떤 경로로 빠져나가든 호출자의 터미널이
  // raw 모드/축소된 스크롤 영역에 갇힌 채로 남지 않도록 보장한다.
  const restore = () => {
    if (restored) return;
    restored = true;
    try { process.stdout.write(disableBand()); } catch {}
    if (!prevRaw) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    // ui.js paints incrementally against a cached last-frame (LAST_PAINTED_ROWS)
    // rather than the physical terminal — since we just wrote straight to the
    // terminal ourselves (bypassing that cache), the cache is now stale for
    // every row in the band. Without this, any row whose next intended content
    // happens to match the stale cached value (e.g. the constant bottom status
    // bar) gets silently skipped, leaving real leftover shell output on screen
    // for the rest of the process's life. clear() nulls the cache and forces
    // a full repaint on the next screen draw.
    try { require('./ui').clear(); } catch {}
  };

  let term;
  try {
    // 테두리 먼저(절대좌표), 그 다음 스크롤 영역 축소 — enableBand() 주석 참고.
    process.stdout.write(drawBorder(cols, layout) + enableBand(layout));
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const shell = process.env.SHELL || 'bash';
    term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: ptyCols,
      rows: ptyRows,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch {
    restore();
    return;
  }

  await new Promise(resolve => {
    let settled = false;

    // Ctrl+X 는 이 임베디드 셸 래퍼 자체의 종료 키다 — 셸로 전달하지 않는다.
    // 셸이 스스로 종료(예: 사용자가 `exit` 입력)한 경우도 동일하게 정상적인
    // 종료 경로로 취급한다 — settled 가드로 멱등하게 처리된다.
    const finish = () => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', onStdin);
      try { term.kill(); } catch {}
      restore();
      resolve();
    };

    const onStdin = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const idx = buf.indexOf(CTRL_X);
      if (idx === -1) {
        try { term.write(chunk); } catch {}
        return;
      }
      if (idx > 0) {
        try { term.write(buf.slice(0, idx)); } catch {}
      }
      finish();
    };

    term.onData(data => {
      if (settled) return;
      try { process.stdout.write(data); } catch {}
    });
    term.onExit(() => finish());

    process.stdin.on('data', onStdin);
  });
}

module.exports = { runMiniShell };
