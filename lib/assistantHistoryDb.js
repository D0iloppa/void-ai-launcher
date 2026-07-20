'use strict';

// 개인비서 채팅 컴포저(lib/ui.js assistantChatView)의 제출 히스토리 링 —
// 프로필별 최근 MAX_ENTRIES개. dJinn(vendor/dJinn, @d0iloppa/djinn) 백엔드.
//
// 왜 새 전용 DB 파일인가(usageDb.js/configDb.js/voidContext.js 를 재사용하지
// 않고): configDb.js 는 부팅 필수 경로(tools/theme/token)라 무관한 도메인을
// 얹으면 그 실패 격리 경계가 흐려진다. usageDb.js 는 이미 schemaless 단일
// 컬렉션 패턴이라 구조적으로 제일 가깝지만, "사용량 캐시/레이트리밋" 이라는
// 별개 도메인 파일이라 같이 쓰면 usage-cache.djinn.db 안에서 관심사가 섞인다.
// voidContext.js 의 그래프 카탈로그(2-level 노드/엣지)는 "프로필당 캡드
// 리스트 10개" 라는 아주 단순한 요구에 비해 과한 스키마다. 그래서 usageDb.js
// 의 "schemaless 단일 컬렉션 + prefix id" 패턴을 그대로 따르되 파일만
// 분리(assistant-history.djinn.db) — configDb.js/usageDb.js 가 이미 이 방식으로
// 관심사를 파일 단위로 나누고 있는 선례를 그대로 반복한 것뿐이다.
//
// 실패 정책은 usageDb.js 와 동일: dJinn require/오픈 실패 시 조용한 no-op 으로
// degrade(읽기는 빈 배열, 쓰기는 아무 일도 안 함) — 입력창 히스토리는 편의
// 기능이라 dJinn 을 못 쓰는 상황이 채팅 자체를 막으면 안 된다.

const fs   = require('fs');
const path = require('path');
const { storageDir } = require('./storage');

const COLLECTION = 'assistant_history';
const MAX_ENTRIES = 10;

let db = null;
let initAttempted = false;

function dbPath() {
  return path.join(storageDir(), 'assistant-history.djinn.db');
}

function makeId(profileName) {
  return `profile:${encodeURIComponent(profileName)}`;
}

function getDb() {
  if (db) return db;
  if (initAttempted) return null;
  initAttempted = true;

  let DJinn;
  try {
    ({ DJinn } = require('@d0iloppa/djinn'));
  } catch {
    return null;
  }

  try {
    const file = dbPath();
    const isNew = !fs.existsSync(file);
    const instance = new DJinn(file, { cacheSize: 16 });
    try { instance.db.pragma('busy_timeout = 3000'); } catch {}
    instance.define(COLLECTION, {});
    if (isNew) {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    db = instance;
    return db;
  } catch {
    return null;
  }
}

// 순수 로직: 기존 entries 배열에 새 텍스트를 밀어넣은 다음 배열을 반환.
// - 바로 직전 항목과 완전히 같은 텍스트면 중복 추가하지 않는다(readline 관례).
// - MAX_ENTRIES 개를 넘으면 가장 오래된 것부터 버린다.
// - 반환 배열은 항상 oldest → newest 순서.
// dJinn 을 전혀 몰라도 되는 순수 함수라 DB 없이 단위 테스트 가능.
function applyPush(entries, text, maxEntries = MAX_ENTRIES) {
  const original = Array.isArray(entries) ? entries : [];
  const trimmed = typeof text === 'string' ? text : '';
  // 변경이 없는 두 경우(빈 텍스트 / 직전과 완전히 같은 텍스트) 모두 입력받은
  // 배열 참조를 "그대로" 반환한다 — 호출자(pushHistory)가 `next === entries`로
  // "실제로 밀어넣을 게 없었다"를 얕은 비교만으로 판별할 수 있게 하기 위함.
  if (!trimmed.trim()) return original;
  if (original.length && original[original.length - 1].text === trimmed) return original;
  const list = original.slice();
  list.push({ text: trimmed, ts: Date.now() });
  while (list.length > maxEntries) list.shift();
  return list;
}

// 저장된 순서 그대로(oldest → newest) 텍스트 배열만 반환 — 최대 MAX_ENTRIES개.
function getHistory(profileName) {
  const instance = getDb();
  if (!instance || !profileName) return [];
  try {
    const doc = instance.get(COLLECTION, makeId(profileName));
    const entries = doc && Array.isArray(doc.entries) ? doc.entries : [];
    return entries.map(e => (e && typeof e.text === 'string') ? e.text : '').filter(Boolean);
  } catch {
    return [];
  }
}

// 새 항목을 최신으로 추가(applyPush 규칙 적용) 후 저장.
function pushHistory(profileName, text) {
  const instance = getDb();
  if (!instance || !profileName) return;
  try {
    const id = makeId(profileName);
    const doc = instance.get(COLLECTION, id);
    const entries = doc && Array.isArray(doc.entries) ? doc.entries : [];
    const next = applyPush(entries, text);
    if (next === entries) return; // 빈 텍스트 등으로 변경 없음
    instance.put(COLLECTION, id, { profileName, entries: next });
  } catch {
    // Silent no-op — 컴포저 제출 경로를 절대 막지 않는다.
  }
}

module.exports = { getHistory, pushHistory, applyPush, MAX_ENTRIES };
