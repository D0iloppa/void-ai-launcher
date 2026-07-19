'use strict';

// 사용량 조회 (rate-limit metering) — pure data-fetching, NO UI imports.
//
// Claude:  OAuth usage endpoint (primary) → hidden `claude /usage` PTY (fallback)
// Codex:   ChatGPT backend usage API (primary) → `codex app-server` JSON-RPC
//          (fallback) → hidden `codex /status` PTY (fallback)
//
// Ported from ref/orca/src/main/rate-limits/{claude,codex}-fetcher.ts and
// claude-pty.ts. Each provider entry point returns a normalized result:
//   { status: 'ok'|'error'|'unavailable',
//     session: { usedPercent, resetsAt }|null,
//     weekly:  { usedPercent, resetsAt }|null,
//     error: string|null,
//     source: string|null }   // which tier answered (diagnostic)

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HTTP_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS   = 12_000;
const PTY_TIMEOUT_MS   = 25_000;
const PTY_SETTLE_MS    = 2_000;

// Claude OAuth usage endpoint — must match the real client's headers so the
// endpoint accepts the request the same way it accepts Claude Code.
const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA      = 'oauth-2025-04-20';
const CLAUDE_USER_AGENT      = 'claude-code/2.1.0';

// Codex backend usage endpoint (same contract Codex itself reads).
const CODEX_BACKEND_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// ── shared helpers ────────────────────────────────────────────

function okResult(session, weekly, source) {
  return { status: 'ok', session, weekly, error: null, source };
}
function errResult(message, source) {
  return { status: 'error', session: null, weekly: null, error: message, source: source || null };
}
function unavailableResult(message, source) {
  return { status: 'unavailable', session: null, weekly: null, error: message, source: source || null };
}

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

// Reset timestamps arrive as ISO strings, Unix seconds, or Unix ms.
function parseResetTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function makeWindow(usedPercent, resetsAtRaw) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return { usedPercent: pct, resetsAt: parseResetTimestamp(resetsAtRaw) };
}

// Fetch with a bounded timeout using the built-in global fetch (Node 18+).
async function fetchJson(url, headers) {
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.httpStatus = res.status;
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      err.retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : null;
    }
    throw err;
  }
  return res.json();
}

// Strip ANSI/OSC control sequences from captured PTY output.
function stripAnsi(str) {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const OSC = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');
  const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
  return str.replace(OSC, '').replace(CSI, '');
}

// Throwaway cwd so a hidden CLI probe never triggers unbounded file discovery
// in the user's real project directory.
function makeThrowawayCwd() {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'void-usage-'));
  } catch {
    return os.tmpdir();
  }
}
function cleanupDir(dir) {
  if (!dir || dir === os.tmpdir()) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── hidden-process bookkeeping ───────────────────────────────
//
// Hidden PTY probes become session leaders of their own pty, not children of
// this process's foreground process group, so if void itself is killed while
// a probe is in flight the spawned `claude`/`codex` process can be left
// running as an orphan. Track every live handle here and force-kill anything
// still active when the process exits.
const activeHandles = new Set();
process.on('exit', () => {
  for (const h of activeHandles) {
    try { h.kill(); } catch {}
  }
});

// ── Claude ────────────────────────────────────────────────────

// overrideDir lets a caller (the startup warmup task) query a *specific*
// session's credentials without mutating process.env — when omitted, this is
// byte-for-byte the same env-based resolution as before.
function claudeConfigDir(overrideDir) {
  return overrideDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Genuine OAuth bearer token only — deliberately NOT ANTHROPIC_API_KEY /
// ANTHROPIC_AUTH_TOKEN, since the usage endpoint is scoped to OAuth sessions.
function readClaudeOAuthToken(overrideDir) {
  const credPath = path.join(claudeConfigDir(overrideDir), '.credentials.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken;
    return typeof token === 'string' && token.trim() !== '' ? token : null;
  } catch {
    return null;
  }
}

async function fetchClaudeViaOAuth(token) {
  const data = await fetchJson(CLAUDE_OAUTH_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
    'User-Agent': CLAUDE_USER_AGENT,
  });
  const pickPercent = (w) =>
    w && (typeof w.utilization === 'number' ? w.utilization
        : typeof w.used_percentage === 'number' ? w.used_percentage
        : null);
  const session = data.five_hour ? makeWindow(pickPercent(data.five_hour), data.five_hour.resets_at) : null;
  const weekly  = data.seven_day ? makeWindow(pickPercent(data.seven_day), data.seven_day.resets_at) : null;
  return okResult(session, weekly, 'oauth');
}

// PTY fallback — hidden `claude`, send `/usage`, scrape the rendered panel.
const CLAUDE_SESSION_RE = /current\s*session/i;
const CLAUDE_WEEKLY_RE  = /(?:current\s*week|weekly\s*(?:limits?|usage|rate\s*limits?)|7\s*[- ]?\s*day)/i;
const CLAUDE_PERCENT_RE = /(\d{1,3})(?:\.\d+)?\s*%\s*(used|consumed|left|remaining|available)/i;

function extractClaudePercentAfter(lines, matchLabel) {
  for (let i = 0; i < lines.length; i++) {
    if (!matchLabel(lines[i])) continue;
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      const m = CLAUDE_PERCENT_RE.exec(lines[j]);
      if (m) {
        const pct = Number.parseFloat(m[1]);
        const word = m[2].toLowerCase();
        const isUsed = word === 'used' || word === 'consumed';
        return isUsed ? pct : 100 - pct;
      }
    }
  }
  return null;
}

function parseClaudePtyUsage(clean) {
  const lines = clean.split(/\r\n|\n|\r/);
  const sessionPct = extractClaudePercentAfter(lines, (l) => CLAUDE_SESSION_RE.test(l));
  const weeklyPct  = extractClaudePercentAfter(lines, (l) => CLAUDE_WEEKLY_RE.test(l));
  return {
    session: sessionPct !== null ? makeWindow(sessionPct, null) : null,
    weekly:  weeklyPct  !== null ? makeWindow(weeklyPct, null)  : null,
  };
}

// Why: claude permanently registers `cwd` into the profile's projects map the
// moment it boots — even for a throwaway probe dir that cleanupDir() then
// deletes from disk right after. Without this, every PTY fallback probe
// leaks one dead project entry into the user's real .claude.json forever.
// Best-effort and silent: never let cleanup failure affect the usage result.
function cleanupClaudeProjectEntry(cwd, overrideDir) {
  try {
    const file = path.join(claudeConfigDir(overrideDir), '.claude.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.projects || !(cwd in parsed.projects)) return;
    delete parsed.projects[cwd];
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  } catch {
    // Missing/invalid file, missing key, concurrent write — no-op.
  }
}

async function fetchClaudeViaPty(overrideDir) {
  let pty;
  try {
    pty = require('node-pty');
  } catch {
    return errResult('node-pty 를 사용할 수 없어 /usage 조회를 건너뜁니다.', 'pty');
  }
  const cwd = makeThrowawayCwd();
  const spawnEnv = { ...process.env, TERM: 'xterm-256color' };
  if (overrideDir) spawnEnv.CLAUDE_CONFIG_DIR = overrideDir;
  return new Promise((resolve) => {
    let output = '';
    let resolved = false, trustAccepted = false, sentUsage = false;
    let settleTimer = null, hardTimer = null;
    let term;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (term) activeHandles.delete(term);
      try { term && term.kill(); } catch {}
      cleanupDir(cwd);
      resolve(result);
    };

    try {
      term = pty.spawn('claude', [], {
        name: 'xterm-256color', cols: 120, rows: 40, cwd,
        env: spawnEnv,
      });
      activeHandles.add(term);
    } catch (err) {
      cleanupDir(cwd);
      const msg = err && err.code === 'ENOENT' ? 'claude CLI 를 찾을 수 없습니다.' : String(err && err.message || err);
      resolve(errResult(msg, 'pty'));
      return;
    }

    hardTimer = setTimeout(() => {
      const { session, weekly } = parseClaudePtyUsage(stripAnsi(output));
      if (session || weekly) finish(okResult(session, weekly, 'pty'));
      else finish(errResult('시간 초과 — /usage 패널을 읽지 못했습니다.', 'pty'));
    }, PTY_TIMEOUT_MS);

    term.onData((data) => {
      output += data;
      if (output.length > 100_000) output = output.slice(-100_000);
      const clean = stripAnsi(output);

      // Why: a brand-new throwaway cwd makes claude show its one-time "do you
      // trust this folder?" dialog before the REPL boots. That screen's words
      // are drawn via per-word cursor jumps with no literal space between them
      // once stripped (unlike the settled REPL UI below), so match the squished
      // form; Enter alone accepts the already-highlighted "Yes" choice.
      if (!trustAccepted && /trust\s*this\s*folder/i.test(clean)) {
        trustAccepted = true;
        try { term.write('\r'); } catch {}
        return;
      }

      // Why: only send /usage once the REPL has reached its idle input-ready
      // screen (recognized by its persistent bottom hint bar), not on a fixed
      // clock — a still-booting or trust-dialog screen silently swallows
      // keystrokes it doesn't understand, dropping /usage before it ever
      // reaches the prompt.
      if (!sentUsage && /for\s*shortcuts/i.test(clean)) {
        sentUsage = true;
        try { term.write('/usage\r'); } catch {}
        return;
      }

      if (sentUsage && !settleTimer && (CLAUDE_SESSION_RE.test(clean) || CLAUDE_WEEKLY_RE.test(clean))) {
        settleTimer = setTimeout(() => {
          const parsed = parseClaudePtyUsage(stripAnsi(output));
          if (parsed.session || parsed.weekly) finish(okResult(parsed.session, parsed.weekly, 'pty'));
          else finish(errResult('/usage 출력을 해석하지 못했습니다.', 'pty'));
        }, PTY_SETTLE_MS);
      }
    });
    term.onExit(() => {
      // Why: claude persists its trust/project registration as part of its own
      // shutdown handling (observed lastGracefulShutdown:true even on a killed
      // probe), which completes asynchronously *after* term.kill() is called
      // but *before* the OS reports this exit event. Doing the .claude.json
      // cleanup here (real process death) rather than immediately after
      // calling kill() avoids racing that write — cleaning up too early just
      // means claude re-writes the entry moments later, leaving it dangling.
      cleanupClaudeProjectEntry(cwd, overrideDir);
      const { session, weekly } = parseClaudePtyUsage(stripAnsi(output));
      if (session || weekly) finish(okResult(session, weekly, 'pty'));
      else finish(errResult('claude 가 /usage 출력 전에 종료되었습니다.', 'pty'));
    });
  });
}

async function fetchClaudeUsageResult(_config, overrideDir, sessionKey) {
  // Tier-0, always-on: parse the CLI's own local session *.jsonl logs for a
  // rate-limit event before touching the network/PTY at all. Zero network,
  // zero PTY, so it can never itself trigger a rate limit — pure upside.
  // Defensively guarded: any parser bug must fall through to the existing
  // chain unchanged, never break usage resolution.
  try {
    const { checkLocalRateLimit } = require('./experiments/localLogTier');
    const local = checkLocalRateLimit(claudeConfigDir(overrideDir));
    if (local && local.limited) {
      return okResult(makeWindow(100, local.resetsAt), null, 'local-log');
    }
  } catch {
    // fall through to the existing chain
  }

  const token = readClaudeOAuthToken(overrideDir);
  // Why: never spawn the hidden `claude` PTY unless a token was found. Without
  // one, /usage would silently drive claude's interactive first-run/login flow
  // against the real ~/.claude — fail closed instead.
  if (!token) {
    return unavailableResult('Claude OAuth 자격 증명이 없습니다.', null);
  }

  const rateLimitKey = sessionKey || 'default';
  const { getRateLimitUntil, setRateLimitUntil } = require('./usageDb');
  const blockedUntil = getRateLimitUntil('claude', rateLimitKey);
  if (blockedUntil && Date.now() < blockedUntil) {
    // Why: a 429 from this endpoint means the provider itself asked us to back
    // off. Retrying immediately (or falling through to the far more expensive
    // hidden-PTY tier) doesn't get real data either — it just adds more load
    // during the exact window we were told to stay quiet, which we observed
    // *extends* the provider's own Retry-After further into the future.
    // Persisted (not in-memory) so every void process sharing this profile
    // honors the same window, not just the one that got the 429.
    return unavailableResult(`OAuth 사용량 조회 rate-limit 대기 중 (약 ${Math.ceil((blockedUntil - Date.now()) / 1000)}초 후 재시도).`, 'oauth');
  }

  try {
    return await fetchClaudeViaOAuth(token);
  } catch (err) {
    if (err && err.httpStatus === 429) {
      const retryAfterSec = Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0 ? err.retryAfterSeconds : 60;
      setRateLimitUntil('claude', rateLimitKey, Date.now() + retryAfterSec * 1000);
      return errResult(`Rate limited — ${retryAfterSec}초 후 재시도.`, 'oauth');
    }
    // Token exists but the OAuth call itself failed for some other reason
    // (network/HTTP) — fall through to the PTY panel scrape.
  }
  try {
    return await fetchClaudeViaPty(overrideDir);
  } catch (err) {
    return errResult(String(err && err.message || err), 'pty');
  }
}

// ── Codex ─────────────────────────────────────────────────────

function codexHomeDir(overrideDir) {
  return overrideDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readCodexAuth(overrideDir) {
  const authPath = path.join(codexHomeDir(overrideDir), 'auth.json');
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }
}

function codexBackendHeaders(auth) {
  const accessToken = auth && auth.tokens && auth.tokens.access_token;
  if (!accessToken) return null;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  return headers;
}

async function fetchCodexViaBackend(auth) {
  const headers = codexBackendHeaders(auth);
  if (!headers) return null;
  const payload = await fetchJson(CODEX_BACKEND_USAGE_URL, headers);
  // plan_type is required by Codex's contract; reject unrelated JSON so the
  // app-server fallback still gets a chance.
  if (!payload || typeof payload.plan_type !== 'string') return null;
  const mapWin = (w) => (w ? makeWindow(w.used_percent, w.reset_at) : null);
  return okResult(
    mapWin(payload.rate_limit && payload.rate_limit.primary_window),
    mapWin(payload.rate_limit && payload.rate_limit.secondary_window),
    'backend'
  );
}

// RPC fallback — `codex -s read-only -a untrusted app-server`, JSON-RPC.
function fetchCodexViaRpc(overrideDir) {
  return new Promise((resolve) => {
    let buffer = '', stderr = '', resolved = false, rpcId = 0, initId = null, rateLimitsId = null;
    let timer = null;
    const args = ['-s', 'read-only', '-a', 'untrusted', 'app-server'];
    let child;

    const cwd = makeThrowawayCwd();
    const spawnEnv = overrideDir ? { ...process.env, CODEX_HOME: overrideDir } : process.env;

    const settle = (result) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      if (child) activeHandles.delete(child);
      try { child && child.kill(); } catch {}
      cleanupDir(cwd);
      resolve(result);
    };

    try {
      child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: spawnEnv });
      activeHandles.add(child);
    } catch (err) {
      cleanupDir(cwd);
      resolve(errResult(String(err && err.message || err), 'rpc'));
      return;
    }

    timer = setTimeout(() => settle(errResult('RPC 시간 초과.', 'rpc')), RPC_TIMEOUT_MS);

    const send = (method, params) => {
      const id = ++rpcId;
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'); } catch {}
      return id;
    };
    const notify = (method) => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n'); } catch {}
    };

    initId = send('initialize', { clientInfo: { name: 'void', version: '1.0.0' } });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id == null) continue;
        if (msg.id === initId) {
          notify('initialized');
          rateLimitsId = send('account/rateLimits/read');
          continue;
        }
        if (rateLimitsId !== null && msg.id === rateLimitsId) {
          if (msg.error) { settle(errResult(msg.error.message || 'RPC 오류', 'rpc')); return; }
          const rl = msg.result && msg.result.rateLimits;
          const mapWin = (w) => (w && typeof w.usedPercent === 'number' ? makeWindow(w.usedPercent, w.resetsAt) : null);
          settle(okResult(mapWin(rl && rl.primary), mapWin(rl && rl.secondary), 'rpc'));
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
    child.on('error', (err) => {
      const isEnoent = err && err.code === 'ENOENT';
      settle(isEnoent ? unavailableResult('codex CLI 를 찾을 수 없습니다.', 'rpc') : errResult(String(err.message || err), 'rpc'));
    });
    child.on('close', () => settle(errResult('RPC 프로세스가 예기치 않게 종료되었습니다.', 'rpc')));
  });
}

// PTY fallback — hidden `codex`, send `/status`, parse rendered panel.
const CODEX_FIVE_HOUR_RE = /5h\s+limit[:\s]*(\d+)%/i;
const CODEX_WEEKLY_RE    = /weekly\s+limit[:\s]*(\d+)%/i;

function parseCodexPtyStatus(clean) {
  const five = CODEX_FIVE_HOUR_RE.exec(clean);
  const week = CODEX_WEEKLY_RE.exec(clean);
  return {
    session: five ? makeWindow(Number.parseInt(five[1], 10), null) : null,
    weekly:  week ? makeWindow(Number.parseInt(week[1], 10), null) : null,
  };
}

async function fetchCodexViaPty(overrideDir) {
  let pty;
  try {
    pty = require('node-pty');
  } catch {
    return errResult('node-pty 를 사용할 수 없어 /status 조회를 건너뜁니다.', 'pty');
  }
  const cwd = makeThrowawayCwd();
  const spawnEnv = { ...process.env, TERM: 'xterm-256color' };
  if (overrideDir) spawnEnv.CODEX_HOME = overrideDir;
  return new Promise((resolve) => {
    let output = '';
    let resolved = false, sentStatus = false;
    let settleTimer = null, hardTimer = null;
    let term;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (term) activeHandles.delete(term);
      try { term && term.kill(); } catch {}
      cleanupDir(cwd);
      resolve(result);
    };

    try {
      term = pty.spawn('codex', [], {
        name: 'xterm-256color', cols: 120, rows: 40, cwd,
        env: spawnEnv,
      });
      activeHandles.add(term);
    } catch (err) {
      cleanupDir(cwd);
      const msg = err && err.code === 'ENOENT' ? 'codex CLI 를 찾을 수 없습니다.' : String(err && err.message || err);
      resolve(errResult(msg, 'pty'));
      return;
    }

    hardTimer = setTimeout(() => {
      const { session, weekly } = parseCodexPtyStatus(stripAnsi(output));
      if (session || weekly) finish(okResult(session, weekly, 'pty'));
      else finish(errResult('시간 초과 — /status 패널을 읽지 못했습니다.', 'pty'));
    }, PTY_TIMEOUT_MS);

    term.onData((data) => {
      output += data;
      if (output.length > 100_000) output = output.slice(-100_000);
      const clean = stripAnsi(output);
      // Why: test the accumulated/stripped buffer, not just the latest chunk —
      // the prompt character can arrive split across two PTY writes, which
      // would otherwise never trigger /status and fall back to the full timeout.
      if (!sentStatus && />\s*$/.test(clean)) {
        sentStatus = true;
        try { term.write('/status\r'); } catch {}
        return;
      }
      if (sentStatus && !settleTimer && (CODEX_FIVE_HOUR_RE.test(clean) || CODEX_WEEKLY_RE.test(clean))) {
        settleTimer = setTimeout(() => {
          const parsed = parseCodexPtyStatus(stripAnsi(output));
          if (parsed.session || parsed.weekly) finish(okResult(parsed.session, parsed.weekly, 'pty'));
          else finish(errResult('/status 출력을 해석하지 못했습니다.', 'pty'));
        }, PTY_SETTLE_MS);
      }
    });
    term.onExit(() => {
      const { session, weekly } = parseCodexPtyStatus(stripAnsi(output));
      if (session || weekly) finish(okResult(session, weekly, 'pty'));
      else finish(errResult('codex 가 /status 출력 전에 종료되었습니다.', 'pty'));
    });
  });
}

async function fetchCodexUsageResult(_config, overrideDir, sessionKey) {
  const auth = readCodexAuth(overrideDir);
  if (!auth) {
    return unavailableResult('Codex 에 로그인되어 있지 않습니다.', null);
  }

  const rateLimitKey = sessionKey || 'default';
  const { getRateLimitUntil, setRateLimitUntil } = require('./usageDb');
  const blockedUntil = getRateLimitUntil('codex', rateLimitKey);
  if (blockedUntil && Date.now() < blockedUntil) {
    // Claude 경로와 동일한 이유로 백오프 — 429 는 곧 재시도해도 소용없고,
    // 조용히 있으라는 신호를 무시하면 provider 의 backoff 창을 오히려
    // 늘릴 뿐이다. 프로세스 전체가 공유하도록 DB 에 저장한다.
    return unavailableResult(`Codex 사용량 조회 rate-limit 대기 중 (약 ${Math.ceil((blockedUntil - Date.now()) / 1000)}초 후 재시도).`, 'backend');
  }

  // Tier 1: backend usage API.
  try {
    const backend = await fetchCodexViaBackend(auth);
    if (backend) return backend;
  } catch (err) {
    if (err && err.httpStatus === 429) {
      const retryAfterSec = Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0 ? err.retryAfterSeconds : 60;
      setRateLimitUntil('codex', rateLimitKey, Date.now() + retryAfterSec * 1000);
      return errResult(`Rate limited — ${retryAfterSec}초 후 재시도.`, 'backend');
    }
    // fall through
  }
  // Tier 2: app-server JSON-RPC.
  try {
    const rpc = await fetchCodexViaRpc(overrideDir);
    if (rpc.status === 'ok' || rpc.status === 'unavailable') return rpc;
  } catch {
    // fall through
  }
  // Tier 3: interactive /status PTY.
  try {
    return await fetchCodexViaPty(overrideDir);
  } catch (err) {
    return errResult(String(err && err.message || err), 'pty');
  }
}

// ── session-key resolution + on-disk cache wrapper ──────────────
//
// Cache is keyed by provider → sessionKey → { ...lastOkResult, timestamp }.
// sessionKey is the *currently active* context only (the named session whose
// configDir matches the live CLAUDE_CONFIG_DIR/CODEX_HOME env var, or the
// literal 'default' when none is active) — never every saved session.

function resolveSessionKey(toolCommand) {
  const envVar = toolCommand === 'claude' ? 'CLAUDE_CONFIG_DIR'
    : toolCommand === 'codex' ? 'CODEX_HOME'
    : null;
  const envDir = envVar ? process.env[envVar] : null;
  if (!envDir) return 'default';
  try {
    const { getSessions } = require('./storage');
    const resolvedEnvDir = path.resolve(envDir);
    const match = getSessions().find((s) =>
      (s.toolCommand || 'claude') === toolCommand &&
      s.configDir &&
      path.resolve(s.configDir) === resolvedEnvDir
    );
    return match ? match.name : 'default';
  } catch {
    return 'default';
  }
}

// Wraps a raw fetch function with cache-on-success + cache-fallback-on-failure.
// Never adds a network/PTY/RPC call of its own — pure side-effect + read-fallback.
//
// overrides is optional { configDir, sessionKey } — used by the startup
// warmup task to query a *specific* session's credentials without mutating
// process.env (multiple targets run sequentially in the same process). When
// omitted (every existing call site), behavior is identical to before:
// session key comes from the live CLAUDE_CONFIG_DIR/CODEX_HOME env var via
// resolveSessionKey(), and credential/PTY reads inherit process.env as-is.
function withUsageCache(provider, toolCommand, fetchFn) {
  return async function cachedGetUsage(config, overrides) {
    const overrideDir = overrides && overrides.configDir ? overrides.configDir : undefined;
    const sessionKey = overrides && overrides.sessionKey
      ? overrides.sessionKey
      : resolveSessionKey(toolCommand);
    const result = await fetchFn(config, overrideDir, sessionKey);
    const { saveUsageCacheEntry, getUsageCacheEntry } = require('./usageDb');

    if (result.status === 'ok') {
      // Why: only a successful reading overwrites the cache, so a later
      // transient failure never clobbers the last-known-good value.
      saveUsageCacheEntry(provider, sessionKey, result);
      return { ...result, cachedAt: Date.now(), stale: false };
    }

    const cached = getUsageCacheEntry(provider, sessionKey);
    if (cached) {
      return {
        ...result,
        session: cached.session,
        weekly: cached.weekly,
        // Why: report which tier produced this *stale* reading (e.g. 'oauth'),
        // not whichever tier the current failed live attempt last touched.
        source: cached.source,
        stale: true,
        cachedAt: cached.timestamp,
      };
    }
    return { ...result, stale: false, cachedAt: null };
  };
}

const getClaudeUsage = withUsageCache('claude', 'claude', fetchClaudeUsageResult);
const getCodexUsage = withUsageCache('codex', 'codex', fetchCodexUsageResult);

module.exports = { getClaudeUsage, getCodexUsage };
