'use strict';

// 시작 시 백그라운드 warmup — void 가 뜰 때 등록된 모든 claude/codex 세션의
// 사용량을 미리 조회해 lib/usageDb.js 캐시를 데워둔다.
//
// Fire-and-forget: launcher.js 는 이 함수를 await 하지 않는다. 절대 throw 하지
// 않고, 콘솔/UI 출력도 전혀 없다 — 유일한 관찰 가능 효과는 다음에 "사용량 조회"
// 메뉴를 열었을 때 캐시가 이미 데워져 있다는 것뿐이다.
//
// 순차 실행 (Promise.all 아님): 여러 세션이 각각 ~25s 짜리 hidden PTY tier로
// 떨어질 수 있으므로, 시작 시점에 여러 개의 숨은 claude/codex 프로세스를 동시에
// 띄우는 무거운 짓을 피한다.

// warmup 대상 목록 — 이름 없는(전역) claude/codex 계정 + 등록된 세션들.
// warmUsageCache 뿐 아니라 wrapper 컨트롤 패널의 사용량 조회(U)에서도 재사용된다.
function getWarmupTargets() {
  const { getSessions } = require('./storage');

  // 이름 없는(전역) 계정 — claude/codex 각각의 기본 설정 경로.
  const targets = [
    { toolCommand: 'claude', configDir: null, sessionKey: 'default' },
    { toolCommand: 'codex', configDir: null, sessionKey: 'default' },
  ];

  for (const s of getSessions()) {
    const toolCommand = (s && s.toolCommand) || 'claude';
    // agy 등은 사용량 조회 메커니즘이 없으므로 건너뛴다.
    if (toolCommand !== 'claude' && toolCommand !== 'codex') continue;
    if (!s || !s.name) continue;
    targets.push({ toolCommand, configDir: s.configDir || null, sessionKey: s.name });
  }
  return targets;
}

async function warmUsageCache(config) {
  try {
    const { getClaudeUsage, getCodexUsage } = require('./usageMeter');
    const targets = getWarmupTargets();

    // void-persistent phase 2 (자동 계정 전환) — 사이클당 1회, TTY/PTY 없이 로컬
    // 로그만 스캔한다. void_persistent:switcher.autoMode 가 꺼져 있으면 즉시 no-op.
    // 절대 throw 하지 않는다(내부에서 이미 방어적으로 감쌈) — 방어적으로 여기서도 한 번 더 감싼다.
    try { require('./void-persistent/autoSwitchDriver').checkAutoSwitch(config); } catch {}

    for (const target of targets) {
      try {
        const overrides = { configDir: target.configDir || undefined, sessionKey: target.sessionKey };
        if (target.toolCommand === 'claude') {
          await getClaudeUsage(config, overrides);
        } else if (target.toolCommand === 'codex') {
          await getCodexUsage(config, overrides);
        }
      } catch {
        // 세션 하나가 실패해도 나머지 warmup 을 막지 않는다.
      }
    }
    return { count: targets.length };
  } catch {
    // warmup 전체가 실패해도 앱 시작에는 영향이 없어야 한다.
    return { count: 0 };
  }
}

// 30초 주기 백그라운드 재조회 폴러.
//
// void_init()/boot warmup 과는 완전히 독립적인 별도 메커니즘이다 — init-status.json
// 마커("부팅 시 1회 실행됐는지")의 의미를 "마지막 주기적 갱신 시각"으로 바꿔버리면
// 안 되므로, 이 폴러는 saveInitStatus()를 호출하지 않고 단순히 warmUsageCache(config)
// 를 그대로 재사용해 반복 호출한다.
//
// 겹침 가드: warmUsageCache 한 사이클은 등록된 세션 수 × 세션당 최대 ~25s(PTY 폴백
// tier)가 걸릴 수 있어, 세션이 많으면 한 사이클이 30초를 넘을 수 있다. 이전 tick이
// 아직 끝나지 않았는데 다음 30초 tick이 겹치면 숨김 PTY가 누적으로 쌓일 위험이 있으므로,
// 진행 중이면 이번 tick은 그냥 건너뛴다(in-flight boolean, finally 로 반드시 리셋 —
// warmUsageCache 자체가 절대 throw 하지 않지만, 방어적으로 이 레벨에서도 catch 한다).
//
// .unref(): 이 인터벌은 launcher.js 최상위 스코프에서 앱 전체 생명주기 동안 살아있고,
// wrapper.js/xtermFrame.js 내부 타이머들과 달리 세션 종료 시 clearInterval 되는 자연스러운
// 정리 지점이 없다. unref 하지 않으면 사용자가 정상 종료해도 이 타이머 때문에 Node
// 프로세스가 계속 떠 있게 된다.
function startUsagePolling(config, intervalMs = 30000) {
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) return; // 이전 사이클이 아직 진행 중 — 이번 tick 은 건너뛴다.
    inFlight = true;
    Promise.resolve()
      .then(() => warmUsageCache(config))
      .catch(() => {
        // 한 사이클 실패는 무음으로 삼키고 다음 tick 에서 다시 시도한다.
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { warmUsageCache, getWarmupTargets, startUsagePolling };
