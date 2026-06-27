'use strict';
const readline = require('readline');
const { getAllTokens, getServiceTokens, setToken, renameToken, deleteToken, addService, deleteService } = require('./config');

// ── Tokens 메뉴 ───────────────────────────────────────────

async function tokensMenu(c) {
  const { menu, message, input, clear, out } = require('./ui');

  while (true) {
    const all = getAllTokens();
    const services = Object.keys(all);
    const totalCount = services.reduce((n, s) => n + Object.keys(all[s]).length, 0);

    const items = [
      { key: '1', label: '토큰 추가',   desc: '' },
      { key: '2', label: '서비스 조회', desc: `${services.length}개 서비스, ${totalCount}개 토큰` },
      { key: '3', label: '토큰 수정',   desc: '별칭 변경 또는 값 업데이트' },
      { key: '4', label: '토큰 삭제',   desc: '' },
      { key: '5', label: '서비스 추가/삭제', desc: '' },
    ];

    const sel = await menu('Tokens', items, { back: true });
    if (!sel) return;

    switch (sel.key) {
      case '1': await addTokenFlow(c); break;
      case '2': await listFlow(c, all); break;
      case '3': await editTokenFlow(c, all); break;
      case '4': await deleteTokenFlow(c, all); break;
      case '5': await serviceFlow(c, all); break;
    }
  }
}

// ── 추가 ─────────────────────────────────────────────────

async function addTokenFlow(c) {
  const { menu, input, out, clear } = require('./ui');
  const all = getAllTokens();
  const services = Object.keys(all);

  // 서비스 선택 또는 새로 입력
  const svcItems = [
    ...services.map((s, i) => ({ key: String(i + 1), label: s })),
    { key: 'n', label: '새 서비스명 입력' },
  ];

  const svcSel = await menu('서비스 선택', svcItems, { back: true });
  if (!svcSel) return;

  let service;
  if (svcSel.key === 'n') {
    clear();
    out('');
    service = (await input('새 서비스명: ')).trim();
    if (!service) return;
  } else {
    service = svcSel.label;
  }

  clear();
  out('');
  const alias = (await input('별칭 (예: TK1, prod, personal): ')).trim();
  if (!alias) return;
  out('');
  const token = (await input(`${service} / ${alias} 토큰값: `, true)).trim();
  if (!token) return;

  setToken(service, alias, token);
  out('\n  ' + c.ok + `✓ 저장됨  [${service}] ${alias}` + c.RESET + '\n');
  await sleep(900);
}

// ── 조회 ─────────────────────────────────────────────────

async function listFlow(c, all) {
  const { clear, out, message } = require('./ui');
  const services = Object.keys(all);
  if (services.length === 0) { await message('저장된 토큰이 없습니다.'); return; }

  clear();
  out('');
  out('  ' + c.signal + '저장된 토큰' + c.RESET);
  out('  ' + c.muted + '─'.repeat(44) + c.RESET);

  for (const svc of services) {
    const entries = Object.entries(all[svc]);
    if (entries.length === 0) {
      out('  ' + c.info + svc + c.RESET + '  ' + c.muted + '(없음)' + c.RESET);
    } else {
      out('  ' + c.info + svc + c.RESET);
      for (const [alias, data] of entries) {
        const masked = data.token.slice(0, 6) + '●'.repeat(8) + data.token.slice(-4);
        out('    ' + c.signal + alias.padEnd(12) + c.RESET + ' ' + c.muted2 + masked + c.RESET);
        out('    ' + ' '.repeat(12) + ' ' + c.muted + data.reg_dt + c.RESET);
      }
    }
    out('');
  }

  out('  ' + c.muted2 + 'Enter 키를 눌러 계속...' + c.RESET);
  await waitEnter();
}

// ── 수정 ─────────────────────────────────────────────────

async function editTokenFlow(c, all) {
  const { menu, input, clear, out } = require('./ui');
  const pair = await pickTokenPair(c, all, '수정할 토큰');
  if (!pair) return;
  const { service, alias } = pair;

  const items = [
    { key: '1', label: '별칭 변경' },
    { key: '2', label: '토큰값 변경' },
  ];
  const sel = await menu(`${service} / ${alias}`, items, { back: true });
  if (!sel) return;

  clear();
  out('');

  if (sel.key === '1') {
    const newAlias = (await input('새 별칭: ')).trim();
    if (!newAlias) return;
    if (renameToken(service, alias, newAlias)) {
      out('\n  ' + c.ok + `✓ 별칭 변경됨  ${alias} → ${newAlias}` + c.RESET + '\n');
    }
  } else {
    const newToken = (await input('새 토큰값: ', true)).trim();
    if (!newToken) return;
    setToken(service, alias, newToken);
    out('\n  ' + c.ok + `✓ 토큰값 업데이트됨  [${service}] ${alias}` + c.RESET + '\n');
  }
  await sleep(900);
}

// ── 삭제 ─────────────────────────────────────────────────

async function deleteTokenFlow(c, all) {
  const { out } = require('./ui');
  const pair = await pickTokenPair(c, all, '삭제할 토큰');
  if (!pair) return;
  const { service, alias } = pair;

  if (deleteToken(service, alias)) {
    out('\n  ' + c.warn + `✓ 삭제됨  [${service}] ${alias}` + c.RESET + '\n');
    await sleep(900);
  }
}

// ── 서비스 추가/삭제 ──────────────────────────────────────

async function serviceFlow(c, all) {
  const { menu, input, clear, out, message } = require('./ui');

  const items = [
    { key: '1', label: '서비스 추가' },
    { key: '2', label: '서비스 삭제', desc: '토큰이 없는 서비스만' },
  ];

  const sel = await menu('서비스 관리', items, { back: true });
  if (!sel) return;

  clear(); out('');

  if (sel.key === '1') {
    const name = (await input('서비스명: ')).trim();
    if (!name) return;
    addService(name);
    out('\n  ' + c.ok + `✓ 서비스 추가됨  ${name}` + c.RESET + '\n');
    await sleep(900);
  } else {
    const empty = Object.keys(all).filter(s => Object.keys(all[s]).length === 0);
    if (empty.length === 0) { await message('삭제 가능한 서비스(빈 서비스)가 없습니다.'); return; }

    const svcItems = empty.map((s, i) => ({ key: String(i + 1), label: s }));
    const svcSel = await menu('삭제할 서비스', svcItems, { back: true });
    if (!svcSel) return;

    if (deleteService(svcSel.label)) {
      out('\n  ' + c.warn + `✓ 서비스 삭제됨  ${svcSel.label}` + c.RESET + '\n');
      await sleep(900);
    }
  }
}

// ── 헬퍼 ─────────────────────────────────────────────────

async function pickTokenPair(c, all, title) {
  const { menu } = require('./ui');
  const services = Object.keys(all).filter(s => Object.keys(all[s]).length > 0);
  if (services.length === 0) {
    const { message } = require('./ui');
    await message('저장된 토큰이 없습니다.');
    return null;
  }

  // Flatten to [service, alias] pairs
  const pairs = [];
  for (const svc of services) {
    for (const alias of Object.keys(all[svc])) {
      pairs.push({ service: svc, alias });
    }
  }

  const items = pairs.map((p, i) => ({
    key: String(i + 1),
    label: `${p.service}`,
    desc: p.alias,
  }));

  const sel = await menu(title, items, { back: true });
  if (!sel) return null;
  return pairs[Number(sel.key) - 1];
}

function waitEnter() {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve(); return; }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'return' || (key.ctrl && key.name === 'c')) {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(false);
        if (key.ctrl && key.name === 'c') process.exit(0);
        resolve();
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { tokensMenu };
