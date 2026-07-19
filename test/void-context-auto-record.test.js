'use strict';

// lib/voidContextAutoRecord.js 순수 로직 단위 테스트 — 실제 그래프/DB/launch 경로를 전혀
// 건드리지 않는다(require 대상이 순수 함수만 export 하는 모듈이라 mock 도 필요 없음).
// 검증 대상: provider 매핑(claude→anthropic, codex→openai, agy/미상→매핑없음),
// resumes 증가 로직, 매핑 불가 provider 에 대한 기록 스킵(computeContextUpdate → null).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapProviderFromCommand,
  nextResumes,
  computeContextUpdate,
} = require('../lib/voidContextAutoRecord');

test('mapProviderFromCommand maps claude -> anthropic, codex -> openai', () => {
  assert.equal(mapProviderFromCommand('claude'), 'anthropic');
  assert.equal(mapProviderFromCommand('codex'), 'openai');
  assert.equal(mapProviderFromCommand('CLAUDE'), 'anthropic'); // 대소문자 무관
  assert.equal(mapProviderFromCommand('Codex'), 'openai');
});

test('mapProviderFromCommand returns null for agy and unknown/empty commands', () => {
  assert.equal(mapProviderFromCommand('agy'), null);
  assert.equal(mapProviderFromCommand('gemini'), null);
  assert.equal(mapProviderFromCommand(''), null);
  assert.equal(mapProviderFromCommand(undefined), null);
  assert.equal(mapProviderFromCommand(null), null);
});

test('nextResumes starts at 1 when there is no existing context', () => {
  assert.equal(nextResumes(null), 1);
  assert.equal(nextResumes(undefined), 1);
  assert.equal(nextResumes({}), 1); // resumes 필드 없는 기존 컨텍스트도 0으로 취급
});

test('nextResumes increments the existing resumes count', () => {
  assert.equal(nextResumes({ resumes: 1 }), 2);
  assert.equal(nextResumes({ resumes: 7 }), 8);
});

test('computeContextUpdate builds a full putContext payload for a mapped provider', () => {
  const update = computeContextUpdate({
    toolCommand: 'claude',
    existingContext: null,
    sessionName: 'my-session',
    workspace: '/repo/root',
  });
  assert.deepEqual(update, {
    task_id: 'my-session',
    provider: 'anthropic',
    named_session: 'my-session',
    workspace: '/repo/root',
    resumes: 1,
  });
});

test('computeContextUpdate increments resumes on repeat launches of the same session', () => {
  const update = computeContextUpdate({
    toolCommand: 'codex',
    existingContext: { resumes: 3 },
    sessionName: 'my-codex-session',
    workspace: '/repo/root',
  });
  assert.equal(update.resumes, 4);
  assert.equal(update.provider, 'openai');
});

test('computeContextUpdate returns null (skip recording) for an unmapped provider like agy', () => {
  const update = computeContextUpdate({
    toolCommand: 'agy',
    existingContext: null,
    sessionName: 'my-agy-session',
    workspace: '/repo/root',
  });
  assert.equal(update, null);
});

test('computeContextUpdate returns null when sessionName is missing', () => {
  const update = computeContextUpdate({
    toolCommand: 'claude',
    existingContext: null,
    sessionName: '',
    workspace: '/repo/root',
  });
  assert.equal(update, null);
});
