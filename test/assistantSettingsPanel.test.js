'use strict';

// lib/assistantSettingsPanel 순수 로직 단위 테스트 — 렌더링(터미널 raw-mode
// 키 루프)은 검증하지 않는다(composerModel.test.js/pet.test.js 와 같은 이유
// 로 제외: 여기선 옵션 인덱스 초기화/순환, 재시작 필요 여부 판정, thinking
// 필터 판정 같은 순수 함수만 검증).

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsPanel = require('../lib/assistantSettingsPanel');
const { ASSISTANT_MODEL_OPTIONS, ASSISTANT_EFFORT_OPTIONS } = require('../lib/assistant');

test('initOptionIndex: finds the index of a stored value', () => {
  assert.equal(settingsPanel.initOptionIndex(ASSISTANT_MODEL_OPTIONS, 'opus'), ASSISTANT_MODEL_OPTIONS.indexOf('opus'));
  assert.equal(settingsPanel.initOptionIndex(ASSISTANT_EFFORT_OPTIONS, 'high'), ASSISTANT_EFFORT_OPTIONS.indexOf('high'));
});

test('initOptionIndex: undefined/missing value falls back to the "default" index', () => {
  assert.equal(settingsPanel.initOptionIndex(ASSISTANT_MODEL_OPTIONS, undefined), ASSISTANT_MODEL_OPTIONS.indexOf('default'));
  assert.equal(settingsPanel.initOptionIndex(ASSISTANT_MODEL_OPTIONS, null), ASSISTANT_MODEL_OPTIONS.indexOf('default'));
});

test('initOptionIndex: a value no longer in the option list (legacy/corrupt) falls back to index 0', () => {
  assert.equal(settingsPanel.initOptionIndex(ASSISTANT_MODEL_OPTIONS, 'not-a-real-model'), 0);
});

test('cycleOptionIndex: steps forward/backward within bounds', () => {
  assert.equal(settingsPanel.cycleOptionIndex(ASSISTANT_MODEL_OPTIONS, 1, 1), 2);
  assert.equal(settingsPanel.cycleOptionIndex(ASSISTANT_MODEL_OPTIONS, 2, -1), 1);
});

test('cycleOptionIndex: wraps around at both ends', () => {
  const last = ASSISTANT_MODEL_OPTIONS.length - 1;
  assert.equal(settingsPanel.cycleOptionIndex(ASSISTANT_MODEL_OPTIONS, last, 1), 0);
  assert.equal(settingsPanel.cycleOptionIndex(ASSISTANT_MODEL_OPTIONS, 0, -1), last);
});

test('shouldRestartOnSettingsChange: true when model changes', () => {
  assert.equal(
    settingsPanel.shouldRestartOnSettingsChange({ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }),
    true
  );
});

test('shouldRestartOnSettingsChange: true when effort changes', () => {
  assert.equal(
    settingsPanel.shouldRestartOnSettingsChange({ model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'low' }),
    true
  );
});

test('shouldRestartOnSettingsChange: false when neither model nor effort changes', () => {
  assert.equal(
    settingsPanel.shouldRestartOnSettingsChange({ model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'high' }),
    false
  );
});

test('shouldRestartOnSettingsChange: treats missing field and "default" as equivalent (no false-positive restart)', () => {
  assert.equal(
    settingsPanel.shouldRestartOnSettingsChange({}, { model: 'default', effort: 'default' }),
    false
  );
  assert.equal(
    settingsPanel.shouldRestartOnSettingsChange({ model: undefined }, { model: 'default' }),
    false
  );
});

test('shouldShowEntry: think entries hidden when showThinking is false', () => {
  assert.equal(settingsPanel.shouldShowEntry({ who: 'think', text: 'x' }, false), false);
  assert.equal(settingsPanel.shouldShowEntry({ who: 'think', text: 'x' }, true), true);
});

test('shouldShowEntry: non-think entries always shown regardless of showThinking', () => {
  for (const who of ['user', 'assistant', 'system', 'tool']) {
    assert.equal(settingsPanel.shouldShowEntry({ who, text: 'x' }, false), true);
    assert.equal(settingsPanel.shouldShowEntry({ who, text: 'x' }, true), true);
  }
});

test('shouldShowEntry: null/undefined entry is never shown', () => {
  assert.equal(settingsPanel.shouldShowEntry(null, true), false);
  assert.equal(settingsPanel.shouldShowEntry(undefined, true), false);
});
