'use strict';

/*
 * store.js — void-to-void 메시지 저장소, dJinn 그래프 백엔드 (Phase B).
 *
 * mailbox.js 의 파일-스풀(마크다운 + 프론트매터)을 대체하는 실제 저장소.
 * lib/voidContext.js 와 동일하게 lib/graphLayer.js 의 initVoidGraphLayer 팩토리
 * 위에 얹되, 완전히 별개의 DB 파일(void-messages.djinn.db, repo root, gitignored)
 * 과 네임스페이스(void_messages)를 쓴다 — void-context.djinn.db 와는 무관.
 * 멀티 네임스페이스-per-DB 는 검증되지 않았으므로 파일 자체를 분리한다.
 *
 * 2단 구조 (voidContext 의 task_id/entry_id 와 형태는 같지만 도메인은 다름):
 *   level-2 node  = 수신자 mailbox id (registry.js 의 selfId()/targetId)
 *   level-3 doc   = 메시지 1건. child_key(entry_id) = `${ISO타임스탬프}-${짧은 랜덤}`
 *                   로 발급해 알파벳순 정렬이 곧 시간순 정렬이 되게 한다
 *                   (listDocs 는 child_key 오름차순만 보장하므로).
 *
 * mailbox id(=node_key)는 사전 등록 없이 최초 발신 시 autoCreateNode 로 즉석
 * 생성한다(voidContext 의 putContext 처럼 미리 만들어두지 않는다) — 파일시스템
 * 시절 inboxDir() 이 mkdirSync 로 즉석 생성하던 것과 동일한 UX.
 *
 * "opaque handle" — mailbox.js 의 listInbox/markReadOne/deleteMessages 가 예전엔
 * 파일 절대경로를 주고받았다. 그래프에는 파일이 없으므로 대신
 * GraphDriver.makeDocId 와 완전히 동일한 형태인 `${targetId}::${entryId}` 를
 * handle 로 노출한다(우연한 재발명이 아니라 store 내부 doc id 를 그대로 노출하는
 * 것 — targetId/entryId 모두 GraphDriver._assertKey 가 '::' 포함을 금지하므로
 * 최초 '::' 기준 분리가 항상 안전하다). 호출부 입장에선 여전히 "불투명한 토큰".
 */

const path = require('path');
const crypto = require('crypto');
const { initVoidGraphLayer } = require('../graphLayer');

const NS = 'void_messages'; // GraphDriver.NS_RE 가 하이픈을 거부하므로 언더스코어 고정(파일명은 하이픈 허용)

function messagesDbFile() {
  return path.join(__dirname, '..', '..', 'void-messages.djinn.db');
}

const { getGraph, ensureSeeded, dbPath } = initVoidGraphLayer({
  dbFile: messagesDbFile(),
  namespace: NS,
  nodeDefs: [], // 시드할 예약 노드 없음 — mailbox id 는 최초 발신 시 즉석 생성
  seed: null,
});

function _requireGraph(action) {
  const g = getGraph();
  if (!g) {
    throw new Error(`messaging/store.${action}: dJinn 을 사용할 수 없어 메시지 저장소에 접근할 수 없습니다`);
  }
  return g;
}

function shortRandom() {
  return crypto.randomBytes(4).toString('hex');
}

// 메시지 고유 id(구 mailbox.js 의 genMsgId 와 동일 포맷) — child_key(entry_id) 와는
// 별개다: entry_id 는 정렬용, id 는 사람이 참조하는 메시지 식별자.
function genMsgId() {
  return crypto.randomBytes(4).toString('hex');
}

function makeHandle(targetId, entryId) {
  return `${targetId}::${entryId}`;
}

function splitHandle(handle) {
  const idx = String(handle == null ? '' : handle).indexOf('::');
  if (idx === -1) return null;
  return { targetId: handle.slice(0, idx), entryId: handle.slice(idx + 2) };
}

function _toRecord(targetId, doc) {
  if (!doc) return null;
  const data = doc.data || {};
  return {
    handle: makeHandle(targetId, doc.child_key),
    id: data.id,
    from: data.from,
    fromLabel: data.fromLabel,
    to: data.to,
    timestamp: data.timestamp,
    read: !!data.read,
    seedType: data.seedType || 'msg', // 레거시/미지정 기본값 — 평문 메시지로 간주
    payload: data.payload != null ? data.payload : null,
    body: data.body,
    task_id: data.task_id || 'general', // 레거시/미지정 기본값 — 태그/그룹핑 전용 필드
  };
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────

function putMessage(targetId, { from, fromLabel, to, body, seedType = 'msg', payload = null, task_id = 'general' } = {}) {
  ensureSeeded();
  if (!targetId) throw new Error('messaging/store.putMessage: targetId 가 필요합니다');
  const g = _requireGraph('putMessage');
  const id = genMsgId();
  const timestamp = new Date().toISOString();
  const entryId = `${timestamp}-${shortRandom()}`;
  const data = {
    id, from, fromLabel, to, timestamp,
    read: false,
    seedType,
    payload: payload != null ? payload : null,
    body: body == null ? '' : String(body),
    task_id: task_id || 'general',
  };
  g.graph.putDoc(NS, String(targetId), entryId, data, { autoCreateNode: true });
  return _toRecord(targetId, { child_key: entryId, data });
}

// ── 읽기 ──────────────────────────────────────────────────────────────────

function getMessage(handle) {
  ensureSeeded();
  const g = _requireGraph('getMessage');
  const parsed = splitHandle(handle);
  if (!parsed) return null;
  const doc = g.graph.getDoc(NS, parsed.targetId, parsed.entryId);
  return _toRecord(parsed.targetId, doc);
}

// 수신자(targetId)의 전체 메시지 — 최신순(구 mailbox.js listInbox 와 동일한 정렬
// 계약). listDocs 는 child_key(entry_id, 곧 timestamp) 오름차순만 보장하므로
// 여기서 다시 timestamp 기준 내림차순 정렬한다.
function listMessages(targetId) {
  ensureSeeded();
  const g = getGraph();
  if (!g) return []; // fail-soft — 구 listInbox()의 "인박스 없음 → []" 계약 유지
  const docs = g.graph.listDocs(NS, String(targetId), { keysOnly: false });
  const out = docs.map(d => _toRecord(targetId, d));
  out.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return out;
}

// targetId 의 메시지 중 task_id 가 일치하는 것만 — listMessages() 와 동일한
// 최신순 정렬 계약을 유지한 채 단순 필터링만 얹는다(그룹핑 UI 편의용, 선택적).
function listMessagesByTask(targetId, task_id = 'general') {
  return listMessages(targetId).filter(m => (m.task_id || 'general') === (task_id || 'general'));
}

// ── 상태 변경 ─────────────────────────────────────────────────────────────

function markMessageRead(handle) {
  ensureSeeded();
  const g = _requireGraph('markMessageRead');
  const parsed = splitHandle(handle);
  if (!parsed) return false;
  const doc = g.graph.getDoc(NS, parsed.targetId, parsed.entryId);
  if (!doc) return false;
  g.graph.putDoc(NS, parsed.targetId, parsed.entryId, { ...doc.data, read: true });
  return true;
}

// 존재하던 메시지를 지웠을 때만 true(구 unlink 성공 시에만 count 하던 것과 동치).
function deleteMessage(handle) {
  ensureSeeded();
  const g = getGraph();
  if (!g) return false;
  const parsed = splitHandle(handle);
  if (!parsed) return false;
  const existed = !!g.graph.getDoc(NS, parsed.targetId, parsed.entryId);
  g.graph.delDoc(NS, parsed.targetId, parsed.entryId);
  return existed;
}

// resume 핸드오프 ack — B(수신측)가 resume seedType 메시지를 수락했을 때 그
// 사실을 payload 에 남긴다. 그래프가 A/B 모두에게 공유되므로(같은 로컬 설치를
// 가리키는 void-messages.djinn.db) A 는 이 필드를 폴링해 자신의 source 세션을
// lock 할 수 있다 — 실제 라우팅/락 적용은 lib/messaging/resumeFork.js 담당.
function markResumeAccepted(messageId, acceptedBy) {
  ensureSeeded();
  const g = _requireGraph('markResumeAccepted');
  const parsed = splitHandle(messageId);
  if (!parsed) return false;
  const doc = g.graph.getDoc(NS, parsed.targetId, parsed.entryId);
  if (!doc) return false;
  const payload = { ...(doc.data.payload || {}), accepted: true, acceptedBy: acceptedBy || null, acceptedAt: new Date().toISOString() };
  g.graph.putDoc(NS, parsed.targetId, parsed.entryId, { ...doc.data, payload });
  return true;
}

module.exports = {
  dbPath,
  getGraph,
  putMessage,
  getMessage,
  listMessages,
  listMessagesByTask,
  markMessageRead,
  deleteMessage,
  markResumeAccepted,
  makeHandle,
  splitHandle,
};
