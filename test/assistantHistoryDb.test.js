'use strict';

// lib/assistantHistoryDb.js 테스트 — 개인비서 채팅 컴포저의 프로필별 제출
// 히스토리 링(dJinn 백엔드). applyPush 는 dJinn 없이도 검증 가능한 순수 로직
// (cap/order/dedup)이고, getHistory/pushHistory 는 storage.js 의
// XDG_CONFIG_HOME override 를 이용해 실제 임시 dJinn DB에 왕복시켜 검증한다
// (test/void-context.test.js 의 "실 dJinn DB로 스모크 테스트" 관례를 따르되,
// 이 모듈은 storageDir() 을 쓰므로 하드코딩된 repo-root 경로 대신 env override
// 로 격리 — void-context.js 보다 테스트하기 쉬운 구조).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'void-assistant-history-test-'));
process.env.XDG_CONFIG_HOME = tmpRoot;

const historyDb = require('../lib/assistantHistoryDb');

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── applyPush: pure ring logic, no DB involved ──────────────────────────

test('applyPush: appends as the newest entry, oldest-first order preserved', () => {
  let entries = [];
  entries = historyDb.applyPush(entries, 'first');
  entries = historyDb.applyPush(entries, 'second');
  assert.deepEqual(entries.map(e => e.text), ['first', 'second']);
});

test('applyPush: caps at maxEntries, dropping the OLDEST when full', () => {
  let entries = [];
  for (let i = 1; i <= 12; i++) entries = historyDb.applyPush(entries, 'msg' + i, 10);
  assert.equal(entries.length, 10);
  assert.deepEqual(entries.map(e => e.text), Array.from({ length: 10 }, (_, i) => 'msg' + (i + 3)));
});

test('applyPush: skips an exact duplicate of the immediately-previous entry', () => {
  let entries = historyDb.applyPush([], 'same');
  const next = historyDb.applyPush(entries, 'same');
  assert.equal(next, entries); // same array reference — no-op detected
  assert.equal(next.length, 1);
});

test('applyPush: a duplicate that is NOT immediately previous is pushed again (not globally deduped)', () => {
  let entries = historyDb.applyPush([], 'a');
  entries = historyDb.applyPush(entries, 'b');
  entries = historyDb.applyPush(entries, 'a');
  assert.deepEqual(entries.map(e => e.text), ['a', 'b', 'a']);
});

test('applyPush: blank/whitespace-only text is a no-op', () => {
  const entries = historyDb.applyPush([], '   ');
  assert.deepEqual(entries, []);
});

// ── getHistory/pushHistory: real dJinn round-trip via a temp DB ─────────

test('pushHistory/getHistory: round-trips through the real dJinn DB, oldest-first, capped at MAX_ENTRIES', () => {
  const profile = 'test-profile-' + process.pid;
  for (let i = 1; i <= 11; i++) historyDb.pushHistory(profile, 'entry' + i);
  const history = historyDb.getHistory(profile);
  assert.equal(history.length, historyDb.MAX_ENTRIES);
  assert.deepEqual(history, Array.from({ length: 10 }, (_, i) => 'entry' + (i + 2)));
});

test('pushHistory/getHistory: isolated per profile — one profile\'s history never leaks into another\'s', () => {
  const a = 'profile-a-' + process.pid;
  const b = 'profile-b-' + process.pid;
  historyDb.pushHistory(a, 'alpha-1');
  historyDb.pushHistory(a, 'alpha-2');
  historyDb.pushHistory(b, 'beta-1');
  assert.deepEqual(historyDb.getHistory(a), ['alpha-1', 'alpha-2']);
  assert.deepEqual(historyDb.getHistory(b), ['beta-1']);
});

test('getHistory: unknown profile returns an empty array', () => {
  assert.deepEqual(historyDb.getHistory('never-seen-' + process.pid), []);
});
