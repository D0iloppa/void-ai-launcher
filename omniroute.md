# omniroute — 한 줄 요약

**OmniRoute**는 여러 LLM 제공사(Provider) API를 하나의 로컬 엔드포인트(`localhost:20128/v1`)로 통합하는 무료·오픈소스 AI 게이트웨이(라우터)다. Claude Code, Cursor, Codex 등 IDE/코딩 툴의 base URL을 이 엔드포인트로 바꾸기만 하면, 뒤에서 268개 이상의 제공사(그중 다수가 무료 티어)를 자동 폴백하며 사용할 수 있다. (출처: https://omniroute.online/)

## 이게 뭔가

- 문제의식: 특정 AI 제공사(Anthropic, OpenAI, Google 등)의 무료/유료 쿼터가 소진되면 개발이 멈춘다. OmniRoute는 여러 제공사를 뒤에 묶어두고 하나가 막히면 자동으로 다른 제공사로 전환(auto-fallback)해 "작업이 끊기지 않게" 한다. 홈페이지 슬로건이 "One endpoint. Never stop building." / "Never Stop Coding."이다. (출처: https://omniroute.online/)
- 아키텍처: `IDE → OmniRoute(로컬 라우터) → 268개 Provider`. OpenAI / Claude / Gemini / Responses API 포맷 간 변환(translate)까지 해준다. (출처: https://omniroute.online/)
- 로컬에서 실행되는 게이트웨이로, API 서버와 관리용 대시보드(Next.js 16)가 같은 포트(`20128`)에서 함께 뜬다. (출처: https://omniroute.online/)
- GitHub README(검색 결과 기준)에 따르면 원래 "9router"라는 프로젝트의 포크이자, Go로 작성된 CLIProxyAPI 프로젝트를 TypeScript로 포팅한 것에서 출발했다고 한다. (출처: GitHub 검색 결과, https://github.com/diegosouzapw/OmniRoute)

## 핵심 개념 / 기능

- **268개+ Provider 지원**: 이 중 90개 이상이 무료 티어를 제공하고, 11개는 완전 무료(unlimited free)로 명시됨 — Kiro, Qoder, LongCat, Cloudflare AI, Gemini CLI, NVIDIA NIM, Cerebras 외 4개. 월간 총 무료 예산은 약 14억(1.4B) 토큰(pool-deduped, 즉 90여 개 제공사에 걸쳐 합산·중복제거된 수치). (출처: https://omniroute.online/)
- **자동 폴백(Auto-Fallback)**: 한 제공사의 쿼터가 소진되면 밀리초 단위로 다른 제공사로 전환.
- **3계층 장애 대응(3-Layer Resilience)**: 제공사 단위 서킷 브레이커, 커넥션 단위 쿨다운, 모델 단위 락아웃.
- **스마트 라우팅 전략 17종**: 쿼터 중심(priority, fill-first), 부하분산(round-robin, p2c, least-used), 비용 최적화(cost-optimized), 컨텍스트 인지(context-relay, context-optimized), 무작위(random, strict-random), 스마트(auto, lkgp, reset-aware, reset-window).
- **토큰 압축 파이프라인**: Session-Dedup, CCR, RTK, Headroom, Relevance, Caveman, LLMLingua-2 등 7개 조합형 압축 엔진을 스택으로 사용. 프로필에 따라 15%(Lite)~95%(Stacked RTK)까지 토큰 절감을 주장.
- **내장 메모리**: FTS5 키워드 검색 + Qdrant 벡터 검색으로 대화 컨텍스트 회상(recall) 지원.
- **MCP 서버**: 31개 스코프에 걸쳐 104개 도구(tool)를 stdio/HTTP/SSE로 노출. A2A(Agent-to-Agent) 프로토콜(JSON-RPC 2.0, 6개 skill)도 지원.
- **프록시 / 스텔스**: 3단계 프록시 지원 + TLS 핑거프린트 스텔스로 지역 차단 우회.
- **범용 호환성**: Claude Code, Cursor, Cline, GitHub Copilot 등 16개 이상 코딩 툴에서 사용 가능하다고 명시.
- **대시보드**: `localhost:20128/dashboard`에서 API 키 발급, 제공사 연결, 설정 관리.
- **기술 스택**: TypeScript / Next.js 16, 로컬 SQLite 저장, 자격증명 AES-256 암호화, 텔레메트리 없음(no telemetry), 셀프호스팅 가능. (출처: https://omniroute.online/)

## Quickstart (설치·초기 설정·첫 사용)

사이트의 quickstart 섹션(https://omniroute.online/#quickstart) 내용을 그대로 옮긴다. "3개 명령으로 끝난다(3 Commands)"고 설명한다.

**1단계 — 설치 및 실행**

사이트 설명: "One npm install, then launch — the API and dashboard come up together on port 20128." (npm 설치 한 번으로 API와 대시보드가 20128 포트에서 동시에 뜬다.)

```bash
npm install -g omniroute
omniroute
```

**2단계 — 무료 제공사 연결**

사이트 설명: "Open the dashboard, pick from 90+ free tiers and sign in — no credit card, no paid API key needed." (대시보드를 열고 90개 이상의 무료 티어 중 하나를 골라 로그인 — 신용카드나 유료 API 키 불필요.)

대시보드 접속: `http://localhost:20128/dashboard`

**3단계 — IDE/툴 연결**

사이트 설명: "Set your tool's base URL to `localhost:20128/v1` and your dashboard key." (사용 중인 툴의 base URL을 `localhost:20128/v1`로, API 키는 대시보드에서 발급받은 키로 설정.)

**연결 확인(verification)**

```bash
curl localhost:20128/v1/models
```

정상이면 모델 목록이 출력된다 (사이트 표기: "✓ models listed 🎉").

**설정 요약**

| 항목 | 값 |
|---|---|
| Base URL | `localhost:20128/v1` |
| Dashboard | `http://localhost:20128/dashboard` |
| Port | `20128` |
| API Key | 대시보드에서 발급 |

사이트는 이 과정을 "Zero config"라고 표현한다 — 설치 즉시 API와 대시보드가 같은 포트에서 함께 뜬다는 의미로 보인다. (출처: https://omniroute.online/, https://omniroute.online/#quickstart)

※ WebSearch로 확인한 GitHub 저장소 설명(README 메타디스크립션 기준)에는 `npx omniroute@latest` 또는 `docker run -p 20128:20128 diegosouzapw/omniroute` 방식의 설치 예시도 언급되어 있었다 — 다만 이는 검색 스니펫에서 확인한 것으로, 공식 사이트 quickstart 본문에 있는 문구는 아니므로 참고용으로만 표기한다. (출처: GitHub 검색 결과)

## 배포 방식 (사이트에 명시된 옵션)

- npm: `npm i -g omniroute`
- Docker: `docker run omniroute`
- 데스크톱 앱(Electron): Windows/Mac/Linux
- ARM / Raspberry Pi
- Termux(Android)
- PWA(브라우저 설치형)
- OpenCode 플러그인
- 소스 빌드: `git clone`

(출처: https://omniroute.online/)

## 사용 예시 / 유즈케이스

- **Claude Code / Cursor / Cline / GitHub Copilot 등에서 provider 락인 없이 사용**: 위 quickstart 3단계처럼 base URL만 `localhost:20128/v1`로 바꾸면, 실제로 어떤 provider가 호출되는지는 OmniRoute가 라우팅 정책(17가지 전략 중 선택)에 따라 결정한다.
- **무료 쿼터 소진 시 자동 전환**: 한 provider의 무료 한도를 다 쓰면 사람이 개입하지 않아도 다른 provider로 넘어가 "작업이 끊기지 않게" 한다.
- **긴 대화/많은 토큰을 쓰는 워크플로우에서 비용·토큰 절감**: RTK+Caveman 등 압축 파이프라인으로 토큰 사용량을 줄인다.
- **에이전트/자동화 워크플로우 통합**: MCP 서버(104개 tool)나 A2A 프로토콜을 통해 Codex, Cursor, Devin, Jules 같은 클라우드 에이전트와 연동 가능하다고 명시.
- **지역 차단 우회가 필요한 환경**: 프록시 + TLS 스텔스 기능으로 특정 지역에서 막힌 provider에 접근.

(출처: https://omniroute.online/ — 위 항목들은 사이트의 기능 설명을 유즈케이스 형태로 재구성한 것이며, 실사용 후기·사례 연구는 사이트에서 별도로 확인되지 않음)

## 요금·제약·주의사항

- **요금**: 사이트는 "무료(Free), 신용카드 불필요"를 명시한다. "90개 이상의 provider의 무료 티어가 플랫폼 전체를 비용 없이 지탱한다"고 설명. 별도의 유료 플랜/구독 정보는 사이트 본문에서 확인되지 않음. (출처: https://omniroute.online/)
- **라이선스**: MIT (사이트 및 GitHub 설명 모두에서 확인). (출처: https://omniroute.online/, GitHub)
- **제약/주의사항**: 사이트 본문에는 rate limit, SLA, 데이터 처리 정책(로그 보관 등)에 대한 구체적 언급이 없음 — **자료에서 확인 안 됨**. "no telemetry"라는 표현은 있으나 이것이 각 provider로 전달되는 실제 요청/응답 데이터의 처리 방식(예: 어떤 provider가 로그를 남기는지)까지 보장하는지는 불명확.
- **신뢰도 관련 주의**: 사이트에 표기된 "2026-02-13 기준 GitHub 스타 20,146개, 기여자 360명 이상, 릴리스 271개, 테스트 25,000개 이상"이라는 수치는 사이트 자체 주장이며 별도로 GitHub에서 직접 재검증하지 않았다. WebSearch로 확인한 GitHub 검색 스니펫에서는 "기여자 500명 이상(Built by 500+ contributors)", "provider 268+/278+/290+"처럼 리비전마다 숫자가 다르게 표기되고 있어(릴리스 버전별로 문구가 계속 바뀌는 것으로 보임), 급성장 중이거나 수치가 자주 업데이트되는 프로젝트로 보인다. 정확한 현재 수치는 GitHub 저장소를 직접 확인 권장.

## 참고 링크

- 공식 사이트: https://omniroute.online/
- Quickstart 섹션: https://omniroute.online/#quickstart
- GitHub 저장소: https://github.com/diegosouzapw/OmniRoute
- GitHub Wiki: https://github.com/diegosouzapw/OmniRoute/wiki

## 조사 메모 (확인된 사실 vs 추정 구분)

**공식 사이트(omniroute.online)에서 직접 확인된 사실:**
- 제품명, 슬로건, 핵심 기능 목록(라우팅 전략 17종, 압축 엔진 7종, 무료 provider 11개 목록 등), quickstart 3단계 명령어, base URL/포트(20128), 대시보드 경로, 라이선스(MIT), 기술 스택.

**WebSearch(GitHub 검색 스니펫)로 교차 확인된 사실:**
- GitHub 저장소 존재(`diegosouzapw/OmniRoute`), "9router 포크 + Go 프로젝트 CLIProxyAPI의 TypeScript 포팅"이라는 프로젝트 배경, `npx omniroute@latest` / `docker run -p 20128:20128 diegosouzapw/omniroute` 형태의 대안 설치 명령(단, 이건 GitHub README 메타디스크립션에서 나온 문구이며 공식 사이트 quickstart 본문에는 없음).

**불명확하거나 자료에서 확인 안 된 부분:**
- 실제 npm 패키지(`omniroute`)의 최신 버전, 다운로드 수, npm 레지스트리 페이지 자체는 별도로 조회하지 않았음.
- GitHub 스타/기여자 수 등 소셜 프루프 수치가 사이트마다·검색 스니펫마다 달라 정확한 "현재" 수치는 미확인.
- 유료 플랜 존재 여부, SLA, 로그/데이터 보관 정책 — 사이트 본문에 명시된 바 없음.
- "268개 provider" 같은 숫자가 실제 통합 테스트를 거친 수인지, 단순 목록 등재 수인지는 사이트 설명만으로는 판단 불가.
- 이 문서는 공식 사이트 1개와 WebSearch 스니펫만을 근거로 작성했으며, GitHub README 원문 전체나 실제 설치·구동 테스트는 수행하지 않았다.
