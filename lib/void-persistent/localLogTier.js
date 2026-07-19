'use strict';

// void-persistent — phase 3 (usage local-log tier), ALWAYS-ON.
//
// Detects Claude rate-limit state by parsing the CLI's own local session
// `*.jsonl` logs — ZERO network, ZERO PTY. Wired into lib/usageMeter.js as
// tier-0 (checked before the OAuth/backoff logic), so it can only ever
// *reduce* API/PTY load, never add risk: a positive answer here means the
// existing chain is skipped for this call; any other outcome (including a
// parser error) falls straight through to the unchanged existing chain.
//
// Ported from ref/mobius/Sources/MobiusCore/RateLimitParser.swift — see that
// file for the Korean design commentary this mirrors. Empirically confirmed
// against a real Claude session log (2026-06-27 rate_limit event):
//   { error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 429,
//     message: { content: [{ type: "text",
//       text: "You've hit your session limit · resets 4:10pm (Asia/Seoul)" }] } }
//
// Pure fs/path only — no network, no child_process, no node-pty.

const fs = require('fs');
const path = require('path');

const RECENT_WINDOW_MS = 15 * 60 * 1000; // only bother with logs touched in the last 15 min
const TAIL_BYTES = 64 * 1024;

// ── candidate / text extraction ─────────────────────────────────────────

// A JSONL line is a rate-limit candidate iff it carries the structured
// error fields the Claude CLI itself writes for a 429. Legacy pipe-epoch
// lines (no structured fields) are intentionally NOT treated as candidates
// here — mobius's P4 fallback is a compatibility shim for very old logs we
// have no evidence still exist in this codebase's supported CLI versions.
function isRateLimitCandidate(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.error === 'rate_limit') return true;
  return obj.isApiErrorMessage === true && obj.apiErrorStatus === 429;
}

// message.content[].text joined; falls back to a top-level "text" field for
// legacy/abbreviated lines.
function eventText(obj) {
  if (obj && obj.message && Array.isArray(obj.message.content)) {
    const joined = obj.message.content
      .map((c) => (c && typeof c.text === 'string' ? c.text : null))
      .filter((t) => t !== null)
      .join('\n');
    if (joined) return joined;
  }
  return typeof (obj && obj.text) === 'string' ? obj.text : '';
}

function lineTimestamp(obj) {
  const s = obj && obj.timestamp;
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// ── reset-time regexes (ported from RateLimitParser.swift) ─────────────

// P1/P5 time-only: "resets 7:30pm (Asia/Seoul)", "resets at 8am (Asia/Seoul)"
const TIME_ONLY_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
// P2 date+time: "resets Jul 13 at 8am (Asia/Seoul)"
const DATE_AND_TIME_RE = /resets?\s+(?:at\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
// P3: monthly spend limit — no reset time
const MONTHLY_SPEND_RE = /hit your monthly spend limit/i;
// P5 lenient: account-limit wording + "resets" mentioned, but no readable time
const LENIENT_LIMIT_RE = /hit your (?:usage|session|weekly)\s+limit\b.*\bresets?\b/i;

const NOT_YOUR_USAGE_LIMIT_RE = /not your usage limit/i;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Resolve wall-clock hour/minute (+ optional month/day) in the given IANA
// timezone to an epoch-ms Date, rolling forward to the next future
// occurrence relative to `reference` (mirrors RateLimitParser.swift's
// Calendar/timezone rolling logic).
function resolveResetTime({ monthAbbr, day, hour, minute, meridiem, tzName, reference }) {
  const hour12 = Number.parseInt(hour, 10);
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null;
  const mer = (meridiem || '').toLowerCase();
  if (mer !== 'am' && mer !== 'pm') return null;
  let hour24 = hour12 % 12;
  if (mer === 'pm') hour24 += 12;
  const min = minute ? Number.parseInt(minute, 10) : 0;

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date(reference));
  } catch {
    return null; // unknown/invalid IANA tz name
  }
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  let year = get('year');
  let month = get('month') - 1; // 0-based to match MONTHS
  let dayNum = get('day');

  // formatToParts gives us the reference's local Y/M/D in the target tz;
  // Date.UTC treats those components as if they were UTC, which — for a
  // fixed-offset-per-day tz like these IANA zones — reproduces the same
  // wall-clock instant we want (matches the Swift Calendar/tz approach's
  // effect: components are interpreted "as lived in that timezone").
  if (monthAbbr && day) {
    const m = MONTHS[monthAbbr.toLowerCase()];
    const d = Number.parseInt(day, 10);
    if (m === undefined || !Number.isFinite(d)) return null;
    month = m;
    dayNum = d;
  }

  let candidate = tzWallClockToUtcMs(tzName, year, month, dayNum, hour24, min);
  if (candidate === null) return null;

  if (monthAbbr && day) {
    if (candidate < reference) {
      candidate = tzWallClockToUtcMs(tzName, year + 1, month, dayNum, hour24, min);
    }
  } else if (candidate <= reference) {
    // already passed today -> roll to tomorrow
    const tomorrow = addDaysInTz(tzName, year, month, dayNum, 1);
    candidate = tzWallClockToUtcMs(tzName, tomorrow.year, tomorrow.month, tomorrow.day, hour24, min);
  }
  return candidate;
}

// Convert a Y/M/D h:m wall-clock reading *in tzName* to an epoch-ms UTC
// timestamp, by bisecting against Intl's rendering of candidate UTC instants
// (works for any IANA zone, including non-whole-hour offsets, without a
// timezone-database dependency).
function tzWallClockToUtcMs(tzName, year, month, day, hour, minute) {
  // First guess: treat the wall-clock reading as if it were UTC, then
  // correct by the difference between that guess's rendering in tzName and
  // the target — at most two iterations converges for all real-world zones.
  let guess = Date.UTC(year, month, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false,
      }).formatToParts(new Date(guess));
    } catch {
      return null;
    }
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const renderedMs = Date.UTC(get('year'), get('month') - 1, get('day'),
      get('hour') === 24 ? 0 : get('hour'), get('minute'), get('second'));
    const targetMs = Date.UTC(year, month, day, hour, minute, 0);
    const diff = targetMs - renderedMs;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function addDaysInTz(tzName, year, month, day, deltaDays) {
  // Use UTC arithmetic on the Y/M/D triple — safe because these are pure
  // calendar-date components, not instants.
  const d = new Date(Date.UTC(year, month, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

// Parse a single event-text string into a reset epoch-ms, or a sentinel:
//   - number: resolved reset time (epoch ms)
//   - null: account-limit event with no readable time (P3 monthly-spend, P5 lenient)
//   - undefined: not a rate-limit event at all (no pattern matched, or excluded)
// `reference` is the epoch-ms to roll relative to (line's own timestamp, or now).
function parseResetTime(text, reference) {
  if (!text) return undefined;
  if (NOT_YOUR_USAGE_LIMIT_RE.test(text)) return undefined;

  if (MONTHLY_SPEND_RE.test(text)) return null;

  let m = DATE_AND_TIME_RE.exec(text);
  if (m) {
    const resolved = resolveResetTime({
      monthAbbr: m[1], day: m[2], hour: m[3], minute: m[4], meridiem: m[5], tzName: m[6],
      reference,
    });
    if (resolved !== null) return resolved;
  }

  m = TIME_ONLY_RE.exec(text);
  if (m) {
    const resolved = resolveResetTime({
      monthAbbr: null, day: null, hour: m[1], minute: m[2], meridiem: m[3], tzName: m[4],
      reference,
    });
    if (resolved !== null) return resolved;
  }

  if (LENIENT_LIMIT_RE.test(text)) return null;

  return undefined;
}

// Parse one already-decoded JSONL object. Returns:
//   { resetsAt: number|null } if it's a genuine account rate-limit event
//   null otherwise (not a candidate, or excluded, or unparseable)
function parseLogLine(obj, now) {
  if (!isRateLimitCandidate(obj)) return null;
  const text = eventText(obj);
  if (!text) return null;
  const reference = lineTimestamp(obj) || now;
  const resetsAt = parseResetTime(text, reference);
  if (resetsAt === undefined) return null;
  return { resetsAt };
}

// ── filesystem scan ──────────────────────────────────────────────────────

function findJsonlFiles(projectsDir, now) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const dir = ent.parentPath || ent.path || projectsDir;
    const full = path.join(dir, ent.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs <= RECENT_WINDOW_MS) out.push(full);
    } catch {
      // file vanished mid-scan — ignore
    }
  }
  return out;
}

// Read only the tail of a (potentially huge) JSONL file and return complete
// lines (the first line of the tail slice is dropped as likely-partial).
function readTailLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // drop probably-partial first line
    return lines.filter((l) => l.trim() !== '');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// Public: scan the given Claude configDir's recent session logs for the most
// recent rate-limit signal.
//
// Returns:
//   { limited: true,  resetsAt: number|null, source: 'local-log' }  — an
//     active (not-yet-passed) account rate limit was found.
//   { limited: false, resetsAt: null,        source: 'local-log' }  — recent
//     logs exist and show no active limit (a clear negative signal).
//   null — nothing relevant found (no recent logs at all); caller should
//     fall through to the rest of the usage chain.
function checkLocalRateLimit(configDir) {
  if (!configDir) return null;
  const projectsDir = path.join(configDir, 'projects');
  const now = Date.now();
  const files = findJsonlFiles(projectsDir, now);
  if (files.length === 0) return null;

  let latest = null; // { resetsAt, lineTs }
  for (const file of files) {
    const lines = readTailLines(file);
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const hit = parseLogLine(obj, now);
      if (!hit) continue;
      const ts = lineTimestamp(obj) || now;
      if (!latest || ts > latest.lineTs) latest = { resetsAt: hit.resetsAt, lineTs: ts };
    }
  }

  if (!latest) return { limited: false, resetsAt: null, source: 'local-log' };

  // resetsAt === null means "account-limit event, but no readable reset
  // time" (P3/P5) — conservatively still report limited so callers don't
  // silently miss a real limit, mirroring mobius's effectiveResetsAt policy
  // at the call site (24h fallback is the *caller's* job, not ours).
  if (latest.resetsAt !== null && latest.resetsAt <= now) {
    return { limited: false, resetsAt: null, source: 'local-log' };
  }
  return { limited: true, resetsAt: latest.resetsAt, source: 'local-log' };
}

module.exports = {
  checkLocalRateLimit,
  isRateLimitCandidate,
  eventText,
  parseResetTime,
  parseLogLine,
};
