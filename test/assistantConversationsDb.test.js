'use strict';

// lib/assistantConversationsDb.js 테스트 — 개인비서 "이전 대화" 목록(프로필별
// 최근 최대 50개, sessionId로 upsert)의 dJinn 백엔드. applyUpsert 는 dJinn
// 없이도 검증 가능한 순수 로직(insert/update-by-sessionId/cap/FIFO)이고,
// getConversations/upsertConversation 은 test/assistantHistoryDb.test.js 와
// 같은 관례(storage.js 의 XDG_CONFIG_HOME override)로 실제 임시 dJinn DB에
// 왕복시켜 검증한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'void-assistant-conversations-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const convDb = require('../lib/assistantConversationsDb');

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── applyUpsert: pure logic, no DB involved ─────────────────────────────

test('applyUpsert: inserts a brand-new sessionId as a new entry', () => {
  const list = convDb.applyUpsert([], { sessionId: 's1', title: 'hi', startedAt: 1, lastAt: 1 });
  assert.deepEqual(list, [{ sessionId: 's1', title: 'hi', startedAt: 1, lastAt: 1 }]);
});

test('applyUpsert: updates title/lastAt of an existing sessionId in place, preserving startedAt', () => {
  let list = convDb.applyUpsert([], { sessionId: 's1', title: 'first title', startedAt: 100, lastAt: 100 });
  list = convDb.applyUpsert(list, { sessionId: 's1', title: 'renamed', lastAt: 200 });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { sessionId: 's1', title: 'renamed', startedAt: 100, lastAt: 200 });
});

test('applyUpsert: lastAt-only update (no title given) keeps the existing title', () => {
  let list = convDb.applyUpsert([], { sessionId: 's1', title: 'keep me', startedAt: 100, lastAt: 100 });
  list = convDb.applyUpsert(list, { sessionId: 's1', lastAt: 999 });
  assert.equal(list[0].title, 'keep me');
  assert.equal(list[0].lastAt, 999);
});

test('applyUpsert: distinct sessionIds are appended as separate entries (dedupe only by sessionId)', () => {
  let list = convDb.applyUpsert([], { sessionId: 's1', title: 'a', startedAt: 1, lastAt: 1 });
  list = convDb.applyUpsert(list, { sessionId: 's2', title: 'b', startedAt: 2, lastAt: 2 });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.sessionId), ['s1', 's2']);
});

test('applyUpsert: caps at maxEntries, dropping the OLDEST (FIFO) when full', () => {
  let list = [];
  for (let i = 1; i <= 12; i++) {
    list = convDb.applyUpsert(list, { sessionId: 's' + i, title: 't' + i, startedAt: i, lastAt: i }, 10);
  }
  assert.equal(list.length, 10);
  assert.deepEqual(list.map(e => e.sessionId), Array.from({ length: 10 }, (_, i) => 's' + (i + 3)));
});

test('applyUpsert: an entry without sessionId is a no-op', () => {
  const list = convDb.applyUpsert([{ sessionId: 's1', title: 'a', startedAt: 1, lastAt: 1 }], { title: 'no id' });
  assert.equal(list.length, 1);
});

// ── getConversations/upsertConversation: real dJinn round-trip ──────────

test('upsertConversation/getConversations: round-trips through the real dJinn DB, sorted lastAt desc', () => {
  const profile = 'conv-profile-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'a', title: 'Alpha', startedAt: 10, lastAt: 10 });
  convDb.upsertConversation(profile, { sessionId: 'b', title: 'Beta', startedAt: 20, lastAt: 30 });
  convDb.upsertConversation(profile, { sessionId: 'c', title: 'Gamma', startedAt: 5, lastAt: 5 });

  const list = convDb.getConversations(profile);
  assert.deepEqual(list.map(e => e.sessionId), ['b', 'a', 'c']); // lastAt desc: 30, 10, 5
});

test('upsertConversation: re-upserting the same sessionId updates it rather than duplicating', () => {
  const profile = 'conv-profile-update-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'x', title: 'original', startedAt: 1, lastAt: 1 });
  convDb.upsertConversation(profile, { sessionId: 'x', title: 'updated', lastAt: 2 });

  const list = convDb.getConversations(profile);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'updated');
  assert.equal(list[0].startedAt, 1);
});

test('getConversations/upsertConversation: isolated per profile', () => {
  const a = 'conv-profile-a-' + process.pid;
  const b = 'conv-profile-b-' + process.pid;
  convDb.upsertConversation(a, { sessionId: 's1', title: 'A1', startedAt: 1, lastAt: 1 });
  convDb.upsertConversation(b, { sessionId: 's2', title: 'B1', startedAt: 1, lastAt: 1 });
  assert.deepEqual(convDb.getConversations(a).map(e => e.sessionId), ['s1']);
  assert.deepEqual(convDb.getConversations(b).map(e => e.sessionId), ['s2']);
});

test('getConversations: unknown profile returns an empty array', () => {
  assert.deepEqual(convDb.getConversations('never-seen-conv-' + process.pid), []);
});

test('renameConversation: updates only the title, preserving startedAt/lastAt', () => {
  const profile = 'conv-profile-rename-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'r1', title: 'original', startedAt: 1, lastAt: 2 });
  convDb.renameConversation(profile, 'r1', 'renamed');

  const list = convDb.getConversations(profile);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'renamed');
  assert.equal(list[0].startedAt, 1);
  assert.equal(list[0].lastAt, 2);
});

test('renameConversation: unknown sessionId is treated like upsertConversation (creates a new entry, applyUpsert semantics)', () => {
  const profile = 'conv-profile-rename-new-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'r1', title: 'original', startedAt: 1, lastAt: 1 });
  convDb.renameConversation(profile, 'never-seen', 'renamed');

  const list = convDb.getConversations(profile);
  assert.deepEqual(list.map(e => e.sessionId).sort(), ['never-seen', 'r1']);
});

// ── applyDelete: pure logic, no DB involved ─────────────────────────────

test('applyDelete: removes the matching sessionId', () => {
  const list = [
    { sessionId: 's1', title: 'a', startedAt: 1, lastAt: 1 },
    { sessionId: 's2', title: 'b', startedAt: 2, lastAt: 2 },
  ];
  const next = convDb.applyDelete(list, 's1');
  assert.deepEqual(next.map(e => e.sessionId), ['s2']);
});

test('applyDelete: sessionId not present is a no-op (same entries, new array)', () => {
  const list = [{ sessionId: 's1', title: 'a', startedAt: 1, lastAt: 1 }];
  const next = convDb.applyDelete(list, 'does-not-exist');
  assert.deepEqual(next, list);
  assert.notEqual(next, list); // new array instance, not the same reference
});

test('applyDelete: missing sessionId argument is a no-op', () => {
  const list = [{ sessionId: 's1', title: 'a', startedAt: 1, lastAt: 1 }];
  assert.deepEqual(convDb.applyDelete(list, undefined), list);
});

test('applyDelete: empty/non-array list returns an empty array', () => {
  assert.deepEqual(convDb.applyDelete(null, 's1'), []);
  assert.deepEqual(convDb.applyDelete(undefined, 's1'), []);
});

// ── deleteConversation: real dJinn round-trip ───────────────────────────

test('deleteConversation: removes the entry from the persisted list', () => {
  const profile = 'conv-profile-delete-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'd1', title: 'keep', startedAt: 1, lastAt: 1 });
  convDb.upsertConversation(profile, { sessionId: 'd2', title: 'remove me', startedAt: 2, lastAt: 2 });

  convDb.deleteConversation(profile, 'd2');

  const list = convDb.getConversations(profile);
  assert.deepEqual(list.map(e => e.sessionId), ['d1']);
});

test('deleteConversation: no-op when sessionId is absent from the list', () => {
  const profile = 'conv-profile-delete-noop-' + process.pid;
  convDb.upsertConversation(profile, { sessionId: 'e1', title: 'a', startedAt: 1, lastAt: 1 });

  convDb.deleteConversation(profile, 'never-existed');

  const list = convDb.getConversations(profile);
  assert.deepEqual(list.map(e => e.sessionId), ['e1']);
});

test('deleteConversation: missing profileName/sessionId does not throw', () => {
  assert.doesNotThrow(() => convDb.deleteConversation(null, 'x'));
  assert.doesNotThrow(() => convDb.deleteConversation('some-profile', null));
});
