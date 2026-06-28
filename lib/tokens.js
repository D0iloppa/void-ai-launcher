'use strict';
const { getAllTokens, setToken, renameToken, deleteToken, addService, deleteService } = require('./config');

// ── Tokens 메뉴 ───────────────────────────────────────────

async function tokensMenu(c) {
  const { menu } = require('./ui');

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
  const { menu, input, flashMessage } = require('./ui');
  const all = getAllTokens();
  const services = Object.keys(all);

  const svcItems = [
    ...services.map((s, i) => ({ key: String(i + 1), label: s })),
    { key: 'n', label: '새 서비스명 입력' },
  ];

  const svcSel = await menu('서비스 선택', svcItems, { back: true });
  if (!svcSel) return;

  let service;
  if (svcSel.key === 'n') {
    service = (await input('새 서비스명: ')).trim();
    if (!service) return;
  } else {
    service = svcSel.label;
  }

  const alias = (await input('별칭 (예: TK1, prod, personal): ')).trim();
  if (!alias) return;
  const token = (await input(`${service} / ${alias} 토큰값: `, true)).trim();
  if (!token) return;

  setToken(service, alias, token);
  await flashMessage(c.ok + `✓ 저장됨  [${service}] ${alias}` + c.RESET);
}

// ── 조회 ─────────────────────────────────────────────────

async function listFlow(c, all) {
  const { message } = require('./ui');
  const services = Object.keys(all);
  if (services.length === 0) { await message('저장된 토큰이 없습니다.'); return; }

  const lines = [];
  lines.push(c.signal + '저장된 토큰' + c.RESET);
  lines.push(c.muted + '─'.repeat(44) + c.RESET);

  for (const svc of services) {
    const entries = Object.entries(all[svc]);
    if (entries.length === 0) {
      lines.push('  ' + c.info + svc + c.RESET + '  ' + c.muted + '(없음)' + c.RESET);
    } else {
      lines.push('  ' + c.info + svc + c.RESET);
      for (const [alias, data] of entries) {
        const masked = data.token.slice(0, 6) + '●'.repeat(8) + data.token.slice(-4);
        lines.push('    ' + c.signal + alias.padEnd(12) + c.RESET + ' ' + c.muted2 + masked + c.RESET);
        lines.push('    ' + ' '.repeat(12) + ' ' + c.muted + data.reg_dt + c.RESET);
      }
    }
    lines.push('');
  }

  await message(lines.join('\n'));
}

// ── 수정 ─────────────────────────────────────────────────

async function editTokenFlow(c, all) {
  const { menu, input, flashMessage } = require('./ui');
  const pair = await pickTokenPair(c, all, '수정할 토큰');
  if (!pair) return;
  const { service, alias } = pair;

  const items = [
    { key: '1', label: '별칭 변경' },
    { key: '2', label: '토큰값 변경' },
  ];
  const sel = await menu(`${service} / ${alias}`, items, { back: true });
  if (!sel) return;

  if (sel.key === '1') {
    const newAlias = (await input('새 별칭: ')).trim();
    if (!newAlias) return;
    if (renameToken(service, alias, newAlias)) {
      await flashMessage(c.ok + `✓ 별칭 변경됨  ${alias} → ${newAlias}` + c.RESET);
    }
  } else {
    const newToken = (await input('새 토큰값: ', true)).trim();
    if (!newToken) return;
    setToken(service, alias, newToken);
    await flashMessage(c.ok + `✓ 토큰값 업데이트됨  [${service}] ${alias}` + c.RESET);
  }
}

// ── 삭제 ─────────────────────────────────────────────────

async function deleteTokenFlow(c, all) {
  const { flashMessage } = require('./ui');
  const pair = await pickTokenPair(c, all, '삭제할 토큰');
  if (!pair) return;
  const { service, alias } = pair;

  if (deleteToken(service, alias)) {
    await flashMessage(c.warn + `✓ 삭제됨  [${service}] ${alias}` + c.RESET);
  }
}

// ── 서비스 추가/삭제 ──────────────────────────────────────

async function serviceFlow(c, all) {
  const { menu, input, message, flashMessage } = require('./ui');

  const items = [
    { key: '1', label: '서비스 추가' },
    { key: '2', label: '서비스 삭제', desc: '토큰이 없는 서비스만' },
  ];

  const sel = await menu('서비스 관리', items, { back: true });
  if (!sel) return;

  if (sel.key === '1') {
    const name = (await input('서비스명: ')).trim();
    if (!name) return;
    addService(name);
    await flashMessage(c.ok + `✓ 서비스 추가됨  ${name}` + c.RESET);
  } else {
    const empty = Object.keys(all).filter(s => Object.keys(all[s]).length === 0);
    if (empty.length === 0) { await message('삭제 가능한 서비스(빈 서비스)가 없습니다.'); return; }

    const svcItems = empty.map((s, i) => ({ key: String(i + 1), label: s }));
    const svcSel = await menu('삭제할 서비스', svcItems, { back: true });
    if (!svcSel) return;

    if (deleteService(svcSel.label)) {
      await flashMessage(c.warn + `✓ 서비스 삭제됨  ${svcSel.label}` + c.RESET);
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

module.exports = { tokensMenu };
