'use strict';

/*
 * voidDispatch.js — 헤드리스 계정-교차 위임(cross-account delegation).
 *
 * 목적: 현재 세션(예: a계정)이 토큰이 부족할 때, 실제 inference 를 별도 named
 * session 프로파일(예: b계정, 정당한 별도 구독)의 토큰으로 청구되도록 작업을
 * "위임"한다. 위임 대상 프로파일의 격리된 CLAUDE_CONFIG_DIR/CODEX_HOME 로
 * 헤드리스 `claude -p` / `codex exec` 를 1회 spawn 하고 결과를 반환한다.
 *
 * 왜 네이티브 서브에이전트가 아니라 이 방식인가:
 *   Claude Code 의 내장 Task/서브에이전트는 부모 프로세스의 크리덴셜을 그대로
 *   상속하므로 다른 계정으로 청구시킬 수 없다. 반면 named session 은 이미
 *   완전히 독립된 CLAUDE_CONFIG_DIR + 독립 로그인(.credentials.json)을 가지므로,
 *   그 프로파일로 별도 프로세스를 띄우면 inference 는 100% 그 계정 토큰으로
 *   청구된다. lib/runner.js applySessionEnv 의 프로파일→env 규칙을 그대로
 *   미러링한다(결합하지 않고 재현 — runner 는 대화형 launch 전용 경로라 여기와
 *   관심사가 다르다).
 *
 * 순수 함수(resolveProfile/buildDispatchEnv/buildDispatchArgs/parseResult)와
 * 부작용(delegate 의 spawn)을 분리해 전자를 유닛 테스트로 독립 검증한다.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const storage = require('./storage');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10분 — 서브에이전트 작업은 길 수 있다

// 호출자(A) 프로세스 env 에서 위임 대상(B) 자식으로 새어나가면 안 되는 변수들.
// 이게 남아 있으면 B 가 A 의 프로파일/토큰으로 인증·청구될 수 있다 —
// 계정-교차 위임의 존재 이유 자체를 무너뜨리므로 반드시 제거한 뒤 대상
// 프로파일 값으로만 다시 세팅한다. TMUX* 는 runner 의 `env -u TMUX ...` 와 동일
// 취지(중첩 tmux 오염 방지).
const LEAKY_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CODEX_HOME',
  'AGY_HOME',
  'AGY_CONFIG_DIR',
  'TMUX',
  'TMUX_PANE',
  'TMUX_PLUGIN_MANAGER_PATH',
];

// profile 이름 → { profile, toolCommand, configDir, session }.
// storage 에 등록된 세션이 있으면 그 configDir/toolCommand 를 신뢰하고,
// 없으면 resolveSessionConfigDir 로 관례적 경로를 계산한다(세션 레코드 없이도
// 이미 존재하는 프로파일 디렉토리를 가리킬 수 있게 — 관대한 해석).
function resolveProfile(profile, toolCommand) {
  if (!profile || !String(profile).trim()) {
    throw new Error('voidDispatch: 위임 대상 profile 이름이 필요합니다');
  }
  const tool = (toolCommand || 'claude').toLowerCase();
  const session = storage.getSession(profile, tool);
  const resolvedTool = (session && session.toolCommand) || tool;
  const configDir = (session && session.configDir)
    || storage.resolveSessionConfigDir(resolvedTool, profile);
  return { profile, toolCommand: resolvedTool, configDir, session: session || null };
}

// 위임 대상 프로파일의 로그인 준비 상태를 소프트 점검한다(하드 실패 아님 —
// 경고만 수집). configDir 자체가 없으면 아직 이 프로파일로 실행/로그인한 적이
// 없다는 강한 신호다.
function profileReadiness(resolved) {
  const warnings = [];
  if (!fs.existsSync(resolved.configDir)) {
    warnings.push(`configDir 없음(${resolved.configDir}) — '${resolved.profile}' 로 아직 로그인/실행한 적이 없을 수 있음`);
    return { ready: false, warnings };
  }
  const cmd = (resolved.toolCommand || 'claude').toLowerCase();
  if (cmd === 'claude') {
    const credFile = path.join(resolved.configDir, '.credentials.json');
    const linked = resolved.session && resolved.session.tokenService && resolved.session.tokenAlias;
    if (!fs.existsSync(credFile) && !linked) {
      warnings.push(`로그인 흔적 없음(.credentials.json 부재, 링크 토큰도 없음) — '${resolved.profile}' 이 실제로 로그인돼 있는지 확인`);
    }
  }
  return { ready: warnings.length === 0, warnings };
}

// runner.applySessionEnv 미러 — baseEnv 를 얕은 복사한 뒤 누수 변수를 제거하고
// 대상 프로파일의 격리 디렉토리 변수를 세팅한다. 순수 함수(baseEnv 를 인자로
// 받아 새 객체를 반환)라 테스트에서 임의 env 를 넣어 검증할 수 있다.
function buildDispatchEnv(baseEnv, resolved) {
  const env = { ...(baseEnv || {}) };
  for (const k of LEAKY_ENV) delete env[k];

  const cmd = (resolved.toolCommand || 'claude').toLowerCase();
  fs.mkdirSync(resolved.configDir, { recursive: true, mode: 0o700 });

  if (cmd === 'codex') {
    env.CODEX_HOME = resolved.configDir;
    return env;
  }
  if (cmd === 'agy') {
    env.AGY_HOME = resolved.configDir;
    env.AGY_CONFIG_DIR = resolved.configDir;
    return env;
  }

  env.CLAUDE_CONFIG_DIR = resolved.configDir;

  // 링크된 토큰(선택) — runner.applySessionEnv 와 동일 규칙. 링크가 없으면
  // 대상 configDir 의 .credentials.json(대화형 로그인 산물)에 의존한다.
  if (cmd === 'claude' && resolved.session && resolved.session.tokenService && resolved.session.tokenAlias) {
    try {
      const token = require('./config').getToken(resolved.session.tokenService, resolved.session.tokenAlias);
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch { /* 토큰 조회 실패는 무시 — 로그인 크리덴셜로 폴백 */ }
  }
  return env;
}

// toolCommand + prompt + 옵션 → 헤드리스 실행 인자 배열. claude 는 -p(print)
// 비대화 모드 + JSON 출력, codex 는 exec 서브커맨드. 순수 함수.
function buildDispatchArgs(toolCommand, prompt, opts = {}) {
  const cmd = (toolCommand || 'claude').toLowerCase();

  if (cmd === 'claude') {
    const args = ['-p', String(prompt), '--output-format', 'json'];
    if (opts.model) args.push('--model', String(opts.model));
    if (opts.permissionMode) args.push('--permission-mode', String(opts.permissionMode));
    if (opts.allowedTools) {
      const list = Array.isArray(opts.allowedTools) ? opts.allowedTools.join(',') : String(opts.allowedTools);
      if (list) args.push('--allowedTools', list);
    }
    return args;
  }

  if (cmd === 'codex') {
    const args = ['exec', String(prompt)];
    if (opts.model) args.push('-m', String(opts.model));
    return args;
  }

  throw new Error(`voidDispatch: 헤드리스 위임을 지원하지 않는 toolCommand '${toolCommand}' (claude|codex 만 가능)`);
}

// 헤드리스 실행 stdout → 정규화된 결과. claude --output-format json 은 단일 JSON
// 객체({type,result,session_id,total_cost_usd,usage,...})를 낸다 — result 본문과
// 사용량/비용을 뽑아 호출자가 "B 토큰을 얼마나 썼는지" 볼 수 있게 한다. 파싱
// 실패나 codex(평문)면 stdout 을 그대로 result 로 돌려준다. 순수 함수.
function parseResult(toolCommand, stdout) {
  const cmd = (toolCommand || '').toLowerCase();
  const raw = stdout == null ? '' : String(stdout);
  if (cmd === 'claude') {
    try {
      const obj = JSON.parse(raw);
      return {
        result: obj.result != null ? obj.result : raw,
        usage: obj.usage || null,
        costUsd: obj.total_cost_usd != null ? obj.total_cost_usd : null,
        sessionId: obj.session_id || null,
        isError: !!obj.is_error,
      };
    } catch {
      return { result: raw, usage: null, costUsd: null, sessionId: null, isError: false };
    }
  }
  return { result: raw, usage: null, costUsd: null, sessionId: null, isError: false };
}

// 등록된 named session 프로파일 목록 + 각 프로파일의 위임 준비 상태.
// 발신측(A) 의 Claude 가 "어느 계정으로 위임할 수 있는지" 발견하는 용도.
function listProfiles(toolCommand) {
  const tool = toolCommand ? String(toolCommand).toLowerCase() : null;
  let sessions = [];
  try { sessions = storage.getSessions(); } catch { return []; }
  return sessions
    .filter(s => !tool || (s.toolCommand || 'claude') === tool)
    .map(s => {
      const resolved = resolveProfile(s.name, s.toolCommand);
      const r = profileReadiness(resolved);
      return {
        name: s.name,
        toolCommand: resolved.toolCommand,
        configDir: resolved.configDir,
        ready: r.ready,
        warnings: r.warnings,
      };
    });
}

// ── 위임 실행(부작용) ──────────────────────────────────────────────────────
// prompt 를 opts.profile 프로파일로 헤드리스 실행하고 결과를 Promise 로 반환한다.
// 절대 reject 하지 않는다 — 항상 { ok, ... } 로 resolve 해 MCP 계층이 오류를
// 구조화된 결과로 그대로 전달하게 한다(fail-soft).
function delegate(prompt, opts = {}) {
  return new Promise((resolve) => {
    if (!prompt || !String(prompt).trim()) {
      return resolve({ ok: false, error: 'prompt 가 비어 있습니다' });
    }

    let resolved;
    try {
      resolved = resolveProfile(opts.profile, opts.toolCommand);
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }

    const command = resolved.toolCommand;
    let args;
    try {
      args = buildDispatchArgs(command, prompt, opts);
    } catch (e) {
      return resolve({ ok: false, error: e.message, profile: resolved.profile });
    }

    const readiness = profileReadiness(resolved);
    const env = buildDispatchEnv(process.env, resolved);
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: `spawn 실패: ${e.message}`, profile: resolved.profile, toolCommand: command });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `실행 오류: ${e.message}` + (e.code === 'ENOENT' ? ` ('${command}' 가 PATH 에 없습니다)` : ''),
        profile: resolved.profile,
        toolCommand: command,
        warnings: readiness.warnings,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseResult(command, stdout);
      resolve({
        ok: !timedOut && code === 0 && !parsed.isError,
        profile: resolved.profile,
        toolCommand: command,
        configDir: resolved.configDir,
        exitCode: code,
        timedOut,
        result: parsed.result,
        usage: parsed.usage,
        costUsd: parsed.costUsd,
        sessionId: parsed.sessionId,
        stderr: stderr.trim() || null,
        warnings: readiness.warnings,
      });
    });
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LEAKY_ENV,
  resolveProfile,
  profileReadiness,
  buildDispatchEnv,
  buildDispatchArgs,
  parseResult,
  listProfiles,
  delegate,
};
