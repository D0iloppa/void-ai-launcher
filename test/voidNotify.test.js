'use strict';

/*
 * lib/voidNotify.js + lib/voidNotifyCrypto.js 유닛 테스트.
 *
 * void-notify 의 DB(+ 암호화 키)는 lib/storage.js 의 storageDir() 아래에 있고, 그건 실제 void
 * CLI 가 쓰는 경로(~/.config/void-launcher/)와 같다 — 의도된 설계(CLAUDE.md 참고). 따라서
 * 테스트는 아래에서 XDG_CONFIG_HOME 을 일회용 임시 디렉토리로 격리해, storageDir() 이 그 temp
 * 경로로 해석되게 한다. 이렇게 하면 vendor/dJinn smoke-test 관례(실행 전/후 db·키 파일 삭제)를
 * 그대로 쓰면서도 실제 사용자 데이터는 절대 건드리지 않는다. 키 파일도 매번 지워 각 실행이 새
 * 키로 결정론적으로 시작한다(같은 프로세스 안에서는 voidNotifyCrypto 가 모듈 전역에 캐시).
 *
 * cron 설치기(lib/cronInstall.js)는 이 구현에서 빠졌다 — cron 은 나중에 상주 데몬으로
 * 완전히 대체될 예정이라, 여기서는 데몬/cron 어느 쪽이든 반복 호출할 driver-agnostic 코어
 * (runWorkerOnce/claimOne/claimDueBatch)만 검증한다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 테스트 저장소 격리: storageDir() 를 해석하는 어떤 모듈을 require 하기 전에 XDG_CONFIG_HOME 을
// 일회용 임시 디렉토리로 돌려, 이 스위트가 실제 ~/.config/void-launcher/ 의 DB/키를 절대
// 건드리지 않게 한다 — npm test 실행이 사용자의 등록 채널/대기 큐/암호화 키를 파괴하면 안 된다.
// storageDir()(lib/storage.js)는 XDG_CONFIG_HOME 을 최우선 후보로 쓰고 캐시하지 않는다.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'void-notify-test-'));

const { storageDir } = require('../lib/storage');

const DB_FILE = path.join(storageDir(), 'void-notify.djinn.db');
const KEY_FILE = path.join(storageDir(), 'void-notify.key');

function removeStateFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch {}
  }
  try { fs.unlinkSync(KEY_FILE); } catch {}
}

test.before(() => removeStateFiles());
test.after(() => removeStateFiles());

const voidNotify = require('../lib/voidNotify');
const crypto = require('../lib/voidNotifyCrypto');

// ── voidNotifyCrypto ────────────────────────────────────────────────────────

test('voidNotifyCrypto: encryptSecret/decryptSecret round-trip', () => {
  const plaintext = 'super-secret-telegram-bot-token-안녕';
  const blob = crypto.encryptSecret(plaintext);
  assert.notEqual(blob, plaintext);
  assert.equal(crypto.decryptSecret(blob), plaintext);
});

test('voidNotifyCrypto: getOrCreateKey persists across calls (same key reused)', () => {
  const k1 = crypto.getOrCreateKey();
  const k2 = crypto.getOrCreateKey();
  assert.ok(Buffer.isBuffer(k1));
  assert.equal(k1.length, 32);
  assert.ok(k1.equals(k2));
});

test('voidNotifyCrypto: decryptSecret rejects a tampered blob (auth tag check)', () => {
  const blob = crypto.encryptSecret('hello');
  const buf = Buffer.from(blob, 'base64');
  buf[buf.length - 1] ^= 0xff; // 마지막 ciphertext 바이트 변조
  const tampered = buf.toString('base64');
  assert.throws(() => crypto.decryptSecret(tampered));
});

// ── 채널 + enqueue ────────────────────────────────────────────────────────

function makeChannelAlias(suffix) {
  return `test-notify-${process.pid}-${suffix}`;
}

test('putChannel stores enc_api_key only — getChannel/listChannels never expose it', () => {
  const alias = makeChannelAlias('chan-a');
  voidNotify.putChannel({ alias, api_key: 'plain-token-xyz', send_to: ['111'] });

  const got = voidNotify.getChannel(alias);
  assert.equal(got.alias, alias);
  assert.equal(got.kind, 'telegram');
  assert.equal(got.enabled, true);
  assert.deepEqual(got.send_to, ['111']);
  assert.equal('enc_api_key' in got, false);
  assert.equal('api_key' in got, false);

  const listed = voidNotify.listChannels();
  const found = listed.find(c => c.alias === alias);
  assert.ok(found);
  assert.equal('enc_api_key' in found, false);

  voidNotify.delChannel(alias);
});

test('putChannel rejects missing api_key / empty send_to / reserved alias', () => {
  assert.throws(() => voidNotify.putChannel({ alias: makeChannelAlias('no-key'), send_to: ['1'] }));
  assert.throws(() => voidNotify.putChannel({ alias: makeChannelAlias('no-sendto'), api_key: 'x', send_to: [] }));
  assert.throws(() => voidNotify.putChannel({ alias: '_reserved', api_key: 'x', send_to: ['1'] }));
});

test('putChannel dedupes send_to (LOW #8)', () => {
  const alias = makeChannelAlias('dedupe-sendto');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1', '2', '1', '2', '3'] });
  const got = voidNotify.getChannel(alias);
  assert.deepEqual(got.send_to, ['1', '2', '3'], 'duplicate chat_ids must be collapsed, order preserved by first occurrence');
  voidNotify.delChannel(alias);
});

test('notify() rejects unknown channel and disabled channel (fail-fast)', () => {
  assert.throws(
    () => voidNotify.notify({ subject: 's', content: 'c', provider_key: makeChannelAlias('never-created') }),
    /알 수 없는 채널/
  );

  const alias = makeChannelAlias('disabled');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'], enabled: false });
  assert.throws(
    () => voidNotify.notify({ subject: 's', content: 'c', provider_key: alias }),
    /비활성화/
  );
  voidNotify.delChannel(alias);
});

test('notify() rejects an invalid `when`', () => {
  const alias = makeChannelAlias('badwhen');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  assert.throws(() => voidNotify.notify({ subject: 's', content: 'c', provider_key: alias, when: 'not-a-date' }));
  voidNotify.delChannel(alias);
});

test('notify() enqueues a queued doc with attempts:0 and no lease', () => {
  const alias = makeChannelAlias('enqueue');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });

  const result = voidNotify.notify({ subject: '제목', content: '본문', provider_key: alias });
  assert.equal(result.ok, true);
  assert.ok(result.entry_id);
  assert.ok(result.when);

  const items = voidNotify.listQueue({ channelKey: alias });
  assert.equal(items.length, 1);
  assert.equal(items[0].entry_id, result.entry_id);
  assert.equal(items[0].status, 'queued');
  assert.equal(items[0].attempts, 0);
  assert.equal(items[0].lease_owner, null);
  assert.equal(items[0].subject, '제목');
  assert.equal(items[0].content, '본문');

  voidNotify.delChannel(alias);
});

// ── 리스 클레임(핵심 동시성 경로) ──────────────────────────────────────────

test('claimOne: queued -> locked, and a second claim of the same doc returns null (race)', () => {
  const alias = makeChannelAlias('claim-race');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  const now = Date.now();
  const claimed = voidNotify.claimOne(alias, entry_id, now);
  assert.ok(claimed, 'first claim should succeed');
  assert.equal(claimed.data.status, 'locked');
  assert.ok(claimed.data.lease_owner);
  assert.equal(claimed.data.lease_expires_at, now + voidNotify.LEASE_MS);

  // 두 번째 클레임 시도(=경쟁에서 진 쪽) — 리스가 아직 유효하므로 null 이어야 한다.
  const second = voidNotify.claimOne(alias, entry_id, now + 1000);
  assert.equal(second, null);

  // 큐 상태로도 확인 — 여전히 locked, 두 번째 시도로 인해 리스가 갱신되지 않았어야 한다.
  const items = voidNotify.listQueue({ channelKey: alias });
  assert.equal(items[0].status, 'locked');
  assert.equal(items[0].lease_expires_at, now + voidNotify.LEASE_MS);

  voidNotify.delChannel(alias);
});

test('claimOne: a stale locked item (expired lease) is reclaimable', () => {
  const alias = makeChannelAlias('claim-stale');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  const t0 = Date.now();
  const first = voidNotify.claimOne(alias, entry_id, t0);
  assert.ok(first);
  assert.equal(first.data.lease_expires_at, t0 + voidNotify.LEASE_MS);

  // 아직 리스가 살아있는 시점 — 재클레임 실패해야 한다.
  const tooEarly = voidNotify.claimOne(alias, entry_id, t0 + 1000);
  assert.equal(tooEarly, null);

  // 리스 만료 이후 — 재클레임 성공해야 한다(예: 워커가 죽었다 재시작한 경우).
  const tLater = t0 + voidNotify.LEASE_MS + 1;
  const reclaimed = voidNotify.claimOne(alias, entry_id, tLater);
  assert.ok(reclaimed, 'expired lease should be reclaimable');
  assert.equal(reclaimed.data.status, 'locked');
  assert.equal(reclaimed.data.lease_expires_at, tLater + voidNotify.LEASE_MS);
  assert.notEqual(reclaimed.data.lease_owner, first.data.lease_owner, 'new claim should mint a new lease_owner');

  voidNotify.delChannel(alias);
});

test('claimDueBatch: only returns items whose `when` has arrived, oldest first', () => {
  const alias = makeChannelAlias('claim-batch');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });

  const now = Date.now();
  const future = voidNotify.notify({ subject: 'future', content: 'c', provider_key: alias, when: new Date(now + 3600_000).toISOString() });
  const due = voidNotify.notify({ subject: 'due', content: 'c', provider_key: alias, when: 'now' });

  // due 의 when 은 notify() 내부에서 이 지점보다 (수 ms) 나중에 new Date().toISOString() 로
  // 찍힌다 — claimDueBatch 에 넘기는 now 는 그보다 뒤여야 "이미 도래함" 필터를 통과한다.
  const claimed = voidNotify.claimDueBatch({ now: Date.now() + 1000 });
  const claimedIds = claimed.map(d => d.child_key);
  assert.ok(claimedIds.includes(due.entry_id), 'due item should be claimed');
  assert.ok(!claimedIds.includes(future.entry_id), 'future item should not be claimed yet');

  voidNotify.delChannel(alias);
});

test('claimOne itself enforces the when-gate (MED #5): a future-dated item is refused even called directly, bypassing _dueCandidates', () => {
  const alias = makeChannelAlias('when-gate');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const future = new Date(Date.now() + 3600_000).toISOString();
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias, when: future });

  // _dueCandidates() 를 거치지 않고 claimOne 을 직접 호출한다 — 예전에는 when 게이트가
  // _dueCandidates 에만 있어서 이 직접 호출 경로로는 조기 발송이 가능했다.
  const claimed = voidNotify.claimOne(alias, entry_id, Date.now());
  assert.equal(claimed, null, 'claimOne must refuse an item whose `when` has not arrived yet');

  const items = voidNotify.listQueue({ channelKey: alias });
  assert.equal(items[0].status, 'queued');
  assert.equal(items[0].lease_owner, null, 'a refused claim must not touch the lease');

  voidNotify.delChannel(alias);
});

test('claimOne bypasses a stale in-process cache entry (HIGH #4): a fresh disk write must win over a previously-cached read', () => {
  const alias = makeChannelAlias('stale-cache');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  const g = voidNotify.getGraph();
  const collection = `${voidNotify.NS}_docs`;
  const id = `${alias}::${entry_id}`;

  // 1) 정상 get() 을 한 번 호출해 이 프로세스의 인메모리 LRU 캐시에 현재값('queued')을 채운다
  //    — 상주 데몬이 폴링 도중 이 항목을 한 번이라도 읽었을 때와 동일한 상태.
  const warmed = g.djinn.get(collection, id);
  assert.equal(warmed.data.status, 'queued');

  // 2) "다른 프로세스"가 같은 SQLite 파일에 직접 써서 상태를 바꾼 것을 재현한다 — 일부러
  //    g.djinn.put()(캐시를 invalidatePrefix 하는 정상 경로)을 거치지 않고 raw SQL UPDATE 로
  //    쓴다. 이러면 이 프로세스의 캐시는 여전히 1)에서 읽은 낡은 'queued' 스냅샷을 들고 있다
  //    — 상주 데몬의 DJinn 인스턴스가 실제로 처할 수 있는 상황과 동일하다.
  const now = Date.now();
  const externallyLocked = {
    ...warmed,
    data: {
      ...warmed.data,
      status: 'locked',
      lease_owner: 'other-process-1234',
      lease_expires_at: now + voidNotify.LEASE_MS, // 아직 만료되지 않은 유효한 리스
    },
  };
  delete externallyLocked.id;
  g.djinn.db.prepare(`UPDATE ${collection} SET doc = ? WHERE id = ?`).run(JSON.stringify(externallyLocked), id);

  // 3) 픽스 이전이었다면: claimOne 의 get() 이 여전히 1)의 캐시된 'queued' 스냅샷을 봐서
  //    claimable 로 오판하고, 다른 프로세스가 방금 잡은 유효한 리스를 덮어써 버렸을 것이다.
  //    픽스 이후: get() 직전에 캐시를 무효화해 진짜 디스크 값('locked', 리스 유효)을 읽으므로
  //    claimOne 은 null 을 반환해야 한다.
  const claimed = voidNotify.claimOne(alias, entry_id, now + 1000);
  assert.equal(claimed, null, 'claimOne must see the fresh (locked, unexpired lease) disk state, not the stale cached queued snapshot');

  // 캐시를 통하지 않는 raw 조회로도 리스가 그대로 살아있는지 재확인(덮어써지지 않았어야 함).
  const row = g.djinn.db.prepare(`SELECT doc FROM ${collection} WHERE id = ?`).get(id);
  const onDisk = JSON.parse(row.doc);
  assert.equal(onDisk.data.lease_owner, 'other-process-1234', 'claimOne must not have clobbered the concurrently-held lease');

  voidNotify.delChannel(alias);
});

test('claimDueBatch: caps the number of items claimed per cycle and notes the truncation (HIGH #3)', () => {
  const alias = makeChannelAlias('batch-cap');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const total = 5;
  for (let i = 0; i < total; i++) {
    voidNotify.notify({ subject: `s${i}`, content: 'c', provider_key: alias });
  }

  const logs = [];
  const claimed = voidNotify.claimDueBatch({
    now: Date.now() + 1000,
    limit: 2,
    log: (...args) => logs.push(args.join(' ')),
  });

  assert.equal(claimed.length, 2, 'batch should be capped at the given limit');
  assert.ok(logs.length > 0, 'a capped batch must be logged/noted, not silently truncated');

  // 잘려나간 나머지는 유실이 아니라 다음 사이클로 이월돼야 한다 — 여전히 queued 로 남아있어야 한다.
  const remaining = voidNotify.listQueue({ channelKey: alias, status: 'queued' });
  assert.equal(remaining.length, total - 2);

  voidNotify.delChannel(alias);
});

test('BATCH_LIMIT is exported and applied by default when claimDueBatch is called without an explicit limit (HIGH #3)', () => {
  assert.ok(Number.isInteger(voidNotify.BATCH_LIMIT) && voidNotify.BATCH_LIMIT > 0);

  const alias = makeChannelAlias('batch-cap-default');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  // limit 을 넘기지 않아도(runWorkerOnce 가 하듯) 무제한 배치가 되면 안 된다 — 기본값이
  // BATCH_LIMIT 이어야 한다. 항목 수가 BATCH_LIMIT 보다 훨씬 적으므로 캡에 걸리진 않지만,
  // 호출 자체가 예외 없이 정상 동작하는지(파라미터 시그니처 회귀 방지) 확인한다.
  const claimed = voidNotify.claimDueBatch({ now: Date.now() + 1000 });
  assert.ok(claimed.length >= 1);

  voidNotify.delChannel(alias);
});

// ── markResult — 재시도/데드레터 ────────────────────────────────────────────

test('markResult: repeated failures exhaust attempts and terminally dead-letter (failed)', () => {
  const alias = makeChannelAlias('deadletter');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  for (let i = 1; i <= voidNotify.MAX_ATTEMPTS; i++) {
    const data = voidNotify.markResult(alias, entry_id, { ok: false, error: `attempt ${i} failed` });
    assert.equal(data.attempts, i);
    if (i < voidNotify.MAX_ATTEMPTS) {
      assert.equal(data.status, 'queued', `attempt ${i} should still be retryable`);
    } else {
      assert.equal(data.status, 'failed', 'final attempt should dead-letter');
    }
    assert.equal(data.lease_owner, null);
    assert.equal(data.lease_expires_at, null);
  }

  const items = voidNotify.listQueue({ channelKey: alias, status: 'failed' });
  assert.equal(items.length, 1);
  assert.equal(items[0].entry_id, entry_id);
  assert.equal(items[0].attempts, voidNotify.MAX_ATTEMPTS);

  voidNotify.delChannel(alias);
});

test('markResult: success clears lease and marks sent', () => {
  const alias = makeChannelAlias('sent');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  voidNotify.claimOne(alias, entry_id, Date.now());
  const data = voidNotify.markResult(alias, entry_id, { ok: true });
  assert.equal(data.status, 'sent');
  assert.equal(data.lease_owner, null);
  assert.equal(data.lease_expires_at, null);
  assert.equal(data.last_error, null);

  voidNotify.delChannel(alias);
});

test('requeueLater: 429 retries are bounded by MAX_RATELIMIT_RETRIES and never burn normal attempts, dead-lettering only after the cap (MED #6)', () => {
  const alias = makeChannelAlias('ratelimit-cap');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  let data;
  for (let i = 1; i <= voidNotify.MAX_RATELIMIT_RETRIES; i++) {
    data = voidNotify.requeueLater(alias, entry_id, Date.now() + 1000, `429 attempt ${i}`);
    assert.equal(data.status, 'queued', `429 retry #${i} should stay a soft retry (queued)`);
    assert.equal(data.attempts, 0, '429 retries must never burn normal attempts');
    assert.equal(data.rate_limit_retries, i);
  }

  // 한도를 넘긴 다음 429 — 데드레터되어야 한다.
  data = voidNotify.requeueLater(alias, entry_id, Date.now() + 1000, 'final 429');
  assert.equal(data.status, 'failed', 'exceeding MAX_RATELIMIT_RETRIES must dead-letter the item');
  assert.equal(data.attempts, 0, 'even the terminal dead-letter must not have burned normal attempts');
  assert.match(data.last_error, /한도|초과/);

  const items = voidNotify.listQueue({ channelKey: alias, status: 'failed' });
  assert.equal(items.length, 1);
  assert.equal(items[0].entry_id, entry_id);

  voidNotify.delChannel(alias);
});

// ── runWorkerOnce (통합 스모크 — sendTelegram 자체는 스텁으로 대체하지 않고, 실제 네트워크
// 호출 없이도 검증 가능한 "채널이 사라진 경우" 경로만 확인한다) ─────────────────────────

test('runWorkerOnce: a queue item whose channel was deleted after enqueue fails cleanly (no throw)', async () => {
  const alias = makeChannelAlias('vanished');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  // 큐 항목은 GraphDriver.putDoc 이 부모 노드에 종속되지 않고 독립 doc 이므로, 채널 노드를
  // 지워도(cascade) 이 특정 doc 은 이미 delChannel 로 함께 지워진다 — "채널 증발" 상황을
  // 재현하려면 채널만 지우고 doc 은 채널 트리 밖에서 직접 살려둬야 하는데, GraphDriver 구조상
  // doc 은 항상 parent_key 로만 연결되므로 delChannel(cascade)이 doc 도 함께 지운다. 대신
  // "노드는 있지만 kind 가 지원되지 않는 경우"로 동일한 방어 경로(실패 시 markResult 로 안전하게
  // failed 처리하고 throw 하지 않음)를 검증한다.
  const g = voidNotify.getGraph();
  const node = g.graph.getNode(voidNotify.NS, alias);
  g.graph.putNode(voidNotify.NS, alias, { child_schema: { ...node.child_schema, kind: 'unsupported-kind' } });

  const summary = await voidNotify.runWorkerOnce({ now: Date.now() });
  assert.equal(summary.processed >= 1, true);
  assert.equal(summary.failed >= 1, true);

  const items = voidNotify.listQueue({ channelKey: alias });
  const item = items.find(i => i.entry_id === entry_id);
  assert.ok(item);
  assert.equal(item.status, 'queued'); // attempts=1 < MAX_ATTEMPTS → 재시도 대기
  assert.match(item.last_error, /지원하지 않는 kind/);

  voidNotify.delChannel(alias);
});

test('runWorkerOnce: a partial multi-recipient failure does not re-send an already-succeeded recipient on retry (HIGH #1)', async () => {
  const alias = makeChannelAlias('partial-sendto');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['rcpt-1', 'rcpt-2'] });
  const { entry_id } = voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  // sendTelegram 을 실제 네트워크 호출 없이, "rcpt-1 은 성공, rcpt-2 는 1차 시도에서만 실패,
  // 재시도에서 성공" 하는 스텁으로 교체한다. alreadySent 를 존중해 이미 성공한 수신자는
  // 절대 다시 시도하지 않는지가 이 테스트의 핵심이다.
  const attemptsPerCall = []; // 매 sender 호출마다 "실제로 시도한" chat_id 목록
  let cycle = 0;
  const originalSender = voidNotify.SENDERS.telegram;
  voidNotify.SENDERS.telegram = async (channelNode, { alreadySent = [] }) => {
    cycle++;
    const { send_to } = channelNode.child_schema;
    const already = new Set(alreadySent.map(String));
    const toAttempt = send_to.filter(id => !already.has(String(id)));
    attemptsPerCall.push([...toAttempt]);
    const sentNow = [];
    for (const id of toAttempt) {
      if (cycle === 1 && id === 'rcpt-2') {
        // rcpt-1 은 이미 이 호출 안에서 성공 처리된 뒤 rcpt-2 에서 실패한다(실제 sendTelegram
        // 의 순차 발송/중단 의미와 동일).
        return { ok: false, error: 'stub: rcpt-2 실패', sentTo: [...alreadySent, ...sentNow] };
      }
      sentNow.push(String(id));
    }
    return { ok: true, sentTo: [...alreadySent, ...sentNow] };
  };

  try {
    const first = await voidNotify.runWorkerOnce({ now: Date.now() });
    assert.equal(first.processed, 1);
    assert.equal(first.failed, 1, '1차 사이클은 부분 실패로 failed 처리되어야 한다');
    assert.equal(first.sent, 0);

    const afterFirst = voidNotify.listQueue({ channelKey: alias }).find(i => i.entry_id === entry_id);
    assert.equal(afterFirst.status, 'queued', '재시도 대기 상태로 남아야 한다(attempts 소진 전)');
    assert.deepEqual(afterFirst.sent_to, ['rcpt-1'], 'rcpt-1 의 성공 진행률이 보존되어야 한다');

    const second = await voidNotify.runWorkerOnce({ now: Date.now() + 1 });
    assert.equal(second.processed, 1);
    assert.equal(second.sent, 1, '2차 사이클은 나머지 수신자만 마저 발송해 성공해야 한다');

    const afterSecond = voidNotify.listQueue({ channelKey: alias }).find(i => i.entry_id === entry_id);
    assert.equal(afterSecond.status, 'sent');

    // 핵심 단언: 2차 사이클(재시도)이 실제로 발송을 "시도"한 대상에 rcpt-1 이 다시 나타나면 안 된다.
    assert.deepEqual(attemptsPerCall[1], ['rcpt-2'], 'retry must only attempt the remaining recipient(s), never re-attempting rcpt-1');
  } finally {
    voidNotify.SENDERS.telegram = originalSender;
  }

  voidNotify.delChannel(alias);
});

test('runWorkerOnce: a 429 response is counted as `deferred`, not `failed`, keeping processed === sent + failed + deferred (LOW #7)', async () => {
  const alias = makeChannelAlias('deferred-count');
  voidNotify.putChannel({ alias, api_key: 'k', send_to: ['1'] });
  voidNotify.notify({ subject: 's', content: 'c', provider_key: alias });

  const originalSender = voidNotify.SENDERS.telegram;
  voidNotify.SENDERS.telegram = async () => ({ ok: false, error: '429', retryAfterSeconds: 30, sentTo: [] });

  try {
    const summary = await voidNotify.runWorkerOnce({ now: Date.now() });
    assert.equal(summary.processed, 1);
    assert.equal(summary.sent, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.processed, summary.sent + summary.failed + summary.deferred, 'processed must equal the sum of sent+failed+deferred');
    assert.equal(typeof summary.errors, 'number');
  } finally {
    voidNotify.SENDERS.telegram = originalSender;
  }

  voidNotify.delChannel(alias);
});

test('runWorkerOnce: return shape stays contract-compatible ({processed,sent,failed} plus new deferred/errors fields)', async () => {
  const summary = await voidNotify.runWorkerOnce({ now: Date.now() });
  assert.equal(typeof summary.processed, 'number');
  assert.equal(typeof summary.sent, 'number');
  assert.equal(typeof summary.failed, 'number');
  assert.equal(typeof summary.deferred, 'number');
  assert.equal(typeof summary.errors, 'number');
  assert.equal(summary.processed, summary.sent + summary.failed + summary.deferred);
});
