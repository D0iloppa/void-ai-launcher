'use strict';

// service → 표준 환경변수 이름 매핑
const SERVICE_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  google:    'GOOGLE_API_KEY',
};

function envFor(service) {
  return SERVICE_ENV[service] || `${service.toUpperCase()}_API_KEY`;
}

// 과거 여기 있던 '[2] LLM CLI 세션 토큰 (setup-token)' 항목(tmux 자동 인증 / 수동
// .credentials.json·tokens.json 붙여넣기)은 제거됨 — 이제 세션별 토큰은 일반 토큰
// 저장소(token:<service>:<alias>)를 재사용하는 lib/sessions.js의 '토큰 연결'
// 액션(선택 사항)으로 대체되었다. 항목 번호는 1/2 로 당겨 재사용한다(항목이 2개뿐이라
// 재넘버링해도 혼동 여지가 없음).
async function extTokensMenu(config, c) {
  const { menu } = require('./ui');
  const { tokensMenu } = require('./tokens');

  while (true) {
    const items = [
      { key: '1', label: '토큰 관리', desc: 'API 키 · OAuth 인증 토큰 등록/수정/삭제 (세션·개인비서에서 사용)' },
      { key: '2', label: '환경변수 Export', desc: '등록된 API 키 export 스크립트 출력' },
    ];

    const sel = await menu('토큰 및 인증 관리', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      await tokensMenu(c);
    } else if (sel.key === '2') {
      await showExportList(c);
    }
  }
}

async function showExportList(c) {
  const { menu, message } = require('./ui');
  const { getAllTokens }   = require('./config');

  while (true) {
    const all = getAllTokens();

    const entries = [];
    for (const [svc, aliases] of Object.entries(all)) {
      for (const [alias, data] of Object.entries(aliases)) {
        entries.push({ svc, alias, envVar: envFor(svc), token: data.token });
      }
    }

    if (entries.length === 0) {
      await message(
        '저장된 토큰이 없습니다.\n\n' +
        c.muted2 + '  메인 메뉴 Tokens 에서 먼저 토큰을 등록하세요.' + c.RESET
      );
      return;
    }

    const items = entries.map((e, i) => ({
      key:   String(i + 1),
      label: `${e.svc}  /  ${e.alias}`,
      desc:  e.envVar,
    }));

    const sel = await menu('외부 토큰 — export 명령어', items, { back: true });
    if (!sel) return;

    const entry = entries[Number(sel.key) - 1];
    if (entry) await showExportCommands(entry, c);
  }
}

async function showExportCommands(entry, c) {
  const { menu, message, wrapCols, messageInnerWidth } = require('./ui');
  const { copyToClipboard } = require('./clipboard');

  const exportLine  = `export ${entry.envVar}="${entry.token}"`;
  const inlineLine  = `${entry.envVar}="${entry.token}" ${entry.svc}`;
  const bashrcHint  = `echo '${exportLine}' >> ~/.zshrc`;

  const items = [
    { key: '1', label: 'export (셸 세션용)' },
    { key: '2', label: '인라인 실행 예시' },
    { key: '3', label: '.zshrc 등록 명령어' },
  ];

  const sel = await menu(`${entry.svc} / ${entry.alias}`, items, { back: true });
  if (!sel) return;

  // Pre-wrap to message()'s own inner box width so the export/inline/bashrc
  // line (one long unbreakable token: the API key) is hard-wrapped across as
  // many lines as it takes instead of being cut short with '…' by makeBox's
  // per-line truncateCols. -2 reserves room for the '  ' indent added below
  // (added AFTER wrapping so it never wraps mid-indent) — without it, an
  // indented line could exceed the box width and get truncated right back.
  const wrapWidth = Math.max(1, messageInnerWidth() - 2);

  const lines = {
    '1': [
      c.signal + '── export (현재 셸 세션에 붙여넣기) ──' + c.RESET,
      '',
      ...wrapCols(c.text + exportLine + c.RESET, wrapWidth).map(l => '  ' + l),
      '',
      c.muted2 + '  현재 터미널에서 바로 사용할 수 있습니다.' + c.RESET,
    ],
    '2': [
      c.signal + '── 인라인 실행 예시 ──' + c.RESET,
      '',
      ...wrapCols(c.text + inlineLine + c.RESET, wrapWidth).map(l => '  ' + l),
      '',
      c.muted2 + '  CLI 바이너리 앞에 붙여 일회성으로 사용합니다.' + c.RESET,
    ],
    '3': [
      c.signal + '── ~/.zshrc / ~/.bashrc 영구 등록 ──' + c.RESET,
      '',
      ...wrapCols(c.text + bashrcHint + c.RESET, wrapWidth).map(l => '  ' + l),
      '',
      c.muted2 + '  실행 후 터미널을 재시작하거나 source ~/.zshrc 하세요.' + c.RESET,
    ],
  };

  // The 'c' copy shortcut copies the ORIGINAL unwrapped/unstyled source
  // string for the CURRENTLY VIEWED variant (not always exportLine) — so
  // pasting produces exactly what's on screen (`export FOO="bar"`, the inline
  // form, or the .zshrc line), never the wrapped/ANSI-colored display text.
  const copySource = { '1': exportLine, '2': inlineLine, '3': bashrcHint };
  await message(lines[sel.key].join('\n'), {
    actions: [
      { key: 'c', label: '복사', run: () => copyToClipboard(copySource[sel.key] || exportLine), flash: '복사됨' },
    ],
  });
}

module.exports = { extTokensMenu };
