# Codex Launch Issue Analysis

## Symptom

- `claude`, `agy`는 launcher에서 실행됨
- `codex`는 launcher에서 시작 직후 실패하거나 화면이 비어 보임

## Reproduction

현재 저장소에서 `tty`로 아래를 실행하면 launcher 내부 경로를 그대로 탈 수 있다.

```bash
node launcher.js codex
```

실제 확인된 에러:

```text
Codex couldn't start because its local database appears to be damaged.
Location: /home/doil/.codex/state_5.sqlite
Cause: attempt to write a readonly database
```

## Root Cause

문제는 `codex` 바이너리 자체가 아니라 기본 상태 디렉토리다.

`codex`는 시작 시 `CODEX_HOME` 또는 기본값 `~/.codex` 아래에 sqlite state DB를 연다.
이 경로가 writable 하지 않으면 초기화 단계에서 즉시 종료한다.

반면 `claude`와 `agy`는 같은 조건에서 동일하게 죽지 않기 때문에 겉보기엔 `codex`만 고장난 것처럼 보인다.

## Why Launcher Was Vulnerable

기존 코드의 기본 실행 경로는 다음과 같았다.

1. 세션 모드가 아니면 `CODEX_HOME`을 명시적으로 주지 않음
2. 그래서 `codex`는 기본 경로 `~/.codex` 사용
3. 홈이 읽기 전용이면 sqlite open 단계에서 실패

추가 취약점도 있었다.

- 네임드 세션 디렉토리를 `os.homedir()`에 고정 생성
- `Chat` 모드에서 `codex` 기본 실행도 writable `CODEX_HOME` 보장 없음
- `Chat` 모드가 `codex`를 다른 CLI와 동일하게 `--prompt` 스타일로 취급

## Fix Applied

### 1. Writable runtime dir resolver 추가

[lib/storage.js](/mnt/c/DEV/ai-launcher/lib/storage.js)에 아래 개념을 추가했다.

- `resolveToolStateDir(toolCommand)`
- `resolveSessionConfigDir(toolCommand, sessionName)`

이 함수들은 순서대로 writable 경로를 찾는다.

1. 홈 기본 경로
2. launcher storage 하위 경로
3. tmp fallback

### 2. Default Codex launch hardening

[lib/runner.js](/mnt/c/DEV/ai-launcher/lib/runner.js)에서 기본 `codex` 실행 시 writable `CODEX_HOME`을 강제한다.

즉:

- 사용자가 `CODEX_HOME`을 줬고 writable 하면 그대로 사용
- 아니면 resolver가 반환한 fallback 경로 사용

### 3. Named session path hardening

세션 생성과 복원에서 `~/.codex-...`, `~/.claude-...`를 직접 합치지 않고 resolver를 사용하게 바꿨다.

영향 파일:

- [launcher.js](/mnt/c/DEV/ai-launcher/launcher.js)
- [lib/runner.js](/mnt/c/DEV/ai-launcher/lib/runner.js)
- [lib/sessions.js](/mnt/c/DEV/ai-launcher/lib/sessions.js)

### 4. Chat mode Codex fix

[lib/chat-runner.js](/mnt/c/DEV/ai-launcher/lib/chat-runner.js)에서:

- 기본 `codex` 실행 시 writable `CODEX_HOME` 적용
- `codex`를 `--prompt` 방식이 아니라 `codex exec` 방식으로 실행

### 5. Wrapper routing change

현재는 [lib/runner.js](/mnt/c/DEV/ai-launcher/lib/runner.js)에서 `codex`만 일반 wrapper 경로 대신 전용 `tmux` 세션 경로를 탄다.

이유:

- 기존 launcher wrapper의 footer/bar redraw가 `codex` TUI와 충돌함
- `codex`는 동일 화면 footer 유지보다 별도 split pane 제어가 더 안정적임

따라서 `codex`는:

- 전용 full-screen `tmux` 세션으로 실행
- 하단 shell split auto-open
- `CODEX_HOME`만 launcher가 보정

## Remaining Note: tmux timing

별개로 `codex`는 detached `tmux`에서 attach 전에 시작되면 pane이 비어 보이는 현상이 있다.
현재 [lib/wrapper.js](/mnt/c/DEV/ai-launcher/lib/wrapper.js)의 `runTmuxSession()`에는 attach 후 시작되도록 짧은 지연이 들어 있다.

이건 이번 read-only DB 문제와는 별개지만, `codex` 관련 증상을 혼동하게 만드는 요소다.

## Validation Checklist

- `node launcher.js codex --help`
- `node launcher.js codex`
- `void codex` 후 하단 shell split 자동 표시
- 홈 메뉴에서 `CODEX` 일반 실행
- `Config -> CLI 세션`에서 codex 세션 생성/실행
- `Chat -> CODEX` 진입
- `npm run check`
