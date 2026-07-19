#!/usr/bin/env node
// VOID//ai-launcher — void-context postinstall bootstrap.
// void-context 는 @d0iloppa/djinn 자체(scripts/install-djinn.js, 필수)와 달리 선택적/다운스트림
// 기능이다 — 초기화가 실패해도 npm install 전체를 막지 않는다(process.exit(0) 고정). 실제
// 안전장치는 lib/voidContext.js 의 모든 접근자가 사용 시점에 명확한 Error 를 던지는 것이다.
// 그래도 실패를 조용히 삼키지 않는다 — 여기서는 크게(loud) 로그만 남긴다.
'use strict';

const log = msg => console.log(`[init-void-context] ${msg}`);
const err = msg => console.error(`[init-void-context] ${msg}`);

try {
  const vc = require('../lib/voidContext');
  const ok = vc.initVoidContext();
  if (ok) {
    log(`void-context ready at ${vc.dbPath()}`);
  } else {
    err('void-context 초기화 실패(dJinn 을 사용할 수 없음) — void-context 는 선택 기능이라 설치는 계속됩니다.');
    err(`db path(미생성 가능): ${vc.dbPath()}`);
  }
} catch (e) {
  err(`FAILED: ${e && e.message ? e.message : e}`);
  err('void-context 초기화 중 예외가 발생했습니다 — void-context 는 선택 기능이라 설치는 계속됩니다.');
}

process.exit(0);
