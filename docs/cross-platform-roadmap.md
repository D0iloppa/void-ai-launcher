# VOID 크로스플랫폼 실행가능성 로드맵

이 문서는 `docs/project-analysis.md`, `docs/windows_porting_guide.md`,
`docs/codex-launch-issue.md`(기존 분석)와 cmux(manaflow-ai/cmux) 리서치, 코드 실증 검증,
그리고 실제 git 히스토리 재구성(`node-pty` → `tmux` 전환 이력)을 종합해 Linux → macOS →
Windows 우선순위로 "지금 가능한 범위"와 "지금은 불가능한 것"을 정리한다. 상세 근거는
codebase-memory MCP의 ADR(project: `mnt-c-DEV-ai-launcher`)에도 기록돼 있다.

**중요**: 이 문서의 목표는 "일단 Windows에서 죽지만 않게 만드는 얕은 포팅"이 아니다. tmux가
POSIX 전용이라는 벽을 진짜로 우회할 아키텍처를 찾는 것이 목적이며, 그런 방향이 안 보이면
Windows 트랙은 보류하는 게 맞다는 전제를 깔고 쓴다.

## 0. 먼저 정정할 것 — "인라인 브라우저 실패"의 실체

git 히스토리 전체를 뒤져도 실제 브라우저 임베드(webview/iframe) 시도의 흔적은 없다. 유일한
단서인 커밋 `a35b3f3`(`merge: tmux fullscreen + Ctrl+Space panel from electron branch`)의
"electron"은 Electron 프레임워크가 아니라 **로컬 작업 브랜치 이름**이었고, 실제 병합 내용은
`lib/panel.mjs` — Ink+React 기반 tmux `display-popup` 제어판(탭 목록/도구 선택)이다.

즉 "인라인 브라우저를 시도했다가 실패했다"는 기억과 실제 커밋 기록이 맞지 않는다. 코드에
남지 않은 채 폐기된 별도 실험이었을 수도 있다 — 이 부분은 사용자 확인이 필요하다.

## 1. 핵심 전제 — cmux는 크로스플랫폼을 "해결"한 게 아니라 "포기"했다

cmux(manaflow-ai/cmux)는 macOS 전용 네이티브 Swift+AppKit 앱이다. libghostty(GPU 가속 터미널
렌더러)를 임베드하고, "인라인 브라우저"는 네이티브 웹뷰를 GUI 패널로 붙인 것이다(agent-browser
프로젝트 포팅). Linux/Windows 지원은 아예 없다 — README가 명시적으로 "지금은 macOS만
지원"이라고 밝힌다.

**결론**: cmux가 참고가 되는 지점은 "크로스플랫폼 해법"이 아니라 "알림 UX, 소켓 기반 외부
제어 CLI, 기존 설정파일 재사용" 같은 부수적 아이디어뿐이다. 인라인 브라우저처럼 네이티브 GUI
전제 기능은 **void가 순수 TTY 프로세스 아키텍처를 유지하는 한 이식 불가능**하다 — 터미널
문자 그리드에는 네이티브 윈도우 객체(웹뷰)를 그릴 수 없기 때문이다. 이건 구현력의 문제가
아니라 아키텍처 층위의 벽이다.

## 2. node-pty → tmux 전환의 실제 이유 (신규 — 오해 정정)

기존에 "wrapper가 tmux라서 크로스플랫폼이 안 된다"는 인식이 있었는데, 실제 히스토리는 더
구체적이다.

**타임라인:**

1. `500ef9d` — 순수 node-pty wrapper 최초 구현. DECSTBM(상하 스크롤 영역) + DECSLRM(좌우
   마진) escape sequence로 상하단 바를 그려놓고 그 안에서 자식 프로세스를 실행.
2. `720d9b1`(같은 날) — 같은 커밋 안에서 **두 가지를 동시에** 추가:
   - `runWrappedShell`: node-pty **만으로** 만든 완전한 자체 멀티플렉서(자체 탭, 자체
     Ctrl+A prefix key, 탭별 pty 관리, `RE_FRAME_BREAKERS` 정규식으로 "우리 프레임을 깨는
     escape sequence"를 걸러내는 방식).
   - `runWrappedTmuxFrame` / `runTmuxWrapped`: 실제 tmux에 위임하는 경로.

즉 "자체 node-pty 멀티플렉서"와 "tmux 위임"을 나란히 구현해서 비교한 흔적이다.

**tmux로 기운 결정적 이유는 `docs/codex-launch-issue.md`에 실측 근거로 남아 있다** — codex만
tmux 전용 경로를 타게 만든 이유:

> - 기존 launcher wrapper의 footer/bar redraw가 `codex` TUI와 충돌함
> - `codex`는 동일 화면 footer 유지보다 별도 split pane 제어가 더 안정적임

즉 자체 구현의 `RE_FRAME_BREAKERS` 정규식 필터링 방식은 "이 AI 툴이 어떤 escape sequence를
쓰는지 하나하나 예측해서 막는" 두더지잡기 구조였고, codex처럼 자기 나름의 풀스크린 렌더링을
하는 툴 앞에서 뚫렸다. tmux는 "임의의 풀스크린 프로그램을 실제 터미널 에뮬레이터로 파싱해
자체 화면 버퍼에 재구성한 뒤, 그 위에 자기 chrome(border/status bar)을 얹는" 방식이라 이
문제를 구조적으로 풀어낸다 — regex 필터링이 아니라 진짜 VT 파서이기 때문이다.

**결론**: node-pty는 버려진 적이 없다(`runWrappedTmuxFrame`도 node-pty로 tmux 프로세스에
attach하는 구조). 버려진 건 "regex로 escape sequence를 걸러내는 방식"이고, 그 대체재로
"이미 완성된 VT 파서"인 tmux를 골랐을 뿐이다. 이 사실이 5절의 Windows 해법 방향을 결정한다.

## 3. tmux 자체가 Windows에서 근본적으로 안 되는 이유 (신규)

"tmux로 cmd.exe/powershell.exe를 띄우면 안 되나?"에 대한 결론: **불가능**.

- tmux는 pane을 열 때 POSIX pty(`openpty()`/`posix_openpt()`)를 하드코딩해서 쓴다. 이 코드
  경로 자체가 Windows 커널에 없다. Cygwin/MSYS2용 tmux 빌드가 있긴 하지만, Cygwin이 제공하는
  "유사 POSIX pty"일 뿐이다.
- 더 근본적으로, `cmd.exe`/`powershell.exe`는 pty가 아니라 **Win32 Console API**(콘솔 핸들,
  `AttachConsole` 등)를 전제로 동작한다. Cygwin/MSYS2 pty는 실제 Windows 콘솔이 아니라 named
  pipe로 흉내낸 것이라, 그 위에서 네이티브 콘솔 앱을 실행하면 화면이 깨지거나 멈춘다 — 이게
  git bash에서 `node`/`python` REPL이 가끔 먹통되는 그 문제이고, MS가 ConPTY를 별도로 만든
  이유다.
- tmux 코어에는 ConPTY 백엔드가 없다(pty 할당 코드가 여전히 Unix 전용). 즉 tmux 자체를
  포크해서 뜯어고치지 않는 한, tmux가 Windows 네이티브 콘솔 앱을 안정적으로 호스팅하는 일은
  없다.

반면 node-pty는 POSIX pty와 Windows ConPTY를 하나의 API로 이미 추상화해 놓았다(win32-x64/
arm64 prebuild에 `conpty.node` 포함). **크로스플랫폼 방향은 "tmux를 Windows에 이식"이 아니라
"tmux가 하던 일(VT 파싱 + chrome 렌더링)을 node-pty 위에서 tmux 없이 다시 구현"이다.**

## 4. WSL 위임 옵션 폐기 (수정 — 이전 판단 뒤집음)

이전 버전 로드맵은 "WSL 감지 후 `wsl tmux ...`로 위임"을 Windows 대안으로 제시했으나 이 전제가
틀렸다. 사용자 실사용 기준: 개발자 지인 중 WSL 설치 비율 10% 미만(본인 제외 전무에 가까움).
Linux를 쓰더라도 VM이나 원격 서버에 셸로 접속하는 쪽을 택하지, Windows 위에 WSL을 구성하는
경우는 드물다는 것이 현장 증언이다.

**즉 WSL은 폴백으로 설계해도 실사용자 대다수에게는 폴백이 작동하지 않는 것과 같다.** 이
옵션은 로드맵에서 제외한다. Windows 트랙은 WSL 유무와 무관하게 네이티브로 동작해야 의미가
있다.

## 5. 목표 아키텍처 제안 — tmux를 "자체 VT 에뮬레이션 코어"로 대체 (신규, 핵심)

2~4절을 종합하면 결론은 하나다: **tmux 의존을 없애려면 tmux가 하던 일(임의의 풀스크린 TUI를
안전하게 파싱해서 자체 chrome과 합성하는 것)을 진짜로 대체할 무언가가 필요하고, regex
필터링(과거에 실패한 방식)으로는 안 된다.**

후보: **`@xterm/headless`**(xterm.js의 DOM 없는 버전) 를 `node-pty` 위에 얹는 방식.

- xterm.js는 완전한 VT100/xterm escape sequence 파서 + 화면 버퍼 모델(alt-screen, 스크롤백,
  커서 상태 등)을 갖고 있다. `@xterm/headless`는 이 파서/버퍼 부분만 떼어 DOM 없이 Node에서
  쓸 수 있게 만든 패키지로, 서버사이드 터미널 레코딩 등에 실제로 쓰인다.
- 구조: 툴별로 `node-pty` 자식 프로세스 하나 + `@xterm/headless` 버퍼 하나를 tab 단위로
  들고 있다가, 활성 탭의 버퍼 내용을 void 자신의 border/status bar chrome과 합성해서
  그린다. 이건 정확히 tmux가 pane마다 하는 일과 같은 모델이며, **regex로 "깨지는 시퀀스를
  사후에 걸러내는" 게 아니라 진짜 파싱을 통해 상태를 알고 다시 그리는 것**이라 codex 같은
  풀스크린 TUI 충돌 문제가 구조적으로 재발하지 않는다.
- `node-pty`는 이미 Linux/macOS/Windows(ConPTY) 전부에서 동작하고, `@xterm/headless`는
  순수 JS라 플랫폼 분기가 필요 없다. **이 방식이 성립하면 Linux/macOS/Windows가 코드 한
  경로를 공유**하게 되고, tmux/WSL 유무는 더 이상 핵심 경로에 영향을 주지 않는다.

### 이 방향이 잃는 것 (정직하게 짚을 트레이드오프)

- **세션 지속성(detach/reattach)** — tmux는 서버 프로세스가 클라이언트(attach)와 분리돼
  있어서 void 프로세스가 죽어도 세션이 살아있다. 자체 node-pty 기반 구조는 void 프로세스가
  이 pty들을 직접 들고 있으므로, void가 죽으면 자식도 같이 죽는 게 기본값이다. 이 기능을
  유지하려면 별도의 상주 데몬 프로세스(pty를 소유하고 IPC로 attach/detach를 중개)가
  필요하다 — 이건 별도 트랙으로 분리해야 할 만큼 작업량이 있다. Linux/macOS는 기존처럼 tmux
  경로를 유지해 이 기능을 지금 그대로 누리고, "tmux 없는 환경(Windows 네이티브)"에서는 이
  기능이 v1 목표에서 빠진다는 걸 미리 인정하고 가는 게 맞다.
- 검증 부담: xterm.js의 alt-screen/resize/색상 처리가 tmux만큼 실전에서 검증된 건 아니다.
  codex/claude/gemini 각각을 붙여서 실측해야 한다.

## 6. 1순위 — Linux

### 구현 가능 범위 (지금 바로)
- 3단계 폴백(`runTmuxSession → runWrapped(codex 제외) → spawnSync`) 전부 정상 동작 확인됨.
- codex sqlite read-only 문제는 `resolveToolStateDir`/`ensureWritableCodexHome`으로 해결
  완료, 코드 검증까지 마침.
- `npm run check` 통과, 문법 오류 없음.
- 여기서 우선 다듬을 것: codex의 tmux attach 타이밍 fragile 이슈(완화만 됐고 근본 수정 아님 —
  race condition에 가까움), wrapper 우선순위 서술 갱신.

### 불가능/보류
- 없음. tmux 기반 경로를 그대로 유지 — 5절의 xterm-headless 코어는 Linux에 강제할 이유가
  없다(이미 tmux로 잘 풀린 문제를 다시 풀 필요 없음).

## 7. 2순위 — macOS

### 구현 가능 범위 (단계적으로)
- node-pty가 darwin-arm64/x64 prebuild를 보유해 설치 자체는 원활.
- tmux는 Big Sur 이후 기본 미설치 — `runTmuxSession`이 tmux 부재 시 정상적으로 false를
  반환하고 `runWrapped`(node-pty 프레임)로 자동 폴백되는 것까지는 코드로 확인됨. `brew
  install tmux` 안내 문구만 추가하면 풀스크린 경로까지 커버 가능 — **코드 변경 없이
  문서/온보딩만으로 해결되는 부분**.
- POSIX 계열이라 Linux와 거의 동일한 완성도로 갈 수 있다.

### 불가능/보류
- cmux 수준의 "네이티브 인라인 브라우저"는 void의 TUI 아키텍처로는 불가능(1절 참고).

## 8. 3순위 — Windows (재작성)

### 전제 변경
- WSL 위임 폐기(4절). 네이티브로 동작해야 함.
- tmux는 애초에 후보에서 제외(3절). "tmux 대체"가 아니라 "tmux가 하던 일의 재구현"이
  목표(5절).

### 구현 가능 범위 (지금 바로, 코드 수정 없이 확인된 것)
- **tmux 부재 자체는 이미 안전하게 폴백됨** — `spawnSync('which', ['tmux'])`가 Windows에서
  ENOENT로 null status가 되어 크래시 없이 "tmux 없음"으로 처리됨.
- **node-pty 네이티브 빌드는 기존 가이드 문서가 과장** — win32-x64/arm64 prebuild
  (`conpty.node`)가 포함돼 있어 `windows-build-tools` 설치가 불요할 가능성이 높다(실기
  미검증).
- **path separator 문제는 애초에 없음** — `path.join()` 이미 일관 사용.

### 코드 수정이 필요한 항목 (얕은 포팅 — 최소 동작선)
- `pty.spawn()`/`spawnSync`에 넘기는 기본 shell이 `/bin/bash`로 하드코딩(`lib/runner.js`,
  `lib/wrapper.js`, `lib/extTokens.js`) — `getHostShell()` 헬퍼로 `isWin` 분기, `cmd.exe`
  또는 `powershell.exe` 사용.
- 기본 에디터 `vi` 하드코딩(`launcher.js`) — `notepad` 폴백.
- 이 항목들만 고치면 **"프레임/멀티탭 없는 plain spawn 경로"는 지금도 최소 동작**할 가능성이
  높다(미검증, 우선 확인 필요).

### 진짜 목표 (얕은 포팅이 아니라 이번에 풀려는 문제)
- **5절의 `node-pty` + `@xterm/headless` 코어를 구현**해서 Windows 네이티브에서도
  border/status bar + 멀티탭 프레임 경험을 tmux/WSL 없이 제공.
- 세션 detach/reattach는 v1 범위에서 제외하고 별도 트랙(상주 데몬)으로 미룬다 — 이 부분까지
  욕심내면 사실상 tmux 서버 모델을 처음부터 다시 만드는 것이라 스코프가 뒤집힌다.
- 이 코어가 실제로 codex 같은 까다로운 TUI 앞에서 버티는지가 "이번 포팅이 얕은 포팅이
  아님"을 증명하는 검증 기준이다 — 이게 실패하면 2절에서 겪은 것과 같은 문제를 Windows에서
  반복하는 것이므로, 이 시점에 Windows 트랙 자체를 재검토해야 한다.

## 9. 다음 액션 (우선순위 순)

1. Linux: `docs/project-analysis.md`, `docs/codex-launch-issue.md`의 wrapper 우선순위
   서술을 최신 3단계로 정정. codex tmux attach 타이밍 race condition 근본 수정.
2. macOS: 온보딩 문서에 `brew install tmux` 안내 추가(코드 변경 없이 해결 가능).
3. Windows 최소선: `getHostShell()`/에디터 폴백 도입 → plain spawn 경로가 실제 Windows
   머신에서 동작하는지 실기 검증(현재 전부 미검증 상태).
4. Windows 본선(핵심 결정 필요): `@xterm/headless` PoC — node-pty 자식 하나 + headless 버퍼
   하나로 claude-code 같은 실제 풀스크린 TUI를 감싸 border를 그려보고, resize/alt-screen/
   색상이 깨지지 않는지 먼저 작은 스파이크로 검증한다. 이게 되면 Linux/macOS도 장기적으로
   이 코어로 통합할지(단, tmux의 detach/reattach를 버리는 트레이드오프 재논의 필요) 결정.
   안 되면 Windows는 "프레임 없는 plain spawn"으로 스코프를 줄이거나 트랙을 보류한다.
5. 세션 detach/reattach를 Windows에서도 원하면 별도 트랙(상주 데몬 + IPC)으로 분리해 논의 —
   이번 로드맵의 스코프 밖.
6. "진짜 인라인 브라우저"는 또 다른 별도 트랙(Electron/Tauri 전환 여부)으로 분리 — 이번
   로드맵의 Linux/macOS/Windows 우선순위와는 독립적인 결정.
