'use strict';

// void-persistent — omniroute-backed usage tier (TOP priority in usageMeter.js's
// claude/codex chains). Shells out to the docker-side router (`router.py void_usage`)
// which does the privileged omniroute management-API call and already strips any
// OAuth/access tokens — this module only ever sees SAFE usage JSON.
//
// Fail-open throughout: router path unset/missing, spawn error, timeout, non-zero
// exit, or unparseable JSON all resolve to `null` so the caller falls through to
// the existing chain unchanged. Mirrors localLogTier.js's contract — a positive
// answer here means "skip the rest of the chain", anything else is a no-op.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROUTER_PATH = '/mnt/c/DEV/docker/models/router.py';
const SPAWN_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15_000;

// ── router path (configurable via configDb settings) ────────────────────

function routerPath() {
  let configured = '';
  try {
    const { getSettings } = require('../configDb');
    const settings = getSettings() || {};
    if (typeof settings.omniroute_router_path === 'string') configured = settings.omniroute_router_path.trim();
  } catch {
    // configDb unavailable — fall back to the default path below
  }
  const p = configured || DEFAULT_ROUTER_PATH;
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// ── fleet fetch (whole `accounts` array, TTL-cached) ─────────────────────

let cache = null; // { expiresAt, accounts }

function fetchAccountsLive() {
  const rp = routerPath();
  if (!rp) return null;
  let result;
  try {
    result = spawnSync('python3', [rp, 'void_usage'], { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.accounts) ? parsed.accounts : null;
  } catch {
    return null;
  }
}

function fetchAccounts() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.accounts;
  const accounts = fetchAccountsLive();
  cache = { expiresAt: now + CACHE_TTL_MS, accounts };
  return accounts;
}

// ── identity derivation ───────────────────────────────────────────────────

// Bounded, skips the (potentially huge) `projects` subtree — oauthAccount is
// expected to answer directly; the shallow walk only covers structural variants.
function findEmailShallow(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  if (typeof obj.emailAddress === 'string' && obj.emailAddress.trim()) return obj.emailAddress.trim();
  if (typeof obj.email === 'string' && obj.email.trim()) return obj.email.trim();
  for (const key of Object.keys(obj)) {
    if (key === 'projects') continue;
    const v = obj[key];
    if (v && typeof v === 'object') {
      const found = findEmailShallow(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function deriveClaudeEmail(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
    if (parsed && parsed.oauthAccount) {
      const email = parsed.oauthAccount.emailAddress || parsed.oauthAccount.email;
      if (typeof email === 'string' && email.trim()) return email.trim();
    }
    return findEmailShallow(parsed, 0);
  } catch {
    return null;
  }
}

function deriveCodexAccountId(homeDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(homeDir, 'auth.json'), 'utf8'));
    const id = parsed && parsed.tokens && parsed.tokens.account_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

// Decodes a JWT's payload without verifying the signature — this is a read-only
// local metadata peek (extracting the `email` claim off a token already on disk
// for the user's own agy session), never a trust decision.
function decodeJwtEmail(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    const email = payload && payload.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

// agy (Antigravity CLI) has no session/weekly usage of its own — only omniroute's
// per-model gemini quotas for the "agy" connection. Identity is a Google account
// email; the credential shape isn't fully known ahead of time so this tries a
// few plausible file/field combinations, falling shallow-search + JWT decode,
// then falls back to the global (non-session) oauth token location.
const AGY_CRED_FILENAMES = [
  'antigravity-oauth-token', 'oauth_creds.json', 'oauth-creds.json',
  'credentials.json', '.credentials.json', 'auth.json',
];
const GLOBAL_AGY_TOKEN_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

function emailFromAgyCredFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const direct = findEmailShallow(parsed, 0);
    if (direct) return direct;
    const idToken = parsed.id_token || (parsed.tokens && parsed.tokens.id_token);
    if (idToken) {
      const fromJwt = decodeJwtEmail(idToken);
      if (fromJwt) return fromJwt;
    }
    return null;
  } catch {
    return null;
  }
}

function deriveAgyEmail(overrideDir) {
  const configDir = overrideDir || process.env.AGY_CONFIG_DIR || process.env.AGY_HOME || null;
  if (configDir) {
    for (const filename of AGY_CRED_FILENAMES) {
      const email = emailFromAgyCredFile(path.join(configDir, filename));
      if (email) return email;
    }
  }
  // Fallback: the global (unnamed-session) antigravity oauth token.
  return emailFromAgyCredFile(GLOBAL_AGY_TOKEN_PATH);
}

// ── lookup ─────────────────────────────────────────────────────────────

function lookupOmnirouteUsage(provider, identity) {
  try {
    const accounts = fetchAccounts();
    if (!accounts) return null;
    const providerAccounts = accounts.filter((a) => a && a.provider === provider);

    let match = null;
    if (provider === 'claude') {
      const email = identity && identity.email;
      if (!email) return null;
      match = providerAccounts.find((a) => a.email === email) || null;
    } else if (provider === 'codex') {
      const accountId = identity && identity.accountId;
      if (accountId) match = providerAccounts.find((a) => a.account_id === accountId) || null;
      // No account_id available to match on (e.g. auth.json unreadable) — if the
      // fleet only has one codex account, it's unambiguous which one applies.
      if (!match && !accountId && providerAccounts.length === 1) match = providerAccounts[0];
    } else if (provider === 'agy') {
      const email = identity && identity.email;
      if (email) match = providerAccounts.find((a) => a.email === email) || null;
      // agy is typically a single connected account — if email derivation failed
      // or didn't match exactly, and there's exactly one agy account, use it.
      if (!match && providerAccounts.length === 1) match = providerAccounts[0];
    }
    if (!match) return null;

    const { makeWindow } = require('../usageMeter');
    const session = match.session ? makeWindow(match.session.usedPercent, match.session.resetsAt) : null;
    const weekly = match.weekly ? makeWindow(match.weekly.usedPercent, match.weekly.resetsAt) : null;
    if (!session && !weekly) return null;
    const fetchedAtMs = match.fetchedAt ? Date.parse(match.fetchedAt) : NaN;
    return { session, weekly, fetchedAt: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null };
  } catch {
    return null;
  }
}

module.exports = {
  routerPath,
  fetchAccounts,
  deriveClaudeEmail,
  deriveCodexAccountId,
  deriveAgyEmail,
  lookupOmnirouteUsage,
};
