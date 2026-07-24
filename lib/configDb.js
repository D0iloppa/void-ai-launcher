'use strict';

// 앱 설정 저장소 — dJinn (vendor/dJinn, @d0iloppa/djinn) 백엔드.
// 두 개의 레거시 설정 소스를 단일 임베디드 DB 로 통합한다:
//   • config.json (repo root)  — API 토큰 저장소 (구 lib/config.js)
//   • config.yml  (repo root)  — tools / theme / settings (구 launcher.js 의 yaml.load)
//
// usage-cache.djinn.db 와는 별도 파일(config.djinn.db)로 관심사를 분리한다.
//
// dJinn 은 better-sqlite3 위의 schemaless JSON 문서 저장소다. 우리는 raw SQL 을
// 직접 다루지 않고 dJinn 의 실제 API (vendor/dJinn/src/db.js 기준 — README 는
// 존재하지 않는 Schema 클래스를 문서화하고 있어 신뢰하지 않는다) 위에 얹는다.
//
// ── require 실패 시의 폴백 (usageDb.js 와 결정적으로 다른 지점) ──────────────
// usageDb.js 는 dJinn require 가 깨지면 조용히 no-op 으로 degrade 한다 — 그건
// "이번 실행엔 사용량 캐시 없음" 이라는 미관상의 문제일 뿐이다. 그러나 이 모듈이
// 죽으면 앱은 부팅에 필요한 tools/theme 자체가 없어진다. 따라서 비대칭 폴백을 둔다:
//   • 설정 접근자(getTools/getTheme/getSettings) — dJinn 불가 시 config.yml
//     (또는 이미 마이그레이션된 config.yml.migrated) 을 js-yaml 로 직접 재파싱해
//     실제 값을 돌려준다. 설정은 부팅 필수이므로 빈 값/ null 로 degrade 하면 안 된다.
//   • 토큰 접근자(getToken/getAllTokens/...) — dJinn 불가 시 빈 값으로 degrade 해도
//     된다. 누락된 API 토큰은 사용 시점에 "미설정" 으로 처리되는 복구 가능한 상태이지
//     부팅을 막지 않기 때문이다.

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { storageDir } = require('./storage');

const COLLECTION = 'config';

// 신규 설치(레거시 config.json 부재) 시 예전 lib/config.js 가 require 시점에
// 자동 생성하던 기본 토큰 서비스 — 토큰 UI 의 기존 동작을 보존하기 위함.
const DEFAULT_SERVICES = ['anthropic', 'openai', 'google'];
// config.yml 도 config.yml.migrated 도 없는 완전 신규 클론(예: git clone 직후)에서
// getTools() 가 빈 배열을 반환하면 런처에 실행할 도구가 하나도 없는 상태가 된다.
// 예전 config.yml 의 기본값을 코드로 보존해 부팅 시 최소 한 벌의 도구는 항상 뜨게 한다.
const DEFAULT_TOOLS = [
  { name: 'CLAUDE CODE', command: 'claude', args: [] },
  { name: 'CODEX', command: 'codex', args: [] },
  { name: 'AGY', command: 'agy', args: [] },
];
// 기본 서비스 시드가 1회만 일어나도록 하는 마커 (token:/service: 접두사와 겹치지
// 않으므로 getAllTokens 스캔에는 잡히지 않는다).
const BOOTSTRAP_ID = 'meta:tokens_bootstrapped';

let db = null;
let initAttempted = false;

function dbPath() {
  return path.join(storageDir(), 'config.djinn.db');
}
// 레거시 파일은 storageDir() 이 아니라 repo root 에 있다 (구 lib/config.js 의
// CONFIG_PATH 관례를 그대로 따른다 — 두 경로 관례를 혼동하지 말 것).
function legacyConfigJsonPath() {
  return path.join(__dirname, '..', 'config.json');
}
function legacyConfigYmlPath() {
  return path.join(__dirname, '..', 'config.yml');
}

// ── id 스킴 (단일 'config' 컬렉션 내 접두사 네임스페이싱 —
//    usage-cache.djinn.db 의 `provider:key` vs `ratelimit:provider:key` 선례를 그대로 따름) ──
//   token:<service>:<alias> → { service, alias, token, reg_dt }
//   service:<service>       → { service }                (빈 서비스 표현용 마커)
//   settings:tools          → { tools: [...] }
//   settings:theme          → { name, colors? }
//   settings:general        → { anonymous_home_prefix, double_width_emoji, wrapper_hpad, wrapper_vpad, windows_use_tmux, omniroute_usage_refresh_interval_sec }
//   void_persistent:switcher → { enabled, persistDir, pool:[...], activePoolIndex, autoMode, autoState }
//                              단일 로우, void-persistent 계정 스위처(phase 1: 수동 전환만) 설정.
//                              autoMode/autoState 는 phase 2 를 위해 영속화만 하고 phase 1 에서는 사용하지 않는다.
//                              (구 키 'experiments:switcher' → 최초 getVoidPersistentSwitcher() 호출 시
//                              1회 자동 마이그레이션 — 아래 getVoidPersistentSwitcher 참고.)
//
// OAuth CLI 토큰(`claude setup-token` 으로 발급)은 별도 스킴이 아니라 위의
// token:<service>:<alias> 스킴을 그대로 재사용한다 — service 값으로 'claude' 를
// 관례로 사용해 anthropic/openai/google 같은 순수 API 키 서비스와 섞이지 않게 한다.
// (세션/개인비서별 전용 토큰이라는 개념은 폐기 — 사용자가 임의 alias 로 등록한 뒤
// lib/assistant.js 가 getToken('claude') 로 아무 alias나 골라 사용한다.)
const TOKEN_PREFIX   = 'token:';
const SERVICE_PREFIX = 'service:';
// encodeURIComponent escapes ':' so distinct (service, alias) pairs can never
// collide onto the same id (e.g. tokenId('a:b','c') vs tokenId('a','b:c') —
// independent review caught this as a silent-overwrite risk with raw concat).
function tokenId(service, alias) { return `${TOKEN_PREFIX}${encodeURIComponent(service)}:${encodeURIComponent(alias)}`; }
function serviceId(service)      { return `${SERVICE_PREFIX}${service}`; }

function fmtDate(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── 레거시 마이그레이션 ────────────────────────────────────────────────
// usageDb.js 의 migrateLegacyJson() 규율을 그대로 따른다: skip-if-present,
// 비파괴적(rename to .migrated, 절대 삭제/이동 안 함), 파일별 try/catch 로
// 감싸 손상된 레거시 파일이 DB 부팅을 막지 못하게 한다.

function migrateLegacyConfigJson(instance) {
  try {
    const jsonPath = legacyConfigJsonPath();
    if (fs.existsSync(jsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const tokens = (parsed && typeof parsed === 'object' && parsed.tokens) || {};
      for (const service of Object.keys(tokens)) {
        // 서비스 마커 (토큰이 없는 빈 서비스도 보존)
        if (!instance.get(COLLECTION, serviceId(service))) {
          instance.put(COLLECTION, serviceId(service), { service });
        }
        const aliases = tokens[service];
        if (!aliases || typeof aliases !== 'object') continue;
        for (const alias of Object.keys(aliases)) {
          const id = tokenId(service, alias);
          if (instance.get(COLLECTION, id)) continue; // 이미 있으면 건드리지 않음
          const entry = aliases[alias] || {};
          instance.put(COLLECTION, id, {
            service, alias,
            token:  entry.token  || '',
            reg_dt: entry.reg_dt || fmtDate(),
          });
        }
      }
      fs.renameSync(jsonPath, jsonPath + '.migrated');
      instance.put(COLLECTION, BOOTSTRAP_ID, { done: true });
    } else if (!instance.get(COLLECTION, BOOTSTRAP_ID)) {
      // 레거시 config.json 이 애초에 없던 신규 설치 — 예전 lib/config.js 가
      // require 시 생성하던 기본 스키마(빈 서비스 3개)를 DB 에 시드해 토큰 UI 의
      // 기존 동작을 보존한다. BOOTSTRAP 마커로 1회만 수행하여 사용자가 나중에 지운
      // 서비스를 재실행 때 되살리지 않도록 한다.
      for (const service of DEFAULT_SERVICES) {
        if (!instance.get(COLLECTION, serviceId(service))) {
          instance.put(COLLECTION, serviceId(service), { service });
        }
      }
      instance.put(COLLECTION, BOOTSTRAP_ID, { done: true });
    }
  } catch {
    // 손상된/부분적인 레거시 파일 — 그냥 두고 DB 는 정상 동작.
  }
}

function migrateLegacyConfigYml(instance) {
  try {
    const ymlPath = legacyConfigYmlPath();
    if (!fs.existsSync(ymlPath)) return;
    const parsed = yaml.load(fs.readFileSync(ymlPath, 'utf8')) || {};
    if (!instance.get(COLLECTION, 'settings:tools')) {
      instance.put(COLLECTION, 'settings:tools', { tools: Array.isArray(parsed.tools) ? parsed.tools : [] });
    }
    if (!instance.get(COLLECTION, 'settings:theme')) {
      instance.put(COLLECTION, 'settings:theme', (parsed.theme && typeof parsed.theme === 'object') ? parsed.theme : {});
    }
    if (!instance.get(COLLECTION, 'settings:general')) {
      instance.put(COLLECTION, 'settings:general', (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {});
    }
    fs.renameSync(ymlPath, ymlPath + '.migrated');
  } catch {
    // 손상된/부분적인 레거시 파일 — 그냥 두고 DB 는 정상 동작.
  }
}

function getDb() {
  if (db) return db;
  // require 실패(패키지 부재)는 프로세스 수명 내내 변하지 않으므로 영구 캐시한다.
  // 반면 인스턴스 생성 실패(예: SQLITE_BUSY 같은 일시적 오류)는 initAttempted 로
  // 영구 차단하지 않는다 — 독립 리뷰에서 한 번의 일시적 실패로 프로세스 전체
  // 수명 동안 DB 가 영구 비활성화되는 문제로 지적됨.
  if (initAttempted) return null;

  let DJinn;
  try {
    ({ DJinn } = require('@d0iloppa/djinn'));
  } catch {
    initAttempted = true; // 패키지 자체가 없음 — 재시도해도 소용없으므로 영구 차단
    return null; // 설정 접근자는 아래에서 config.yml 로 폴백, 토큰 접근자는 빈 값으로 degrade
  }

  try {
    const file = dbPath();
    const isNew = !fs.existsSync(file);
    // DJinn 생성자가 journal_mode=WAL 을 설정한다. busy_timeout 은 설정하지 않으므로
    // 다중 프로세스 안전성을 위해 직접 추가 — DJinn 은 내부 better-sqlite3 를
    // instance.db 로 노출한다. 단일 컬렉션이며 exact id 조회 + 전체 스캔만 하므로
    // 인덱스는 두지 않는다.
    const instance = new DJinn(file, { cacheSize: 64 });
    try { instance.db.pragma('busy_timeout = 3000'); } catch {}
    instance.define(COLLECTION, { indexes: [] });
    if (isNew) {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    migrateLegacyConfigJson(instance);
    migrateLegacyConfigYml(instance);
    db = instance;
    return db;
  } catch {
    return null;
  }
}

// ── 설정 폴백 (dJinn 불가 시 config.yml 직접 파싱) ────────────────────────
function readYmlFallback() {
  try {
    const ymlPath = legacyConfigYmlPath();
    const p = fs.existsSync(ymlPath)              ? ymlPath
            : fs.existsSync(ymlPath + '.migrated') ? ymlPath + '.migrated'
            : null;
    if (!p) return {};
    return yaml.load(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

// get() 이 doc 에 붙여 돌려주는 id 필드를 제거한다.
function stripId(doc) {
  if (!doc) return doc;
  const { id, ...rest } = doc;
  return rest;
}

// ── 토큰 접근자 (구 lib/config.js 와 동일한 외부 동작) ─────────────────────

function getAllTokens() {
  const instance = getDb();
  if (!instance) return {}; // 토큰은 부팅 필수가 아니므로 빈 값으로 degrade 가능
  try {
    // where 절 없는 find → _buildWhere 가 base SQL 을 그대로 반환(전체 스캔).
    // vendor/dJinn/src/db.js 의 _buildWhere 로 직접 확인함.
    const rows = instance.find(COLLECTION, {});
    const result = {};
    // 1) 서비스 마커 (빈 서비스 포함)
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id.startsWith(SERVICE_PREFIX)) {
        const svc = row.service;
        if (svc && !result[svc]) result[svc] = {};
      }
    }
    // 2) 토큰 문서
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id.startsWith(TOKEN_PREFIX)) {
        const { service, alias, token, reg_dt } = row;
        if (!service || !alias) continue;
        if (!result[service]) result[service] = {};
        result[service][alias] = { token, reg_dt };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getToken(service, alias = null) {
  const instance = getDb();
  if (!instance) return null;
  try {
    if (alias) {
      const doc = instance.get(COLLECTION, tokenId(service, alias));
      return (doc && doc.token) ? doc.token : null;
    }
    const tokens = getAllTokens()[service] || {};
    const keys = Object.keys(tokens);
    return keys.length > 0 ? tokens[keys[0]].token : null;
  } catch {
    return null;
  }
}

function setToken(service, alias, token) {
  const instance = getDb();
  if (!instance) return;
  try {
    if (!instance.get(COLLECTION, serviceId(service))) {
      instance.put(COLLECTION, serviceId(service), { service });
    }
    instance.put(COLLECTION, tokenId(service, alias), { service, alias, token, reg_dt: fmtDate() });
  } catch {}
}

function renameToken(service, oldAlias, newAlias) {
  const instance = getDb();
  if (!instance) return false;
  try {
    const entry = instance.get(COLLECTION, tokenId(service, oldAlias));
    if (!entry) return false;
    instance.put(COLLECTION, tokenId(service, newAlias), {
      service, alias: newAlias, token: entry.token, reg_dt: entry.reg_dt,
    });
    instance.del(COLLECTION, tokenId(service, oldAlias));
    return true;
  } catch {
    return false;
  }
}

function deleteToken(service, alias) {
  const instance = getDb();
  if (!instance) return false;
  try {
    const id = tokenId(service, alias);
    if (!instance.get(COLLECTION, id)) return false;
    instance.del(COLLECTION, id);
    // 구 동작: 마지막 alias 를 지워도 서비스(빈 객체)는 남는다 — service 마커가 유지.
    return true;
  } catch {
    return false;
  }
}

function addService(service) {
  const instance = getDb();
  if (!instance) return;
  try {
    if (!instance.get(COLLECTION, serviceId(service))) {
      instance.put(COLLECTION, serviceId(service), { service });
    }
  } catch {}
}

function deleteService(service) {
  const instance = getDb();
  if (!instance) return false;
  try {
    const marker = instance.get(COLLECTION, serviceId(service));
    const tokenRows = instance.find(COLLECTION, {}).filter(
      r => typeof r.id === 'string' && r.id.startsWith(TOKEN_PREFIX) && r.service === service
    );
    if (!marker && tokenRows.length === 0) return false; // 존재하지 않던 서비스
    if (marker) instance.del(COLLECTION, serviceId(service));
    for (const r of tokenRows) instance.del(COLLECTION, r.id);
    return true;
  } catch {
    return false;
  }
}

// ── 설정 접근자 ─────────────────────────────────────────────────────────

// config.yml/.migrated 파일 자체가 없으면(완전 신규 클론) 하드코딩 기본값을,
// 파일은 있지만 tools 가 비어있거나 형식이 잘못됐으면 빈 배열을 돌려준다 —
// 사용자가 명시적으로 도구를 전부 지운 상태(빈 배열)는 그대로 존중한다.
function toolsFallback() {
  const parsed = readYmlFallback();
  if (Object.keys(parsed).length === 0) return DEFAULT_TOOLS;
  const t = parsed.tools;
  return Array.isArray(t) ? t : [];
}

function getTools() {
  const instance = getDb();
  if (!instance) return toolsFallback();
  try {
    const doc = instance.get(COLLECTION, 'settings:tools');
    if (doc && Array.isArray(doc.tools)) return doc.tools;
    return toolsFallback();
  } catch {
    return toolsFallback();
  }
}

function setTools(tools) {
  const instance = getDb();
  if (!instance) return;
  try { instance.put(COLLECTION, 'settings:tools', { tools: Array.isArray(tools) ? tools : [] }); } catch {}
}

function getTheme() {
  const instance = getDb();
  if (!instance) {
    const th = readYmlFallback().theme;
    return (th && typeof th === 'object') ? th : {};
  }
  try {
    const doc = instance.get(COLLECTION, 'settings:theme');
    if (doc) return stripId(doc);
    const th = readYmlFallback().theme;
    return (th && typeof th === 'object') ? th : {};
  } catch {
    const th = readYmlFallback().theme;
    return (th && typeof th === 'object') ? th : {};
  }
}

function setTheme(theme) {
  const instance = getDb();
  if (!instance) return;
  try { instance.put(COLLECTION, 'settings:theme', (theme && typeof theme === 'object') ? theme : {}); } catch {}
}

function getSettings() {
  const instance = getDb();
  if (!instance) {
    const s = readYmlFallback().settings;
    return (s && typeof s === 'object') ? s : {};
  }
  try {
    const doc = instance.get(COLLECTION, 'settings:general');
    if (doc) return stripId(doc);
    const s = readYmlFallback().settings;
    return (s && typeof s === 'object') ? s : {};
  } catch {
    const s = readYmlFallback().settings;
    return (s && typeof s === 'object') ? s : {};
  }
}

function setSettings(settings) {
  const instance = getDb();
  if (!instance) return;
  try { instance.put(COLLECTION, 'settings:general', (settings && typeof settings === 'object') ? settings : {}); } catch {}
}

// ── void-persistent: 계정 스위처 (phase 1: 수동 전환) ───────────────────────
// getSettings/setSettings 와 동일한 getDb()-null-guard + try/catch-swallow
// 패턴을 그대로 따른다. dJinn 이 불가하면(설치 실패 등) 조용히 기본값/no-op 으로
// degrade 한다 — 이 기능은 부가 기능이라 부팅을 막을 이유가 없다.
function defaultVoidPersistentSwitcher() {
  return { enabled: false, persistDir: null, pool: [], activePoolIndex: -1, autoMode: false, autoState: {} };
}

// 구 키 'experiments:switcher' → 신 키 'void_persistent:switcher' 1회 마이그레이션.
// 신 키가 없고 구 키 문서가 있으면, 그 문서를 신 키로 옮겨 쓰고(기존 사용자의
// pool/persistDir/settings 보존) 구 키는 지운다. 실패해도 기존 try/catch 로
// fail-soft — 기본값으로 degrade.
function getVoidPersistentSwitcher() {
  const instance = getDb();
  if (!instance) return defaultVoidPersistentSwitcher();
  try {
    const doc = instance.get(COLLECTION, 'void_persistent:switcher');
    if (doc) return { ...defaultVoidPersistentSwitcher(), ...stripId(doc) };

    const legacyDoc = instance.get(COLLECTION, 'experiments:switcher');
    if (legacyDoc) {
      const migrated = { ...defaultVoidPersistentSwitcher(), ...stripId(legacyDoc) };
      instance.put(COLLECTION, 'void_persistent:switcher', migrated);
      try { instance.del(COLLECTION, 'experiments:switcher'); } catch {}
      return migrated;
    }

    return defaultVoidPersistentSwitcher();
  } catch {
    return defaultVoidPersistentSwitcher();
  }
}

function setVoidPersistentSwitcher(obj) {
  const instance = getDb();
  if (!instance) return;
  try {
    const merged = { ...defaultVoidPersistentSwitcher(), ...(obj && typeof obj === 'object' ? obj : {}) };
    instance.put(COLLECTION, 'void_persistent:switcher', merged);
  } catch {}
}

// ── void-omni-persistent: 독립 프로필(name + toolCommand + omniroute_url +
// omniroute_api_key) 저장소 ──────────────────────────────────────────────
// getVoidPersistentSwitcher/setVoidPersistentSwitcher 와 동일한 getDb()-null-
// guard + default-merge + try/catch-swallow 패턴을 그대로 따른다. 새 문서 키
// ('void_omni_persistent:profiles')를 써서 기존 'void_persistent:switcher' 와
// 충돌하지 않는다. 배열 전체를 get→수정→set 하는 단순 CRUD로 충분하다
// (pool/autoMode 같은 phase2 개념 없음 — 프로필마다 완전히 독립된 설정).
// omniroute_api_key 는 setToken() 과 동일하게 평문 저장한다(이 저장소 전체의
// 기존 관례 — 별도 암호화 레이어를 새로 두지 않는다).
function defaultVoidOmniPersistentProfiles() {
  return { profiles: [] };
}

function getVoidOmniPersistentProfiles() {
  const instance = getDb();
  if (!instance) return defaultVoidOmniPersistentProfiles();
  try {
    const doc = instance.get(COLLECTION, 'void_omni_persistent:profiles');
    if (doc) return { ...defaultVoidOmniPersistentProfiles(), ...stripId(doc) };
    return defaultVoidOmniPersistentProfiles();
  } catch {
    return defaultVoidOmniPersistentProfiles();
  }
}

function setVoidOmniPersistentProfiles(profiles) {
  const instance = getDb();
  if (!instance) return;
  try {
    const merged = { ...defaultVoidOmniPersistentProfiles(), ...(profiles && typeof profiles === 'object' ? profiles : {}) };
    instance.put(COLLECTION, 'void_omni_persistent:profiles', merged);
  } catch {}
}

module.exports = {
  dbPath,
  // 토큰
  getToken, setToken, getAllTokens, renameToken, deleteToken, addService, deleteService,
  // 설정
  getTools, setTools, getTheme, setTheme, getSettings, setSettings,
  // void-persistent 계정 스위처
  getVoidPersistentSwitcher, setVoidPersistentSwitcher,
  // void-omni-persistent 프로필
  getVoidOmniPersistentProfiles, setVoidOmniPersistentProfiles,
  // 마이그레이션 (테스트/명시 호출용 — getDb 초기화 경로에서 자동 호출됨)
  migrateLegacyConfigJson, migrateLegacyConfigYml,
};
