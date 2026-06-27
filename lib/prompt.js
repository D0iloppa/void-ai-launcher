'use strict';
const readline = require('readline');
const { getToken } = require('./config');

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    desc: 'Claude 모델  (claude CLI)',
    envKey: 'ANTHROPIC_API_KEY',
    services: ['anthropic'],
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  openai: {
    label: 'OpenAI',
    desc: 'GPT 모델  (codex CLI)',
    envKey: 'OPENAI_API_KEY',
    services: ['openai'],
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  },
  google: {
    label: 'Google',
    desc: 'Gemini 모델  (agy CLI)',
    envKey: 'GOOGLE_API_KEY',
    services: ['google', 'gemini'],
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
};

// opts.apiKey / opts.service / opts.alias 를 주입하면 제공자 선택 건너뜀
async function promptMode(initialText, config, c, opts = {}) {
  const { menu, message, clear, out } = require('./ui');

  let providerKey, provider, apiKey;

  if (opts.apiKey) {
    // 토큰 실행 경로: 서비스 이름으로 제공자 추론
    apiKey = opts.apiKey;
    const svc = (opts.service || '').toLowerCase();
    providerKey = Object.keys(PROVIDERS).find(k => PROVIDERS[k].services.includes(svc)) || 'anthropic';
    provider    = PROVIDERS[providerKey];
  } else {
    // 제공자 선택
    const provItems = Object.entries(PROVIDERS).map(([key, p], i) => ({
      key: String(i + 1), label: p.label, desc: p.desc,
    }));
    const provSel = await menu('Prompt — 제공자 선택', provItems, { back: true });
    if (!provSel) return;

    providerKey = Object.keys(PROVIDERS)[Number(provSel.key) - 1];
    provider    = PROVIDERS[providerKey];

    // 토큰 조회 (config.json → env 순서)
    apiKey = null;
    for (const svc of provider.services) {
      apiKey = getToken(svc);
      if (apiKey) break;
    }
    apiKey = apiKey || process.env[provider.envKey];
  }

  if (!apiKey) {
    await message(
      c.warn + `${provider.label} 토큰이 없습니다.` + c.RESET + '\n\n' +
      `  Tokens 메뉴에서 '${provider.services[0]}' 서비스에 토큰을 추가하거나\n` +
      `  ${provider.envKey} 환경변수를 설정하세요.`
    );
    return;
  }

  // 모델 선택
  const modelItems = provider.models.map((m, i) => ({ key: String(i + 1), label: m }));
  const modelSel   = await menu('모델 선택', modelItems, { back: true });
  if (!modelSel) return;
  const model = provider.models[Number(modelSel.key) - 1];

  // 프롬프트 입력
  const text = initialText || await getMultilineInput(c);
  if (!text.trim()) return;

  clear();
  out(c.signal + '─'.repeat(48) + c.RESET);
  out('');

  try {
    if (providerKey === 'anthropic') {
      await callAnthropic(apiKey, model, text, c);
    } else if (providerKey === 'openai') {
      await callOpenAI(apiKey, model, text, c);
    } else {
      await callGoogle(apiKey, model, text, c);
    }
  } catch (err) {
    out('\n' + c.warn + '오류: ' + err.message + c.RESET);
  }

  out('');
  out(c.signal + '─'.repeat(48) + c.RESET);
  out('');
  out(c.muted2 + '  Enter 키를 눌러 계속...' + c.RESET);
  await waitEnter();
}

async function callAnthropic(apiKey, model, text, c) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { throw new Error('@anthropic-ai/sdk 미설치 — npm install @anthropic-ai/sdk'); }

  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model, max_tokens: 8192,
    messages: [{ role: 'user', content: text }],
  });
  stream.on('text', chunk => process.stdout.write(c.text + chunk + c.RESET));
  await stream.finalMessage();
}

async function callGoogle(apiKey, model, text, c) {
  let GoogleGenerativeAI;
  try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); }
  catch { throw new Error('@google/generative-ai 미설치 — npm install @google/generative-ai'); }

  const genAI   = new GoogleGenerativeAI(apiKey);
  const gmodel  = genAI.getGenerativeModel({ model });
  const result  = await gmodel.generateContentStream(text);
  for await (const chunk of result.stream) {
    const delta = chunk.text();
    if (delta) process.stdout.write(c.text + delta + c.RESET);
  }
}

async function callOpenAI(apiKey, model, text, c) {
  let OpenAI;
  try { const mod = require('openai'); OpenAI = mod.default || mod; }
  catch { throw new Error('openai 미설치 — npm install openai'); }

  const client = new OpenAI({ apiKey });
  const stream = await client.chat.completions.create({
    model, stream: true,
    messages: [{ role: 'user', content: text }],
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) process.stdout.write(c.text + delta + c.RESET);
  }
}

async function getMultilineInput(c) {
  const { out } = require('./ui');
  out('');
  out(c.signal + '◆ ' + c.RESET + c.text + '프롬프트 입력 (빈 줄 두 번 → 전송):' + c.RESET);
  out('');

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    let emptyCount = 0;
    rl.on('line', line => {
      if (line === '') {
        if (++emptyCount >= 2) { rl.close(); }
        else lines.push('');
      } else {
        emptyCount = 0;
        lines.push(line);
      }
    });
    rl.on('close', () => resolve(lines.join('\n').trimEnd()));
  });
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

module.exports = { promptMode };
