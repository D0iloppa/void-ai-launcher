'use strict';
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ── 기본 스키마 ───────────────────────────────────────────
const DEFAULT_SCHEMA = {
  tokens: {
    anthropic: {},   // claude CLI
    openai:    {},   // codex CLI
    google:    {},   // agy (Antigravity / Gemini)
  },
};

// ── 날짜 포맷 ─────────────────────────────────────────────
function fmtDate(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── 파일 R/W ──────────────────────────────────────────────
function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    save(DEFAULT_SCHEMA);
    return JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
  }
}

function save(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ── Token API ─────────────────────────────────────────────

function getServiceTokens(service) {
  return load().tokens?.[service] || {};
}

function getAllTokens() {
  return load().tokens || {};
}

function getToken(service, alias = null) {
  const tokens = getServiceTokens(service);
  if (alias) return tokens[alias]?.token || null;
  const keys = Object.keys(tokens);
  return keys.length > 0 ? tokens[keys[0]].token : null;
}

function setToken(service, alias, token) {
  const cfg = load();
  if (!cfg.tokens)          cfg.tokens = {};
  if (!cfg.tokens[service]) cfg.tokens[service] = {};
  cfg.tokens[service][alias] = { token, reg_dt: fmtDate() };
  save(cfg);
}

function renameToken(service, oldAlias, newAlias) {
  const cfg = load();
  const entry = cfg.tokens?.[service]?.[oldAlias];
  if (!entry) return false;
  cfg.tokens[service][newAlias] = entry;
  delete cfg.tokens[service][oldAlias];
  save(cfg);
  return true;
}

function deleteToken(service, alias) {
  const cfg = load();
  if (!cfg.tokens?.[service]?.[alias]) return false;
  delete cfg.tokens[service][alias];
  save(cfg);
  return true;
}

function addService(service) {
  const cfg = load();
  if (!cfg.tokens)          cfg.tokens = {};
  if (!cfg.tokens[service]) cfg.tokens[service] = {};
  save(cfg);
}

function deleteService(service) {
  const cfg = load();
  if (cfg.tokens?.[service] !== undefined) {
    delete cfg.tokens[service];
    save(cfg);
    return true;
  }
  return false;
}

// 첫 require 시 config.json 없으면 기본 스키마 생성
if (!fs.existsSync(CONFIG_PATH)) {
  save(DEFAULT_SCHEMA);
}

module.exports = {
  load, save,
  getAllTokens, getServiceTokens, getToken,
  setToken, renameToken, deleteToken,
  addService, deleteService,
  CONFIG_PATH,
};
