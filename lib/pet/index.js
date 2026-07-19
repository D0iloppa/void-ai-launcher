'use strict';

// 개인비서 챗뷰(assistantChatView)에 렌더되는 다마고치 스타일 펫의 렌더러-비종속
// 인터페이스. 이 파일과 skin-invader.js 는 순수 로직/데이터만 다룬다 —
// require('../ui') 금지, 터미널 이스케이프 코드 생성 금지. 색상은 항상
// 호출자(lib/ui.js)가 입힌다. 이래야 스킨을 자유롭게 교체할 수 있고(PetSkin
// 인터페이스), 순수 함수 위주라 단위 테스트가 쉽다(test/pet.test.js).

const { PET_GRID, padToGrid } = require('./grid');

// ── 감정 어휘 ────────────────────────────────────────────────
// 공통 인터페이스가 소유하는 16개 감정 어휘. 어시스턴트 런타임에는 감정 신호가
// 없으므로(phase1 확인됨) deriveEmotion() 은 기존 8-mood 이벤트 상태 + vitals
// 임계값만으로 이 중 하나를 골라낸다 — 텍스트 감성분석 같은 건 하지 않는다.
const EMOTIONS = [
  'neutral', 'happy', 'laughing', 'wink', 'sad', 'angry', 'surprised',
  'confused', 'thinking', 'love', 'cool', 'thumbsup', 'sleepy', 'worried',
  'facepalm', 'celebrate',
];

// 스킨이 실제로 그릴 줄 아는 6개 베이스 감정. 스킨은 이보다 더 많은 표정을
// 그릴 필요가 없다 — 16개 전부를 이 6개로 접어서(EMOTION_16_TO_6) 넘긴다.
const BASE_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy'];

// 16 감정 → 6 베이스 감정. 6개 베이스는 자기 자신으로 매핑(항등).
const EMOTION_16_TO_6 = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
  surprised: 'surprised', sleepy: 'sleepy',
  laughing: 'happy', wink: 'happy', love: 'happy', cool: 'happy',
  thumbsup: 'happy', celebrate: 'happy',
  confused: 'surprised',
  thinking: 'neutral',
  worried: 'sad', facepalm: 'sad',
};

function mapEmotion16to6(emotion) {
  return EMOTION_16_TO_6[emotion] || 'neutral';
}

// 기존 assistantChatView 의 8-mood(setMood 로 구동) → 16 어휘 어댑터.
// focused 는 16 어휘에 "집중" 개념이 따로 없어 가장 가까운 'cool' 로,
// alert 는 눈이 커지는 뉘앙스라 'surprised' 로 사상한다.
const MOOD8_TO_EMOTION16 = {
  idle: 'neutral',
  thinking: 'thinking',
  happy: 'happy',
  error: 'angry',
  confused: 'confused',
  focused: 'cool',
  sleepy: 'sleepy',
  alert: 'surprised',
};

// ── vitals 모델 ──────────────────────────────────────────────
// 시간당 감소량 — 다마고치 감각으로 satiety(포만)/energy(활력) 는 빨리 줄고
// (밥/잠이 자주 필요), mood(기분) 는 완만히, bond(유대) 는 상호작용 누적을
// 존중해 아주 천천히 줄어든다.
const DECAY_PER_HOUR = {
  satiety: 4,
  energy: 3,
  mood: 1.5,
  bond: 0.5,
};

// 상호작용 종류별 vitals 회복량. key 는 launcher.js 의 onPetInteract(kind) 가 넘기는
// kind 문자열과 1:1 대응한다.
const INTERACTIONS = {
  feed: { satiety: 25 },
  play: { mood: 20, bond: 5 },
  rest: { energy: 30 },
  pet: { bond: 20, mood: 10 },
};

function clampVital(n) {
  return Math.max(0, Math.min(100, n));
}

// now/updated_at 은 항상 `typeof === 'number'` 로 판별한다 — `now || Date.now()`
// 식으로 쓰면 (테스트에서 흔한) epoch 0 이 falsy 라 실제로 넘긴 0 이 조용히
// Date.now() 로 뒤바뀌는 버그가 생긴다.
function resolveNow(now) {
  return typeof now === 'number' ? now : Date.now();
}

// 신규/레거시 프로필 백필용 기본 vitals. bond(유대)만 낮게 시작해 상호작용으로
// 쌓아가는 맛을 준다.
function defaultVitals(now) {
  return { satiety: 80, energy: 80, mood: 70, bond: 40, updated_at: resolveNow(now) };
}

// updated_at 이후 경과 시간만큼 각 vital 을 감소시킨다(순수 함수, 입력을 변경하지
// 않음). 서버 오브 트루스는 "매번 재계산"이 아니라 이 lazy decay 뿐이다 —
// 백그라운드 타이머로 갉아먹지 않으므로 프로세스가 안 떠 있는 동안에도 정확하다.
function applyDecay(vitals, now) {
  const nowTs = resolveNow(now);
  const v = vitals || defaultVitals(nowTs);
  const prevTs = typeof v.updated_at === 'number' ? v.updated_at : nowTs;
  const hours = Math.max(0, (nowTs - prevTs) / (1000 * 60 * 60));
  return {
    satiety: clampVital(v.satiety - DECAY_PER_HOUR.satiety * hours),
    energy: clampVital(v.energy - DECAY_PER_HOUR.energy * hours),
    mood: clampVital(v.mood - DECAY_PER_HOUR.mood * hours),
    bond: clampVital(v.bond - DECAY_PER_HOUR.bond * hours),
    updated_at: nowTs,
  };
}

// 상호작용 적용: 먼저 지금까지의 decay 를 반영한 뒤 회복량을 더한다(순수 함수).
// kind 가 INTERACTIONS 에 없으면 decay 만 반영해 그대로 반환한다 — 모르는 키로
// 던지지 않는다(fail-open; 이 함수는 결국 UI 상호작용 경로에서도 호출된다).
function interact(vitals, kind, now) {
  const decayed = applyDecay(vitals, now);
  const bumps = INTERACTIONS[kind];
  if (!bumps) return decayed;
  const next = { ...decayed };
  for (const [key, amount] of Object.entries(bumps)) {
    next[key] = clampVital((next[key] || 0) + amount);
  }
  return next;
}

// ── 감정 도출 ────────────────────────────────────────────────
// event-state 우선, 그다음 vitals 임계값. moodState 는 setMood()/setState() 가
// 다루는 8-mood 이름(§MOOD8_TO_EMOTION16) 이다.
function deriveEmotion({ moodState, vitals } = {}) {
  const mapped = MOOD8_TO_EMOTION16[moodState] || 'neutral';

  // idle(=neutral) 상태에서만 vitals 임계값으로 표정을 덮어쓴다 — thinking/error 등
  // 이벤트 신호가 뚜렷할 땐 vitals 로 헷갈리게 하지 않는다.
  if (moodState === 'idle' && vitals) {
    if (vitals.energy < 20) return 'sleepy';
    if (vitals.satiety < 20) return 'sad';
  }
  return mapped;
}

// ── PetSkin 인터페이스 ───────────────────────────────────────
/**
 * @typedef {Object} PetSkin
 * @property {string} id - 레지스트리 키(예: 'space-invader')
 * @property {string} label - 사용자용 표시 이름(스킨 선택 메뉴에 노출)
 * @property {string[]} renderableEmotions - 이 스킨이 실제로 그릴 줄 아는 감정
 *   (BASE_EMOTIONS 의 부분집합, 보통 전체 6종)
 * @property {(emotion16: string) => string} mapEmotion - 16 감정 → 이 스킨이
 *   그릴 수 있는 감정으로 접는다.
 * @property {(args: {emotion: string, vitals: object, frame: number}) => string[]} drawSprite -
 *   색 코드 없는 순수 문자열 배열을 반환한다(호출자인 lib/ui.js 가 색을 입힌다).
 *   emotion 은 16 어휘/6 베이스 어느 쪽이 와도 안전하게 처리해야 하고
 *   (내부적으로 알 수 없는 값이면 mapEmotion 으로 접는다), 이 함수는 draw() 에서
 *   호출되는 render 경로이므로 절대 throw 하지 않는다.
 *
 *   **그리드 계약**: 반환 배열은 정확히 PET_GRID.rows 줄이어야 하고, 각 줄은
 *   정확히 PET_GRID.cols 칸이어야 한다(모자라면 공백 패딩). 이래야 스킨을
 *   무엇으로 바꿔도 렌더러가 항상 같은 크기의 "LCD 화면" 한 장으로 취급할 수
 *   있다 — 배치(중앙정렬 등)는 렌더러 책임, 스킨은 그리드를 채우는 책임만 진다.
 *   스킨이 이 계약을 어겨도(줄 수/폭이 다름) 렌더러가 항상 고정 그리드를
 *   받도록 padToGrid() 를 안전망으로 제공한다.
 */

const skinRegistry = new Map();

function registerSkin(skin) {
  skinRegistry.set(skin.id, skin);
}

// 모르는 id 는 기본 스킨('space-invader')으로 fail-open. 기본 스킨조차 등록되지
// 않은 극단적 상황(예: require 순서 문제)에는 null — 호출자가 getAvatarFrame
// 폴백으로 넘어갈 신호로 쓴다.
function getSkin(id) {
  return skinRegistry.get(id) || skinRegistry.get('space-invader') || null;
}

function listSkins() {
  return [...skinRegistry.values()].map(s => ({ id: s.id, label: s.label }));
}

// ── MCP 이벤트 소스 (phase2 준비 — 시그니처만) ─────────────────
/**
 * @typedef {Object} PetStimulus
 * @property {string} kind - 예: 'tool_success' | 'tool_error' | 'long_idle' 등(phase2 에서 정의)
 * @property {number} at - epoch ms
 * @property {object} [meta] - 자유 형식 부가 데이터
 */

// phase2: wire void MCP events here — 지금은 구독해도 아무 것도 오지 않는
// 시그니처만 제공한다. 실제 MCP/이벤트 배선은 이번 phase 범위 밖.
function createPetEventSource() {
  return {
    subscribe(cb) {
      // phase2: wire void MCP events here
      void cb;
      return () => {};
    },
  };
}

registerSkin(require('./skin-invader').SpaceInvaderSkin);

module.exports = {
  PET_GRID,
  padToGrid,
  EMOTIONS,
  BASE_EMOTIONS,
  EMOTION_16_TO_6,
  mapEmotion16to6,
  MOOD8_TO_EMOTION16,
  DECAY_PER_HOUR,
  INTERACTIONS,
  defaultVitals,
  applyDecay,
  interact,
  deriveEmotion,
  registerSkin,
  getSkin,
  listSkins,
  createPetEventSource,
};
