'use strict';

// 사용량 조회 캐시 — dJinn (vendor/dJinn, @d0iloppa/djinn) 백엔드.
// dJinn 은 better-sqlite3 위에 얹은 schemaless JSON 문서 저장소 — 우리는 raw SQL을
// 직접 다루지 않고 dJinn 의 실제 API (vendor/dJinn/src/db.js 기준, README 가 아님 —
// README 는 존재하지 않는 Schema 클래스를 문서화하고 있어 신뢰하지 않았음) 위에 얹는다.
//
// Why dJinn instead of raw better-sqlite3: 여러 void 프로세스가 동시에 실행될 때
// JSON 파일 read-modify-write 로 인한 경합/유실을 SQLite (WAL) 로 해결하는 것은
// 이전 라운드와 동일하되, 그 SQLite 레이어 자체를 자체 제작 라이브러리(dJinn)로
// 교체한 것 — 로직상 변화는 없음.
//
// dJinn(그리고 그 하위의 better-sqlite3) 은 이제 설치 시점에 필수(mandatory)다 —
// scripts/install-djinn.js 가 package.json 의 preinstall 훅으로 실행되어
// vendor/*.tgz (커밋된 tgz, 없으면 vendor/dJinn 서브모듈에서 빌드) 로부터 설치를
// 보장하며, 설치 자체가 실패하면 npm install 전체가 nonzero 로 종료된다.
// 아래의 require try/catch 는 설치 시점의 선택성(optionality) 장치가 아니라,
// 설치 이후 런타임에서만 발생할 수 있는 실패(예: 설치 후 Node.js 버전을 업그레이드해
// better-sqlite3 의 네이티브 바인딩이 ABI 불일치로 깨지는 경우)에 대한 방어적
// 안전망으로 남겨둔 것이다 — 실패 시 이 모듈의 모든 읽기/쓰기는 조용히 no-op 으로
// 동작한다 (읽기는 null, 쓰기는 아무 일도 하지 않음). 예전 raw-SQL/JSON 방식으로
// 폴백하지 않는다 — 그건 이 교체의 목적 자체를 무너뜨린다.
//
// 문서 저장 (dJinn 은 schemaless — id TEXT PRIMARY KEY, doc TEXT 한 테이블):
//   id  = `${provider}:${sessionKey}`
//   doc = { provider, sessionKey, data, timestamp }
//   data 는 opaque JSON — provider/tier 별로 모양이 다르므로(그리고 향후 provider가
//   완전히 다른 모양일 수 있으므로) 스키마를 강제하지 않는다.
//
// 새 DB 파일명 `usage-cache.djinn.db` 사용 — 지난 라운드의 raw-SQL
// `usage-cache.db` (provider/session_key/data/timestamp 컬럼을 가진 구조화된
// 테이블)는 dJinn 의 schemaless id+doc 테이블과 구조가 달라 재사용하면 깨진/반쯤
// 마이그레이션된 테이블이 될 위험이 있다. 그 파일은 그냥 orphan 으로 남겨둔다
// (며칠치의 재조회 가능한 캐시일 뿐이라 마이그레이션할 가치가 없음).
//
// 2라운드 전 JSON 레거시 캐시(usage-cache.json)로부터의 1회성 마이그레이션은
// 계속 유지 — 로직은 동일, insert 방식만 raw SQL → db.put() 으로 바뀜.

const fs   = require('fs');
const path = require('path');
const { storageDir } = require('./storage');

const COLLECTION = 'usage_cache';

let db = null;
let initAttempted = false;

function dbPath() {
  return path.join(storageDir(), 'usage-cache.djinn.db');
}
function legacyJsonPath() {
  return path.join(storageDir(), 'usage-cache.json');
}

function makeId(provider, sessionKey) {
  return `${provider}:${sessionKey}`;
}

// 예전 JSON 캐시(usage-cache.json, raw-SQL 이전)로부터의 1회성 마이그레이션.
// 비파괴적 — 레거시 파일은 이름만 바꾸고 절대 지우지 않으며, dJinn 에 이미 존재하는
// (provider, sessionKey) id 는 건드리지 않는다 (더 오래된 JSON 스냅샷이 최신 DB
// 데이터를 덮어쓰지 않도록). 손상된/부분적인 레거시 파일이 DB 동작을 막지 않도록
// try/catch 로 전체를 감싼다.
function migrateLegacyJson(instance) {
  try {
    const jsonPath = legacyJsonPath();
    if (!fs.existsSync(jsonPath)) return;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      fs.renameSync(jsonPath, jsonPath + '.migrated');
      return;
    }

    for (const provider of Object.keys(parsed)) {
      const sessions = parsed[provider];
      if (!sessions || typeof sessions !== 'object') continue;
      for (const sessionKey of Object.keys(sessions)) {
        const entry = sessions[sessionKey];
        if (!entry || typeof entry !== 'object') continue;
        const id = makeId(provider, sessionKey);
        if (instance.get(COLLECTION, id)) continue; // 이미 있으면 건드리지 않음
        const { timestamp, ...rest } = entry;
        const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
        instance.put(COLLECTION, id, { provider, sessionKey, data: rest, timestamp: ts });
      }
    }
    fs.renameSync(jsonPath, jsonPath + '.migrated');
  } catch {
    // 손상된/부분적인 레거시 파일 — 그냥 두고 DB는 정상 동작.
  }
}

function getDb() {
  if (db) return db;
  if (initAttempted) return null;
  initAttempted = true;

  let DJinn;
  try {
    ({ DJinn } = require('@d0iloppa/djinn'));
  } catch {
    return null;
  }

  try {
    const file = dbPath();
    const isNew = !fs.existsSync(file);
    // DJinn 생성자가 이미 journal_mode=WAL 을 설정하므로 여기서 다시 설정하지
    // 않는다 (vendor/dJinn/src/db.js 확인함). busy_timeout 은 DJinn 이 설정하지
    // 않으므로 다중 프로세스 안전성을 위해 우리가 직접 추가 — DJinn 은 내부
    // better-sqlite3 인스턴스를 `instance.db` 로 노출한다.
    const instance = new DJinn(file, { cacheSize: 64 });
    try { instance.db.pragma('busy_timeout = 3000'); } catch {}
    instance.define(COLLECTION, { indexes: ['provider'] });
    if (isNew) {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    migrateLegacyJson(instance);
    db = instance;
    return db;
  } catch {
    return null;
  }
}

function getUsageCacheEntry(provider, sessionKey) {
  const instance = getDb();
  if (!instance) return null;
  try {
    const doc = instance.get(COLLECTION, makeId(provider, sessionKey));
    if (!doc) return null;
    return { ...doc.data, timestamp: doc.timestamp };
  } catch {
    return null;
  }
}

function saveUsageCacheEntry(provider, sessionKey, data, timestampOverride) {
  const instance = getDb();
  if (!instance) return;
  try {
    const timestamp = typeof timestampOverride === 'number' && Number.isFinite(timestampOverride)
      ? timestampOverride
      : Date.now();
    instance.put(COLLECTION, makeId(provider, sessionKey), { provider, sessionKey, data, timestamp });
  } catch {
    // Silent no-op — never throw out of the cache layer.
  }
}

// Cross-process rate-limit gate — separate id namespace ("ratelimit:...") in
// the same collection so it can never collide with a real makeId() cache key.
// Backed by the same dJinn/SQLite file every void process already shares
// (WAL + busy_timeout), so this acts as a persisted lock across concurrently
// running void instances, not just within one process's memory — the actual
// problem observed: two independent void processes each retrying an
// OAuth-429'd endpoint every 30s doubled the hammering and kept extending
// the provider's own Retry-After window further into the future.
function makeRateLimitId(provider, sessionKey) {
  return `ratelimit:${provider}:${sessionKey}`;
}

function getRateLimitUntil(provider, sessionKey) {
  const instance = getDb();
  if (!instance) return null;
  try {
    const doc = instance.get(COLLECTION, makeRateLimitId(provider, sessionKey));
    const until = doc && doc.data && doc.data.blockedUntil;
    return typeof until === 'number' && Number.isFinite(until) ? until : null;
  } catch {
    return null;
  }
}

function setRateLimitUntil(provider, sessionKey, blockedUntil) {
  const instance = getDb();
  if (!instance) return;
  try {
    instance.put(COLLECTION, makeRateLimitId(provider, sessionKey), {
      provider, sessionKey, data: { blockedUntil }, timestamp: Date.now(),
    });
  } catch {
    // Silent no-op — never throw out of the cache layer.
  }
}

module.exports = { getUsageCacheEntry, saveUsageCacheEntry, getRateLimitUntil, setRateLimitUntil };
