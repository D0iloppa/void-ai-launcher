'use strict';

// 개인비서 채팅 컴포저(lib/ui.js assistantChatView 의 입력창)를 위한 순수
// 텍스트/커서 모델. 렌더링·raw-mode 키 처리와 분리해 여기서만 두는 이유는
// voidContextAutoRecord.js 와 같다 — dJinn/터미널 의존성 없는 순수 로직이라
// 단위 테스트가 쉽다.
//
// 좌표계: 모든 인덱스는 "코드포인트" 단위다(Array.from(value)의 인덱스),
// value.length(UTF-16 code unit 길이)가 아니다. 서로게이트 페어(이모지 등)가
// 커서 연산 중간에 잘리지 않게 하기 위함. ui.js 의 colWidth/wrapCols 도
// `for (const ch of str)` 로 코드포인트 단위 순회를 하므로(ZWJ 시퀀스처럼 여러
// 코드포인트가 시각적으로 한 글자인 경우까지 폭 계산에서 합치진 않음), 이
// 모듈의 코드포인트 단위 커서도 기존 폭 계산과 같은 단위에서 논다 — 새로운
// 제약이 아니라 기존 wrapCols 의 동작을 그대로 물려받는 것.

function toChars(value) {
  return Array.from(String(value == null ? '' : value));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function length(value) {
  return toChars(value).length;
}

// 커서 위치에 문자열을 삽입. { value, cursor } 반환 (cursor 는 삽입된 텍스트
// 바로 뒤로 이동).
function insertText(value, cursor, insertStr) {
  const chars = toChars(value);
  const c = clamp(cursor, 0, chars.length);
  const ins = toChars(insertStr);
  chars.splice(c, 0, ...ins);
  return { value: chars.join(''), cursor: c + ins.length };
}

// Backspace — 커서 앞 한 글자 삭제. 0 위치에서는 no-op.
function deleteBackward(value, cursor) {
  const chars = toChars(value);
  const c = clamp(cursor, 0, chars.length);
  if (c === 0) return { value: chars.join(''), cursor: 0 };
  chars.splice(c - 1, 1);
  return { value: chars.join(''), cursor: c - 1 };
}

// 커서 위치의 글자 삭제(forward-delete) — 아직 키에 바인딩하진 않았지만
// deleteBackward 와 대칭인 순수 연산이라 함께 둔다.
function deleteForward(value, cursor) {
  const chars = toChars(value);
  const c = clamp(cursor, 0, chars.length);
  if (c >= chars.length) return { value: chars.join(''), cursor: c };
  chars.splice(c, 1);
  return { value: chars.join(''), cursor: c };
}

function moveLeft(value, cursor) {
  return clamp(cursor - 1, 0, length(value));
}

function moveRight(value, cursor) {
  return clamp(cursor + 1, 0, length(value));
}

// `value` 를 `width` 칸에서 ui.js 의 wrapCols 와 같은 방식(코드포인트별
// colWidth 를 누적, 넘치기 직전에 줄바꿈)으로 시각적 줄(visual line)로
// 나눈다. wrapCols 와 달리 각 시각적 줄이 원문 `value` 에서 차지하는
// [start, end) 코드포인트 인덱스 범위도 함께 반환한다 — 커서 인덱스를
// (row, col) 로 매핑/역매핑하는 데 필요.
//
// colWidth 는 호출자(lib/ui.js)가 주입한다 — 이 순수 모듈이 ui.js 의
// module-private 팔레트/헬퍼에 의존하지 않게 하기 위함.
function layoutVisualLines(value, width, colWidth) {
  const w = Math.max(1, width);
  const lines = [];
  const logical = String(value == null ? '' : value).split('\n');
  let offset = 0; // 현재 논리 줄이 시작하는 코드포인트 오프셋
  logical.forEach((raw, li) => {
    const chars = toChars(raw);
    if (chars.length === 0) {
      lines.push({ start: offset, end: offset, text: '' });
    } else {
      let segStart = 0;
      let used = 0;
      for (let i = 0; i < chars.length; i++) {
        const cw = colWidth(chars[i]);
        if (used + cw > w && i > segStart) {
          lines.push({ start: offset + segStart, end: offset + i, text: chars.slice(segStart, i).join('') });
          segStart = i;
          used = 0;
        }
        used += cw;
      }
      lines.push({ start: offset + segStart, end: offset + chars.length, text: chars.slice(segStart).join('') });
    }
    offset += chars.length;
    if (li < logical.length - 1) offset += 1; // 소비된 '\n' 자체가 인덱스 1개를 차지
  });
  if (lines.length === 0) lines.push({ start: 0, end: 0, text: '' });
  return lines;
}

// `lines`(layoutVisualLines 결과) 안에서 커서 인덱스가 속하는 (row, col).
// 줄 경계(= 다음 줄의 start 와 같은 지점)에 커서가 있으면 — 그게 실제 개행
// 이든 자동 줄바꿈 지점이든 — 다음 줄의 0번 칼럼으로 취급한다(줄바꿈 직후에
// 커서를 두는 것과 같은, 흔한 텍스트 편집기 관례). 단, 문서의 마지막 줄
// 끝(더 이상 다음 줄이 없음)에서는 그 줄의 끝 칼럼으로 취급한다.
function cursorRowCol(lines, value, cursor) {
  const c = clamp(cursor, 0, length(value));
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r];
    const isLast = r === lines.length - 1;
    if (c < ln.end || (isLast && c === ln.end)) {
      return { row: r, col: c - ln.start };
    }
  }
  const last = lines[lines.length - 1];
  return { row: lines.length - 1, col: c - last.start };
}

// cursorRowCol 의 역연산 — (row, col) 을 유효한 커서 인덱스로 clamp.
function rowColToCursor(lines, row, col) {
  const r = clamp(row, 0, lines.length - 1);
  const ln = lines[r];
  const lineLen = ln.end - ln.start;
  return ln.start + clamp(col, 0, lineLen);
}

// Home — 현재 "시각적 줄"의 시작으로 이동(로직 줄 전체가 아니라 줄바꿈된
// 해당 화면 줄만).
function moveHome(value, cursor, width, colWidth) {
  const lines = layoutVisualLines(value, width, colWidth);
  const { row } = cursorRowCol(lines, value, cursor);
  return lines[row].start;
}

// End — 현재 시각적 줄의 끝으로 이동.
function moveEnd(value, cursor, width, colWidth) {
  const lines = layoutVisualLines(value, width, colWidth);
  const { row } = cursorRowCol(lines, value, cursor);
  return lines[row].end;
}

// 커서를 시각적 줄 기준 위(delta=-1)/아래(delta=+1)로 한 줄 이동, 칼럼은
// 최대한 보존(readline/textarea 의 "goal column" 관례 — 이동 대상 줄이 더
// 짧으면 그 줄 끝으로 clamp). 이미 첫/마지막 시각적 줄이라 더 이동할 수
// 없으면 커서를 그대로 반환한다 — 호출자(ui.js)가 이 "제자리" 신호로
// 채팅 스크롤백 등 다른 동작으로 폴백할지 판단한다.
function moveVisualRow(value, cursor, width, colWidth, delta) {
  const lines = layoutVisualLines(value, width, colWidth);
  const { row, col } = cursorRowCol(lines, value, cursor);
  const targetRow = row + delta;
  if (targetRow < 0 || targetRow > lines.length - 1) return cursor;
  return rowColToCursor(lines, targetRow, col);
}

// 총 `total`개 시각적 줄 중 `displayRows`개만 보이는 뷰포트의 top row를,
// `cursorRow` 가 항상 보이도록 계산한다(오토그로우 입력창의 4줄 캡 스크롤).
// 기본은 bottom-anchored(가장 흔한 케이스: 끝에서 타이핑 중) — 커서가 그
// 창보다 위/아래로 벗어나면 그 방향으로만 최소한으로 밀어준다.
function computeViewportTop(total, displayRows, cursorRow) {
  const maxTop = Math.max(0, total - displayRows);
  let top = maxTop;
  if (cursorRow < top) top = cursorRow;
  if (cursorRow > top + displayRows - 1) top = cursorRow - displayRows + 1;
  return clamp(top, 0, maxTop);
}

module.exports = {
  toChars, length, clamp,
  insertText, deleteBackward, deleteForward,
  moveLeft, moveRight, moveHome, moveEnd, moveVisualRow,
  layoutVisualLines, cursorRowCol, rowColToCursor,
  computeViewportTop,
};
