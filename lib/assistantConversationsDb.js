'use strict';

// 개인비서 채팅(launcher.js showAssistantChat)의 프로필별 "이전 대화" 목록 —
// claude 세션의 실제 sessionId(system:init 이벤트로만 알 수 있음, meta 핸들러
// 참고)를 title/시각과 함께 최근 최대 50개 저장한다. dJinn(vendor/dJinn,
// @d0iloppa/djinn) 백엔드.
//
// lib/assistantHistoryDb.js 와 완전히 같은 구조/실패 정책을 그대로 복제한다
// (그 파일의 헤더 주석에 있는 "왜 새 전용 DB 파일인가" 논지가 여기도 그대로
// 적용된다 — configDb.js/usageDb.js 는 무관한 도메인, voidContext.js 의
// 그래프 스키마는 "프로필당 캡드 리스트" 요구에 비해 과하다). 파일만 분리
// (assistant-conversations.djinn.db) — schemaless 단일 컬렉션 + prefix id.
//
// 실패 정책은 assistantHistoryDb.js 와 동일: dJinn require/오픈 실패 시 조용한
// no-op 으로 degrade(읽기는 빈 배열, 쓰기는 아무 일도 안 함) — "이전 대화
// 불러오기"는 편의 기능이라 dJinn 을 못 쓰는 상황이 채팅 자체를 막으면 안 된다.

const fs   = require('fs');
const path = require('path');
const { storageDir } = require('./storage');

const COLLECTION = 'assistant_conversations';
const MAX_ENTRIES = 50;

let db = null;
let initAttempted = false;

function dbPath() {
  return path.join(storageDir(), 'assistant-conversations.djinn.db');
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

// 순수 로직: 기존 conversations 배열에 새/갱신 항목을 밀어넣은 다음 배열을
// 반환한다.
// - entry.sessionId 가 이미 목록에 있으면 그 항목의 title/lastAt 만 갱신하고
//   (startedAt 은 최초 값을 보존), 위치는 그대로 둔다(순서는 항상 저장된
//   순서 그대로 — "최근 순 정렬"은 호출자인 getConversations 가 lastAt 기준
//   으로 한다).
// - 없으면 새 항목으로 끝에 추가한다.
// - maxEntries 를 넘으면 가장 오래된 것(배열 맨 앞)부터 버린다(FIFO).
// - 변경이 없으면(사실상 없음 — title/lastAt 갱신은 항상 변경으로 침) 항상
//   새 배열을 반환한다. dJinn 을 전혀 몰라도 되는 순수 함수라 DB 없이 단위
//   테스트 가능.
function applyUpsert(list, entry, cap = MAX_ENTRIES) {
  const original = Array.isArray(list) ? list : [];
  if (!entry || !entry.sessionId) return original;

  const idx = original.findIndex(e => e && e.sessionId === entry.sessionId);
  const next = original.slice();
  if (idx >= 0) {
    const existing = next[idx];
    next[idx] = {
      sessionId: entry.sessionId,
      title: entry.title != null ? entry.title : existing.title,
      startedAt: existing.startedAt, // 최초 시작 시각은 보존
      lastAt: entry.lastAt != null ? entry.lastAt : existing.lastAt,
    };
  } else {
    next.push({
      sessionId: entry.sessionId,
      title: entry.title || '새 대화',
      startedAt: entry.startedAt != null ? entry.startedAt : entry.lastAt,
      lastAt: entry.lastAt != null ? entry.lastAt : entry.startedAt,
    });
  }
  while (next.length > cap) next.shift();
  return next;
}

// 순수 로직: 기존 conversations 배열에서 sessionId가 일치하는 항목을
// 제거한 새 배열을 반환한다. 없으면(이미 지워졌거나 애초에 없던 id) 원본과
// 동일한 내용의 새 배열을 그대로 돌려준다(no-op) — applyUpsert와 같은 스타일로
// dJinn 없이 단위 테스트 가능.
function applyDelete(list, sessionId) {
  const original = Array.isArray(list) ? list : [];
  if (!sessionId) return original.slice();
  return original.filter(e => !(e && e.sessionId === sessionId));
}

// 저장된 대화 목록을 lastAt 내림차순(최근 대화 먼저)으로 반환한다 — 저장
// 순서는 applyUpsert 가 "밀어넣은 순서"(oldest→newest에 가깝지만 갱신 시
// 위치를 안 옮김)라 화면에 바로 쓰기엔 부적합하므로 여기서 정렬해 돌려준다.
function getConversations(profileName) {
  const instance = getDb();
  if (!instance || !profileName) return [];
  try {
    const doc = instance.get(COLLECTION, makeId(profileName));
    const list = doc && Array.isArray(doc.conversations) ? doc.conversations : [];
    return list.slice().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  } catch {
    return [];
  }
}

// 새/갱신 항목을 저장한다(applyUpsert 규칙 적용).
function upsertConversation(profileName, entry) {
  const instance = getDb();
  if (!instance || !profileName || !entry || !entry.sessionId) return;
  try {
    const id = makeId(profileName);
    const doc = instance.get(COLLECTION, id);
    const list = doc && Array.isArray(doc.conversations) ? doc.conversations : [];
    const next = applyUpsert(list, entry);
    instance.put(COLLECTION, id, { profileName, conversations: next });
  } catch {
    // Silent no-op — 대화 기록 저장 실패가 채팅 전송 경로를 막으면 안 된다.
  }
}

// 저장 공간 확보용 삭제 — 해당 프로필 목록에서 sessionId 항목을 제거하고
// 즉시 영속화한다(applyDelete 규칙 적용). 저장된 트랜스크립트 jsonl 자체를
// 지우는 건 이 함수의 책임이 아니다(launcher.js onLoadConversation의 삭제
// 흐름이 fs.unlink로 따로 처리) — 이 파일은 목록 메타데이터만 안다.
function deleteConversation(profileName, sessionId) {
  const instance = getDb();
  if (!instance || !profileName || !sessionId) return;
  try {
    const id = makeId(profileName);
    const doc = instance.get(COLLECTION, id);
    const list = doc && Array.isArray(doc.conversations) ? doc.conversations : [];
    const next = applyDelete(list, sessionId);
    instance.put(COLLECTION, id, { profileName, conversations: next });
  } catch {
    // Silent no-op — 삭제 실패가 채팅 화면을 막으면 안 된다(fail-open).
  }
}

module.exports = { getConversations, upsertConversation, deleteConversation, applyUpsert, applyDelete, MAX_ENTRIES };
