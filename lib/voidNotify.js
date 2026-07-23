'use strict';

/*
 * void-notify — Transactional Outbox: notify({when,subject,content,provider_key}) 로 메시지를
 * enqueue 하면, 1분 간격 cron 워커(runWorkerOnce, void notify-worker CLI)가 만기된 항목을
 * 리스(lease) 기반으로 잠그고 실제 발송(현재는 Telegram) 한다.
 *
 * lib/voidContext.js 와 같은 GraphDriver 3단 구조를 재사용하지만 저장 위치가 다르다 — 의도적
 * 편차다:
 *   - void-context 는 저장소별 태스크 이력이라 "이 저장소를 다시 클론하면 이력도 새로 시작"이
 *     자연스러워 repo-root(path.join(__dirname,'..')) 에 둔다.
 *   - void-notify 는 사용자 개인의 상주 백그라운드 서비스(cron 워커)다. repo 재클론이나 전역
 *     npm install 을 다시 해도 큐/채널/암호화 키가 사라지면 안 되므로 lib/storage.js 의
 *     storageDir()(~/.config/void-launcher/) 아래에 DB와 키 파일을 둔다. 이 차이를 "버그"로
 *     보고 repo-root 로 옮기지 말 것 — void-context 와 다른 저장 위치는 이 파일의 존재 이유다.
 *
 * 계층:
 *   root(node_id=1, 고정)
 *   → node(parent_id=1, node_key=alias) = 채널 등록 1개. child_schema={kind,label,enc_api_key,
 *     send_to,enabled}. api_key 는 절대 평문 저장 안 됨(voidNotifyCrypto.encryptSecret 만).
 *   → doc(parent_id=해당 채널 node_id, child_key=entry_id) = 큐 항목(dispatch) 1개.
 *     data={channel_key,subject,content,when,status,attempts,lease_owner,lease_expires_at,
 *     last_error,sent_to,rate_limit_retries}. sent_to 는 다중 수신자 채널에서 "이미 발송
 *     성공한 chat_id" 진행률이고(부분발송 재중복 방지), rate_limit_retries 는 429 소프트
 *     재시도 전용 카운터(attempts 와 별도, 무한 재시도 방지용 상한 있음).
 *
 * 예약 노드 '_schema' — voidContext.js 와 동일한 규약: '기본구성' 1회 시드, listChannels 등에서
 * '_' 로 시작하는 node_key 는 항상 필터링(_isReserved), delChannel 도 삭제를 거부한다.
 *
 * 리스 클레임(THE critical correctness path) — GraphDriver.putDoc 은 무조건 upsert라 동시성
 * 안전한 "claim"에 쓸 수 없다. 대신 g.djinn.transaction() (vendor/dJinn/src/db.js:172-175,
 * 실제 better-sqlite3 WAL 트랜잭션 — graphLayer가 busy_timeout=3000 설정) 안에서 직접
 * `${NS}_docs` 컬렉션을 read-check-write 해 CAS(compare-and-swap) 클레임을 구현한다
 * (claimOne). 두 프로세스가 동시에 같은 항목을 집으면 트랜잭션 직렬화 덕에 한쪽만 성공하고
 * 나머지는 null(=놓침)을 받는다.
 */

const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { storageDir } = require('./storage');
const { initVoidGraphLayer } = require('./graphLayer');
const { encryptSecret, decryptSecret } = require('./voidNotifyCrypto');

const NS = 'void_notify'; // GraphDriver.NS_RE 가 하이픈을 거부하므로 언더스코어 고정(파일명은 하이픈 허용)
const KINDS = new Set(['telegram']); // 현재는 telegram 만 — kind→sender map 으로 확장
const LEASE_MS = 120000; // 2 * cron 주기(1분) — 워커가 죽어도 다음 사이클에서 회수 가능
const MAX_ATTEMPTS = 5;
// HIGH #3: 한 사이클(claimDueBatch 1회)에서 클레임할 최대 항목 수. 상한이 없으면 백로그가
// 쌓였을 때 배치 전체(클레임 + 이어지는 발송 루프)의 벽시계 시간이 LEASE_MS 를 넘길 수 있고,
// 그러면 다음 사이클이 "아직 처리 중"인 뒷쪽 항목을 리스 만료로 오판해 재클레임 → 중복발송
// 하게 된다. 25~50 사이 값 권장 — 값을 정할 때 (BATCH_LIMIT * 평균 발송 소요시간) <
// LEASE_MS 가 되도록 여유를 둘 것.
const BATCH_LIMIT = 25;
// MED #6: 429(rate-limit) 소프트 재시도 전용 상한 — attempts 를 소모하지 않는 429 재시도가
// 무한히 반복되면(지속적으로 rate-limit 되는 채널) 영원히 status:'queued' 로 남아
// status:'failed' 기반 모니터링에 절대 걸리지 않는다. 이 상한을 넘기면 데드레터(failed)한다.
const MAX_RATELIMIT_RETRIES = 10;

function voidNotifyDbFile() {
  return path.join(storageDir(), 'void-notify.djinn.db');
}

function shortRandom() {
  return crypto.randomBytes(4).toString('hex');
}

function _isReserved(key) {
  return String(key).startsWith('_');
}

// '기본구성' 시드 — 예약 노드 '_schema' 하나만 멱등하게 생성(존재 여부로 가드).
function seedSchemaNode(g) {
  if (g.graph.getNode(NS, '_schema')) return; // 이미 시드됨 — 재시작/재설치에도 멱등
  g.graph.putNode(NS, '_schema', {
    description: 'void-notify channel/queue field schema (reference; not a real channel)',
    child_schema: {
      channel: {
        kind: 'telegram (only for now)',
        label: 'display label',
        enc_api_key: 'base64(iv[12]||tag[16]||ciphertext), AES-256-GCM — never plaintext, never returned',
        send_to: 'chat id string[]',
        enabled: 'bool',
      },
      queue_doc: {
        channel_key: 'owning channel alias',
        subject: 'string',
        content: 'string',
        when: 'ISO due timestamp',
        status: 'queued|locked|sent|failed',
        attempts: 'int, 0-based',
        lease_owner: '"<pid>-<hex>" | null',
        lease_expires_at: 'epoch ms | null',
        last_error: 'string | null',
        sent_to: 'chat id string[] already successfully sent (partial multi-recipient progress)',
        rate_limit_retries: 'int, 0-based — 429 soft-retry count, separate from attempts',
      },
    },
  });
}

const { getGraph, ensureSeeded, dbPath } = initVoidGraphLayer({
  dbFile: voidNotifyDbFile(),
  namespace: NS,
  nodeDefs: [],
  seed: seedSchemaNode,
});

function _requireGraph(action) {
  const g = getGraph();
  if (!g) {
    throw new Error(`voidNotify.${action}: dJinn 을 사용할 수 없어 void-notify 저장소에 접근할 수 없습니다`);
  }
  return g;
}

// ── 채널 registry(level-2 node) ──────────────────────────────────────────

function _redactChannel(node) {
  if (!node) return null;
  const { enc_api_key, ...rest } = node.child_schema || {};
  return { alias: node.node_key, ...rest, created_at: node.created_at, modified_at: node.modified_at };
}

function putChannel({ alias, kind = 'telegram', label, api_key, send_to = [], enabled = true } = {}) {
  ensureSeeded();
  if (!alias || !String(alias).trim()) throw new Error('voidNotify.putChannel: alias 가 필요합니다');
  if (_isReserved(alias)) throw new Error("voidNotify.putChannel: alias 는 '_' 로 시작할 수 없습니다(예약됨)");
  if (!KINDS.has(kind)) throw new Error(`voidNotify.putChannel: kind 는 ${[...KINDS].join('|')} 중 하나여야 합니다(got '${kind}')`);
  if (!api_key || !String(api_key).trim()) throw new Error('voidNotify.putChannel: api_key 가 필요합니다');
  if (!Array.isArray(send_to) || send_to.length === 0) {
    throw new Error('voidNotify.putChannel: send_to(수신 chat id 배열)가 최소 1개 필요합니다');
  }
  const g = _requireGraph('putChannel');
  const enc_api_key = encryptSecret(String(api_key));
  const child_schema = {
    kind,
    label: label || alias,
    enc_api_key,
    send_to: [...new Set(send_to.map(String))], // LOW #8: 중복 chat_id 제거(입력 실수로 같은 수신자에 중복 발송 방지)
    enabled: !!enabled,
  };
  const result = g.graph.putNode(NS, alias, { child_schema });
  return { alias, node_id: result.node_id };
}

// 평문/암호문 api_key 를 절대 포함하지 않는 안전한 조회 — MCP/CLI 어디서 호출해도 노출 안전.
function getChannel(alias) {
  ensureSeeded();
  const g = _requireGraph('getChannel');
  if (!alias || _isReserved(alias)) return null;
  return _redactChannel(g.graph.getNode(NS, alias));
}

function listChannels() {
  ensureSeeded();
  const g = _requireGraph('listChannels');
  return g.graph.childrenOf(NS, 1) // parent_id=1 → 모든 level-2 채널 node
    .filter(n => !_isReserved(n.node_key))
    .map(_redactChannel);
}

function delChannel(alias) {
  ensureSeeded();
  if (!alias) throw new Error('voidNotify.delChannel: alias 가 필요합니다');
  if (_isReserved(alias)) throw new Error("voidNotify.delChannel: '_' 로 시작하는 예약 노드는 삭제할 수 없습니다");
  const g = _requireGraph('delChannel');
  if (!g.graph.getNode(NS, alias)) return { alias, existed: false, deletedDocs: 0 };
  const { deletedDocs } = g.graph.delNode(NS, alias, { cascade: true });
  return { alias, existed: true, deletedDocs };
}

// 발송 시점에만 메모리 상에서 복호화한다 — 어떤 공개 접근자/MCP 응답 경로도 이 함수를 거치지 않는다.
function _decryptChannelApiKey(alias) {
  const g = _requireGraph('_decryptChannelApiKey');
  const node = g.graph.getNode(NS, alias);
  if (!node) return null;
  return decryptSecret(node.child_schema.enc_api_key);
}

// ── 큐(level-3 doc) — enqueue ─────────────────────────────────────────────

function _resolveWhen(when) {
  if (when == null || when === 'now') return new Date().toISOString();
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error(`voidNotify.notify: when 값이 유효한 날짜/ISO 문자열이 아닙니다(got '${when}')`);
  return d.toISOString();
}

// notify({when,subject,content,provider_key}) → { ok:true, entry_id, when }.
// 채널 존재/활성화를 먼저 확인해 fail-fast 한다(존재하지 않는 채널로 큐에 쌓아두고 나중에
// 워커가 실패시키는 것보다, enqueue 시점에 거절하는 편이 사용자에게 더 즉각적인 피드백).
function notify({ when = 'now', subject, content, provider_key } = {}) {
  ensureSeeded();
  if (!subject || !String(subject).trim()) throw new Error('voidNotify.notify: subject 가 필요합니다');
  if (!content || !String(content).trim()) throw new Error('voidNotify.notify: content 가 필요합니다');
  if (!provider_key) throw new Error('voidNotify.notify: provider_key 가 필요합니다');

  const whenIso = _resolveWhen(when);

  const channel = getChannel(provider_key);
  if (!channel) throw new Error(`voidNotify.notify: 알 수 없는 채널 '${provider_key}' — notify_put_channel 로 먼저 등록하세요`);
  if (!channel.enabled) throw new Error(`voidNotify.notify: 채널 '${provider_key}' 가 비활성화 상태입니다`);

  const g = _requireGraph('notify');
  const entryId = `${new Date().toISOString()}-${shortRandom()}`;
  const data = {
    channel_key: provider_key,
    subject: String(subject),
    content: String(content),
    when: whenIso,
    status: 'queued',
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
    last_error: null,
    sent_to: [],
    rate_limit_retries: 0,
  };
  g.graph.putDoc(NS, provider_key, entryId, data, { autoCreateNode: false });
  return { ok: true, entry_id: entryId, when: whenIso };
}

// ── 읽기 전용 큐 상태 조회 ─────────────────────────────────────────────────

function listQueue({ channelKey, status, limit, offset } = {}) {
  ensureSeeded();
  const g = _requireGraph('listQueue');
  const where = {};
  if (channelKey) where.parent_key = channelKey;
  if (status) where['data.status'] = status;
  let docs = g.djinn.find(`${NS}_docs`, where, { orderBy: 'child_key' });
  if (offset) docs = docs.slice(offset);
  if (limit != null) docs = docs.slice(0, limit);
  return docs.map(d => ({
    entry_id: d.child_key,
    channel_key: d.parent_key,
    ...d.data,
    created_at: d.created_at,
    modified_at: d.modified_at,
  }));
}

// ── 리스 클레임(핵심 동시성 경로) ──────────────────────────────────────────

// 후보(due candidates) 수집: status='queued' 전체 + status='locked' 중 리스가 만료된 것.
// dJinn find() 는 등호/LIKE 뿐이라(범위 쿼리 불가) when<=now 필터와 정렬은 JS 로 한다.
function _dueCandidates(now) {
  const g = _requireGraph('_dueCandidates');
  const nowIso = new Date(now).toISOString();
  // 크로스-프로세스 신선도(cross-process freshness): dJinn find() 는 in-process LRU 캐시를
  // 조회하고, 무효화는 "같은 인스턴스"의 put/del 때만 일어난다(vendor/dJinn/src/db.js). 상주
  // 데몬(voidDaemon)은 한 djinn 인스턴스를 오래 재사용하므로, *다른 프로세스*(MCP notify /
  // CLI = 별도 프로세스)가 새로 INSERT 한 queued 행을 데몬의 캐시된 find() 결과가 못 본다 —
  // 예약 메시지가 영영 미발송으로 남는 원인. 그래서 매 폴링 discovery 직전에 docs 컬렉션
  // 캐시를 비워 SQLite 에서 fresh 하게 읽는다(claimOne 의 read-check 앞 무효화와 동일 취지).
  g.djinn._cache && g.djinn._cache.invalidatePrefix(`${NS}_docs`);
  const queued = g.djinn.find(`${NS}_docs`, { 'data.status': 'queued' });
  const locked = g.djinn.find(`${NS}_docs`, { 'data.status': 'locked' });
  const staleLocked = locked.filter(d => d.data.lease_expires_at != null && d.data.lease_expires_at < now);
  const candidates = [...queued, ...staleLocked].filter(d => d.data.when <= nowIso);
  candidates.sort((a, b) => new Date(a.data.when) - new Date(b.data.when));
  return candidates;
}

// 단건 원자적 클레임. g.djinn.transaction() 이 실제 better-sqlite3 WAL 트랜잭션이라
// 프로세스 간에도 안전하다 — read-check-write 를 한 트랜잭션 안에서 수행하므로, 두 워커가
// 동시에 같은 (channelKey,entryId) 를 집으면 한쪽만 성공하고 나머지는 null 을 받는다(=놓침).
function claimOne(channelKey, entryId, now) {
  const g = _requireGraph('claimOne');
  const id = `${channelKey}::${entryId}`;
  const nowIso = new Date(now).toISOString();
  return g.djinn.transaction(() => {
    // HIGH #4: 상주 데몬(lib/voidDaemon.js)은 프로세스 생명 동안 DJinn 인스턴스 하나를 계속
    // 재사용한다 — 그 인스턴스의 인메모리 LRU 캐시(vendor/dJinn/src/db.js get())는 같은
    // 프로세스가 예전에 읽어둔 값을 그대로 들고 있을 수 있다. transaction() 은 이 캐시를
    // bypass 하지 않으므로, 그 사이 다른 프로세스(예: 수동 `void notify-worker` CLI 실행)가
    // 같은 SQLite 파일에 직접 써서 상태를 바꿨다면 아래 get() 이 디스크가 아니라 stale 캐시를
    // 돌려줘 CAS 판정이 틀어질 수 있다(이미 다른 쪽이 locked 로 잡은 항목을 queued 로 오판해
    // 재클레임). put() 이 쓰기 뒤에 하는 것과 동일한 invalidatePrefix 를 여기 read-check 앞에서
    // 먼저 호출해 "진짜 디스크 읽기"를 강제한다(vendor/dJinn 은 건드리지 않음 — 이 프로세스가
    // 들고 있는 캐시 인스턴스만 무효화).
    g.djinn._cache && g.djinn._cache.invalidatePrefix(`${NS}_docs`);
    const fresh = g.djinn.get(`${NS}_docs`, id);
    if (!fresh) return null;
    // MED #5: when 게이트는 지금까지 _dueCandidates() 에만 있었다 — claimOne 을 직접 호출하는
    // 경로(테스트, 향후 다른 드라이버)는 그 필터를 거치지 않으므로 여기서도 반드시 확인한다.
    // _dueCandidates 는 목록 조회 최적화로만 남겨둔다(claimOne 이 최종 방어선).
    if (fresh.data.when > nowIso) return null; // 아직 도래하지 않음 — 조기 발송 방지
    const claimable = fresh.data.status === 'queued'
      || (fresh.data.status === 'locked' && fresh.data.lease_expires_at != null && fresh.data.lease_expires_at < now);
    if (!claimable) return null; // 이미 다른 워커가 가져갔거나(locked, 리스 유효) sent/failed 로 종결됨
    const { id: _id, ...rest } = fresh;
    const data = {
      ...fresh.data,
      status: 'locked',
      lease_owner: `${process.pid}-${shortRandom()}`,
      lease_expires_at: now + LEASE_MS,
    };
    g.djinn.put(`${NS}_docs`, id, { ...rest, data, modified_at: new Date().toISOString() });
    return { ...rest, data };
  });
}

// 만기된 큐 항목을 모두 원자적으로 클레임해 배열로 반환한다(claim 실패분은 자동 스킵).
// HIGH #3: limit 기본값을 BATCH_LIMIT 로 둬 무제한 배치를 막는다 — 배치가 커서 벽시계 시간이
// LEASE_MS 를 넘기면 아직 처리 중인 뒷쪽 항목을 다음 사이클이 리스 만료로 오판해 재클레임
// (중복발송)하기 때문이다. 잘렸다면(capped) 무음 절단하지 않고 log 로 남긴다.
// HIGH #2: 항목 하나의 claimOne 실패(예: 일시적 DB 잠김)가 배치 전체를 중단시키지 않도록
// 각 클레임 시도를 개별적으로 격리한다 — 실패 건수는 반환 배열의 비열거 이동 없는 일반
// 프로퍼티 claimErrors 로 노출해(배열 자체의 length/map 등 기존 계약은 그대로) runWorkerOnce
// 가 errors 카운트에 합산할 수 있게 한다.
function claimDueBatch({ now = Date.now(), limit = BATCH_LIMIT, log = (...a) => console.error('[void-notify]', ...a) } = {}) {
  ensureSeeded();
  const candidates = _dueCandidates(now);
  const toClaim = limit != null ? candidates.slice(0, limit) : candidates;
  if (limit != null && candidates.length > limit) {
    log(`claimDueBatch: 대기 중 ${candidates.length}건 중 BATCH_LIMIT(${limit})만 이번 사이클에 클레임 — 나머지 ${candidates.length - limit}건은 다음 사이클로 이월(데이터 유실 아님)`);
  }
  const claimed = [];
  let claimErrors = 0;
  for (const cand of toClaim) {
    try {
      // HIGH #3: 배치 시작 시점의 공유 now 가 아니라, 이 항목을 실제로 클레임하는 순간의
      // Date.now() 를 리스 앵커로 쓴다 — 배치 처리(특히 이어지는 발송 루프)가 오래 걸릴수록
      // 뒤쪽 항목의 리스가 앞쪽 기준 시각으로 앵커링되면 실제보다 일찍 만료된 것처럼 보여
      // 아직 처리 중인데도 재클레임(중복발송)될 위험이 커진다.
      const claimNow = Date.now();
      const result = claimOne(cand.parent_key, cand.child_key, claimNow);
      if (result) claimed.push(result);
    } catch (e) {
      claimErrors++;
      log(`claimDueBatch: claimOne(${cand.parent_key}::${cand.child_key}) 실패 — 이 항목만 건너뛰고 계속합니다: ${e.message}`);
    }
  }
  claimed.claimErrors = claimErrors; // runWorkerOnce 의 errors 집계용 (배열 계약은 그대로 유지)
  return claimed;
}

// ── 발송 결과 반영 ─────────────────────────────────────────────────────────

function _putQueueData(channelKey, entryId, mutate) {
  const g = _requireGraph('_putQueueData');
  const id = `${channelKey}::${entryId}`;
  return g.djinn.transaction(() => {
    const fresh = g.djinn.get(`${NS}_docs`, id);
    if (!fresh) return null;
    const { id: _id, ...rest } = fresh;
    const data = mutate(fresh.data);
    g.djinn.put(`${NS}_docs`, id, { ...rest, data, modified_at: new Date().toISOString() });
    return data;
  });
}

// 성공 → status:'sent', 리스 해제. 실패 & attempts+1<MAX → status:'queued'(재시도), last_error
// 기록, 리스 해제. 실패 & attempts 소진 → status:'failed'(데드레터, 종결— 더 이상 재시도 안 함).
// HIGH #1: sentTo 가 주어지면(다중 수신자 채널의 부분발송 진행률) 그대로 doc 에 반영한다 —
// 그래야 재시도(status:'queued' 로 되돌아간 뒤 다음 클레임)가 이미 성공한 수신자를 sender
// 쪽에서 건너뛸 수 있다. 주어지지 않으면(예: 채널 증발/미지원 kind 처럼 sender 를 아예 못
// 부른 경우) 기존 진행률을 그대로 보존한다.
function markResult(channelKey, entryId, { ok, error, sentTo } = {}) {
  return _putQueueData(channelKey, entryId, (data) => {
    const sent_to = sentTo !== undefined ? sentTo.map(String) : (data.sent_to || []);
    if (ok) {
      return { ...data, status: 'sent', lease_owner: null, lease_expires_at: null, last_error: null, sent_to, rate_limit_retries: 0 };
    }
    const attempts = (data.attempts || 0) + 1;
    const status = attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
    return { ...data, status, attempts, lease_owner: null, lease_expires_at: null, last_error: error || null, sent_to };
  });
}

// Telegram 429 전용 — attempts 를 소모하지 않고 when 만 뒤로 미룬 뒤 queued 로 되돌린다
// (레이트리밋은 메시지 자체의 결함이 아니므로 attempts 기반 데드레터 카운트에 넣지 않는다).
// MED #6: 그러나 attempts 를 전혀 태우지 않으면 지속적으로 rate-limit 되는 채널이 영원히
// queued 로 남아 status:'failed' 모니터링에 절대 안 잡힌다 — 그래서 별도의 bounded 카운터
// (rate_limit_retries)를 두고, 상한(MAX_RATELIMIT_RETRIES)을 넘기면 명시적으로 데드레터한다.
// sentTo 가 주어지면(HIGH #1) 부분발송 진행률도 함께 보존한다.
function requeueLater(channelKey, entryId, whenEpochMs, note, sentTo) {
  return _putQueueData(channelKey, entryId, (data) => {
    const sent_to = sentTo !== undefined ? sentTo.map(String) : (data.sent_to || []);
    const rate_limit_retries = (data.rate_limit_retries || 0) + 1;
    if (rate_limit_retries > MAX_RATELIMIT_RETRIES) {
      return {
        ...data,
        status: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        last_error: `rate-limit 재시도 한도(${MAX_RATELIMIT_RETRIES}) 초과 — 데드레터: ${note || data.last_error}`,
        rate_limit_retries,
        sent_to,
      };
    }
    return {
      ...data,
      status: 'queued',
      when: new Date(whenEpochMs).toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      last_error: note || data.last_error,
      rate_limit_retries,
      sent_to,
    };
  });
}

// ── 발송 어댑터(kind → sender) ─────────────────────────────────────────────

// force IPv4 — Node fetch/https default hangs on hosts with a black-holed IPv6 route (e.g.
// WSL2); Telegram is reachable over IPv4. 순수 https.request 래퍼 — {status,headers,body} 로
// 응답을 모아 반환한다(body 는 raw 문자열, 호출부가 필요시 JSON.parse). timeoutMs 경과 시
// req.destroy(Error) 로 강제 종료해 워커가 영원히 블록되지 않게 한다.
function httpsPostJson(url, bodyObj, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      family: 4, // force IPv4 — Node fetch/https default hangs on hosts with a black-holed IPv6 route (e.g. WSL2); Telegram is reachable over IPv4.
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`요청 타임아웃(${timeoutMs}ms)`));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`요청 타임아웃(${timeoutMs}ms)`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Telegram Bot API 로 send_to 의 각 chat_id 에 순차 발송한다.
// HIGH #1: alreadySent 에 들어있는 chat_id 는 건너뛴다(이전 사이클에서 이미 성공한 수신자 —
// 재발송하면 중복 알림). 하나가 실패하면 그 시점까지 실제로 성공한 chat_id 를 sentTo 에 담아
// 즉시 중단한다 — 호출부(markResult/requeueLater)가 이 sentTo 를 doc 에 반영해두면, 다음
// 재시도는 성공한 수신자를 다시 건드리지 않고 나머지만 마저 발송한다.
async function sendTelegram(channelNode, { subject, content, alreadySent = [] }) {
  const alias = channelNode.node_key;
  const { send_to = [] } = channelNode.child_schema || {};
  const already = new Set(alreadySent.map(String));
  let token;
  try {
    token = _decryptChannelApiKey(alias);
  } catch (e) {
    return { ok: false, error: `api_key 복호화 실패: ${e.message}`, sentTo: [...already] };
  }
  if (!token) return { ok: false, error: 'api_key 가 없습니다', sentTo: [...already] };

  const text = `${subject}\n\n${content}`;
  const sentTo = [...already];
  for (const chatId of send_to) {
    const chatIdStr = String(chatId);
    if (already.has(chatIdStr)) continue; // 이미 성공한 수신자 — 재발송하지 않음
    try {
      // NOTE: 절대 token 이나 token 이 박힌 URL 을 error 메시지에 포함하지 않는다(아래
      // 모든 실패 분기는 status/body 스니펫만 담는다).
      const res = await httpsPostJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }, { timeoutMs: 15000 });
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 429) {
          let retryAfterSeconds = null;
          try {
            const parsed = JSON.parse(res.body);
            retryAfterSeconds = parsed && parsed.parameters && Number(parsed.parameters.retry_after);
          } catch { /* 헤더로 폴백 */ }
          if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
            const ra = Number(res.headers['retry-after']);
            retryAfterSeconds = Number.isFinite(ra) && ra > 0 ? ra : 30;
          }
          return { ok: false, error: `Telegram 429 (chat_id=${chatId})`, retryAfterSeconds, sentTo };
        }
        return { ok: false, error: `Telegram HTTP ${res.status} (chat_id=${chatId}): ${String(res.body).slice(0, 200)}`, sentTo };
      }
    } catch (e) {
      return { ok: false, error: `Telegram 요청 실패(chat_id=${chatId}): ${e.message}`, sentTo };
    }
    sentTo.push(chatIdStr);
  }
  return { ok: true, sentTo };
}

const SENDERS = { telegram: sendTelegram };

// ── cron 워커 1회 실행(void notify-worker) ─────────────────────────────────

// 반환: { processed, sent, failed, deferred, errors, error? }. processed === sent + failed +
// deferred 불변식을 항상 지킨다(errors 는 그 위에 더해지는 별도 카운터 — "claim/처리 중
// 예외가 몇 건 있었는지"일 뿐, 파티션의 일부가 아니다). 이 함수는 절대 reject 하지 않는다 —
// case 'notify-worker'(launcher.js, try/catch 없이 직행 호출)와 lib/voidDaemon.js 의
// setInterval 루프 양쪽 다 이 함수가 개별 항목 실패로 죽지 않는다는 계약에 의존한다.
async function runWorkerOnce({ now = Date.now() } = {}) {
  ensureSeeded();
  const g = getGraph();
  if (!g) return { processed: 0, sent: 0, failed: 0, deferred: 0, errors: 0, error: 'dJinn 을 사용할 수 없습니다' };

  // HIGH #2: claim 단계(claimDueBatch → _dueCandidates/claimOne) 자체가 던지면(예: dJinn
  // 일시적 오류) 이번 사이클 전체를 죽이는 대신 빈 배치로 취급하고 계속한다 — 다음 사이클
  // (1분 뒤 cron, 또는 데몬의 다음 폴)에서 다시 시도된다.
  let claimed = [];
  let errors = 0;
  try {
    claimed = claimDueBatch({ now });
  } catch (e) {
    errors++;
    claimed = [];
  }
  errors += claimed.claimErrors || 0; // claimDueBatch 내부에서 개별 격리된 claimOne 실패 건수

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  for (const doc of claimed) {
    const channelKey = doc.parent_key;
    const entryId = doc.child_key;
    try {
      const channelNode = g.graph.getNode(NS, channelKey);

      if (!channelNode) {
        markResult(channelKey, entryId, { ok: false, error: `채널 '${channelKey}' 가 존재하지 않습니다(삭제됨?)` });
        failed++;
        continue;
      }

      const kind = channelNode.child_schema.kind;
      const sender = SENDERS[kind];
      if (!sender) {
        markResult(channelKey, entryId, { ok: false, error: `지원하지 않는 kind '${kind}'` });
        failed++;
        continue;
      }

      // HIGH #1: 이전 사이클에서 부분발송으로 이미 성공한 수신자(sent_to)를 sender 에 넘겨
      // 재시도가 그 수신자를 다시 건드리지 않게 한다.
      const alreadySent = doc.data.sent_to || [];
      const result = await sender(channelNode, { subject: doc.data.subject, content: doc.data.content, alreadySent });

      if (result.ok) {
        markResult(channelKey, entryId, { ok: true, sentTo: result.sentTo !== undefined ? result.sentTo : alreadySent });
        sent++;
      } else if (result.retryAfterSeconds) {
        // LOW #7: 429 소프트 재시도는 failed 가 아니라 별도 deferred 로 센다(단, MED #6 상한을
        // 넘겨 requeueLater 가 내부적으로 데드레터했다면 그건 진짜 failed 다).
        const after = requeueLater(channelKey, entryId, now + result.retryAfterSeconds * 1000, result.error, result.sentTo);
        if (after && after.status === 'failed') failed++; else deferred++;
      } else {
        // HIGH #1: 부분발송 실패도 sentTo 를 함께 기록해 다음 재시도가 이미 성공한 수신자를
        // 건드리지 않게 한다.
        markResult(channelKey, entryId, { ok: false, error: result.error, sentTo: result.sentTo });
        failed++;
      }
    } catch (e) {
      // HIGH #2: 이 항목 하나의 처리 예외가 배치 전체를 중단시키지 않는다 — 카운트만 하고
      // 다음 항목으로 계속 진행한다.
      errors++;
      try {
        markResult(channelKey, entryId, { ok: false, error: e.message });
      } catch { /* markResult 자체가 실패해도(예: 일시적 DB 잠김) 무시하고 계속 */ }
      failed++;
    }
  }

  return { processed: claimed.length, sent, failed, deferred, errors };
}

// ── 초기화(postinstall 훅에서 호출) ────────────────────────────────────────

function initVoidNotify() {
  ensureSeeded();
  return !!getGraph();
}

module.exports = {
  NS,
  KINDS,
  LEASE_MS,
  MAX_ATTEMPTS,
  BATCH_LIMIT,
  MAX_RATELIMIT_RETRIES,
  dbPath,
  getGraph,
  initVoidNotify,
  notify,
  putChannel, getChannel, listChannels, delChannel,
  listQueue,
  claimOne, claimDueBatch,
  markResult, requeueLater,
  sendTelegram,
  SENDERS, // 테스트 전용 seam — kind→sender 맵을 그대로 노출해 네트워크 호출 없이 sender 를 스텁 교체할 수 있게 한다
  runWorkerOnce,
};
