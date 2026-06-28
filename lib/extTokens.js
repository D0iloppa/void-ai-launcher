'use strict';
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runTmuxSession } = require('./wrapper');

// service → 표준 환경변수 이름 매핑
const SERVICE_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  google:    'GOOGLE_API_KEY',
};

function envFor(service) {
  return SERVICE_ENV[service] || `${service.toUpperCase()}_API_KEY`;
}

function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function checkTokenInfo(configDir) {
  if (!configDir) return null;
  const possibleFiles = [
    '.credentials.json',
    'tokens.json',
    'credentials.json',
    '.claude.json'
  ];
  for (const file of possibleFiles) {
    try {
      const filePath = path.join(configDir, file);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat && stat.size > 2) {
          return stat.mtime;
        }
      }
    } catch (e) {
      // Ignore filesystem access / permission errors
    }
  }
  return null;
}

async function extTokensMenu(config, c) {
  const { menu, message, input } = require('./ui');
  const { getSessions }   = require('./storage');
  const { exitAltScreen, enterAltScreen } = require('./ui');
  const { tokensMenu } = require('./tokens');

  while (true) {
    const items = [
      { key: '1', label: 'API 토큰 관리 (config.json)', desc: '외부 API 키 등록, 수정, 삭제' },
      { key: '2', label: 'LLM CLI 세션 토큰 (setup-token)', desc: 'CLI 세션별 API 토큰 등록 및 로그인' },
      { key: '3', label: '환경변수 Export', desc: '등록된 API 키 export 스크립트 출력' },
    ];

    const sel = await menu('토큰 및 인증 관리', items, { back: true });
    if (!sel) return;

    if (sel.key === '1') {
      await tokensMenu(c);
    } else if (sel.key === '2') {
      const rawSessions = getSessions();
      const sessions = (rawSessions || []).filter(s => s && typeof s === 'object' && s.configDir);

      if (sessions.length === 0) {
        await message(
          '등록된 CLI 세션이 없습니다.\n\n' +
          c.muted2 + '  먼저 설정 > LLM CLI 세션관리에서 세션을 생성하세요.' + c.RESET
        );
        continue;
      }

      const sessionItems = sessions.map((s, i) => {
        const tokenMtime = checkTokenInfo(s.configDir);
        let tokenStatus = c.warn + '[토큰 없음]' + c.RESET;
        if (tokenMtime) {
          tokenStatus = c.ok + '[인증 완료]' + c.RESET + ' ' + c.muted2 + formatTime(tokenMtime) + c.RESET;
        }
        return {
          key: String(i + 1),
          label: s.name,
          desc: `${s.toolCommand || 'claude'}  |  ${tokenStatus}`,
        };
      });

      const sSel = await menu('토큰 설정할 세션 선택', sessionItems, { back: true });
      if (!sSel) continue;

      const session = sessions[Number(sSel.key) - 1];
      if (session) {
        const cmd = (session.toolCommand || 'claude').toLowerCase();

        const sessionMenuTitle = `세션 인증: ${session.name} (${cmd})`;
        const sessionMenuItems = [
          { key: '1', label: '자동 인증 시작 (setup-token)', desc: 'tmux 세션 내에서 setup-token 실행' },
          { key: '2', label: '수동으로 토큰 붙여넣기', desc: '직접 발급받은 API 토큰 붙여넣기' },
        ];
        const actSel = await menu(sessionMenuTitle, sessionMenuItems, { back: true });
        if (!actSel) continue;

        if (actSel.key === '1') {
          exitAltScreen();
          const runCmd = `${cmd} setup-token; echo; echo -e "\\x1b[32m인증 프로세스가 종료되었습니다. [Enter] 키를 누르면 이전 화면으로 돌아갑니다.\\x1b[0m"; read`;
          const toolObj = { command: 'bash', args: ['-c', runCmd] };
          const label = `setup-token · ${cmd} [${session.name}]`;

          const env = { ...process.env };
          if (cmd === 'codex') {
            env.CODEX_HOME = session.configDir;
          } else if (cmd === 'agy') {
            env.AGY_HOME = session.configDir;
            env.AGY_CONFIG_DIR = session.configDir;
          } else {
            env.CLAUDE_CONFIG_DIR = session.configDir;
          }

          const { loadTheme } = require('./theme');
          const palette = config ? loadTheme(config) : {};

          let wrapped = runTmuxSession(toolObj, env, label, { colors: palette });
          if (!wrapped) {
            process.stdout.write('\x1b[2J\x1b[H');
            spawnSync('bash', ['-c', runCmd], { env, stdio: 'inherit', shell: false });
          }

          enterAltScreen();
          await message(c.signal + '인증 프로세스가 완료되었습니다.' + c.RESET);
        } else if (actSel.key === '2') {
          const tokenVal = await input('API 토큰값 입력: ');
          if (tokenVal === null || tokenVal.trim() === '') continue;
          const tokenValTrimmed = tokenVal.trim();

          try {
            fs.mkdirSync(session.configDir, { recursive: true, mode: 0o700 });

            if (cmd === 'claude') {
              const credPath = path.join(session.configDir, '.credentials.json');
              const credData = {
                claudeAiOauth: {
                  accessToken: tokenValTrimmed,
                  refreshToken: "",
                  expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
                  scopes: ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
                  subscriptionType: "team",
                  rateLimitTier: "default_claude_max_5x"
                }
              };
              fs.writeFileSync(credPath, JSON.stringify(credData, null, 2), { mode: 0o600 });

              const tokPath = path.join(session.configDir, 'tokens.json');
              fs.writeFileSync(tokPath, JSON.stringify({ token: tokenValTrimmed, accessToken: tokenValTrimmed }, null, 2), { mode: 0o600 });
            } else {
              const tokPath = path.join(session.configDir, 'tokens.json');
              fs.writeFileSync(tokPath, JSON.stringify({ token: tokenValTrimmed, accessToken: tokenValTrimmed }, null, 2), { mode: 0o600 });
            }

            await message(c.ok + '수동 토큰 저장 완료!' + c.RESET);
          } catch (err) {
            await message(c.warn + '토큰 저장에 실패했습니다: ' + err.message + c.RESET);
          }
        }
      }
    } else if (sel.key === '3') {
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
  const { menu, message } = require('./ui');

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

  const lines = {
    '1': [
      c.signal + '── export (현재 셸 세션에 붙여넣기) ──' + c.RESET,
      '',
      '  ' + c.text + exportLine + c.RESET,
      '',
      c.muted2 + '  현재 터미널에서 바로 사용할 수 있습니다.' + c.RESET,
    ],
    '2': [
      c.signal + '── 인라인 실행 예시 ──' + c.RESET,
      '',
      '  ' + c.text + inlineLine + c.RESET,
      '',
      c.muted2 + '  CLI 바이너리 앞에 붙여 일회성으로 사용합니다.' + c.RESET,
    ],
    '3': [
      c.signal + '── ~/.zshrc / ~/.bashrc 영구 등록 ──' + c.RESET,
      '',
      '  ' + c.text + bashrcHint + c.RESET,
      '',
      c.muted2 + '  실행 후 터미널을 재시작하거나 source ~/.zshrc 하세요.' + c.RESET,
    ],
  };

  await message(lines[sel.key].join('\n'));
}

module.exports = { extTokensMenu };
