'use strict';

// EXPERIMENTAL — phase 2 (자동 전환) glue.
//
// lib/experiments/autoSwitchEngine.js (순수 상태머신)를 실제 configDb 상태 +
// lib/experiments/localLogTier.js (zero-network 로컬 로그 스캔)에 연결한다.
// lib/usageWarmup.js 의 백그라운드 폴러에서 호출되므로 **TTY/PTY 를 절대
// 건드리지 않는다** — 실제 재시작은 여기서 하지 않고 autoState.pendingRestart
// 를 남겨서, 살아있는 xtermFrame 패널이(barTimer 틱에서) 그걸 소비해 기존
// 수동 전환(S키)과 동일한 onControlAction({type:'switch'}) 경로로 재시작한다.
//
// 실패는 여기서 끝난다 — checkAutoSwitch 가 던지면 warmup 사이클 전체가 깨질
// 수 있으므로, 모든 것을 try/catch 로 감싼다(전 구간 방어적).

const configDb = require('../configDb');
const { checkLocalRateLimit } = require('./localLogTier');
const switchProfile = require('./switchProfile');
const engine = require('./autoSwitchEngine');

// memberLimits 항목: { resetsAt: number|null, recordedAt: number }
// resetsAt === null 이면 "리셋 시각 불명, 여전히 소진" — localLogTier 의 보수적
// 정책을 그대로 이어받는다(자동으로는 절대 회복 판정하지 않는다).
function isMemberLimitAvailable(entry, now, marginMs) {
  if (!entry) return true;
  if (entry.resetsAt === null || entry.resetsAt === undefined) return false;
  return now > entry.resetsAt + marginMs;
}

function buildPoolView(pool, activeIndex, memberLimits, now, marginMs) {
  return pool.map((m, i) => {
    const entry = memberLimits[i];
    if (!entry || isMemberLimitAvailable(entry, now, marginMs)) {
      return { ...m, rateLimit: null };
    }
    return { ...m, rateLimit: { resetsAt: entry.resetsAt, modelScoped: false } };
  });
}

// 백그라운드 폴러(lib/usageWarmup.js)의 매 사이클에서 호출된다. 실패해도
// warmup 사이클을 절대 깨뜨리지 않는다.
function checkAutoSwitch() {
  try {
    const state = configDb.getExperimentSwitcher();
    if (!state.enabled || !state.autoMode) return;
    const pool = Array.isArray(state.pool) ? state.pool : [];
    if (pool.length < 2 || state.activePoolIndex < 0 || state.activePoolIndex >= pool.length) return;
    if (!state.persistDir) return;

    const now = Date.now();
    const cooldownMs = engine.DEFAULT_COOLDOWN_MS;
    const marginMs = engine.DEFAULT_MARGIN_MS;
    const activeIndex = state.activePoolIndex;

    const autoState = { ...engine.defaultAutoState(), ...(state.autoState || {}) };
    const memberLimits = { ...(autoState.memberLimits || {}) };

    const localHit = checkLocalRateLimit(state.persistDir);
    if (localHit && localHit.limited) {
      memberLimits[activeIndex] = { resetsAt: localHit.resetsAt, recordedAt: now };
    } else if (localHit && !localHit.limited) {
      delete memberLimits[activeIndex];
    }

    const poolView = buildPoolView(pool, activeIndex, memberLimits, now, marginMs);
    const opts = { autoMode: state.autoMode, cooldownMs, marginMs };

    let decision;
    if (localHit && localHit.limited) {
      decision = engine.onRateLimitHit(poolView, activeIndex, { modelScoped: false, resetsAt: localHit.resetsAt }, autoState, now, opts);
    } else {
      decision = engine.onTick(poolView, activeIndex, autoState, now, opts);
    }

    let nextAutoState = { ...autoState, memberLimits };

    if (decision && decision.type === 'switchTo') {
      const result = switchProfile.switchTo(decision.index);
      if (result.ok) {
        nextAutoState = engine.noteSwitched(nextAutoState, now, { toPrimary: decision.index === 0 });
        nextAutoState.memberLimits = memberLimits;
        nextAutoState.pendingRestart = { poolIndex: decision.index };
      }
    }

    // switchTo(가 성공했다면) 이미 activePoolIndex 를 갱신해 뒀으니, 그 이후
    // 상태를 다시 읽어 autoState 만 patch 한다(경합 최소화).
    const freshState = configDb.getExperimentSwitcher();
    freshState.autoState = nextAutoState;
    configDb.setExperimentSwitcher(freshState);
  } catch {
    // 백그라운드 폴러를 절대 깨뜨리지 않는다.
  }
}

// 살아있는 xtermFrame 패널이 barTimer 틱마다 폴링한다 — pending 이 있으면
// 소비(clear)하고 반환, 없으면 null. 수동 S 키와 동일한
// onControlAction({type:'switch', poolIndex}) 경로로 넘겨져 재시작을 유발한다.
function consumePendingRestart() {
  try {
    const state = configDb.getExperimentSwitcher();
    const pending = state.autoState && state.autoState.pendingRestart;
    if (!pending) return null;
    state.autoState = { ...state.autoState, pendingRestart: null };
    configDb.setExperimentSwitcher(state);
    return pending;
  } catch {
    return null;
  }
}

module.exports = { checkAutoSwitch, consumePendingRestart, buildPoolView, isMemberLimitAvailable };
