# VOID Launcher Guidelines

이 문서는 `ai-launcher` 작업 시 항상 우선 적용하는 운영 기준이다.

## 1. Build / Install

- `build`의 의미는 패키징이 아니라 `void` 명령어를 실제로 등록 가능한 상태로 만드는 것이다.
- 표준 빌드 진입점은 `npm run build` 이다.
- `npm run build` 는 반드시 [`cmd_generator.js`](/mnt/c/DEV/ai-launcher/cmd_generator.js) 를 호출해야 한다.
- `cmd_generator.js` 는 Node.js 스크립트이므로 `node ./cmd_generator.js` 로 실행한다. (Linux/Mac/Windows 공통)
- `cmd_generator.js` 변경 시 다음 조건을 유지한다.
  - `/usr/local/bin/void` 등록 가능해야 한다.
  - 설치 시작 초반에 `sudo` 권한을 먼저 확인해야 한다.
  - `nvm` 환경에서도 동작하도록 실제 `node` 경로를 wrapper script에 기록해야 한다.
  - y/N 선택형 의존성 설치 prompt를 두지 않는다.
  - 런타임에 필요한 의존성은 설치 스크립트가 전부 설치해야 한다.
  - 읽기 전용 홈 환경에서도 동작하도록 npm cache 경로를 외부에서 지정 가능해야 한다.

## 2. Command Registration

- 최종 사용자 관점의 산출물은 `void` 명령어다.
- tarball 생성이나 단순 `node launcher.js` 실행만으로 빌드 완료로 간주하지 않는다.
- 설치 경로와 wrapper 내용이 변경되면 `sudo void` 재실행 경로도 함께 검토한다.

## 3. CLI Compatibility

- 툴 실행 시 사용자 추가 인자는 절대 버리면 안 된다.
- `void codex --help`, `void codex exec ...`, `void claude ...` 같은 호출은 원본 CLI 인자를 그대로 전달해야 한다.
- 비-TTY 환경에서는 wrapper UI를 강제하지 말고 직접 실행 fallback이 가능해야 한다.

## 4. Session Rules

- 세션 기능은 특정 도구 전용으로 하드코딩하지 않는다.
- 현재 세션 지원 대상은 `claude`, `codex` 이다.
- 세션 저장 시 `(toolCommand, sessionName)` 조합을 식별자로 취급한다.
- 도구별 환경 변수 규칙:
  - `claude` → `CLAUDE_CONFIG_DIR`
  - `codex` → `CODEX_HOME`

## 5. Storage / Runtime Safety

- 상태 저장은 단일 경로에 고정하지 않는다.
- 읽기 전용 홈에서도 동작하도록 writable fallback 경로를 유지해야 한다.
- 실행 검증 시 홈 디렉토리 쓰기 가능 여부를 전제하지 않는다.
- `codex` 기본 실행은 `~/.codex`가 writable 하지 않으면 launcher storage 하위 fallback `CODEX_HOME`을 자동으로 사용해야 한다.
- 세션 디렉토리(`.claude-*`, `.codex-*`)도 `os.homedir()` 고정이 아니라 writable 경로 해석 함수를 통해 만들어야 한다.

## 6. Wrapper UX

- `Wrapper` 영역 바깥 테두리는 유지한다.
- resize 보호 영역은 `Wrapper` 내부에만 둔다.
- host shell 탭은 AI 제어용이 아니라 사용자가 직접 조작하는 로컬 셸이라는 의미를 유지한다.
- `svc` / host shell / tool tabs 의 역할을 섞지 않는다.
- `codex`는 일반 wrapper redraw와 충돌하므로 예외적으로 전용 `tmux` split 제어 정책을 유지한다.
- `codex`용 제어는 footer 재그리기 대신 하단 shell split auto-open 방식을 기본으로 한다.

## 7. Change Discipline

- 새 기능 추가 시 다음을 함께 확인한다.
  - 홈 메뉴 진입점
  - 히스토리/빠른 시작 복원
  - 세션 저장 포맷 호환성
  - 비-TTY fallback
  - `npm run check`
  - 필요 시 `npm run build`

## 8. Documentation Policy

- 빌드 방식이나 설치 경로가 바뀌면 이 문서를 먼저 업데이트한다.
- 작업자가 반복해서 실수할 수 있는 규칙은 코드만 고치지 말고 여기에 명시한다.
