'use strict';

// EXPERIMENTAL — phase 2 (자동 전환) 순수 상태머신.
//
// fs/pty/network 를 전혀 require 하지 않는다 — 모든 함수는 순수 함수/plain
// object 만 다룬다 (테스트 용이성 + 부작용 격리). 실제 전환 실행/영속화는
// lib/experiments/autoSwitchDriver.js 가 담당한다.
//
// ref/mobius/Sources/MobiusCore/AutoSwitchEngine.swift 를 그대로 포팅한다 —
// Swift 원본의 provider-scoped 클래스(cooldown/margin/lastSwitchAt 를
// 인스턴스 필드로 들고 lock 으로 감쌈)를, 이 프로젝트의 나머지 experiments
// 모듈들과 같은 스타일로 "state 를 인자로 받고 state 를 반환/변경하는 순수
// 함수" 형태로 바꿨을 뿐 로직은 1:1 이다.
//
// pool 멤버 shape(이 엔진이 기대하는 최소 필드 — driver 가 조립해서 넘긴다):
//   { name, toolCommand, userPinned?: boolean, needsReauth?: boolean,
//     rateLimit?: { resetsAt: number|null, modelScoped?: boolean } | null }
// rateLimit == null 이면 "현재 한도 소진 아님"으로 취급한다.
// rateLimit.resetsAt == null 이면 "리셋 시각 불명 — 여전히 소진 상태"로
// 취급한다(localLogTier.js 의 conservative 정책과 동일).

const DEFAULT_COOLDOWN_MS = 120000; // 전환 직후 재전환 금지
const DEFAULT_MARGIN_MS = 60000;    // 리셋 시각 + margin 후에만 primary 로 복귀

function defaultAutoState() {
  return { lastSwitchAt: null, autoSwitchedFromPrimary: false };
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────

function inCooldown(state, now, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const last = state && state.lastSwitchAt;
  if (typeof last !== 'number') return false;
  return now < last + cooldownMs;
}

// member 가 현재 시점 now 기준으로 소진 상태인지.
function isMemberLimited(member, now) {
  const rl = member && member.rateLimit;
  if (!rl) return false;
  if (rl.resetsAt === null || rl.resetsAt === undefined) return true; // 리셋 시각 불명 → 보수적으로 소진 취급
  return now < rl.resetsAt;
}

// 후보: pool 순서(우선순위)대로, activeIndex 를 제외하고 한도 안 걸렸고
// 재인증 불필요한 첫 멤버. Swift 의 firstAvailable(excluding:) 과 동일.
function firstAvailable(pool, activeIndex, now) {
  if (!Array.isArray(pool)) return null;
  for (let i = 0; i < pool.length; i++) {
    if (i === activeIndex) continue;
    const m = pool[i];
    if (!m) continue;
    if (m.needsReauth) continue;
    if (isMemberLimited(m, now)) continue;
    return i;
  }
  return null;
}

// ── rate-limit hit 이벤트 처리 ──────────────────────────────────────────
// hit: { modelScoped?: boolean, resetsAt?: number|null }
// opts: { cooldownMs?, marginMs? } (marginMs 는 onTick 에서만 쓰이지만 시그니처
// 일관성을 위해 함께 받아둔다)
function onRateLimitHit(pool, activeIndex, hit, state, now, opts = {}) {
  const cooldownMs = typeof opts.cooldownMs === 'number' ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;

  if (!opts.autoMode) return { type: 'none' };
  if (!Array.isArray(pool) || activeIndex < 0 || activeIndex >= pool.length) return { type: 'none' };
  if (inCooldown(state, now, cooldownMs)) return { type: 'none' };

  const active = pool[activeIndex];
  // 모델 전용 한도 + 사용자가 이 계정을 직접 고름(pin) → 전환하지 않고 머문다.
  if (hit && hit.modelScoped && active && active.userPinned) return { type: 'none' };

  // hit 을 반영한 가상의 pool(호출자는 별도로 실제 state 를 갱신한다) —
  // Swift 의 markedFile 과 동일한 목적.
  const marked = pool.map((m, i) => {
    if (i !== activeIndex) return m;
    return { ...m, rateLimit: { resetsAt: hit && 'resetsAt' in hit ? hit.resetsAt : null, modelScoped: Boolean(hit && hit.modelScoped) } };
  });

  const next = firstAvailable(marked, activeIndex, now);
  if (next === null) return { type: 'allExhausted' };
  return { type: 'switchTo', index: next, reason: 'activeExhausted' };
}

// ── 주기 틱 ──────────────────────────────────────────────────────────────
function onTick(pool, activeIndex, state, now, opts = {}) {
  const cooldownMs = typeof opts.cooldownMs === 'number' ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
  const marginMs = typeof opts.marginMs === 'number' ? opts.marginMs : DEFAULT_MARGIN_MS;

  if (!opts.autoMode) return { type: 'none' };
  if (!Array.isArray(pool) || activeIndex < 0 || activeIndex >= pool.length) return { type: 'none' };
  if (inCooldown(state, now, cooldownMs)) return { type: 'none' };

  const active = pool[activeIndex];
  if (!active) return { type: 'none' };

  // (A) 자가복구: 활성 계정이 여전히 소진/재인증 필요 상태면 여유 계정으로 전환.
  //     단, 모델 전용 한도 + 사용자 핀이면 밀어내지 않는다("1회 자동 전환 후
  //     내가 되돌리면 머문다" 정책 — Swift 의 autoSwitchMayLeave 와 동일 의도).
  const activeStuck = Boolean(active.needsReauth) || isMemberLimited(active, now);
  const activeModelPinned = active.rateLimit && active.rateLimit.modelScoped && active.userPinned;
  if (activeStuck && !activeModelPinned) {
    const next = firstAvailable(pool, activeIndex, now);
    if (next !== null) return { type: 'switchTo', index: next, reason: 'activeExhausted' };
  }

  // (B) primary 복귀 — 현재 fallback 활성이 "자동 전환"의 결과일 때만.
  if (!state || !state.autoSwitchedFromPrimary) return { type: 'none' };
  if (activeIndex === 0) return { type: 'none' };
  const primary = pool[0];
  if (!primary || primary.needsReauth) return { type: 'none' };
  const primaryRl = primary.rateLimit;
  if (primaryRl && primaryRl.resetsAt !== null && primaryRl.resetsAt !== undefined) {
    if (now < primaryRl.resetsAt + marginMs) return { type: 'none' };
  } else if (primaryRl) {
    // primary 가 여전히 소진(리셋 시각 불명) 상태 — 복귀 보류.
    return { type: 'none' };
  }
  return { type: 'switchTo', index: 0, reason: 'primaryRecovered' };
}

// ── 전환 완료 후 부기 ────────────────────────────────────────────────────
// toPrimary === true 로 복귀했으면 autoSwitchedFromPrimary 를 false 로 리셋,
// fallback 으로 갔으면 true 로 세운다 — Swift 의 lastSwitchAt 갱신 + 이
// 프로젝트가 별도로 유지하는 autoSwitchedFromPrimary 플래그를 합친 것.
function noteSwitched(state, now, { toPrimary = false } = {}) {
  return {
    ...(state || defaultAutoState()),
    lastSwitchAt: now,
    autoSwitchedFromPrimary: !toPrimary,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MARGIN_MS,
  defaultAutoState,
  inCooldown,
  firstAvailable,
  isMemberLimited,
  onRateLimitHit,
  onTick,
  noteSwitched,
};
