'use strict';

/*
 * test/sync-ssh.test.js 전용 가짜 `ssh` 실행 파일.
 *
 * 실제 시스템 ssh/sshd, 유효한 인증정보가 없는 환경(CI 등)에서도
 * lib/sync.js의 spawnSshTunnel/waitForTunnelReady 분기(성공/조기실패)를
 * 결정론적으로 검증하기 위한 스텁 — void의 spawnSshTunnel()이 실제로
 * argv를 어떻게 구성하는지(특히 `-L 127.0.0.1:<local>:<remoteHost>:<remotePort>`)
 * 그대로 넘겨받아 파싱한다.
 *
 * 동작은 env FAKE_SSH_MODE로 제어:
 *   'success' (기본) — argv의 -L에서 로컬 포트를 뽑아 그 포트를 그냥 열어두고
 *                       (실제 포워딩은 하지 않음 — "포트가 열렸다"는 신호만
 *                       재현하면 충분), SIGTERM 받을 때까지 대기한다(실제
 *                       `ssh -N`과 동일한 장기 대기 프로세스 형태).
 *   'fail'            — 실제 ssh가 BatchMode 인증 실패 시 그러듯 즉시
 *                       nonzero 종료 코드로 종료한다.
 */

const net = require('net');

const mode = process.env.FAKE_SSH_MODE || 'success';

if (mode === 'fail') {
  process.stderr.write('fake-ssh: Permission denied (publickey).\n');
  process.exit(255);
}

const args = process.argv.slice(2);
const lIdx = args.indexOf('-L');
const spec = lIdx !== -1 ? args[lIdx + 1] : null;
const m = spec && /^([^:]+):(\d+):(.+):(\d+)$/.exec(spec);
if (!m) {
  process.stderr.write('fake-ssh: -L 인자를 파싱하지 못함: ' + spec + '\n');
  process.exit(2);
}
const localPort = Number(m[2]);

const server = net.createServer((sock) => sock.end());
server.on('error', (err) => {
  process.stderr.write('fake-ssh: listen 실패: ' + (err && err.message) + '\n');
  process.exit(3);
});
server.listen(localPort, '127.0.0.1', () => {
  // 부모가 SIGTERM으로 죽일 때까지 그냥 대기 — 실제 `ssh -N`과 동일.
});

process.on('SIGTERM', () => process.exit(0));
