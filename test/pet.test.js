'use strict';

// lib/pet 순수 로직 단위 테스트 — 렌더링(터미널 출력)은 검증하지 않는다(TUI 는
// void-context-auto-record.test.js 와 같은 이유로 테스트 대상에서 제외: 여기선
// 순수 함수만 검증). 검증 대상: decay 수학, 16→6 감정 접기, vitals clamp,
// interact 회복량, deriveEmotion 의 event-state 우선순위, 영속 blob 모양,
// 스킨 레지스트리 기본값.

const test = require('node:test');
const assert = require('node:assert/strict');

const pet = require('../lib/pet');
const { SpaceInvaderSkin } = require('../lib/pet/skin-invader');

const HOUR = 1000 * 60 * 60;

test('defaultVitals returns the persisted blob shape', () => {
  const now = 1_000_000;
  const v = pet.defaultVitals(now);
  assert.deepEqual(Object.keys(v).sort(), ['bond', 'energy', 'mood', 'satiety', 'updated_at']);
  assert.equal(v.updated_at, now);
  for (const key of ['satiety', 'energy', 'mood', 'bond']) {
    assert.ok(v[key] >= 0 && v[key] <= 100);
  }
});

test('applyDecay subtracts DECAY_PER_HOUR * elapsed hours', () => {
  const start = { satiety: 80, energy: 80, mood: 70, bond: 40, updated_at: 0 };
  const oneHourLater = pet.applyDecay(start, HOUR);
  assert.equal(oneHourLater.satiety, 80 - pet.DECAY_PER_HOUR.satiety);
  assert.equal(oneHourLater.energy, 80 - pet.DECAY_PER_HOUR.energy);
  assert.equal(oneHourLater.mood, 70 - pet.DECAY_PER_HOUR.mood);
  assert.equal(oneHourLater.bond, 40 - pet.DECAY_PER_HOUR.bond);
  assert.equal(oneHourLater.updated_at, HOUR);
});

test('applyDecay is pure (does not mutate its input)', () => {
  const start = { satiety: 80, energy: 80, mood: 70, bond: 40, updated_at: 0 };
  const copy = { ...start };
  pet.applyDecay(start, HOUR);
  assert.deepEqual(start, copy);
});

test('applyDecay clamps at 0 for long elapsed time', () => {
  const start = { satiety: 10, energy: 10, mood: 10, bond: 10, updated_at: 0 };
  const farFuture = pet.applyDecay(start, 1000 * HOUR);
  assert.equal(farFuture.satiety, 0);
  assert.equal(farFuture.energy, 0);
  assert.equal(farFuture.mood, 0);
  assert.equal(farFuture.bond, 0);
});

test('applyDecay treats missing vitals as defaultVitals (fail-open)', () => {
  const result = pet.applyDecay(null, 5000);
  assert.equal(result.updated_at, 5000);
  assert.equal(result.satiety, 80); // 0시간 경과 취급(updated_at=now로 새로 시작) → decay 없음
});

test('interact applies decay then adds the interaction bump, clamped at 100', () => {
  const start = { satiety: 90, energy: 80, mood: 70, bond: 40, updated_at: 0 };
  const fed = pet.interact(start, 'feed', HOUR);
  // decay 후 satiety = 90 - 4 = 86, + feed 25 = 111 → clamp 100
  assert.equal(fed.satiety, 100);
  assert.equal(fed.updated_at, HOUR);
});

test('interact with an unknown kind only applies decay (fail-open, no throw)', () => {
  const start = { satiety: 90, energy: 80, mood: 70, bond: 40, updated_at: 0 };
  assert.doesNotThrow(() => pet.interact(start, 'nonexistent-kind', HOUR));
  const result = pet.interact(start, 'nonexistent-kind', HOUR);
  assert.equal(result.satiety, 90 - pet.DECAY_PER_HOUR.satiety);
});

test('all four interaction kinds referenced by the UI hint line are defined', () => {
  for (const kind of ['feed', 'play', 'rest', 'pet']) {
    assert.ok(pet.INTERACTIONS[kind], `missing INTERACTIONS.${kind}`);
  }
});

test('EMOTION_16_TO_6 maps the full 16-word vocabulary onto the 6 base emotions', () => {
  for (const emo of pet.EMOTIONS) {
    const mapped = pet.mapEmotion16to6(emo);
    assert.ok(pet.BASE_EMOTIONS.includes(mapped), `${emo} -> ${mapped} not a base emotion`);
  }
  // 스펙에 명시된 고정 매핑 몇 가지를 직접 확인
  assert.equal(pet.mapEmotion16to6('laughing'), 'happy');
  assert.equal(pet.mapEmotion16to6('wink'), 'happy');
  assert.equal(pet.mapEmotion16to6('love'), 'happy');
  assert.equal(pet.mapEmotion16to6('celebrate'), 'happy');
  assert.equal(pet.mapEmotion16to6('thumbsup'), 'happy');
  assert.equal(pet.mapEmotion16to6('cool'), 'happy');
  assert.equal(pet.mapEmotion16to6('confused'), 'surprised');
  assert.equal(pet.mapEmotion16to6('thinking'), 'neutral');
  assert.equal(pet.mapEmotion16to6('worried'), 'sad');
  assert.equal(pet.mapEmotion16to6('facepalm'), 'sad');
  // 6개 베이스는 항등 매핑
  for (const base of pet.BASE_EMOTIONS) {
    assert.equal(pet.mapEmotion16to6(base), base);
  }
});

test('deriveEmotion prioritizes event state over vitals thresholds', () => {
  assert.equal(pet.deriveEmotion({ moodState: 'thinking', vitals: { satiety: 5, energy: 5 } }), 'thinking');
  assert.equal(pet.deriveEmotion({ moodState: 'error', vitals: { satiety: 100, energy: 100 } }), 'angry');
  assert.equal(pet.deriveEmotion({ moodState: 'happy' }), 'happy');
});

test('deriveEmotion falls back to vitals thresholds only when idle', () => {
  assert.equal(pet.deriveEmotion({ moodState: 'idle', vitals: { satiety: 80, energy: 5 } }), 'sleepy');
  assert.equal(pet.deriveEmotion({ moodState: 'idle', vitals: { satiety: 5, energy: 80 } }), 'sad');
  assert.equal(pet.deriveEmotion({ moodState: 'idle', vitals: { satiety: 80, energy: 80 } }), 'neutral');
  assert.equal(pet.deriveEmotion({ moodState: 'idle' }), 'neutral'); // vitals 없음
});

test('deriveEmotion falls back to neutral for an unknown moodState', () => {
  assert.equal(pet.deriveEmotion({ moodState: 'nonsense' }), 'neutral');
  assert.equal(pet.deriveEmotion({}), 'neutral');
});

test('getSkin returns the registered default space-invader skin and falls back to it for unknown ids', () => {
  const skin = pet.getSkin('space-invader');
  assert.equal(skin.id, 'space-invader');
  const fallback = pet.getSkin('does-not-exist');
  assert.equal(fallback.id, 'space-invader');
});

test('listSkins exposes at least the default skin with an id/label', () => {
  const skins = pet.listSkins();
  assert.ok(skins.some(s => s.id === 'space-invader' && typeof s.label === 'string'));
});

test('SpaceInvaderSkin.drawSprite renders one line per row, no ANSI color codes, for every base emotion and both frames', () => {
  for (const emotion of pet.BASE_EMOTIONS) {
    for (const frame of [0, 1]) {
      const lines = SpaceInvaderSkin.drawSprite({ emotion, vitals: {}, frame });
      assert.ok(Array.isArray(lines) && lines.length > 0);
      for (const line of lines) {
        assert.equal(typeof line, 'string');
        assert.ok(!line.includes('\x1b'), 'sprite lines must be plain (no ANSI codes)');
      }
    }
  }
});

test('SpaceInvaderSkin.drawSprite never throws on unknown/undefined emotion or frame (render-path fail-open)', () => {
  assert.doesNotThrow(() => SpaceInvaderSkin.drawSprite({}));
  assert.doesNotThrow(() => SpaceInvaderSkin.drawSprite({ emotion: 'not-a-real-emotion', frame: 99 }));
  assert.doesNotThrow(() => SpaceInvaderSkin.drawSprite({ emotion: undefined, frame: undefined }));
});

test('SpaceInvaderSkin.drawSprite accepts 16-vocab emotions by folding them via mapEmotion', () => {
  const laughing = SpaceInvaderSkin.drawSprite({ emotion: 'laughing', frame: 0 });
  const happy = SpaceInvaderSkin.drawSprite({ emotion: 'happy', frame: 0 });
  assert.deepEqual(laughing, happy);
});

test('pet.padToGrid(drawSprite(...)) conforms to the PET_GRID contract (exact rows x cols) for every base emotion', () => {
  for (const emotion of pet.BASE_EMOTIONS) {
    const graded = pet.padToGrid(SpaceInvaderSkin.drawSprite({ emotion, frame: 0 }));
    assert.equal(graded.length, pet.PET_GRID.rows);
    for (const line of graded) assert.equal(line.length, pet.PET_GRID.cols);
  }
});

test('padToGrid pads short rows, truncates long rows, and fills/trims missing/excess row count (safety net)', () => {
  const tooFewAndRagged = pet.padToGrid(['ab', 'a very very very long line well past cols']);
  assert.equal(tooFewAndRagged.length, pet.PET_GRID.rows);
  for (const line of tooFewAndRagged) assert.equal(line.length, pet.PET_GRID.cols);
  assert.equal(pet.padToGrid(null).length, pet.PET_GRID.rows); // non-array input: fail-open, all-blank grid
});

test('SpaceInvaderSkin varies antenna/shoulder pose per emotion, not just the eyes (distinctness requirement)', () => {
  const byEmotion = {};
  for (const emo of pet.BASE_EMOTIONS) byEmotion[emo] = SpaceInvaderSkin.drawSprite({ emotion: emo, frame: 0 });
  const antennaRows = new Set(Object.values(byEmotion).map(rows => rows[0]));
  const shoulderRows = new Set(Object.values(byEmotion).map(rows => rows[4]));
  assert.ok(antennaRows.size > 1, 'antenna row (row 0) should differ across at least some emotions');
  assert.ok(shoulderRows.size > 1, 'shoulder/arm row (row 4) should differ across at least some emotions');
});

test('createPetEventSource exposes a subscribe() that returns an unsubscribe function and never calls back (phase1: not wired)', () => {
  const source = pet.createPetEventSource();
  let called = false;
  const unsubscribe = source.subscribe(() => { called = true; });
  assert.equal(typeof unsubscribe, 'function');
  assert.doesNotThrow(() => unsubscribe());
  assert.equal(called, false);
});
