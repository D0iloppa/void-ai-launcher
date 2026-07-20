'use strict';

// lib/assistantEmbodimentMcp.js 의 require-safe 순수 헬퍼(getAvatarState/
// setExpression) 단위 테스트 — 실제 stdio MCP 핸드셰이크(@modelcontextprotocol/sdk
// 로 연결하는 부분)는 여기서 검증하지 않는다(그건 require.main===module 블록
// 안에서만 실행되고, 이 파일은 그 진입점을 절대 실행하지 않는다). 검증 대상:
// 프로필 부재/미지정 에러, decay 반영된 vitals 조회, agentEmotion 검증 + 저장,
// deriveEmotion 과의 통합(설정한 표정이 실제로 emotion 필드에 반영되는지).
//
// storage.js는 XDG_CONFIG_HOME(설정돼 있으면)을 storageDir()에서 매 호출 시
// 다시 읽으므로, 이 테스트는 실제 사용자 설정을 절대 건드리지 않도록 임시
// 디렉토리로 그때그때 오버라이드한다(finally에서 원복 + 정리).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const embodiment = require('../lib/assistantEmbodimentMcp');
const storage = require('../lib/storage');
const petLib = require('../lib/pet');

function withTempConfigHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-embodiment-test-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getAvatarState throws when no profile name is given', () => {
  withTempConfigHome(() => {
    assert.throws(() => embodiment.getAvatarState(null), /VOID_ASSISTANT_NAME/);
  });
});

test('getAvatarState throws when the profile does not exist', () => {
  withTempConfigHome(() => {
    assert.throws(() => embodiment.getAvatarState('nonexistent-profile'), /찾을 수 없습니다/);
  });
});

test('getAvatarState backfills a missing pet block and applies decay to vitals', () => {
  withTempConfigHome(() => {
    const now = 1_000_000;
    storage.saveAssistant({ name: 'agent1', toolCommand: 'claude', configDir: '/tmp/x', created_at: 'x', isOnboard: true });
    const state = embodiment.getAvatarState('agent1', now);
    assert.equal(state.skinId, embodiment.DEFAULT_SKIN_ID);
    assert.equal(state.vitals.updated_at, now);
    assert.equal(state.agentEmotion, null);
    assert.ok(petLib.EMOTIONS.includes(state.emotion));
  });
});

test('getAvatarState decays vitals relative to the stored updated_at', () => {
  withTempConfigHome(() => {
    const start = 0;
    const HOUR = 1000 * 60 * 60;
    storage.saveAssistant({
      name: 'agent2', toolCommand: 'claude', configDir: '/tmp/x', created_at: 'x', isOnboard: true,
      pet: { skinId: 'space-invader', vitals: { satiety: 80, energy: 80, mood: 70, bond: 40, updated_at: start } },
    });
    const state = embodiment.getAvatarState('agent2', HOUR);
    assert.equal(state.vitals.satiety, 80 - petLib.DECAY_PER_HOUR.satiety);
    assert.equal(state.vitals.updated_at, HOUR);
  });
});

test('setExpression rejects an unknown emotion and does not persist anything', () => {
  withTempConfigHome(() => {
    storage.saveAssistant({ name: 'agent3', toolCommand: 'claude', configDir: '/tmp/x', created_at: 'x', isOnboard: true });
    assert.throws(() => embodiment.setExpression('agent3', 'not-a-real-emotion'), /유효하지 않은 감정/);
    const profile = storage.getAssistant('agent3');
    assert.equal(profile.pet, undefined);
  });
});

test('setExpression validates against the full EMOTIONS vocabulary, persists agentEmotion with a TTL, and getAvatarState reflects it', () => {
  withTempConfigHome(() => {
    const now = 5_000_000;
    storage.saveAssistant({ name: 'agent4', toolCommand: 'claude', configDir: '/tmp/x', created_at: 'x', isOnboard: true });

    const result = embodiment.setExpression('agent4', 'love', now);
    assert.equal(result.emotion, 'love');
    assert.equal(result.agentEmotion.emotion, 'love');
    assert.equal(result.agentEmotion.expiresAt, now + embodiment.EXPRESSION_TTL_MS);

    const persisted = storage.getAssistant('agent4');
    assert.equal(persisted.pet.agentEmotion.emotion, 'love');

    // 만료 전에는 emotion 이 그 값을 그대로 우선 반영해야 한다.
    const stillFresh = embodiment.getAvatarState('agent4', now + 1000);
    assert.equal(stillFresh.emotion, 'love');

    // TTL 만료 이후에는 mechanical 기본 판단(vitals/moodState)으로 되돌아간다.
    const afterExpiry = embodiment.getAvatarState('agent4', now + embodiment.EXPRESSION_TTL_MS + 1);
    assert.notEqual(afterExpiry.emotion, 'love');
  });
});

test('setExpression throws when no profile name is given', () => {
  withTempConfigHome(() => {
    assert.throws(() => embodiment.setExpression(null, 'happy'), /VOID_ASSISTANT_NAME/);
  });
});
