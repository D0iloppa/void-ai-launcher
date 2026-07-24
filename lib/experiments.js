'use strict';

// 설정 및 이력 → experiments — 아직 config.js 의 정식 tools 목록에 넣기엔
// 이른(실험적인) 부가 도구들을 위한 게이트 서브메뉴. EXPERIMENTS 배열에
// { key, label, desc, run(config, c) } 항목을 추가하는 것만으로 새 실험
// 도구를 등록할 수 있다 — launcher.js 를 건드릴 필요 없음.

const EXPERIMENTS = [
  {
    key: 'o',
    label: 'omniroute 설치',
    desc: '여러 LLM provider를 localhost:20128/v1 로 통합하는 로컬 게이트웨이',
    run: runOmniroute,
  },
];

// omniroute 바이너리 설치 여부 확인 — cliPreflight.js 의 isInstalled() 와
// 동일한 PATH 조회 방식(which/where)을 재사용한다.
function checkInstalled() {
  try {
    const { isInstalled } = require('./cliPreflight');
    return isInstalled('omniroute');
  } catch {
    return false;
  }
}

async function runOmniroute(config, c) {
  const { message } = require('./ui');
  const installed = checkInstalled();

  await message([
    c.BOLD + 'omniroute' + c.RESET,
    '',
    '  여러 LLM provider(Claude/OpenAI/Gemini 등)를 로컬 게이트웨이',
    '  ' + c.muted2 + 'http://localhost:20128/v1' + c.RESET + ' 하나로 통합해주는 라우터입니다.',
    '',
    installed
      ? '  ' + c.ok + '이미 설치됨' + c.RESET
      : '  ' + c.warn + '[미설치]' + c.RESET,
    '',
    '  설치 방법 (둘 중 하나):',
    '  ' + c.muted2 + 'npm install -g omniroute' + c.RESET,
    '  ' + c.muted2 + 'docker run -p 20128:20128 diegosouzapw/omniroute' + c.RESET,
    '',
    '  설치 후:',
    '  ' + c.muted2 + 'omniroute' + c.RESET + ' 실행 → ' + c.muted2 + 'http://localhost:20128/dashboard' + c.RESET + ' 접속',
    '',
    '  Enter 를 누르면 아래 npm 설치 명령이 미리 입력된 미니 터미널이 열립니다.',
    '  ' + c.muted2 + '(자동 실행되지 않습니다 — Enter 로 직접 실행하거나 docker 명령으로 바꿔 입력하세요.)' + c.RESET,
  ].join('\n'));

  try {
    const { runMiniShell } = require('./miniShell');
    await runMiniShell({ initialInput: 'npm install -g omniroute' });
  } catch {}
}

async function experimentsMenu(config, c) {
  const { menu } = require('./ui');

  while (true) {
    const items = EXPERIMENTS.map(exp => ({
      key: exp.key,
      label: exp.label,
      desc: exp.desc,
    }));

    const sel = await menu('experiments', items, { back: true });
    if (!sel) return;

    const exp = EXPERIMENTS.find(e => e.key === sel.key);
    if (exp) await exp.run(config, c);
  }
}

module.exports = { experimentsMenu, EXPERIMENTS };
