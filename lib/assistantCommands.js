'use strict';

// 개인비서 채팅(lib/ui.js assistantChatView)의 '/'-슬래시 명령 레지스트리 —
// 순수 로직. assistantSettingsPanel.js/composerModel.js 와 같은 이유로 여기
// 분리해둔다: dJinn/터미널 의존성이 없는 순수 함수라 단위 테스트가 쉽다.
//
// kind:
//   'local'       — void 자신이 처리(launcher.js onSubmit 인터셉터)하고 child
//                    프로세스로는 보내지 않는다. 지금은 /skills 하나뿐이다 —
//                    분석 결과 "/skills isn't available in this environment"
//                    라는 응답이 claude 헤드리스 클라이언트 자체의 자체
//                    단락(client-side short-circuit)이라는 게 검증됐기
//                    때문(신뢰할 사실로 전제).
//   'passthrough' — 오늘과 동일하게 child stdin 으로 그대로 흘려보낸다.
//                    /mcp, /usage, /model, /effort 는 claude 가 헤드리스에서도
//                    이미 정상 응답하므로 별도 처리 없이 그냥 지나간다.
//
// /resume 은 의도적으로 목록에 없다 — 헤드리스에서 거부되는 명령이라 별도
// UI(추후 기능)로 다뤄질 예정.
const COMMANDS = [
  { name: '/skills', desc: '사용 가능한 스킬 목록을 보여줍니다', kind: 'local' },
  { name: '/mcp', desc: '연결된 MCP 서버 목록을 보여줍니다', kind: 'passthrough' },
  { name: '/usage', desc: '이번 세션의 토큰/비용 사용량을 보여줍니다', kind: 'passthrough' },
  { name: '/model', desc: '현재 모델 정보를 보여줍니다', kind: 'passthrough' },
  { name: '/effort', desc: '현재 reasoning effort 를 보여줍니다', kind: 'passthrough' },
];

// prefix 는 선행 '/' 를 포함한다('/' 단독이면 전체 목록). 대소문자 구분 없이
// name.startsWith(prefix) 로 매칭.
function filterCommands(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0 || prefix[0] !== '/') return [];
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(p));
}

// 사용자가 아직 명령어를 타이핑 중인지(인자/공백 없이 '/'로 시작하는 단일
// 토큰인지) 판정. 공백/개행이 하나라도 섞여 있으면(이미 인자가 붙었거나 여러
// 줄이면) 자동완성을 끝낼 신호로 null 을 반환한다.
function parseLeadingToken(inputValue) {
  const v = String(inputValue == null ? '' : inputValue);
  if (!v.startsWith('/')) return null;
  if (/\s/.test(v)) return null;
  return v;
}

module.exports = { COMMANDS, filterCommands, parseLeadingToken };
