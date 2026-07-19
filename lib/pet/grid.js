'use strict';

// 스킨과 무관하게 인터페이스가 소유하는 고정 렌더 그리드 크기(다마고치 LCD
// 느낌) — PetSkin.drawSprite() 는 반드시 이 그리드에 정확히 맞는 배열(rows 줄,
// 각 줄 정확히 cols 칸)을 반환해야 한다. 배치(중앙정렬 등)는 렌더러(lib/ui.js)
// 책임이고, 스킨은 "그리드를 채우는" 책임만 진다 — 이렇게 해야 어떤 스킨을
// 꽂아도 같은 자리에 딱 맞는다(스킨 교체 가능성이 이 인터페이스의 존재 이유).
//
// index.js 와 각 스킨(skin-invader.js 등) 양쪽에서 이 값을 참조하는데, index.js
// 가 스킨을 require 하는 쪽이라 값을 index.js 안에 두면 스킨→index.js 순환
// require 가 생긴다 — 그래서 의존관계 없는 별도 파일로 뺐다.
//
// 값은 space-invader 스킨(안테나줄+눈줄+7행 몸통 = 9행, 몸통 11열)이 여백 없이
// 정확히 들어가는 크기로 골랐다 — "스킨이 요구하는 최소치".
const PET_GRID = { cols: 13, rows: 9 };

// 스킨이 반환한 줄들을 PET_GRID 규격(정확히 rows 줄, 각 줄 정확히 cols 칸)으로
// 강제한다 — 짧은 줄은 우측 공백 패딩, 넘치는 줄은 자르고, 줄 수가 모자라면
// 빈 줄로 채우고 넘치면 자른다. 스킨 구현이 계약을 어겨도(줄 수/폭이 다름)
// 렌더러가 항상 고정 그리드를 받도록 하는 안전망 — render 경로이므로 절대
// throw 하지 않는다.
function padToGrid(lines) {
  const src = Array.isArray(lines) ? lines : [];
  const out = [];
  for (let i = 0; i < PET_GRID.rows; i++) {
    const raw = typeof src[i] === 'string' ? src[i] : '';
    out.push(raw.length >= PET_GRID.cols ? raw.slice(0, PET_GRID.cols) : raw + ' '.repeat(PET_GRID.cols - raw.length));
  }
  return out;
}

module.exports = { PET_GRID, padToGrid };
