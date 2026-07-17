'use strict';

// 이 앱의 첫 라이트 테마 — bg/text 명암이 다른 모든 테마와 반대다.
// lib/theme.js의 onSignal 계산(대비비 기반)이 이 극성 반전에서도 올바르게
// 동작함을 확인한 뒤 추가함(무회귀 검증: 기존 8개 다크 테마 결과 불변).
module.exports = {
  bg: '#ffffff', panel: '#f5f5f5', panel2: '#e8e8e8',
  border: '#cccccc', borderHi: '#999999',
  signal: '#000000', signalDim: '#d4d4d4',
  text: '#000000', muted: '#b3b3b3', muted2: '#666666',
  ok: '#16a34a', warn: '#d97706', info: '#2563eb',
};
