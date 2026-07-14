# VOID AI Launcher Project Analysis

## 1. Purpose

`void-ai-launcher`는 여러 AI CLI를 하나의 터미널 TUI에서 실행하기 위한 Node.js 런처다.
현재 기본 대상 도구는 `claude`, `codex`, `agy`다.

지원하려는 실행 형태는 세 가지다.

- 기본 실행: 사용자의 기존 CLI 설정을 그대로 사용
- 익명 실행: 임시 `HOME` 기반 격리 환경
- 네임드 세션 실행: 도구별 설정 디렉토리를 분리한 지속형 환경

이 프로젝트의 핵심 가치는 "도구 목록을 YAML로 선언하고, 동일한 UX로 각 AI CLI를 라우팅"하는 데 있다.

## 2. Entry Points

### [launcher.js](/mnt/c/DEV/ai-launcher/launcher.js)

메인 엔트리다.

- `config.yml` 로드
- 색상/프레임 초기화
- CLI 인자 직행 모드 처리
- 홈 메뉴 및 고급 메뉴 렌더링
- 히스토리/빠른 시작/세션 실행/채팅 모드 연결

### [config.yml](/mnt/c/DEV/ai-launcher/config.yml)

도구 선언과 UI 설정의 단일 진입점이다.

- `tools[]`: 표시명, 실행 바이너리, 기본 인자
- `theme`: 내장 테마 이름 및 오버라이드
- `settings.wrapper_hpad`, `settings.wrapper_vpad`: 프레임 내부 여백

### [cmd_generator.sh](/mnt/c/DEV/ai-launcher/cmd_generator.sh)

실제 사용자 명령 `void`를 설치 가능한 형태로 만드는 빌드 스크립트다.
이 저장소에서 `build`는 번들 생성이 아니라 "전역 실행 가능한 wrapper 생성" 의미가 더 강하다.

## 3. Runtime Architecture

### 3.1 UI Layer

#### [lib/ui.js](/mnt/c/DEV/ai-launcher/lib/ui.js)

Ink가 아닌 수동 ANSI 렌더링 기반 메뉴 UI다.

- 메뉴 선택
- 입력 프롬프트
- 메시지 박스
- 대체 스크린 진입/이탈
- CJK 폭 계산 대응

홈 화면과 일반 메뉴는 여기서 관리한다.

#### [lib/theme.js](/mnt/c/DEV/ai-launcher/lib/theme.js)

테마 팔레트 로드와 ANSI 색상 토큰 생성을 담당한다.

### 3.2 Launch / Environment Layer

#### [lib/runner.js](/mnt/c/DEV/ai-launcher/lib/runner.js)

도구 실행의 실제 오케스트레이터다.

주요 책임:

- 익명 모드의 임시 `HOME` 구성
- 세션 모드의 `CLAUDE_CONFIG_DIR`, `CODEX_HOME` 구성
- 기본 `codex` 실행 시 writable `CODEX_HOME` 보장
- 래퍼 실행 우선순위 결정

실행 우선순위:

1. `runTmuxSession`
2. `runWrappedTmuxFrame`
3. `runWrapped`
4. plain `spawnSync`

즉, 가능한 한 `tmux` 기반 UX를 우선 사용하고, 실패 시 더 단순한 경로로 내려간다.

### 3.3 Terminal Wrapper Layer

#### [lib/wrapper.js](/mnt/c/DEV/ai-launcher/lib/wrapper.js)

가장 복잡한 런타임 모듈이다.

주요 기능:

- `node-pty` 기반 framed wrapper
- `tmux` 기반 전체화면 세션
- `tmux` inside `node-pty` 혼합 모드
- 상단/하단 바 렌더링
- resize 대응
- ANSI 시퀀스 필터링

중요한 설계 포인트:

- AI CLI가 화면 전체를 지워도 `void` 바를 복원해야 한다.
- 도구가 `tmux` 내부에 있더라도 도구 자신은 `TMUX` 환경을 감지하지 않게 해야 한다.
- `codex`처럼 attach 이전 렌더링에 민감한 도구는 시작 타이밍을 조정해야 한다.

### 3.4 Session / Persistence Layer

#### [lib/storage.js](/mnt/c/DEV/ai-launcher/lib/storage.js)

런처 상태 저장의 기준점이다.

저장 대상:

- `last.json`
- `history.json`
- `sessions.json`

경로 정책:

1. `$XDG_CONFIG_HOME/void-launcher`
2. `~/.config/void-launcher`
3. `./.void-launcher`
4. `${tmp}/void-launcher`

추가로 현재는 도구 런타임 경로 해석도 맡는다.

- `resolveToolStateDir(tool)`
- `resolveSessionConfigDir(tool, sessionName)`

이 함수들은 읽기 전용 홈 환경에서도 실제로 쓸 수 있는 경로를 반환한다.

#### [lib/sessions.js](/mnt/c/DEV/ai-launcher/lib/sessions.js)

두 종류의 세션을 다룬다.

- 일반 터미널 세션(`tmux`)
- AI CLI 네임드 세션(`claude`, `codex`)

현재 세션 지원 대상은 `claude`, `codex`다.

## 4. Feature Map

### 4.1 일반 실행

`void <tool> [args...]`

- `config.yml`에 등록된 바이너리를 실행
- 추가 인자를 그대로 전달
- 비TTY면 wrapper를 포기하고 직접 실행

### 4.2 익명 모드

`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`를 임시 디렉토리로 돌려 격리 실행한다.

장점:

- 기존 로그인 상태와 설정 분리
- 종료 후 정리 가능

주의:

- 현재 cleanup은 프로세스 종료 후점에 맞춰져 있으므로 크래시 시 잔여물이 남을 수 있다.

### 4.3 네임드 세션

도구별 설정 디렉토리를 세션명 기준으로 분리한다.

- `claude` -> `CLAUDE_CONFIG_DIR`
- `codex` -> `CODEX_HOME`

이제 세션 디렉토리는 홈 고정이 아니라 writable 경로 해석을 거친다.

### 4.4 Chat Mode

#### [lib/chat-runner.js](/mnt/c/DEV/ai-launcher/lib/chat-runner.js)

간단한 REPL형 대화 모드다.

- `claude`: `--prompt`, `--continue` 기반
- `codex`: `codex exec` 기반 one-shot 누적 컨텍스트
- 기타 바이너리: `--prompt` 기반 누적 컨텍스트

`codex`는 일반 인터랙티브 TUI와 옵션 체계가 달라 별도 분기가 필요하다.

## 5. Current Behavioral Risks

### 5.1 Wrapper path divergence

실행 경로가 `tmux fullscreen`, `tmux frame`, `node-pty`, `plain spawn`으로 나뉘므로 도구별 문제를 재현할 때 항상 어떤 경로를 탔는지 먼저 확인해야 한다.

### 5.2 Tool-specific CLI differences

`claude`, `codex`, `agy`는 모두 AI CLI지만 옵션 체계가 다르다.

- `claude`는 `--prompt`, `--continue` 중심
- `codex`는 interactive default + `exec` subcommand 구조
- `agy`는 `--prompt`/`--print` 스타일

공통 래퍼만 보고 옵션을 통합하면 깨질 가능성이 높다.

### 5.3 Read-only home environments

이 프로젝트는 실제로 읽기 전용 홈 환경에서 깨지기 쉽다.
특히 `codex`는 로컬 sqlite state DB를 반드시 쓰기 때문에 가장 민감하다.

### 5.4 tmux attach timing

`codex`는 detached 상태에서 먼저 시작되면 pane이 비어 있는 상태로 남는 현상이 있다.
그래서 attach 후 실행되도록 시작 타이밍 제어가 들어가 있다.

## 6. Recommended Maintenance Rules

- 세션/도구 런타임 경로는 `os.homedir()`를 직접 조합하지 말고 공통 resolver를 사용한다.
- 새 AI CLI를 붙일 때는 "interactive mode"와 "print/exec mode"를 분리해서 본다.
- `codex` 계열 변경은 기본 실행, 세션 실행, chat mode를 같이 검증한다.
- wrapper 문제를 볼 때는 non-TTY fallback도 함께 점검한다.
