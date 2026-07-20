'use strict';

// 개인비서 채팅 화면(lib/ui.js assistantChatView)의 Ctrl+\ 설정 패널을 위한
// 순수 로직. 렌더링·raw-mode 키 처리와 분리해 여기서만 두는 이유는
// composerModel.js/voidContextAutoRecord.js 와 같다 — dJinn/터미널 의존성
// 없는 순수 함수라 단위 테스트가 쉽다.

// 저장된 값(model/effort, 'default' sentinel 포함)을 옵션 목록에서 찾아 콤보
// 행의 초기 optionIndex 를 정한다. 목록에 없는(레거시/손상) 값은 'default'
// 자리로 폴백한다 — assistantModelSettingsMenu 의 기존
// `Math.max(0, options.indexOf(value || 'default'))` 패턴과 동일.
function initOptionIndex(options, value) {
  const idx = options.indexOf(value || 'default');
  return idx >= 0 ? idx : 0;
}

// ←(-1)/→(+1) 콤보 순환 — 양 끝에서 멈추지 않고 반대편으로 랩어라운드한다
// (menu() 의 combo row와 달리, 이 패널은 좁아서 옵션 수가 적은 편이라
// wrap-around 가 더 자연스러운 사용자 결정).
function cycleOptionIndex(options, currentIndex, delta) {
  const n = options.length;
  if (n === 0) return 0;
  return ((currentIndex + delta) % n + n) % n;
}

// model/effort 변경만 다음 메시지부터 세션 재시작이 필요하다(spawn 시점에
// 고정되는 CLI 플래그라서) — reasoning 은 화면 전용 토글이라 세션과 무관.
// prev/next 는 { model, effort } 형태('default'는 "필드 없음"과 동등하게
// 취급 — profile.model 필드 자체가 없는 경우 'default' 로 정규화해서 비교).
function shouldRestartOnSettingsChange(prev, next) {
  const norm = v => (v == null ? 'default' : v);
  return norm(prev.model) !== norm(next.model) || norm(prev.effort) !== norm(next.effort);
}

// showThinking 이 false 면 'think' 엔트리를 트랜스크립트에서 숨긴다 — 그 외
// 엔트리(user/assistant/system/tool)는 항상 통과.
function shouldShowEntry(entry, showThinking) {
  if (!entry) return false;
  if (entry.who === 'think') return showThinking !== false;
  return true;
}

module.exports = {
  initOptionIndex,
  cycleOptionIndex,
  shouldRestartOnSettingsChange,
  shouldShowEntry,
};
