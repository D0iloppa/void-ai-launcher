# VOID//ai-launcher

AI CLI 도구(Claude Code, Codex, agy 등)를 대화형 TUI 메뉴로 실행하는 Node.js 런처입니다.
일반 실행, 익명 모드(격리된 임시 `$HOME`), 네임드 세션(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`
분리)을 지원합니다.



![](main.png)

## Requirements

- **Node.js 18 이상 — 반드시 사전에 설치되어 있어야 합니다.**
`cmd_generator.js`(설치 스크립트)와 `launcher.js` 자체가 Node 런타임으로 실행되는
스크립트라서, 설치 스크립트를 돌리는 시점에 이미 Node가 있어야 합니다. Node를 설치해
주는 부트스트랩 과정은 없습니다.
  - [nodejs.org](https://nodejs.org)에서 LTS 버전 설치, 또는 `nvm`/`brew install node` 등
  사용 중인 버전 관리자로 설치하세요.
  - 확인: `node -v` (v18.x 이상이어야 함)
- **Linux**: 추가 설치 없이 바로 사용 가능. 풀스크린 wrapper(멀티탭, border/status bar)를
쓰려면 `tmux`가 필요합니다 — 없어도 크래시 없이 더 단순한 실행 경로로 자동 폴백됩니다.
- **macOS**: Big Sur 이후 tmux가 기본 미포함이라 설치 스크립트가 `brew install tmux`를
자동으로 실행합니다. Xcode Command Line Tools가 없거나(또는 macOS 업데이트 후 흔히
깨지는 경우) brew install이 실패하면, 설치 스크립트가 이를 감지해 재설치를 안내/진행합니다.
tmux가 끝내 없어도 크래시 없이 더 단순한 실행 경로로 자동 폴백됩니다.
- **Windows**: 네이티브 지원. 풀스크린 wrapper는 [tmux-windows](https://github.com/arndawg/tmux-windows)
(winget 우선, 실패 시 서브모듈에 pin된 릴리즈에서 `tmux.exe` 자동 다운로드)를 사용합니다.
tmux-windows 확보에 실패해도 `@xterm/headless` 기반 자체 컴포지터로 자동 폴백되어
border/status bar가 있는 풀스크린 경험을 유지합니다(멀티탭/세션 detach-reattach는 현재
tmux-windows 경로에서만 지원).

## Install

```bash
git clone https://github.com/D0iloppa/void-ai-launcher.git
cd void-ai-launcher
```

Windows에서 tmux-windows를 서브모듈 릴리즈 바이너리로 직접 빌드/사용하려면 대신
`git clone --recurse-submodules https://github.com/D0iloppa/void-ai-launcher.git`로
clone하세요(winget으로 자동 설치되면 이 단계는 불필요합니다).

OS별 설치 스크립트를 실행하세요. Node.js가 없으면 스크립트가 먼저 설치를 시도한 뒤
`cmd_generator.js`(의존성 설치 + `void` 전역 명령 등록)를 호출합니다.


| OS                   | 명령                      |
| -------------------- | ----------------------- |
| macOS / Linux        | `./scripts/install.sh`  |
| Windows (PowerShell) | `./scripts/install.ps1` |
| Windows (cmd.exe)    | `scripts\install.cmd`   |


Node.js가 이미 설치돼 있다면 `npm run build`(= `cmd_generator.js` 직접 호출)로도 동일하게
설치할 수 있습니다.

## Usage

```bash
void                       # 대화형 메인 메뉴
void --help                # 도움말
void <tool> [args...]      # 예: void claude, void codex exec "..."
void <tool> --anon         # 익명 모드 (임시 $HOME)
void host                  # 호스트 셸 실행
void prompt                # Anthropic/OpenAI/Google 프롬프트 모드
void tokens                # API 토큰 관리
void sessions              # 네임드 세션 관리
void update                # git 기반 자체 업데이트(뒤처져 있으면 즉시 pull --ff-only)
```

대화형 메인 메뉴에서는 이 외에도 **고급 모드**(Personal Assistant / 익명 실행 / 세션 실행 /
void-persistent)와 **설정 및 이력**(History, VOID 설정, 토큰/세션 관리, 업데이트) 하위 메뉴로
아래 Features의 모든 기능에 접근할 수 있습니다.

## Features

- **실행 모드** — 일반 실행, 익명 모드(격리된 임시 `$HOME`), 네임드 세션(`CLAUDE_CONFIG_DIR`/
  `CODEX_HOME` 분리, 재사용 가능한 프로필)을 지원합니다. 실행 중인 도구는 border/status bar가
  있는 프레임 wrapper(크로스플랫폼 `@xterm/headless` + `node-pty` 컴포지터, 필요 시 순수
  `node-pty` 프레임으로 폴백)로 감싸지며, 프레임 안에서 `Ctrl+\`로 컨트롤 패널(도움말/사용량/
  계정 전환/메시징)을 열 수 있습니다.
- **Personal Assistant** — 프로필별로 격리된 configDir(자체 OAuth 자격증명 + `uv` Python venv +
  전역 스킬 심볼릭 링크 + 전용 `workspace/`)을 갖는 상주 AI 어시스턴트입니다. 최초 대화에서
  온보딩을 거쳐 성격/어투를 `persona.md`로 저장하고, 이후 세션은 이 persona + 누적되는
  `memory.md`를 시스템 프롬프트로 씁니다. Read/Edit/Write/Bash 외에 **Skill/Task(서브에이전트)
  툴**도 허용되어 있어 자체적으로 스킬을 쓰고 하위 작업을 위임할 수 있습니다. 채팅 화면에는
  배고픔/활력/기분/유대감 4가지 vitals와 감정 표정을 갖는 **다마고치 스타일 펫 아바타**가
  함께 표시되며, 먹이주기/놀아주기/재우기/쓰다듬기로 상호작용합니다.
- **void-persistent** — Claude 계정을 여러 개 등록해 두고 전환하는 기능입니다. 수동 전환(자격증명
  파일을 원자적으로 스왑 + 실패 시 롤백)뿐 아니라, 사용량 한도에 걸리면 자동으로 다음 계정으로
  넘어가고 리셋 후 원래 계정으로 복귀하는 자동 모드, 그리고 API 호출 없이 Claude CLI 자체
  세션 로그만 읽어 한도 상태를 감지하는 제로-네트워크 로컬 로그 tier까지 3단계로 구성됩니다.
- **void-context** — 이름 있는 세션의 실행/재개 이력을 별도 그래프 DB에 자동 기록하고, MCP
  서버(`lib/voidContextMcp.js`)로 다른 AI 에이전트에게도 노출합니다.
- **세션 메시징 / resume / resume-fork** — 같은 머신에서 실행 중인 다른 void 인스턴스에 메시지를
  보내거나(1:1/전체), 내 세션을 상대에게 그대로 이관(resume, source는 잠금)하거나 복사해서
  공유(resume-fork)할 수 있습니다.
- **세션 동기화** — 두 void 설치본 사이에서 네임드 세션 프로필 전체를 페어링 코드로 주고받습니다.
  기본은 LAN/VPN 직결 WebSocket(중계 서버 없음, AES-256-GCM 프레이밍)이고, 같은 네트워크가 아닐
  때를 위한 SSH 터널 경유 옵션도 있습니다.
- **자체 업데이트** — 시작 시(옵션) 또는 `void update`로 git 기반 업데이트를 확인하고, 커밋되지
  않은 변경이 없을 때만 `git pull --ff-only`로 안전하게 적용합니다(hard-reset 없음).
- **직접 프롬프트 모드** — `void prompt`로 대화형 CLI 없이 Anthropic/OpenAI/Google API를 즉시
  호출합니다.
- **토큰 관리** — 서비스/별칭별 API 토큰을 등록·조회·삭제하고, 외부 셸 세션에서 쓸 수 있도록
  export 명령도 생성합니다.
- **사용량 미터링** — Claude/Codex의 세션·주간 사용량을 OAuth/백엔드 API → RPC → PTY 스크레이핑
  순으로 폴백하며 조회하고, 백그라운드에서 캐시를 미리 데워 둡니다.

## Configuration

도구 목록·테마·설정·API 토큰은 SQLite 기반 저장소(`~/.config/void-launcher/config.djinn.db`,
`lib/configDb.js`)에서 관리합니다. 레거시 `config.json`/`config.yml`은 최초 실행 시 이 DB로
자동 마이그레이션된 뒤 `.migrated` 확장자로 이름이 바뀌고 더 이상 참조되지 않습니다. 도구/테마/
설정은 대화형 메뉴(설정 및 이력 → VOID 설정)에서 편집하거나 `configDb.setTools`/`setTheme`/
`setSettings`를 직접 호출하며, 더 이상 YAML 파일을 손으로 편집하는 방식이 아닙니다.

## Development

```bash
npm run check      # 전체 JS 파일 문법 검사 (node --check, lib/void-persistent, lib/messaging, lib/pet 포함)
npm test           # node --test test/ — assistant 샌드박스, messaging, pet, resumeFork, selfUpdate, sync 등
```

아키텍처/디렉토리 구조/모듈별 책임/데이터 저장소 상세는 [`spec.md`](spec.md)를, 빌드 명령과
에이전트 운영 지침은 [`CLAUDE.md`](CLAUDE.md)를 참고하세요.