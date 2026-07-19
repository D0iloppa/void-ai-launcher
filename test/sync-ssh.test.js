'use strict';

/*
 * lib/sync.js SSH 터널 전송 유닛 테스트.
 *
 * 기존 LAN/pairing-code 흐름(manifest/crypto/보안 안전장치)은 이 변경에서
 * 손대지 않았으므로 여기서는 새로 추가된 SSH 전송 계층의 순수 로직만 검증한다:
 *   - parseSshTarget / buildSshForwardArgs (인자 검증 + argv 구성, 순수 함수)
 *   - getFreeLocalPort / tryTcpConnectOnce / waitForTcpOpen (loopback 기반)
 *   - spawnSshTunnel + waitForTunnelReady (실제 ssh/sshd 없이도 결정론적으로
 *     검증하기 위해 test/fixtures/fake-ssh.js 스텁으로 override)
 *
 * 실제 시스템 ssh 바이너리나 sshd 접속 가능성에는 의존하지 않는다 — CI/샌드박스
 * 환경에서도 안정적으로 통과해야 하기 때문.
 *
 * fake-ssh.js 스텁은 일부러 test/ 트리 밖(../test-fixtures/)에 둔다 — Node의
 * 테스트 러너는 `node --test test/`로 지정된 경로 아래의 .js 파일을 (확장자
 * 패턴과 무관하게) 전부 테스트 파일로 취급해 직접 실행해버리므로, test/ 안에
 * 두면 인자 없이 실행되어 실패한다.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');

const sync = require('../lib/sync');

const FAKE_SSH = path.join(__dirname, '..', 'test-fixtures', 'fake-ssh.js');

// ── parseSshTarget ────────────────────────────────────────────
test('parseSshTarget: user@host', () => {
  assert.deepEqual(sync.parseSshTarget('alice@example.com'), { user: 'alice', host: 'example.com', port: null });
});

test('parseSshTarget: bare host (no user)', () => {
  assert.deepEqual(sync.parseSshTarget('example.com'), { user: null, host: 'example.com', port: null });
});

test('parseSshTarget: user@host:port', () => {
  assert.deepEqual(sync.parseSshTarget('bob@10.0.0.5:2222'), { user: 'bob', host: '10.0.0.5', port: 2222 });
});

test('parseSshTarget: bracketed IPv6 with port', () => {
  assert.deepEqual(sync.parseSshTarget('root@[::1]:22'), { user: 'root', host: '[::1]', port: 22 });
});

test('parseSshTarget: bracketed IPv6 without port', () => {
  assert.deepEqual(sync.parseSshTarget('[fe80::1]'), { user: null, host: '[fe80::1]', port: null });
});

test('parseSshTarget: rejects leading dash (option injection)', () => {
  assert.equal(sync.parseSshTarget('-oProxyCommand=evil'), null);
});

test('parseSshTarget: rejects unbracketed multi-colon IPv6', () => {
  assert.equal(sync.parseSshTarget('::1'), null);
});

test('parseSshTarget: rejects shell metacharacters / whitespace', () => {
  assert.equal(sync.parseSshTarget('host; rm -rf /'), null);
  assert.equal(sync.parseSshTarget('host $(whoami)'), null);
  assert.equal(sync.parseSshTarget(''), null);
  assert.equal(sync.parseSshTarget('   '), null);
});

test('parseSshTarget: rejects double @ and out-of-range port', () => {
  assert.equal(sync.parseSshTarget('a@b@host'), null);
  assert.equal(sync.parseSshTarget('host:99999'), null);
  assert.equal(sync.parseSshTarget('host:0'), null);
});

test('parseSshTarget: rejects non-string input', () => {
  assert.equal(sync.parseSshTarget(null), null);
  assert.equal(sync.parseSshTarget(undefined), null);
  assert.equal(sync.parseSshTarget(42), null);
});

// ── buildSshForwardArgs ───────────────────────────────────────
test('buildSshForwardArgs: shape + -L spec + trailing target', () => {
  const args = sync.buildSshForwardArgs({ target: 'alice@example.com', sshPort: 2222, localPort: 40000, remotePort: 50000 });
  assert.ok(Array.isArray(args));
  assert.equal(args[0], '-N');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  const lIdx = args.indexOf('-L');
  assert.ok(lIdx !== -1);
  assert.equal(args[lIdx + 1], '127.0.0.1:40000:127.0.0.1:50000');
  const pIdx = args.indexOf('-p');
  assert.equal(args[pIdx + 1], '2222');
  assert.equal(args[args.length - 1], 'alice@example.com'); // target은 마지막 위치 인자
});

test('buildSshForwardArgs: omits -p when sshPort not given', () => {
  const args = sync.buildSshForwardArgs({ target: 'host', localPort: 40001, remotePort: 50001 });
  assert.equal(args.includes('-p'), false);
});

test('buildSshForwardArgs: rejects invalid port ranges / missing target', () => {
  assert.equal(sync.buildSshForwardArgs({ target: '', localPort: 1, remotePort: 1 }), null);
  assert.equal(sync.buildSshForwardArgs({ target: 'host', localPort: 0, remotePort: 1 }), null);
  assert.equal(sync.buildSshForwardArgs({ target: 'host', localPort: 1, remotePort: 70000 }), null);
});

// ── getFreeLocalPort / tryTcpConnectOnce / waitForTcpOpen (loopback) ──
test('getFreeLocalPort: returns a bindable loopback port', async () => {
  const port = await sync.getFreeLocalPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);

  // 곧바로 다시 bind 가능해야 한다(포트가 실제로 해제되었는지 확인).
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('tryTcpConnectOnce: resolves true against a listening loopback server', async () => {
  const port = await sync.getFreeLocalPort();
  const srv = net.createServer((sock) => sock.end());
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    const ok = await sync.tryTcpConnectOnce('127.0.0.1', port, 1000);
    assert.equal(ok, true);
  } finally {
    srv.close();
  }
});

test('tryTcpConnectOnce: resolves false against a closed port', async () => {
  const port = await sync.getFreeLocalPort(); // 아무도 리스닝하지 않음
  const ok = await sync.tryTcpConnectOnce('127.0.0.1', port, 500);
  assert.equal(ok, false);
});

test('waitForTcpOpen: resolves true once a server starts listening mid-wait', async () => {
  const port = await sync.getFreeLocalPort();
  let srv;
  const timer = setTimeout(() => {
    srv = net.createServer((sock) => sock.end());
    srv.listen(port, '127.0.0.1');
  }, 300);

  try {
    const ok = await sync.waitForTcpOpen('127.0.0.1', port, { timeoutMs: 3000, intervalMs: 100 });
    assert.equal(ok, true);
  } finally {
    clearTimeout(timer);
    if (srv) srv.close();
  }
});

test('waitForTcpOpen: resolves false on timeout when nothing ever listens', async () => {
  const port = await sync.getFreeLocalPort();
  const ok = await sync.waitForTcpOpen('127.0.0.1', port, { timeoutMs: 500, intervalMs: 100 });
  assert.equal(ok, false);
});

// ── spawnSshTunnel + waitForTunnelReady (fake-ssh 스텁 기반) ──────
test('spawnSshTunnel + waitForTunnelReady: success path resolves ok:true once fake tunnel opens the local port', async () => {
  const localPort = await sync.getFreeLocalPort();
  const args = sync.buildSshForwardArgs({ target: 'irrelevant@example.com', localPort, remotePort: 9 });
  const tunnel = sync.spawnSshTunnel(args, null, {
    command: process.execPath,
    prefixArgs: [FAKE_SSH],
    env: { ...process.env, FAKE_SSH_MODE: 'success' },
  });

  try {
    const result = await sync.waitForTunnelReady(tunnel, localPort, 5000);
    assert.deepEqual(result, { ok: true });
  } finally {
    tunnel.stop();
  }
});

test('spawnSshTunnel + waitForTunnelReady: failure path (auth-denied stub) resolves ok:false quickly', async () => {
  const localPort = await sync.getFreeLocalPort();
  const args = sync.buildSshForwardArgs({ target: 'irrelevant@example.com', localPort, remotePort: 9 });
  const events = [];
  const tunnel = sync.spawnSshTunnel(args, (e) => events.push(e), {
    command: process.execPath,
    prefixArgs: [FAKE_SSH],
    env: { ...process.env, FAKE_SSH_MODE: 'fail' },
  });

  const start = Date.now();
  const result = await sync.waitForTunnelReady(tunnel, localPort, 5000);
  const elapsedMs = Date.now() - start;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ssh-tunnel-exited');
  assert.ok(elapsedMs < 4000, `조기 실패가 빠르게 감지되어야 함 (실측 ${elapsedMs}ms)`);
  assert.ok(events.some(e => e.phase === 'ssh-tunnel-exit'));
  tunnel.stop();
});
