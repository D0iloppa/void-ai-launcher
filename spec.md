# spec.md — 구조/아키텍처 스펙

이 문서는 `CLAUDE.md`(빌드 명령·에이전트 운영 지침)를 보완하는 **구조 문서**다.
빌드 명령/개발 워크플로/카파시 원칙 등은 `CLAUDE.md`를 참고하고, 여기서는 중복 없이
디렉토리 구조·모듈 책임·데이터 저장소·서브모듈·프로토콜만 다룬다.

## 1. 디렉토리 구조

```
void-ai-launcher/
├── launcher.js            # 진입점 — CLI arg dispatch(handleArgs) + 전체 메뉴 트리
├── bootstrap.js            # 실제 실행 진입점(npm bin) — 자체 업데이트 체크 → launcher.js 실행
├── cmd_generator.js         # 설치 스크립트 — 의존성 설치, `void` 전역 명령 등록, linkGlobalSkills()
├── package.json
├── CLAUDE.md / spec.md / README.md / ONBOARDING.md / TASK_CONTEXT.md
├── main.png                 # README 스크린샷
├── config.json.migrated / config.yml.migrated   # 레거시 설정(1회 마이그레이션 후 잔존, 더 이상 참조 안 됨)
├── lib/                     # 전체 기능 모듈(2절 표 참고)
│   ├── void-persistent/     # 계정 자동전환(phase1 수동/phase2 자동/phase3 로컬로그)
│   ├── messaging/           # void-to-void 메시징(그래프 백엔드) + resume/resume-fork
│   └── pet/                 # 개인비서 챗뷰의 다마고치 펫 (인터페이스+그리드+스킨)
├── vendor/                  # 서브모듈(3절)
│   ├── dJinn/                — better-sqlite3 기반 그래프 DB 엔진 (필수)
│   ├── void-assistant/       — 상주 어시스턴트 세션 엔진
│   ├── tmux-windows/         — Windows용 tmux 바이너리 공급원
│   └── d0iloppa-djinn-0.2.0.tgz  — dJinn 설치용 커밋된 vendor tarball(서브모듈 빌드 폴백 전 우선 시도)
├── scripts/
│   ├── install.sh / install.ps1 / install.cmd   # OS별 설치 스크립트(cmd_generator.js 호출)
│   ├── install-djinn.js      # preinstall — vendor tgz에서 dJinn 설치, 실패 시 서브모듈 빌드 폴백
│   └── init-void-context.js  # postinstall — void-context.djinn.db 최초 생성/시드
├── themes/                   # 내장 컬러 테마 9종(js 모듈, theme.js가 로드)
├── docs/                     # 배경 문서(일부 stale) — project-analysis, ui_design_specification,
│                              #   cross-platform-roadmap, guideline, windows_porting_guide, codex-launch-issue
├── test/                     # node --test 스위트 (assistant-sandbox, messaging-store, pet,
│                              #   resumeFork, selfUpdate, sync-ssh, void-context(-auto-record), xtermFrame-mail-restart)
└── _global/g_skills/         # 전역 스킬 저장소 — cmd_generator.js가 네임드 세션에, assistant.js가
                               #   어시스턴트 프로필에 각각 심볼릭 링크로 연결
```

## 2. 모듈 책임 표 (`lib/` 전체)

CLAUDE.md의 표에 이미 있는 모듈(`runner.js`, `wrapper.js`, `ui.js`, `sessions.js`,
`storage.js`, `config.js`, `configDb.js`, `theme.js`, `tokens.js`, `prompt.js`,
`extTokens.js`, `assistant.js`, `cliPreflight.js`, `miniShell.js`, `usageDb.js`,
`usageMeter.js`, `usageWarmup.js`, `sync.js`, `graphLayer.js`, `voidContext.js`,
`voidContextAutoRecord.js`, `voidContextMcp.js`)는 그대로 정확하므로 여기서 반복하지
않는다. 아래는 CLAUDE.md 표에 **빠져 있는** 모듈을 포함한 전체 목록이다.

| 모듈 | 책임 |
|---|---|
| `lib/aggregator.js` | 모델 라우팅 애그리게이터 — `/mnt/c/DEV/docker/models/router.py`를 Node로 이식. chat/imagegen/tts/stt/embedding 5개 task의 provider 카탈로그(dJinn `aggregator.djinn.db`)를 관리하고 Gemini/NVIDIA REST를 직접 호출(스트리밍 포함)한다. void 자체 CLI에는 배선되지 않은 **라이브러리**로, 다른 스크립트가 require해서 쓴다 |
| `lib/chat-runner.js` | `node lib/chat-runner.js --binary <cmd> --sock <sock>` 형태의 독립 프로세스 — claude/codex를 논스트리밍 프롬프트-응답 REPL로 감싸고, tmux 메일박스(`mcp-hub.js`)를 폴링해 다른 탭에서 온 메시지도 큐에 넣어 순차 처리한다 |
| `lib/mcp-hub.js` | (1) 메일박스 경로 헬퍼 + MCP 실행 커맨드 빌더(순수 라이브러리, SDK 미의존) (2) `node lib/mcp-hub.js --sock <sock>`로 실행되는 독립 프로세스 — `@modelcontextprotocol/sdk`를 지연 로드해 tmux 창별 `send_message`/`check_mailbox`/`list_targets` MCP 툴을 HTTP로 제공하는 "voidhub" 서버 |
| `lib/animation.js` | 터미널 텍스트 이펙트 순수 함수 모음 — shimmerText(반짝임), scrambleText(스크램블/디코딩), glitchText(글리치), 색 보간/휘도 계산. UI 장식용 |
| `lib/panel.mjs` | Ink(React) 기반 tmux 컨트롤 패널(ESM) — 새 탭 생성(풀스크린/채팅), 탭 목록/전환/종료, 메시지 발신 UI. `runTmuxSession`(아래 참고)에서만 스폰됨 |
| `lib/selfUpdate.js` | git 기반 자체 업데이트 코어 — `checkUpdate`(fetch 후 behind-count), `applyUpdate`(`git pull --ff-only`만, dirty면 거부, package-lock 변경 시 npm install). 전 함수 fail-open. `bootstrap.js`(시작 시 업데이트 프롬프트)와 `launcher.js`의 `void update`/설정 메뉴가 호출 |
| `lib/xtermFrame.js` | `@xterm/headless` + `node-pty` 기반 크로스플랫폼 프레임 컴포지터(`runXtermWrapped`) — 자식 PTY 출력을 진짜 VT 파서로 읽어 void의 border/status bar chrome과 합성해 다시 그린다. 컨트롤 패널(Ctrl+\\)에서 도움말/사용량/void-persistent 계정전환(S)/메시징(M) 오버레이를 모두 이 파일이 그린다. **모든 OS에서 1순위로 시도되는 현재의 기본 wrapper 경로**(2026-07 기준, `lib/runner.js`) — 사전 존재하는 파일이라 이번 문서화 작업에서 수정하지 않음 |
| `lib/void-persistent/switchProfile.js` | phase1(수동 계정 전환) 핵심 로직 — pool CRUD, 자격증명 파일(`.credentials.json`/`.claude.json`) 원자적 스왑+롤백(`switchTo`), 세션 캡처, `runVoidPersistentSession` 실행 루프 |
| `lib/void-persistent/autoSwitchDriver.js` | phase2(자동 전환) glue — `autoSwitchEngine`(순수 상태머신) + `localLogTier`(로컬 로그 스캔)를 실제 configDb 상태에 연결. `usageWarmup.js`의 백그라운드 폴러에서 호출되며 TTY/PTY는 건드리지 않고 `pendingRestart` 플래그만 남긴다 |
| `lib/void-persistent/autoSwitchEngine.js` | phase2 순수 상태머신(fs/pty/network 미의존) — rate-limit hit/주기 tick에 따라 `switchTo`/`none`/`allExhausted` 결정을 반환(외부 Swift 참고 구현을 그대로 포팅) |
| `lib/void-persistent/localLogTier.js` | phase3(제로-네트워크 사용량 로컬 로그 tier) — Claude CLI 자체 세션 `*.jsonl`에서 rate-limit 이벤트를 파싱해 리셋 시각을 추출. `usageMeter.js`의 tier-0로 배선되어 있어 API/PTY 부하를 줄이기만 한다 |
| `lib/messaging/registry.js` | void-to-void 프레즌스 레지스트리 — 실행 중인 void 프로세스가 `storageDir()/mail/registry/`에 자기 자신을 등록(파일시스템 전용, dJinn/네트워크 불필요), pid 생존 여부로 stale 항목 정리 |
| `lib/messaging/mailbox.js` | 메시징 공개 API(하위호환 유지) — 내부 저장소가 파일 스풀에서 dJinn 그래프(`store.js`)로 전환됐지만 함수 시그니처는 그대로. `listInbox`가 돌려주는 `file` 필드는 이제 파일 경로가 아니라 opaque handle |
| `lib/messaging/store.js` | 메시지 저장소의 실제 dJinn 그래프 백엔드(`void-messages.djinn.db`, 네임스페이스 `void_messages`) — mailbox id(수신자)를 level-2 노드로, 메시지 1건을 level-3 doc으로 저장 |
| `lib/messaging/resumeFork.js` | seedType `resume`/`resume-fork` 전용 로직 — Claude 세션 jsonl 파일 포인터 생성/복사/uuid rewrite, source 세션 lock, `acceptSeed()` 라우팅(msg→inject, resume→switch, resume-fork→register) |
| `lib/pet/index.js` | 개인비서 챗뷰 다마고치 펫의 렌더러-비종속 인터페이스 — vitals(satiety/energy/mood/bond) lazy decay, 상호작용(feed/play/rest/pet) 처리, 16종 감정 어휘 + PetSkin 레지스트리(`registerSkin`/`getSkin`) |
| `lib/pet/grid.js` | 스킨 무관 고정 렌더 그리드(`PET_GRID` = 13×9) + `padToGrid` 안전망(스킨이 그리드 계약을 어겨도 렌더러는 항상 고정 크기를 받음) |
| `lib/pet/skin-invader.js` | 기본 펫 스킨 "Space Invader" — 6가지 베이스 감정(neutral/happy/sad/angry/surprised/sleepy)마다 다른 안테나/팔/발 자세로 블록 문자 스프라이트를 그리는 순수 렌더링 모듈(색상 없음, `lib/ui.js`가 채색) |

### 부연 — `lib/assistant.js`의 신규 샌드박스 기능

CLAUDE.md는 `assistant.js`를 "Personal Assistant 프로필 — 격리 venv + void-assistant 세션"으로만
요약한다. 실제로는 다음 샌드박스/스킬 배선이 추가돼 있다:
- `linkAssistantSkills(configDir)` — `_global/g_skills` → `<configDir>/skills` 심볼릭 링크(Windows는
  junction). 프로필 생성 시 + 세션 시작 시(레거시 프로필 백필) 양쪽에서 호출되는 멱등 연산, 실패해도
  세션 시작을 막지 않음(fail-open)
- `ensureAssistantWorkspace(configDir)` — 자격증명/venv/persona가 있는 `configDir`과 분리된
  `<configDir>/workspace`를 만들어 세션의 실제 `cwd`로 사용(Bash/Write 산출물이 여기 쌓임)
- 세션은 `DEFAULT_ALLOWED_TOOLS = ['Read','Edit','Write','Bash','Skill','Task']`로 제한되어 스폰됨 —
  Task(서브에이전트)/Skill 툴이 허용되어 있어 개인비서도 서브에이전트를 띄우고 스킬을 쓸 수 있다

### 부연 — `runTmuxSession` 경로(현재 미사용, 사전 존재 코드)

`lib/wrapper.js`의 `runTmuxSession`(실제 tmux 바이너리에 위임, `lib/mcp-hub.js` MCP 허브 +
`lib/panel.mjs` 컨트롤 패널 + `lib/chat-runner.js` 채팅 탭을 조합한 멀티탭 경험)은 여전히
export되어 있지만, `lib/runner.js`에서 호출부가 **주석 처리**되어 있어(`// wrapped =
runTmuxSession(...)`) 현재 실제 실행 경로에서는 도달하지 않는다 — `lib/xtermFrame.js`의
`runXtermWrapped`가 모든 OS에서 1순위로 대체했다. 주석 자체가 "향후 멀티페인 지원을 위해
남겨둠, tmux 지원을 의도적으로 폐지하지 않는 한 제거 금지"라고 명시하므로 dead code가 아니라
보류된 경로다. `lib/sessions.js`의 "터미널 세션(tmux)" 메뉴(별도 detachable 세션 관리)는
이것과 무관하게 실제 tmux 바이너리를 직접 호출해 현재도 동작한다.

## 3. 데이터 저장소 & 영속화

### 3.1 SQLite (dJinn) DB

| 파일 | 경로 | 용도 | 소유 모듈 |
|---|---|---|---|
| `config.djinn.db` | `~/.config/void-launcher/` (storageDir) | 도구 목록·테마·설정·API 토큰·void-persistent 스위처 상태 | `lib/configDb.js` |
| `usage-cache.djinn.db` | storageDir | 사용량 캐시 + rate-limit 백오프 윈도우 | `lib/usageDb.js` |
| `aggregator.djinn.db` | storageDir | 모델 라우팅 카탈로그(chat/imagegen/tts/stt/embedding + imagegen_chain + NVIDIA 카탈로그) | `lib/aggregator.js` |
| `void-context.djinn.db` | 레포 루트(gitignored) | task-context 그래프(네임스페이스 `void_context`) — 네임드 세션 launch/exit을 자동 기록 | `lib/voidContext.js`, MCP: `lib/voidContextMcp.js` |
| `void-messages.djinn.db` | 레포 루트(gitignored) | void-to-void 메시징 그래프(네임스페이스 `void_messages`) — 수신자별 메시지 | `lib/messaging/store.js` |

다섯 DB 모두 `lib/graphLayer.js`의 `initVoidGraphLayer()` 팩토리(require 실패의 영구 캐시,
인스턴스 생성 실패의 일시적 재시도 구분, `isNew` 시 `chmod 0600` 등 공통 부트스트랩) 위에
얹혀 있으며, 서로 다른 파일로 분리되어 있어 한 DB의 손상/부재가 다른 DB에 영향을 주지 않는다.
`config.djinn.db`/`aggregator.djinn.db`는 dJinn 자체를 못 쓰는 극단적 상황에서도 코드 내
`DEFAULT_*` 상수로 읽기 폴백을 제공(쓰기는 명시적 Error).

### 3.2 JSON (`storage.js`, storageDir 안)

| 파일 | 내용 |
|---|---|
| `last.json` | 마지막 실행 대상(빠른 시작용) |
| `history.json` | 실행 이력 |
| `sessions.json` | 네임드 CLI 세션 목록({name, toolCommand, configDir, created_at, handedOff?}) |
| `assistants.json` | 개인비서 프로필 목록({name, toolCommand, configDir, isOnboard, model?, effort?, tokenService?, tokenAlias?, pet?}) |
| `init-status.json` | 백그라운드 사용량 warmup 1회성 실행 기록 |

`storageDir()`은 `$XDG_CONFIG_HOME/void-launcher` → `~/.config/void-launcher` → cwd의
`.void-launcher` → tmpdir 순으로 첫 쓰기 가능한 디렉토리를 고른다(0700 권한).

### 3.3 프로필별 configDir 레이아웃

네임드 세션(`lib/sessions.js`)과 개인비서 프로필(`lib/assistant.js`)은 각각 격리된
`configDir`(`~/.claude-<name>` 류, `resolveSessionConfigDir`/`resolveAssistantConfigDir`)을
갖는다. 개인비서 프로필의 `configDir` 내부 구조:

```
<configDir>/
├── .credentials.json / .claude.json   # OAuth 자격증명(claude CLI 자체가 관리)
├── persona.md          # 온보딩 완료 후 저장되는 시스템 프롬프트(3인칭 아닌 "너 자신에게 주는 지침")
├── memory.md            # 세션이 스스로 쌓는 장기 기억(있으면 persona 뒤에 이어붙여 시스템 프롬프트에 포함)
├── ONBOARDING.md         # 최초 온보딩 대화용 지침(레포 루트 템플릿에서 1회 복사, {{CONFIG_DIR}} 치환)
├── venv/                 # uv로 생성한 격리 Python venv(Bash 툴이 쓰는 python이 이 안에서 실행)
├── skills -> ../../_global/g_skills   # 전역 스킬 저장소 심볼릭 링크(junction on Windows)
└── workspace/            # 세션의 실제 cwd — Bash/Write 산출물이 여기 쌓임(configDir 자체와 분리)
```

`void-persistent`의 persist 프로필(`resolvePersistProfileDir`)도 별도 디렉토리에
`.credentials.json`/`.claude.json`만 담아 pool 멤버 간 전환 대상이 된다(source 세션의
configDir은 절대 변형하지 않음).

## 4. 서브모듈 (`vendor/`)

| 서브모듈 | 제공 기능 |
|---|---|
| `vendor/dJinn` | `@d0iloppa/djinn` — better-sqlite3 기반 그래프 DB 엔진. 모든 `*.djinn.db` 저장소의 백엔드. **필수**(`scripts/install-djinn.js`가 preinstall에서 커밋된 vendor tgz 우선 설치, 실패 시 서브모듈 자체 빌드로 폴백) |
| `vendor/void-assistant` | 상주 `claude`/`codex` 세션 엔진(5절 참고) — Personal Assistant 채팅이 이 패키지의 `createSession()`을 구동 |
| `vendor/tmux-windows` | Windows용 tmux 바이너리 확보 경로(winget 우선, 실패 시 이 서브모듈에 pin된 릴리즈에서 `tmux.exe` 다운로드) — `lib/sessions.js`의 터미널 세션 메뉴가 Windows에서도 동작하게 함 |

## 5. 핵심 프로토콜/인터페이스

### 5.1 void-assistant stdio line-JSON 프로토콜

`vendor/void-assistant`가 spawn하는 claude 자식 프로세스는
`--input-format stream-json --output-format stream-json --include-partial-messages`로 실행된다.

**보내는 쪽** (`Session.sendMessage(text)` → 자식 stdin, 개행 종료 JSON 1줄):
```json
{"type":"user","message":{"role":"user","content":"<text>"}}
```

**받는 쪽** (자식 stdout, 줄 단위 JSON — `vendor/void-assistant/lib/streamJsonEvents.js`의 `dispatchStreamEvent`가 파싱):
- 텍스트 델타:
  `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`
  → `Session`이 `'delta'` 이벤트로 재방출
- 세션 초기화:
  `{"type":"system","subtype":"init","model":"...","session_id":"...","slash_commands":[...]}`
  → `'meta'` 이벤트({model, sessionId, slashCommands})
- 턴 완료:
  `{"type":"result","result":"<최종 텍스트>", usage:{...}, total_cost_usd:...}`
  → `'done'` 이벤트(finalText, usage)

파싱 불가/부분 라인은 조용히 스킵(계약대로). 유휴 타임아웃(기본 180초) 시 프로세스는 죽이지
않고 해당 턴만 실패시킨다(`'error'` 이벤트) — 세션은 계속 살아 있어 다음 턴을 받을 수 있다.

### 5.2 세션 동기화(`lib/sync.js`) — WS/SSH 프레이밍

- **페어링 코드**: `[version:1][addrFamily:1][addr:4|16][port:2 BE][secret:16][checksum:2]`를
  Crockford Base32(I/L/O/U 제외)로 인코딩, 5글자씩 하이픈으로 그룹핑해 사용자에게 표시.
- **전송 프레임**: AES-256-GCM, `[type:1][iv:12][tag:16][ciphertext]`.
- **전송로**: 기본은 LAN/VPN 직결 WebSocket(중계 서버 없음). SSH 터널 옵션은 기존 WS+AES-GCM
  프로토콜은 그대로 두고 `ssh -L`(로컬 포트 포워딩)로 그 연결이 지나가는 경로만 바꾼다 —
  시스템 `ssh` 바이너리를 서브프로세스로 사용, 새 암호화 계층 없음.
- **가드레일**: 세션명/toolCommand는 원격 매니페스트를 신뢰하지 않고 화이트리스트
  정규식(`^[a-zA-Z0-9][a-zA-Z0-9-]*$`) + 알려진 도구 목록으로 검증. 인증 타임아웃(15초),
  매니페스트당 세션 수(100)/파일 수(10000)/총 바이트(2GiB) 상한으로 DoS를 방지.

### 5.3 MCP 서버

- **`lib/voidContextMcp.js`** — `.mcp.json`에 등록된 stdio MCP(`node lib/voidContextMcp.js`).
  dJinn의 내장 `serveMcp`로 void-context 그래프(task-context)를 MCP 클라이언트에 노출.
- **`lib/mcp-hub.js`의 "voidhub" 서버** — `runTmuxSession` 경로(현재 미사용, 2절 참고) 안에서만
  스폰되는 per-tmux-socket HTTP MCP 서버. `@modelcontextprotocol/sdk`를 지연 로드하며 SDK가
  없으면 조용히 종료(`process.exit(3)`), 호출부는 chat-runner 메일박스만으로 폴백. 툴:
  `send_message(target, text)` / `check_mailbox()` / `list_targets()`.

### 5.4 PetSkin 인터페이스

`lib/pet/index.js`가 소유하는 렌더러-비종속 계약:

```
PetSkin = {
  id: string,                 // 레지스트리 키(예: 'space-invader')
  label: string,               // 표시 이름
  renderableEmotions: string[], // BASE_EMOTIONS(6종)의 부분집합
  mapEmotion(emotion16) -> baseEmotion,
  drawSprite({emotion, vitals, frame}) -> string[]   // 색 코드 없는 순수 문자열 배열
}
```

`drawSprite`의 반환은 **반드시** `PET_GRID`(13열×9행, `lib/pet/grid.js`)에 정확히 맞아야
한다는 것이 그리드 계약이다 — 스킨이 계약을 어겨도 `padToGrid()`가 안전망으로 강제 보정한다.
색상은 항상 호출자(`lib/ui.js`)가 입히므로 스킨/인터페이스 양쪽 다 ANSI 이스케이프를
생성하지 않는다. 16개 감정 어휘는 6개 베이스 감정으로 접혀(`EMOTION_16_TO_6`) 스킨에
전달되고, 기존 8-mood(`setMood`) 이벤트 상태는 `MOOD8_TO_EMOTION16`으로 16어휘에 매핑된다.

## 6. 기능 → 주요 모듈 맵

| 기능 | 주요 모듈 |
|---|---|
| 일반/익명/네임드 세션 실행 + 프레임 wrapper | `launcher.js`(launchTool) → `lib/runner.js` → `lib/xtermFrame.js`(1순위) / `lib/wrapper.js`(폴백) |
| Personal Assistant (상주 채팅) | `lib/assistant.js`, `vendor/void-assistant`, `lib/pet/*`(펫 아바타), `_global/g_skills`(스킬 링크) |
| void-persistent (계정 자동 전환) | `lib/void-persistent/switchProfile.js`(수동), `autoSwitchEngine.js`+`autoSwitchDriver.js`(자동), `localLogTier.js`(로컬 로그 신호), `lib/xtermFrame.js`(S키 오버레이) |
| void-context (task-context 그래프 + MCP) | `lib/voidContext.js`, `lib/voidContextAutoRecord.js`, `lib/voidContextMcp.js`, `lib/graphLayer.js` |
| 세션 메시징 + resume/resume-fork | `lib/messaging/{registry,mailbox,store,resumeFork}.js`, `lib/xtermFrame.js`(M키 오버레이) |
| 세션 동기화(Export/Import) | `lib/sync.js` |
| 자체 업데이트 | `lib/selfUpdate.js`, `bootstrap.js` |
| 직접 프롬프트 모드 | `lib/prompt.js` |
| 토큰 관리 | `lib/tokens.js`, `lib/extTokens.js`, `lib/config.js`, `lib/configDb.js` |
| 사용량 미터링 | `lib/usageDb.js`, `lib/usageMeter.js`, `lib/usageWarmup.js`, `lib/void-persistent/localLogTier.js`(tier-0) |
| 모델 라우팅 애그리게이터(독립 라이브러리) | `lib/aggregator.js` |
| 다중 탭 MCP 허브(현재 미사용 경로) | `lib/mcp-hub.js`, `lib/panel.mjs`, `lib/chat-runner.js` (`runTmuxSession` 전용) |
| 자체 설치/전역 스킬 연결 | `cmd_generator.js`(linkGlobalSkills), `lib/assistant.js`(linkAssistantSkills) |
