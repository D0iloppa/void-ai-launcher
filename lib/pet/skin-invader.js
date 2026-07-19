'use strict';

// Space Invaders 스킨 — 고전 아케이드 "오징어" 인베이더 실루엣을 블록 문자로
// 그린다. 순수 렌더링 모듈: 색 코드도, require('../ui') 도 없다 — 문자열만
// 반환하고 색은 항상 호출자(lib/ui.js)가 입힌다.
//
// idle 애니메이션은 제거됨(터미널 부하/깜빡임을 원치 않는다는 사용자 결정) —
// 펫은 이제 이벤트(감정 변경) 시에만 다시 그려지는 정적 스프라이트다. 그래서
// 6감정을 눈으로 뚜렷이 구분하려면 "다리 wiggle" 대신 안테나/팔 자세/발 모양을
// 감정별로 다르게 그려야 한다 — 아래 EMOTION_CONFIG 가 그 담당.

const { PET_GRID } = require('./grid');

const BASE_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'sleepy'];

// 16 감정 → 이 스킨의 6 베이스 감정. lib/pet/index.js 의 EMOTION_16_TO_6 과 값은
// 같지만(스펙 고정), 스킨은 인터페이스상 자기 own mapEmotion 을 갖도록 로컬로도
// 들고 있다 — 다른 스킨이 다른 접기 규칙을 쓸 수 있게 하기 위함.
const EMOTION_16_TO_6 = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
  surprised: 'surprised', sleepy: 'sleepy',
  laughing: 'happy', wink: 'happy', love: 'happy', cool: 'happy',
  thumbsup: 'happy', celebrate: 'happy',
  confused: 'surprised',
  thinking: 'neutral',
  worried: 'sad', facepalm: 'sad',
};

function mapEmotion(emotion) {
  return EMOTION_16_TO_6[emotion] || 'neutral';
}

// 공통 몸통(목/머리/가슴) — 감정과 무관하게 고정. 어깨(팔)줄과 발줄만 감정별로
// 갈아 끼워 자세를 바꾼다(EMOTION_CONFIG.shoulderRow/feetRow). 11열 고정.
const BASE_NECK     = '...X...X...';
const BASE_HEAD     = '..XXXXXXX..';
const BASE_SHOULDER = '.XX.XXX.XX.';
const BASE_CHEST    = 'XXXXXXXXXXX';
const BASE_WAIST    = 'X.XXXXXXX.X';
const BASE_HIP      = 'X.X.....X.X';
const BASE_FEET     = '...XX.XX...';

// 감정별 안테나 줄(맨 위, 11열 고정) + 눈 문자 쌍 + 어깨/발줄 오버라이드(null 이면
// BASE_SHOULDER/BASE_FEET 그대로). 안테나·팔 자세를 감정마다 다르게 해 눈만으로
// 구분하던 예전 버전보다 실루엣 자체가 달라 보이게 한다.
const EMOTION_CONFIG = {
  // 곧은 안테나, 기본 자세 — 다른 5개 감정의 기준선.
  neutral: {
    antennaRow: '..|.....|..',
    eyes: ['o', 'o'],
    shoulderRow: null,
    feetRow: null,
  },
  // 안테나가 바깥·위로 뻗고(cheer 자세), 팔도 벌려 올리고, 발은 모아 통통 뛰는 느낌.
  happy: {
    antennaRow: '.\\......./.',
    eyes: ['^', '^'],
    shoulderRow: 'X.X.XXX.X.X',
    feetRow: '....XX.....',
  },
  // 안테나가 안쪽으로 처지고(,), 팔도 몸 쪽으로 웅크린다.
  sad: {
    antennaRow: '...,...,...',
    eyes: ['u', 'u'],
    shoulderRow: '..X.XXX.X..',
    feetRow: null,
  },
  // 안테나가 미간 쪽으로 몰려 찡그린 눈썹 모양(/ \), 팔은 넓게 벌려 전투 자세.
  angry: {
    antennaRow: "..../\\.....",
    eyes: ['x', 'x'],
    shoulderRow: 'XX..XXX..XX',
    feetRow: '.XX.....XX.',
  },
  // 안테나가 놀라 뻣뻣이 서고(!), 팔은 몸 밖으로 활짝, 발은 붕 떠서 비워둔다.
  surprised: {
    antennaRow: '..!.....!..',
    eyes: ['O', 'O'],
    shoulderRow: 'X...XXX...X',
    feetRow: '...........',
  },
  // 안테나가 완전히 처져 안 보이고(대신 Z 표시), 눈은 감고, 발도 모아 축 늘어짐.
  sleepy: {
    antennaRow: '........Z..',
    eyes: ['-', '-'],
    shoulderRow: null,
    feetRow: '.....XX....',
  },
};

// 인터페이스가 소유한 고정 그리드(lib/pet/grid.js) 폭 안에서 몸통(11열)을
// 중앙 정렬한다 — 그리드 계약(정확히 PET_GRID.cols 칸)은 이 스킨이 이미
// 여백 없이 딱 맞게 설계돼 있어 자동으로 지켜지지만(9행 x 11열 몸통 +
// 그리드 13열), 다른 폭의 스킨이었어도 이 중앙정렬 로직은 그대로 재사용 가능.
function convertRow(template) {
  let row = '';
  for (const ch of template) {
    if (ch === 'X') row += '█';
    else if (ch === '.') row += ' ';
    else row += ch; // 안테나/눈 문자 등은 그대로 둔다
  }
  const pad = Math.max(0, Math.floor((PET_GRID.cols - row.length) / 2));
  return ' '.repeat(pad) + row;
}

// emotion 은 16 어휘/6 베이스 어느 쪽이 와도 안전하다 — 6종에 없으면 mapEmotion
// 으로 접는다. render 경로에서 호출되므로 절대 던지지 않는다(fallback 뿐).
// frame 은 더 이상 애니메이션에 쓰이지 않는다(idle 애니메이션 제거 — 사용자 결정:
// 터미널 부하/깜빡임 방지) — 이 스킨은 감정당 정적 포즈 하나뿐이라 값과 무관하게
// 항상 같은 포즈를 그린다. 인터페이스 시그니처 호환을 위해 파라미터 자체는 계속 받는다.
// vitals 는 현재 이 스킨에서는 쓰지 않는다(표정은 emotion 하나로 이미 결정됨) —
// 인터페이스 시그니처엔 향후 스킨(vitals 기반 액세서리 등)을 위해 유지해 둔다.
// 그리드 계약(lib/pet/grid.js PET_GRID): 안테나+눈+7행 몸통 = 정확히
// PET_GRID.rows(9)줄을 반환한다. 각 줄은 PET_GRID.cols(13) 안에서 중앙 정렬만
// 하고 우측 공백은 채우지 않는데, 그 나머지는 호출자(lib/ui.js)가 padToGrid()
// 로 채워 정확히 cols 폭을 맞춘다(안전망 — 이 스킨이 계약을 어겨도 렌더러가
// 항상 고정 그리드를 받는다).
function drawSprite({ emotion, vitals, frame } = {}) {
  void vitals;
  void frame;
  const emo6 = BASE_EMOTIONS.includes(emotion) ? emotion : mapEmotion(emotion);
  const cfg = EMOTION_CONFIG[emo6] || EMOTION_CONFIG.neutral;
  const eyeRow = '..' + cfg.eyes[0] + '.....' + cfg.eyes[1] + '..';
  const rows = [
    cfg.antennaRow,
    eyeRow,
    BASE_NECK,
    BASE_HEAD,
    cfg.shoulderRow || BASE_SHOULDER,
    BASE_CHEST,
    BASE_WAIST,
    BASE_HIP,
    cfg.feetRow || BASE_FEET,
  ];
  return rows.map(convertRow);
}

const SpaceInvaderSkin = {
  id: 'space-invader',
  label: 'Space Invader',
  renderableEmotions: BASE_EMOTIONS,
  mapEmotion,
  drawSprite,
};

module.exports = { SpaceInvaderSkin };
