'use strict';
const { spawn }  = require('child_process');
const readline   = require('readline');

// ── argv ─────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
function arg(name, def = '') {
  const i = rawArgs.indexOf(name);
  return i >= 0 && rawArgs[i + 1] ? rawArgs[i + 1] : def;
}

let binary      = arg('--binary', 'claude');
let model       = arg('--model', '');
const configDir = arg('--config-dir', '');
const sessionName = arg('--session-name', 'default');

// ── env ──────────────────────────────────────────────────
const env = { ...process.env };
if (configDir) {
  if (binary === 'codex') env.CODEX_HOME = configDir;
  else env.CLAUDE_CONFIG_DIR = configDir;
}

// ── colors ───────────────────────────────────────────────
const R  = '\x1b[0m';
const B  = '\x1b[1m';
const G  = '\x1b[32m';
const C  = '\x1b[36m';
const GR = '\x1b[90m';
const Y  = '\x1b[33m';

function cols() { return process.stdout.columns || 72; }
function sep()  { return GR + '─'.repeat(cols()) + R; }

function clearContent() {
  // Use EL (Erase Line) instead of ED (Erase Display): EL respects DECSLRM margins
  // and won't touch the wrapper border bars at columns outside the margins.
  // \x1b[2J would erase the entire host screen, destroying the wrapper frame.
  const rows = process.stdout.rows || 24;
  let s = '\x1b[H'; // go to scroll-region origin (DECOM-relative)
  for (let i = 0; i < rows; i++) {
    s += '\x1b[2K';
    if (i < rows - 1) s += '\r\n';
  }
  s += '\x1b[H';
  process.stdout.write(s);
}

function printHeader() {
  clearContent();
  process.stdout.write(B + G + '[void chat]' + R + '  ' + B + binary + R);
  if (model) process.stdout.write(GR + ' · ' + R + C + model + R);
  process.stdout.write('  ' + GR + '// ' + sessionName + R + '\n');
  process.stdout.write(sep() + '\n');
  process.stdout.write(GR + '/clear 초기화  /model <이름> 변경  /help 도움말  Ctrl+C 종료\n' + R);
  process.stdout.write(sep() + '\n\n');
}

// ── conversation state ────────────────────────────────────
let isFirst = true;
const history = []; // [{user, assistant}] for non-claude binaries

function buildSpawnArgs(input) {
  if (binary === 'claude') {
    const a = [];
    if (!isFirst) a.push('--continue');
    if (model)    a.push('--model', model);
    a.push('--prompt', input);
    return a;
  }
  // other binaries: prepend accumulated history as context
  let full = input;
  if (history.length) {
    const ctx = history
      .map(h => `Human: ${h.user}\nAssistant: ${h.assistant}`)
      .join('\n\n');
    full = ctx + '\n\nHuman: ' + input;
  }
  const a = [];
  if (model) a.push('--model', model);
  a.push('--prompt', full);
  return a;
}

function runPrompt(input) {
  return new Promise(resolve => {
    const pargs = buildSpawnArgs(input);
    process.stdout.write('\n' + GR + binary);
    if (model) process.stdout.write(' (' + model + ')');
    process.stdout.write(': ' + R);

    const child = spawn(binary, pargs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', d => { const s = d.toString(); out += s; process.stdout.write(s); });
    child.stderr.on('data', d => {
      const s = d.toString().trim();
      if (s) process.stdout.write('\n' + Y + s + R);
    });
    child.on('error', err => {
      process.stdout.write(Y + '\n⚠ ' + err.message + R + '\n');
      resolve('');
    });
    child.on('close', code => {
      if (code !== 0 && !out.trim())
        process.stdout.write('\n' + Y + `⚠ exit ${code} — '${binary}' 실행 오류` + R);
      process.stdout.write('\n\n' + sep() + '\n\n');
      resolve(out);
    });
  });
}

// ── REPL ─────────────────────────────────────────────────
async function main() {
  printHeader();

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  });
  rl.on('close', () => process.exit(0));

  const ask = () => {
    rl.question(B + 'You: ' + R, async raw => {
      const input = raw.trim();
      if (!input) { ask(); return; }

      if (input === '/clear' || input === '/reset') {
        history.length = 0;
        isFirst = true;
        printHeader();
        ask();
        return;
      }

      if (input.startsWith('/model ')) {
        model = input.slice(7).trim();
        process.stdout.write(GR + ' model → ' + C + (model || '기본값') + R + '\n\n');
        ask();
        return;
      }

      if (input === '/help') {
        process.stdout.write([
          '',
          B + '명령어' + R,
          '  /clear           대화 초기화 (히스토리 리셋)',
          '  /model <이름>    모델 변경  예: /model claude-opus-4-8',
          '  /help            이 도움말',
          '  Ctrl+C           종료',
          '',
        ].join('\n'));
        ask();
        return;
      }

      const response = await runPrompt(input);

      if (binary === 'claude') {
        isFirst = false;
      } else if (response.trim()) {
        history.push({ user: input, assistant: response.trim() });
        if (history.length > 20) history.shift(); // ponytail: bounded; extend if needed
      }

      ask();
    });
  };

  ask();
}

main().catch(e => { process.stderr.write('chat-runner: ' + e.message + '\n'); process.exit(1); });
