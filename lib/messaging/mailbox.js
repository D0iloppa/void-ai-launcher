'use strict';

/*
 * mailbox.js — void-to-void mail store 공개 API (Phase B: 그래프 백엔드로 이전).
 *
 * 내부 저장소가 파일 스풀(마크다운 + 프론트매터)에서 dJinn 그래프
 * (lib/messaging/store.js, void-messages.djinn.db)로 바뀌었다 — 이 파일이
 * export 하는 모든 함수명/시그니처는 그대로 유지된다(하위 호환, 기존 호출부
 * byte-unchanged). 유일하게 "의미"가 바뀐 것은 listInbox() 가 돌려주고
 * markReadOne/deleteMessages 가 받는 `file` 값이다: 더 이상 파일시스템 절대
 * 경로가 아니라 store.js 의 opaque handle(`${targetId}::${entryId}`) 문자열이다.
 * 호출부는 원래도 이 값을 "그냥 불투명한 토큰"으로만 다뤘으므로(문자열을 그대로
 * 되돌려주기만 함) 계약 자체는 깨지지 않는다 — 단, path.resolve() 등으로 실제
 * 파일시스템 경로처럼 다루는 호출부가 있다면 그건 이 변경에 맞춰 갱신되어야
 * 한다(예: lib/xtermFrame.js 의 [a] accept 플로우 — Worker 2 소관).
 *
 * registry.js(피어 프레즌스)는 파일시스템 그대로 유지 — 이 마이그레이션
 * 대상이 아니다.
 *
 * 구식 온디스크 .md 인박스: 하드 컷오버, 마이그레이션 없음(신규 WIP, 실 데이터 없음).
 */

const store = require('./store');

// 레거시 파일시스템 경로 개념 — 그래프 백엔드에는 "인박스 디렉토리"가 없으므로
// 메시지를 이 안에 쓰지는 않지만, registry.js 의 INBOX_DIR/<id> 경로 자체는
// 호출부 호환을 위해 그대로 돌려준다(존재 보장을 위해 mkdir 은 계속 수행).
function inboxDir(id) {
  const { INBOX_DIR } = require('./registry');
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(INBOX_DIR, String(id));
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return dir;
}

function preview(body, maxLen = 60) {
  const firstLine = String(body || '').split('\n').find(l => l.trim().length > 0) || '';
  const collapsed = firstLine.trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen - 1) + '…' : collapsed;
}

// seedType/payload/task_id 는 additive — 생략하면 기존과 동일하게 seedType='msg',
// payload=null, task_id='general' 인 평문 메시지가 만들어진다(기존 호출부
// byte-unchanged 동작).
function writeMessage(targetId, { from, fromLabel, to, body, seedType = 'msg', payload = null, task_id = 'general' } = {}) {
  const record = store.putMessage(targetId, { from, fromLabel, to, body, seedType, payload, task_id });
  return record.handle;
}

function sendTo(targetId, body, { registry, seedType = 'msg', payload = null, task_id = 'general' } = {}) {
  const reg = registry || require('./registry');
  const self = reg.selfIdentity();
  return writeMessage(targetId, { from: self.id, fromLabel: self.label, to: targetId, body, seedType, payload, task_id });
}

function broadcast(body, { registry, seedType = 'msg', payload = null, task_id = 'general' } = {}) {
  const reg = registry || require('./registry');
  const self = reg.selfIdentity();
  const peers = reg.listPeers({ includeSelf: false });
  let count = 0;
  for (const peer of peers) {
    try {
      writeMessage(peer.id, { from: self.id, fromLabel: self.label, to: '*', body, seedType, payload, task_id });
      count++;
    } catch {}
  }
  return count;
}

function listInbox(id) {
  let records = [];
  try { records = store.listMessages(id); } catch { return []; }
  return records.map(r => ({
    file: r.handle, // NOTE: 파일 경로 아님 — store.js opaque handle (헤더 주석 참고)
    id: r.id,
    from: r.from,
    fromLabel: r.fromLabel,
    to: r.to,
    timestamp: r.timestamp,
    read: r.read,
    seedType: r.seedType,
    payload: r.payload,
    body: r.body,
    task_id: r.task_id,
    preview: preview(r.body),
  }));
}

// 인박스에 실제로 등장한 task_id 를 중복 없이 모은다(발신 UI 의 "기존 태그
// 선택" 목록용) — 항상 'general' 을 포함해 빈 인박스에서도 최소 1개는 있게
// 한다. 정렬은 등장 순서(=listInbox 의 최신순)를 따르되 'general' 을 맨 앞에 둔다.
function listTaskIds(id) {
  const seen = new Set(['general']);
  for (const entry of listInbox(id)) seen.add(entry.task_id || 'general');
  return ['general', ...[...seen].filter(t => t !== 'general').sort()];
}

function markReadOne(file) {
  try { return store.markMessageRead(file); } catch { return false; }
}

function markRead(files) {
  let count = 0;
  for (const f of files || []) { if (markReadOne(f)) count++; }
  return count;
}

function deleteMessages(files) {
  let count = 0;
  for (const f of files || []) {
    try { if (store.deleteMessage(f)) count++; } catch {}
  }
  return count;
}

function cleanup(id) {
  const entries = listInbox(id);
  return deleteMessages(entries.map(e => e.file));
}

function unreadCount(id) {
  return listInbox(id).filter(m => !m.read).length;
}

function totalCount(id) {
  return listInbox(id).length;
}

// ── 레거시 프론트매터 parse/serialize ───────────────────────────────────
// 그래프 백엔드는 이 텍스트 포맷을 더 이상 쓰지 않지만(내부적으로 호출되지
// 않음), 하위 호환을 위해 그대로 남겨둔다 — 외부 호출부/과거 스모크 테스트가
// 참조할 수 있다.

function escapeValue(v) {
  return String(v == null ? '' : v).replace(/\r?\n/g, ' ');
}

function serialize({ id, from, fromLabel, to, timestamp, read }, body) {
  const lines = [
    '---',
    `id: ${escapeValue(id)}`,
    `from: ${escapeValue(from)}`,
    `fromLabel: ${escapeValue(fromLabel)}`,
    `to: ${escapeValue(to)}`,
    `timestamp: ${escapeValue(timestamp)}`,
    `read: ${read ? 'true' : 'false'}`,
    '---',
    body == null ? '' : String(body),
  ];
  return lines.join('\n');
}

// Fails soft: a missing/garbled header just yields default fields and the
// whole file content becomes the body.
function parse(raw) {
  const out = { id: '', from: '', fromLabel: '', to: '', timestamp: '', read: false, body: '' };
  if (typeof raw !== 'string') return out;

  if (raw.startsWith('---')) {
    const rest = raw.slice(3);
    const endIdx = rest.indexOf('\n---');
    if (endIdx !== -1) {
      const header = rest.slice(0, endIdx).replace(/^\n/, '');
      let body = rest.slice(endIdx + 4);
      if (body.startsWith('\n')) body = body.slice(1);
      for (const line of header.split('\n')) {
        const m = /^([a-zA-Z]+):\s?(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        const val = m[2];
        if (key === 'read') out.read = val.trim() === 'true';
        else if (key in out) out[key] = val;
      }
      out.body = body;
      return out;
    }
  }
  // No recognizable frontmatter — treat whole file as body.
  out.body = raw;
  return out;
}

module.exports = {
  inboxDir,
  writeMessage,
  sendTo,
  broadcast,
  listInbox,
  listTaskIds,
  markRead,
  markReadOne,
  deleteMessages,
  cleanup,
  unreadCount,
  totalCount,
  // exported for the smoke test / advanced callers
  parse,
  serialize,
};
