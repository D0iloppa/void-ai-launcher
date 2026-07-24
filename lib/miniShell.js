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
// ── 스크롤백 (PgUp/PgDn, 마우스 휠) ──────────────────────────────────
// 위 문단의 "출력을 캡처·해석하지 않는다"는 원칙은 라이브 패스스루 경로에
// 대한 것이고, 이 절은 그 원칙을 깨지 않으면서 밴드 "자신의" 과거 출력을
// 되짚어볼 수 있게 하는 추가 기능이다(shell.js/tokens.js 쪽에서 그 내용을
// 읽거나 파싱하는 것은 여전히 없다 — 순전히 사용자가 눈으로 보기 위한 것).
// term.onData 에서 받은 raw 청크를 줄 단위로 캡처해 scrollback[] 에 쌓아
// 두되(완전한 터미널 에뮬레이션이 아니라 npm/docker 류의 줄 지향 설치 로그를
// 겨냥한 best-effort — SGR 색 코드는 보존하고 커서 이동류 CSI 는 버리며,
// vim 같은 풀스크린 내부 TUI 는 깔끔하게 스크롤되지 않는다), PgUp/PgDn 또는
// 마우스 휠 이벤트가 오면 그 버퍼를 밴드에 절대좌표로 그려 넣는 "스크롤
// 모드"로 전환한다. 스크롤 모드 동안에도 pty 는 계속 돌고 출력은 계속
// scrollback 에 쌓이지만, 화면에는 쓰지 않는다(사용자가 과거를 보고 있는
// 중이므로) — 바닥까지 내려오거나(오프셋 0) 다른 아무 키나 누르면 라이브
// 모드로 돌아가며, 그 시점의 scrollback 꼬리를 다시 그려 화면을 최신 상태로
// 맞춘 뒤 이후의 pty 출력은 다시 그대로 통과시킨다(라이브 경로 자체는 스크롤을
// 한 번도 쓰지 않으면 이전과 바이트 단위로 동일하게 동작한다).
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
// 무관하게 동일하게 동작). 스크롤 모드에서 scrollback 을 그려 넣을 때도
// 같은 이유로 절대좌표(at())만 쓴다.

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
const TITLE_SCROLL = '미니 터미널 [SCROLL ↑↓ PgUp/PgDn] (Ctrl+X로 닫기)';

// 마우스 휠 리포팅(SGR 확장 모드) on/off — restore() 에서 반드시 짝을 맞춰
// off 해야 한다(파일 하단 disableBand/restore 참고).
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

// 스크롤백 캡은 "MAX_LINES 를 넘고 나서 SLACK 만큼 더 쌓이면 한 번에
// MAX_LINES 로 잘라낸다" — wrapper.js appendBuffer() 의 MAX_BUFFER 슬라이스
// 관례와 같은 이유(매 줄마다 O(n) splice 하지 않기 위한 상각)다.
const MAX_LINES = 2000;
const TRIM_SLACK = 200;

// PgUp/PgDn 이스케이프 및 SGR 마우스(`\x1b[<Cb;Cx;CyM` 또는 `...m`) 이스케이프.
const PGUP_SEQ = '\x1b[5~';
const PGDN_SEQ = '\x1b[6~';
const SPECIAL_RE = /\x1b\[5~|\x1b\[6~|\x1b\[<\d+;\d+;\d+[Mm]/g;
const MOUSE_EVENT_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/;

function at(row, col) {
  return `\x1b[${row};${col}H`;
}

// term.onData() 로 들어오는 pty 원본 출력을 scrollback 버퍼용으로 정제한다.
// 완전한 터미널 에뮬레이션이 아니다(파일 상단 주석 참고) — SGR(색/속성,
// ESC[...m)만 보존하고 그 외 이스케이프(커서 이동, 화면/줄 지우기, 타이틀
// 설정 OSC, 문자셋 지정 등)는 버린다. 그런 시퀀스는 "지금 화면의 어디에
// 그릴지"를 위한 것이지, 나중에 줄 단위로 재생할 버퍼에는 의미가 없다.
function sanitizeForBuffer(str) {
  // OSC(타이틀 설정 등) — BEL 또는 ST(ESC\)로 종료.
  let s = str.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // 문자셋 지정: ESC ( X / ESC ) X
  s = s.replace(/\x1b[()][A-Za-z0-9]/g, '');
  // CSI('[')·OSC(']') 도입자가 아닌, ESC 뒤 단일 문자 시퀀스(ESC 7/8/=/>/c 등).
  // best-effort — 모든 VT 이스케이프를 다 알지는 못한다.
  s = s.replace(/\x1b[^[\]()]/g, '');
  // CSI: SGR(끝이 'm')만 보존, 나머지(커서 이동/지우기 등)는 제거.
  s = s.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, m => (m.endsWith('m') ? m : ''));
  return s;
}

// 정제된 텍스트를 scrollback[]/curLine 상태로 흡수한다. \n 은 줄 종료(현재
// 줄을 scrollback 에 push 하고 새 줄 시작), \r 은 "현재 줄을 통째로
// 리셋"한다 — 실제 터미널처럼 커서 컬럼을 추적해 부분 덮어쓰기를 하지는
// 않지만(파일 상단 주석의 fidelity 한계), npm/docker 진행바처럼 \r 뒤에
// 줄 전체를 다시 보내는 흔한 패턴에는 이 정도 단순화로 충분하다.
function makeLineAssembler() {
  const scrollback = [];
  let curLine = '';

  function trim() {
    if (scrollback.length > MAX_LINES + TRIM_SLACK) {
      scrollback.splice(0, scrollback.length - MAX_LINES);
    }
  }

  function feed(raw) {
    const clean = sanitizeForBuffer(raw);
    const parts = clean.split(/(\r\n|\r|\n)/);
    for (const part of parts) {
      if (part === '') continue;
      if (part === '\n' || part === '\r\n') {
        scrollback.push(curLine);
        curLine = '';
        trim();
      } else if (part === '\r') {
        curLine = '';
      } else {
        curLine += part;
      }
    }
  }

  // scrollback + 아직 개행되지 않은 현재 줄(있다면) — 스크롤 렌더링용 뷰.
  function fullBuffer() {
    return curLine ? scrollback.concat([curLine]) : scrollback;
  }

  return { feed, fullBuffer };
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
// titleText 를 넘기면(스크롤 모드 표시용) 기본 TITLE 대신 그것을 쓴다.
function drawBorder(cols, layout, titleText) {
  const { colWidth } = require('./ui');
  const sig = sigFg();

  let title = ` ${titleText || TITLE} `;
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

// 스크롤 모드에서 밴드 콘텐츠 행에 scrollback 창을 그려 넣는다. drawBorder()
// 가 이미 콘텐츠 행을 \x1b[2K 로 비워 놓은 뒤 호출하는 것을 전제로 한다.
// lines 는 정확히 `content` 개(부족하면 위쪽을 빈 문자열로 패딩된) 배열이다.
function renderScrollLines(cols, layout, lines) {
  const { truncateCols } = require('./ui');
  let s = '';
  for (let i = 0; i < lines.length; i++) {
    const row = layout.topM + i;
    s += at(row, 1) + truncateCols(lines[i], cols) + RST;
  }
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
// 마우스 리포팅(?1000/?1006)도 enableBand 와 짝을 맞춰 여기서 끈다 —
// 켠 채로 두면 셸 종료 후 호출자의 터미널이 계속 마우스 이벤트를 SGR
// 시퀀스로 stdin 에 흘려보내는 상태로 남는다.
function disableBand() {
  return MOUSE_OFF + '\x1b[?6l' + '\x1b[?69l' + '\x1b[r';
}

// opts: { rows?: number, initialInput?: string } — rows 는 셸 콘텐츠 행 수,
// 기본 3(테두리 제외 — 위의 computeBandLayout 주석 참고). initialInput 이
// 주어지면 셸 프롬프트에 그 문자열을 타이핑해 놓는다(개행 없음 — 실행은
// 사용자가 직접 Enter 를 눌러야 함). 반환값은 없다(resolve(undefined)) —
// 이 컴포넌트는 셸의 출력을 읽거나 해석하지 않는다(단, 자신의 과거 출력을
// 화면에 되짚어 보여주는 스크롤백은 예외 — 파일 상단 주석 참고).
async function runMiniShell(opts = {}) {
  const miniRows = typeof opts.rows === 'number' && opts.rows > 0 ? opts.rows : 3;
  const initialInput = typeof opts.initialInput === 'string' ? opts.initialInput : '';

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
  const content = ptyRows; // 스크롤 렌더링에서 쓰는 이름(밴드 콘텐츠 행 수)

  const prevRaw = process.stdin.isRaw;
  let restored = false;
  // 방어적 정리 — spawn 실패를 포함해 어떤 경로로 빠져나가든 호출자의 터미널이
  // raw 모드/축소된 스크롤 영역/마우스 리포팅 모드에 갇힌 채로 남지 않도록
  // 보장한다.
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
    // 테두리 먼저(절대좌표), 그 다음 스크롤 영역 축소, 그 다음 마우스 휠
    // 리포팅 on — enableBand()/MOUSE_ON 주석 참고.
    process.stdout.write(drawBorder(cols, layout) + enableBand(layout) + MOUSE_ON);
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

  if (initialInput) {
    try { term.write(initialInput); } catch {}
  }

  await new Promise(resolve => {
    let settled = false;

    // 스크롤백 상태 — 라이브 경로와 완전히 분리되어 있다: term.onData 는
    // 항상 이 어셈블러에 원본을 먹이고(스크롤 모드든 아니든), 화면에 쓸지는
    // scrollMode 플래그로만 결정한다(아래 term.onData 참고).
    const assembler = makeLineAssembler();
    let scrollMode = false;
    let scrollOffset = 0; // 0 = 라이브(바닥)
    const PAGE_STEP = content;
    const WHEEL_STEP = 3;

    function clampOffset(off) {
      const total = assembler.fullBuffer().length;
      const maxOffset = Math.max(0, total - content);
      return Math.max(0, Math.min(maxOffset, off));
    }

    function renderScrollWindow() {
      const buf = assembler.fullBuffer();
      const total = buf.length;
      const end = Math.max(0, total - scrollOffset);
      const start = Math.max(0, end - content);
      const windowLines = buf.slice(start, end);
      const padded = windowLines.length < content
        ? Array(content - windowLines.length).fill('').concat(windowLines)
        : windowLines;
      try {
        process.stdout.write(
          drawBorder(cols, layout, TITLE_SCROLL) + renderScrollLines(cols, layout, padded)
        );
      } catch {}
    }

    function renderLiveTail() {
      const buf = assembler.fullBuffer();
      const tail = buf.slice(Math.max(0, buf.length - content));
      const padded = tail.length < content
        ? Array(content - tail.length).fill('').concat(tail)
        : tail;
      try {
        process.stdout.write(drawBorder(cols, layout) + renderScrollLines(cols, layout, padded));
      } catch {}
    }

    // PgUp/PgDn/휠 이벤트 처리 — delta>0 는 과거로(위로), delta<0 는 최신으로
    // (아래로) 스크롤한다. 오프셋이 0 으로 돌아오면 라이브 모드로 복귀하고,
    // 스크롤 도중 화면에 못 쓰고 쌓여 있던 pty 출력을 반영하도록 현재 꼬리를
    // 다시 그린다(그 뒤로는 term.onData 가 다시 그대로 통과시킨다).
    function scrollBy(delta) {
      const next = clampOffset(scrollOffset + delta);
      if (next === scrollOffset && scrollMode === (next !== 0)) return;
      scrollOffset = next;
      if (scrollOffset === 0) {
        if (scrollMode) {
          scrollMode = false;
          renderLiveTail();
        }
      } else {
        scrollMode = true;
        renderScrollWindow();
      }
    }

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

    // 일반 텍스트(=특수 시퀀스가 아닌 구간)를 처리한다. 스크롤 모드 중이면
    // "아무 키나 누르면 라이브로 복귀"에 해당 — 그 키 자체는 pty로 전달하지
    // 않고 버린다(스크롤 중 눌린 키를 셸이 받아 예기치 않게 실행하는 것을
    // 막기 위한 단순하고 안전한 선택 — 파일 상단 설계 노트 참고). 라이브
    // 모드면 이전과 완전히 동일하게 그대로 pty 로 전달한다.
    function handlePlainSegment(segStr) {
      if (!segStr) return;
      if (scrollMode) {
        scrollOffset = 0;
        scrollMode = false;
        renderLiveTail();
        return;
      }
      try { term.write(Buffer.from(segStr, 'latin1')); } catch {}
    }

    function handleSpecial(seq) {
      if (seq === PGUP_SEQ) { scrollBy(+PAGE_STEP); return; }
      if (seq === PGDN_SEQ) { scrollBy(-PAGE_STEP); return; }
      const mm = MOUSE_EVENT_RE.exec(seq);
      if (mm) {
        const btn = Number(mm[1]);
        if (btn === 64) scrollBy(+WHEEL_STEP);
        else if (btn === 65) scrollBy(-WHEEL_STEP);
        // 그 외 버튼(클릭 등)은 조용히 삼킨다 — pty 로 전달하지 않는다.
      }
    }

    // Ctrl+X 이전 구간을 PgUp/PgDn/마우스휠과 일반 텍스트로 나눠 처리한다.
    // latin1 왕복(Buffer.toString/from)은 임의의 바이트를 1:1로 보존하므로
    // CJK 등 멀티바이트 입력을 셸로 전달할 때도 원본 바이트가 그대로 간다.
    function handleInputBytes(buf) {
      try {
        const str = buf.toString('latin1');
        SPECIAL_RE.lastIndex = 0;
        let lastIndex = 0;
        let m;
        while ((m = SPECIAL_RE.exec(str))) {
          const plain = str.slice(lastIndex, m.index);
          if (plain) handlePlainSegment(plain);
          handleSpecial(m[0]);
          lastIndex = SPECIAL_RE.lastIndex;
        }
        const rest = str.slice(lastIndex);
        if (rest) handlePlainSegment(rest);
      } catch {
        // fail-open: 파싱이 어떤 이유로든 던지면 원본을 그대로 셸에 전달해
        // 최소한 입력이 먹통이 되는 것만은 피한다.
        try { term.write(buf); } catch {}
      }
    }

    const onStdin = chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const idx = buf.indexOf(CTRL_X);
      const head = idx === -1 ? buf : buf.slice(0, idx);
      if (head.length) handleInputBytes(head);
      if (idx !== -1) finish();
    };

    term.onData(data => {
      if (settled) return;
      try { assembler.feed(data); } catch {}
      if (!scrollMode) {
        try { process.stdout.write(data); } catch {}
      }
    });
    term.onExit(() => finish());

    process.stdin.on('data', onStdin);
  });
}

module.exports = { runMiniShell };
