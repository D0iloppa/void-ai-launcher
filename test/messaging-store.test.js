'use strict';

/*
 * lib/messaging/store.js 유닛 테스트 — dJinn 그래프 백엔드.
 *
 * store.js 는 lib/voidContext.js 와 동일한 패턴으로 repo-root 고정 경로의
 * void-messages.djinn.db 를 연다(오버라이드 seam 없음 — voidContext.js 도
 * 마찬가지). 실제 배포된 인스턴스의 데이터가 아니라 이 리포를 체크아웃한
 * 개발자의 로컬 파일(gitignored, 없으면 새로 생성됨)이므로, vendor/dJinn 의
 * smoke test 관례(테스트 시작 전 기존 db 삭제)를 그대로 따른다 — 실행 전/후
 * 모두 파일을 지워 흔적을 남기지 않는다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'void-messages.djinn.db');

function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch {}
  }
}

test.before(() => removeDbFiles());
test.after(() => removeDbFiles());

const store = require('../lib/messaging/store');

test('putMessage/listMessages/getMessage round-trip a seedType=msg envelope', () => {
  const targetId = `test-target-${process.pid}-a`;
  const rec = store.putMessage(targetId, {
    from: 'peer-a', fromLabel: 'Peer A', to: targetId, body: 'hello there',
  });

  assert.equal(rec.seedType, 'msg'); // 기본값
  assert.equal(rec.payload, null);
  assert.equal(rec.read, false);
  assert.equal(rec.body, 'hello there');
  assert.match(rec.handle, new RegExp(`^${targetId}::`));

  const listed = store.listMessages(targetId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].handle, rec.handle);
  assert.equal(listed[0].seedType, 'msg');

  const fetched = store.getMessage(rec.handle);
  assert.deepEqual(fetched, listed[0]);
});

test('putMessage carries seedType + payload through the round-trip (resume/resume-fork envelopes)', () => {
  const targetId = `test-target-${process.pid}-b`;
  const payload = { sessionId: 'abc-123', cwd: '/some/cwd', sourceProfile: 'alice', toolCommand: 'claude' };

  const resumeRec = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: '', seedType: 'resume', payload });
  assert.equal(resumeRec.seedType, 'resume');
  assert.deepEqual(resumeRec.payload, payload);

  const forkRec = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: '', seedType: 'resume-fork', payload });
  assert.equal(forkRec.seedType, 'resume-fork');

  const listed = store.listMessages(targetId);
  const seedTypes = listed.map(m => m.seedType).sort();
  assert.deepEqual(seedTypes, ['resume', 'resume-fork']);
});

test('legacy docs missing the seedType field default to msg on read', () => {
  const targetId = `test-target-${process.pid}-c`;
  // store.js 도입 이전(가상의) 레거시 doc 을 흉내낸다 — data 에 seedType 필드가
  // 아예 없는 상태로 그래프 계층에 직접 write.
  const g = store.getGraph();
  assert.ok(g, 'dJinn 그래프를 사용할 수 없어 테스트를 진행할 수 없습니다');
  g.graph.putDoc('void_messages', targetId, '2020-01-01T00:00:00.000Z-legacy1', {
    id: 'legacy1', from: 'x', fromLabel: 'X', to: targetId, timestamp: '2020-01-01T00:00:00.000Z',
    read: false, body: '레거시 메시지',
    // seedType 필드 자체가 없음
  }, { autoCreateNode: true });

  const listed = store.listMessages(targetId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].seedType, 'msg');
  assert.equal(listed[0].payload, null);
});

test('markMessageRead flips read flag; deleteMessage returns true only if it existed', () => {
  const targetId = `test-target-${process.pid}-d`;
  const rec = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'x' });
  assert.equal(store.getMessage(rec.handle).read, false);

  assert.equal(store.markMessageRead(rec.handle), true);
  assert.equal(store.getMessage(rec.handle).read, true);

  assert.equal(store.markMessageRead('nonexistent::handle-here'), false);

  assert.equal(store.deleteMessage(rec.handle), true);
  assert.equal(store.getMessage(rec.handle), null);
  assert.equal(store.deleteMessage(rec.handle), false); // 이미 지워짐 — 재삭제는 false
});

test('markResumeAccepted stamps accepted/acceptedBy/acceptedAt onto payload without losing pointer fields', () => {
  const targetId = `test-target-${process.pid}-e`;
  const payload = { sessionId: 'sid-1', cwd: '/cwd', sourceProfile: 'alice', toolCommand: 'claude' };
  const rec = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: '', seedType: 'resume', payload });

  assert.equal(store.markResumeAccepted(rec.handle, 'bob'), true);
  const after = store.getMessage(rec.handle);
  assert.equal(after.payload.accepted, true);
  assert.equal(after.payload.acceptedBy, 'bob');
  assert.equal(typeof after.payload.acceptedAt, 'string');
  // 원본 pointer 필드는 보존됨
  assert.equal(after.payload.sessionId, 'sid-1');
  assert.equal(after.payload.cwd, '/cwd');
  assert.equal(after.payload.sourceProfile, 'alice');
});

test('makeHandle/splitHandle round-trip, including entryIds containing single colons (ISO timestamps)', () => {
  const parsed = store.splitHandle(store.makeHandle('peer-1', '2026-07-19T04:50:49.081Z-abcd1234'));
  assert.deepEqual(parsed, { targetId: 'peer-1', entryId: '2026-07-19T04:50:49.081Z-abcd1234' });
  assert.equal(store.splitHandle('no-separator-here'), null);
});

test('putMessage defaults task_id to general and round-trips an explicit task_id', () => {
  const targetId = `test-target-${process.pid}-g`;

  const defaulted = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'no tag given' });
  assert.equal(defaulted.task_id, 'general');
  assert.equal(store.getMessage(defaulted.handle).task_id, 'general');

  const tagged = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'tagged', task_id: 'refactor-x' });
  assert.equal(tagged.task_id, 'refactor-x');
  assert.equal(store.getMessage(tagged.handle).task_id, 'refactor-x');

  const listed = store.listMessages(targetId);
  const byId = Object.fromEntries(listed.map(m => [m.handle, m]));
  assert.equal(byId[defaulted.handle].task_id, 'general');
  assert.equal(byId[tagged.handle].task_id, 'refactor-x');
});

test('legacy docs missing the task_id field default to general on read', () => {
  const targetId = `test-target-${process.pid}-h`;
  const g = store.getGraph();
  assert.ok(g, 'dJinn 그래프를 사용할 수 없어 테스트를 진행할 수 없습니다');
  g.graph.putDoc('void_messages', targetId, '2020-01-01T00:00:00.000Z-legacy2', {
    id: 'legacy2', from: 'x', fromLabel: 'X', to: targetId, timestamp: '2020-01-01T00:00:00.000Z',
    read: false, body: '레거시 메시지', seedType: 'msg',
    // task_id 필드 자체가 없음
  }, { autoCreateNode: true });

  const listed = store.listMessages(targetId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].task_id, 'general');
});

test('listMessagesByTask filters to the matching task_id only', () => {
  const targetId = `test-target-${process.pid}-i`;
  const a = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'general one' });
  const b = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'tagged one', task_id: 'proj-x' });
  const c = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'tagged two', task_id: 'proj-x' });

  const generalOnly = store.listMessagesByTask(targetId, 'general');
  assert.deepEqual(generalOnly.map(m => m.handle), [a.handle]);

  const projX = store.listMessagesByTask(targetId, 'proj-x');
  assert.deepEqual(projX.map(m => m.handle).sort(), [b.handle, c.handle].sort());
});

test('listMessages sorts newest-first regardless of graph child_key ascending order', () => {
  const targetId = `test-target-${process.pid}-f`;
  const older = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'older' });
  const newer = store.putMessage(targetId, { from: 'a', fromLabel: 'A', to: targetId, body: 'newer' });
  const listed = store.listMessages(targetId);
  assert.equal(listed[0].handle, newer.handle);
  assert.equal(listed[1].handle, older.handle);
});
