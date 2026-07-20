'use strict';

// 개인비서(void assistant) 전용 "체화(embodiment)" MCP — 어시스턴트가 자신의
// 우측 다마고치 아바타(SpaceInvaderSkin, 만족/활력/기분/유대 4 vitals)를
// 읽고(READ) 자신의 표정을 직접 설정(WRITE)할 수 있게 하는, void 전용 MCP.
//
// lib/voidContextMcp.js / lib/mcp-hub.js 와 같은 dual-role 패턴:
//   1. require 만으로는 부수효과 없는 순수 헬퍼(getAvatarState/setExpression)만
//      노출한다 — lib/storage.js(JSON 파일 I/O)와 lib/pet(순수 로직)만 건드리고
//      MCP SDK 는 건드리지 않으므로 항상 안전하게 require 할 수 있다(단위 테스트용).
//   2. 직접 실행되면(require.main === module) stdio MCP 서버를 띄운다 — 이때만
//      @modelcontextprotocol/sdk 를 lazy require 한다.
//
// 이 서버가 어느 프로필의 아바타를 다루는지는 도구 인자가 아니라
// process.env.VOID_ASSISTANT_NAME 으로 결정된다(lib/assistant.js 의
// startAssistantSession 이 이 MCP 자식 프로세스에 주입) — 도구 스키마를
// 최소로 유지하기 위함(에이전트가 매번 자기 프로필명을 몰라도 됨).

const storage = require('./storage');
const petLib = require('./pet');

const DEFAULT_SKIN_ID = 'space-invader';
// 에이전트가 set_expression 으로 지정한 표정이 우선 적용되는 시간 — 그 이후엔
// lib/pet/index.js 의 기존 mechanical 분기(vitals/moodState)로 자연히 되돌아간다.
const EXPRESSION_TTL_MS = 5 * 60 * 1000; // 5분

function requireProfileName(profileName) {
  if (!profileName) {
    throw new Error('VOID_ASSISTANT_NAME 이 설정되지 않았습니다 — 어느 프로필의 아바타인지 알 수 없습니다.');
  }
}

function loadProfile(profileName) {
  requireProfileName(profileName);
  const profile = storage.getAssistant(profileName);
  if (!profile) {
    throw new Error(`'${profileName}' 어시스턴트 프로필을 찾을 수 없습니다.`);
  }
  return profile;
}

// launcher.js showAssistantChat 이 채팅 진입 시 하는 것과 동일한 lazy backfill —
// MCP 가 채팅보다 먼저(또는 채팅과 무관하게) 호출될 수 있으므로 이 파일 안에서도
// 독립적으로 같은 기본값을 보장한다.
function ensurePet(profile) {
  if (!profile.pet) profile.pet = { skinId: DEFAULT_SKIN_ID, vitals: petLib.defaultVitals() };
  if (!profile.pet.skinId) profile.pet.skinId = DEFAULT_SKIN_ID;
  return profile.pet;
}

// READ: 현재 아바타 상태(스킨 + decay 반영된 vitals + 파생 표정)를 반환한다.
// 화면(launcher.js)의 mood(8-mood 이벤트 상태)는 이 MCP 호출 시점에 알 수 없으므로
// moodState 없이(=idle 취급) 호출해, 에이전트가 직접 설정한 agentEmotion 이 있으면
// 그것을, 없으면 vitals 임계값 기반 표정을 돌려준다.
function getAvatarState(profileName, now) {
  const profile = loadProfile(profileName);
  const pet = ensurePet(profile);
  const vitals = petLib.applyDecay(pet.vitals, now);
  const emotion = petLib.deriveEmotion({ vitals, agentEmotion: pet.agentEmotion, now });
  return {
    skinId: pet.skinId,
    vitals,
    emotion,
    agentEmotion: pet.agentEmotion || null,
  };
}

// WRITE: emotion 을 검증한 뒤 profile.pet.agentEmotion 에 TTL과 함께 저장한다.
// 저장 시점까지의 decay 도 함께 반영해 vitals 를 갱신한다(다음 조회 시 정확한
// 값이 나오도록) — emotion 자체는 vitals 와 무관하게 강제 설정되는 오버레이다.
function setExpression(profileName, emotion, now) {
  if (!petLib.EMOTIONS.includes(emotion)) {
    throw new Error(`유효하지 않은 감정입니다: '${emotion}'. 사용 가능: ${petLib.EMOTIONS.join(', ')}`);
  }
  const profile = loadProfile(profileName);
  const pet = ensurePet(profile);
  const nowTs = typeof now === 'number' ? now : Date.now();
  pet.vitals = petLib.applyDecay(pet.vitals, nowTs);
  pet.agentEmotion = { emotion, expiresAt: nowTs + EXPRESSION_TTL_MS };
  storage.saveAssistant(profile);
  return {
    skinId: pet.skinId,
    vitals: pet.vitals,
    emotion: petLib.deriveEmotion({ vitals: pet.vitals, agentEmotion: pet.agentEmotion, now: nowTs }),
    agentEmotion: pet.agentEmotion,
  };
}

module.exports = {
  getAvatarState,
  setExpression,
  DEFAULT_SKIN_ID,
  EXPRESSION_TTL_MS,
};

if (require.main === module) {
  async function main() {
    let McpServer, StdioServerTransport, z;
    try {
      ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
      ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
      z = require('zod');
    } catch (e) {
      console.error(`[assistantEmbodimentMcp] MCP SDK 를 불러올 수 없습니다: ${e.message}`);
      process.exit(1);
    }

    const profileName = process.env.VOID_ASSISTANT_NAME || null;
    const server = new McpServer({ name: 'embodiment', version: '1.0.0' });

    const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    const err = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

    server.registerTool('get_avatar_state', {
      description:
        '당신(에이전트)이 사용자 화면 우측에 갖고 있는 다마고치 스타일 아바타(SpaceInvaderSkin)의 ' +
        '현재 상태를 읽는다. 만족(satiety)/활력(energy)/기분(mood)/유대(bond) 4개 vitals(0-100, 시간이 ' +
        '지나면 자연히 줄어듦)와 그로부터 파생되는 현재 표정(emotion)을 반환한다. 당신에게는 실제로 ' +
        '얼굴이 있다 — 이 도구로 그 상태를 확인할 수 있다.',
      inputSchema: {},
    }, async () => {
      try { return ok(getAvatarState(profileName)); } catch (e) { return err(e.message); }
    });

    server.registerTool('set_expression', {
      description:
        '자신의 아바타 표정을 직접 설정한다(수 분간 우선 적용된 뒤 자연스러운 상태로 되돌아감). ' +
        `사용 가능한 감정: ${petLib.EMOTIONS.join(', ')}. 지금 응답/기분에 어울리는 표정으로 ` +
        '아바타를 갱신하고 싶을 때 사용한다.',
      inputSchema: { emotion: z.enum(petLib.EMOTIONS) },
    }, async ({ emotion }) => {
      try { return ok(setExpression(profileName, emotion)); } catch (e) { return err(e.message); }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  main().catch(e => {
    console.error(`[assistantEmbodimentMcp] FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}
