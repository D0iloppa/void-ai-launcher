'use strict';
const { spawn, spawnSync } = require('child_process');
const readline   = require('readline');
const fs   = require('fs');
const { resolveToolStateDir } = require('./storage');
const mailbox = require('./mcp-hub'); // pure require — mailbox path helpers only

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
const sock        = arg('--sock', ''); // enables the shared mailbox (optional)

// ── env ──────────────────────────────────────────────────
const env = { ...process.env };
if (configDir) {
  if (binary === 'codex') env.CODEX_HOME = configDir;
  else env.CLAUDE_CONFIG_DIR = configDir;
} else if (binary === 'codex') {
  env.CODEX_HOME = resolveToolStateDir('codex');
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
  if (binary === 'codex') {
    let full = input;
    if (history.length) {
      const ctx = history
        .map(h => `Human: ${h.user}\nAssistant: ${h.assistant}`)
        .join('\n\n');
      full = ctx + '\n\nHuman: ' + input;
    }
    const a = ['exec', '--skip-git-repo-check'];
    if (model) a.push('--model', model);
    a.push(full);
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

// ── job queue (shared by human input + mailbox) ───────────
// A single busy flag + queue serialises every prompt, whether typed by the
// human or delivered via the mailbox, so runs never overlap.
let busy = false;
const jobs = []; // { text, from } — from=null for the local human

function postProcess(input, response) {
  if (binary === 'claude') {
    isFirst = false;
  } else if (response.trim()) {
    history.push({ user: input, assistant: response.trim() });
    if (history.length > 20) history.shift(); // bounded
  }
}

function submitJob(text, from) {
  jobs.push({ text, from });
  tryDrain();
}

async function tryDrain() {
  if (busy || jobs.length === 0) return;
  busy = true;
  while (jobs.length) {
    const job = jobs.shift();
    if (job.from != null) {
      process.stdout.write('\n' + C + '◂ [from: ' + job.from + '] ' + R + job.text + '\n');
    }
    const response = await runPrompt(job.text);
    postProcess(job.text, response);
  }
  busy = false;
}

// ── mailbox poller ────────────────────────────────────────
function startMailbox() {
  if (!sock) return; // no --sock → pure REPL, backward compatible

  // Self-detect our tmux window index (TMUX/TMUX_PANE inherited from the pane).
  const r = spawnSync('tmux', ['-L', sock, 'display-message', '-p', '#{window_index}'], { encoding: 'utf8' });
  const idx = (r.stdout || '').trim();
  if (r.status !== 0 || !idx) return; // not in a tmux pane → skip mailbox silently

  const file = mailbox.ensureMailbox(sock, idx); // file existence = registration
  process.stdout.write(GR + `// mailbox #${idx} 수신 대기 중` + R + '\n\n');

  let offset = 0;
  setInterval(() => {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < offset) offset = 0; // file truncated/rotated → re-read
    if (size <= offset) return;

    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      chunk = buf.slice(0, read);
    } catch { return; }

    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) return; // no complete line yet — wait for the newline
    const consumable = chunk.slice(0, lastNl + 1);
    offset += consumable.length;

    for (const line of consumable.toString('utf8').split('\n').filter(Boolean)) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg.text === 'string') submitJob(msg.text, msg.from == null ? '?' : msg.from);
    }
  }, 500);
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

  startMailbox();

  const ask = () => {
    rl.question(B + 'You: ' + R, raw => {
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

      // Queue the prompt (serialised with mailbox jobs via the busy flag) and
      // re-prompt immediately so the human is never blocked.
      submitJob(input, null);
      ask();
    });
  };

  ask();
}

main().catch(e => { process.stderr.write('chat-runner: ' + e.message + '\n'); process.exit(1); });
