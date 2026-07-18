'use strict';
// 두 void 설치본 사이에서 네임드 세션 프로필 전체를 같은 네트워크/VPN 대역 안에서
// WebSocket으로 직접(중계 서버 없이) 동기화한다. Export가 페어링 코드를 표시하며
// 임시 ws 서버를 띄우고, Import는 그 코드를 입력해 접속한 뒤 세션을 받아 로컬에
// 반영한다. `ws`는 여기서만(그리고 이 모듈의 각 flow 안에서만) lazy 하게 로드해
// 의존성이 없어도 모듈 자체는 항상 로드되게 한다(lib/wrapper.js의 node-pty 선택적
// 로딩과 동일한 원칙).
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const http   = require('http');
const { resolveSessionConfigDir, getSessions, saveSession } = require('./storage');

let VOID_VERSION = 'unknown';
try { VOID_VERSION = require('../package.json').version; } catch {}

function isAvailable() {
  try { require.resolve('ws'); return true; } catch { return false; }
}

function fmtNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 안전한 진행상황 로거 ────────────────────────────────────
// secret / HMAC proof / encKey / 파일 내용은 절대 이 함수를 거치지 않는다 —
// 허용된(primitive) 필드만 통과시키는 화이트리스트 방식이라 호출부 실수로
// 민감값이 섞여 들어와도 UI/로그에 노출되지 않는다.
const LOG_ALLOWLIST = ['phase', 'message', 'sessionName', 'fileCount', 'byteCount', 'errorCode', 'rel', 'status', 'reason'];
function safeEvent(fields) {
  const out = {};
  if (!fields) return out;
  for (const k of LOG_ALLOWLIST) {
    if (k in fields) out[k] = fields[k];
  }
  return out;
}

// ── 보안 상수 ────────────────────────────────────────────────
// 세션명/toolCommand는 원격(상대방 export 측)이 보낸 매니페스트에서 오므로 절대
// 신뢰하지 않는다 — lib/sessions.js:185, lib/assistant.js:15와 동일한 규칙으로
// 검증해야 resolveSessionConfigDir()가 "../../.." 같은 값으로 임의 디렉토리를
// 가리키는 경로 조작(디렉토리 클로버링)을 막을 수 있다.
const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
// lib/sessions.js의 sessionCapableTools()가 실제로 세션을 만들 수 있다고 인정하는
// 도구 집합과 동일 — 정규식 통과만으로는 "낯선 도구명"까지 허용해버리므로 이중으로 좁힌다.
const KNOWN_TOOL_COMMANDS = ['claude', 'codex', 'agy'];
// 인증(challenge/auth) 없이 연결만 붙잡아두는 클라이언트가 single-use 슬롯과
// bind된 포트를 영구히 점유해 진짜 상대의 접속을 막는(DoS) 것을 방지한다.
const AUTH_TIMEOUT_MS = 15 * 1000;
// 인증된 상대라도 매니페스트 자체의 무결성/출처까지 보장되는 건 아니다(공격자가
// 정상적으로 인증에 성공한 뒤 비정상적인 매니페스트를 보낼 수 있음) — 개수/용량에
// 상한을 둬서 디스크 고갈(DoS)을 막는다.
const MAX_MANIFEST_SESSIONS = 100;
const MAX_FILES_PER_SESSION = 10000;
const MAX_MANIFEST_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// ── Crockford Base32 (I,L,O,U 제외, 패딩 없음) ───────────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of str) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function groupCode(flat) {
  return (flat.match(/.{1,5}/g) || []).join('-');
}

// ── IP <-> Buffer ────────────────────────────────────────────
function ipv4ToBuffer(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 0 || n > 255) return null;
    buf[i] = n;
  }
  return buf;
}

function bufferToIpv4(buf) {
  return Array.from(buf).join('.');
}

function ipv6ToBuffer(ip) {
  let addr = String(ip);
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);

  const dcIdx = addr.indexOf('::');
  let head, tail;
  if (dcIdx !== -1) {
    head = addr.slice(0, dcIdx).split(':').filter(Boolean);
    tail = addr.slice(dcIdx + 2).split(':').filter(Boolean);
  } else {
    head = addr.split(':');
    tail = [];
  }
  const fillCount = 8 - head.length - tail.length;
  if (fillCount < 0) return null;
  const groups = [...head, ...Array(fillCount).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    buf.writeUInt16BE(v, i * 2);
  }
  return buf;
}

function bufferToIpv6(buf) {
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(i * 2).toString(16));

  // 가장 긴 0-런을 '::'로 압축 (표시용 — round-trip 정확성엔 필요 없음).
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen > 1) {
    const before = groups.slice(0, bestStart).join(':');
    const after = groups.slice(bestStart + bestLen).join(':');
    return `${before}::${after}`;
  }
  return groups.join(':');
}

// ── 페어링 코드 인코딩/디코딩 ─────────────────────────────────
// 구조: [version:1=0x01][addrFamily:1(4|6)][addr:4|16][port:2 BE][secret:16][checksum:2]
// checksum = sha256(version..secret)의 앞 2바이트.
function buildPairingCode({ host, port, secret }) {
  const isV6 = host.includes(':');
  const family = isV6 ? 6 : 4;
  const addrBuf = isV6 ? ipv6ToBuffer(host) : ipv4ToBuffer(host);
  if (!addrBuf || !Buffer.isBuffer(secret) || secret.length !== 16) return null;

  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);

  const pre = Buffer.concat([Buffer.from([0x01, family]), addrBuf, portBuf, secret]);
  const checksum = crypto.createHash('sha256').update(pre).digest().slice(0, 2);
  const full = Buffer.concat([pre, checksum]);
  return groupCode(base32Encode(full));
}

// 실패 시 항상 null — 호출부는 어떤 이유든 뭉뚱그려 재시도를 안내하고, 코드 자체는
// 절대 되돌려 보여주지 않는다(로그/화면 어디에도 원본 입력을 echo하지 않음).
function parsePairingCode(codeRaw) {
  try {
    const clean = String(codeRaw).replace(/[\s-]/g, '').toUpperCase();
    if (!clean) return null;
    const buf = base32Decode(clean);
    if (!buf || buf.length < 2) return null;

    const version = buf[0];
    if (version !== 0x01) return null;
    const family = buf[1];
    if (family !== 4 && family !== 6) return null;

    const addrLen = family === 4 ? 4 : 16;
    const expectedLen = 1 + 1 + addrLen + 2 + 16 + 2;
    if (buf.length !== expectedLen) return null;

    let offset = 2;
    const addrBuf = buf.slice(offset, offset + addrLen); offset += addrLen;
    const port = buf.readUInt16BE(offset); offset += 2;
    const secret = buf.slice(offset, offset + 16); offset += 16;
    const checksum = buf.slice(offset, offset + 2);

    const pre = buf.slice(0, offset);
    const expectedChecksum = crypto.createHash('sha256').update(pre).digest().slice(0, 2);
    if (!checksum.equals(expectedChecksum)) return null;

    const host = family === 4 ? bufferToIpv4(addrBuf) : bufferToIpv6(addrBuf);
    return { host, port, secret, family };
  } catch {
    return null;
  }
}

// ── 네트워크 인터페이스 열거 ──────────────────────────────────
function listInterfaces() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(nets || {})) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      const isV6 = addr.family === 'IPv6' || addr.family === 6;
      const family = isV6 ? 'IPv6' : 'IPv4';
      if (!isV6 && /^169\.254\./.test(addr.address)) continue; // link-local IPv4
      if (isV6 && /^fe80:/i.test(addr.address)) continue;       // link-local IPv6 (fe80::/10)
      result.push({ iface: name, address: addr.address, family });
    }
  }
  return result;
}

function pickAutoInterface(list) {
  const ipv4 = list.filter(i => i.family === 'IPv4');
  const priv10  = ipv4.find(i => /^10\./.test(i.address));
  if (priv10) return priv10;
  const priv172 = ipv4.find(i => /^172\.(1[6-9]|2\d|3[0-1])\./.test(i.address));
  if (priv172) return priv172;
  const priv192 = ipv4.find(i => /^192\.168\./.test(i.address));
  if (priv192) return priv192;
  if (ipv4.length > 0) return ipv4[0];
  const ipv6 = list.filter(i => i.family === 'IPv6');
  if (ipv6.length > 0) return ipv6[0];
  return null;
}

// ── 경로 검증 (load-bearing) ─────────────────────────────────
function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('/') || norm === '..' || norm.startsWith('../') || /^[A-Za-z]:/.test(norm)) return null;
  return norm;
}

// dest가 실제로 localConfigDir(또는 스테이징 디렉토리) 아래에 있는지 재확인한다.
// safeRelPath만으로는 상위 레이어의 path.join 구현 실수를 못 잡으므로 이중 방어.
function resolveSafeDest(baseDir, rel) {
  const safeRel = safeRelPath(rel);
  if (!safeRel) return null;
  const dest = path.join(baseDir, safeRel);
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedDest = path.resolve(dest);
  if (!resolvedDest.startsWith(resolvedBase)) return null;
  return { safeRel, dest };
}

// ── AES-256-GCM 프레임: [type:1][iv:12][tag:16][ciphertext] ──
function encryptFrame(key, type, payloadBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(payloadBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([type]), iv, tag, enc]);
}

// 인증 태그 검증 실패 시 decipher.final()이 던진다 — 그대로 전파해 호출부가
// "이 세션을 중단"하게 만든다(깨진 내용을 해석하지 않음).
function decryptFrame(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1 + 12 + 16) throw new Error('FRAME_TOO_SHORT');
  const type = buf[0];
  const iv = buf.slice(1, 13);
  const tag = buf.slice(13, 29);
  const ciphertext = buf.slice(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { type, payload: dec };
}

function encodeJson(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }
function decodeJson(buf) { return JSON.parse(buf.toString('utf8')); }

function sendControlFrame(ws, encKey, obj) {
  const frame = encryptFrame(encKey, 0x01, encodeJson(obj));
  return new Promise((resolve, reject) => ws.send(frame, err => (err ? reject(err) : resolve())));
}

// ── Export: 세션 파일 목록 수집 ──────────────────────────────
// entry.isSymbolicLink()은 건너뛰고 요약에 개수만 남긴다(따라가지 않음 — 순환/탈출 방지).
function walkSessionFiles(baseDir) {
  const files = [];
  let skippedSymlinks = 0;
  let totalBytes = 0;

  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { skippedSymlinks++; continue; }
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (entry.isFile()) {
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        files.push({ rel, size: st.size, mode: st.mode & 0o777, abs: full });
        totalBytes += st.size;
      }
    }
  };

  if (fs.existsSync(baseDir)) walk(baseDir, '');
  return { files, totalBytes, skippedSymlinks };
}

// 토큰 연결(tokenService/tokenAlias)은 의도적으로 제외한다 — 다른 기기로 함께
// 넘어가면 안 되는 부가 링크이기 때문(설계상 UI에도 별도로 안내).
function buildExportManifest(sessions) {
  const result = [];
  let totalBytes = 0;
  let skippedSymlinks = 0;

  for (const s of sessions) {
    const walked = walkSessionFiles(s.configDir);
    totalBytes += walked.totalBytes;
    skippedSymlinks += walked.skippedSymlinks;
    result.push({
      name: s.name,
      toolCommand: (s.toolCommand || 'claude').toLowerCase(),
      createdAt: s.created_at,
      files: walked.files,
      totalBytes: walked.totalBytes,
    });
  }

  return { sessions: result, totalSessions: result.length, totalBytes, skippedSymlinks };
}

async function sendFileBytes(ws, encKey, absPath, hash) {
  const CHUNK = 64 * 1024;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absPath, { highWaterMark: CHUNK });
    stream.on('error', reject);
    stream.on('data', chunk => {
      stream.pause();
      hash.update(chunk);
      const frame = encryptFrame(encKey, 0x02, chunk);
      ws.send(frame, err => {
        if (err) { reject(err); return; }
        stream.resume();
      });
    });
    stream.on('end', resolve);
  });
}

async function sendManifestAndFiles(ws, encKey, manifestData, onEvent) {
  const manifestMsg = {
    type: 'manifest',
    v: 1,
    generatedBy: { voidVersion: VOID_VERSION, platform: process.platform },
    sessions: manifestData.sessions.map(s => ({
      name: s.name, toolCommand: s.toolCommand, createdAt: s.createdAt,
      files: s.files.map(f => ({ rel: f.rel, size: f.size, mode: f.mode })),
      totalBytes: s.totalBytes,
    })),
    totalSessions: manifestData.totalSessions,
    totalBytes: manifestData.totalBytes,
  };
  await sendControlFrame(ws, encKey, manifestMsg);
  const fileCount = manifestData.sessions.reduce((n, s) => n + s.files.length, 0);
  onEvent(safeEvent({ phase: 'manifest-sent', fileCount, byteCount: manifestData.totalBytes }));

  for (let si = 0; si < manifestData.sessions.length; si++) {
    const sess = manifestData.sessions[si];
    for (const file of sess.files) {
      await sendControlFrame(ws, encKey, { type: 'file-start', v: 1, sessionIndex: si, rel: file.rel, size: file.size, mode: file.mode });
      const hash = crypto.createHash('sha256');
      await sendFileBytes(ws, encKey, file.abs, hash);
      await sendControlFrame(ws, encKey, { type: 'file-end', v: 1, sessionIndex: si, rel: file.rel, sha256: hash.digest('hex') });
      onEvent(safeEvent({ phase: 'file-sent', sessionName: sess.name, rel: file.rel, byteCount: file.size, message: `전송: ${sess.name}/${file.rel}` }));
    }
  }

  await sendControlFrame(ws, encKey, { type: 'done', v: 1, totalFiles: fileCount, totalBytes: manifestData.totalBytes });
  onEvent(safeEvent({ phase: 'awaiting-result', message: '가져오기 측 완료 보고 대기 중...' }));
}

// ── Export: ws 서버 ──────────────────────────────────────────
// chosenIp에 직접 bind (0.0.0.0 금지) — 사용자가 명시적으로 고른 인터페이스
// 밖에서는 아예 리스닝하지 않는다. single-use: 첫 연결만 받고, 이후 연결은
// 1013으로 즉시 닫아 브루트포스 시도 횟수를 1회로 제한한다.
async function startExportServer(chosenIp, sessions, onEvent) {
  const WebSocket = require('ws');
  const manifestData = buildExportManifest(sessions);

  return new Promise((resolveSetup, rejectSetup) => {
    const server = http.createServer();
    const wss = new WebSocket.Server({ server });
    let handled = false;
    let secret = null;
    let ttlTimer = null;
    let settledResult = false;
    let resolveResult;
    const resultPromise = new Promise(r => { resolveResult = r; });

    const finalize = (result) => {
      if (settledResult) return;
      settledResult = true;
      if (ttlTimer) clearTimeout(ttlTimer);
      resolveResult(result);
      try { wss.close(); } catch {}
      try { server.close(); } catch {}
    };

    wss.on('connection', (ws) => {
      if (handled) { try { ws.close(1013, 'busy'); } catch {} return; }
      handled = true;
      if (ttlTimer) clearTimeout(ttlTimer);
      onEvent(safeEvent({ phase: 'connected', message: '가져오기 클라이언트 연결됨 — 인증 중' }));

      const nonce = crypto.randomBytes(16);
      let encKey = null;
      let authed = false;

      // MEDIUM 1 fix: connection이 붙었다고 무기한 슬롯을 내주지 않는다 — 이
      // 시간 안에 인증을 마치지 못하면 강제 종료하고 서버 자체도 정리한다
      // (single-use라 재시도는 어차피 불가능하므로, 매달아두는 것보다 실패로
      // 확정짓는 편이 진짜 상대의 재시도 경로를 더 빨리 열어준다).
      const authTimer = setTimeout(() => {
        if (!authed) {
          onEvent(safeEvent({ phase: 'auth-timeout', errorCode: 'AUTH_TIMEOUT', message: '인증 시간 초과' }));
          try { ws.terminate(); } catch {}
          finalize({ ok: false, reason: 'auth-timeout' });
        }
      }, AUTH_TIMEOUT_MS);

      try {
        ws.send(JSON.stringify({ type: 'challenge', v: 1, nonce: nonce.toString('base64') }));
      } catch {
        clearTimeout(authTimer);
        finalize({ ok: false, reason: 'send-failed' });
        return;
      }

      ws.on('message', async (data) => {
        try {
          if (!authed) {
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.v !== 1) throw new Error('VERSION_MISMATCH');
            if (msg.type !== 'auth' || typeof msg.proof !== 'string') throw new Error('BAD_AUTH_MSG');

            const expected = crypto.createHmac('sha256', secret).update(nonce).digest();
            const proofBuf = Buffer.from(msg.proof, 'hex');
            const ok = proofBuf.length === expected.length && crypto.timingSafeEqual(proofBuf, expected);
            if (!ok) {
              clearTimeout(authTimer);
              try { ws.send(JSON.stringify({ type: 'error', v: 1, code: 'AUTH_FAILED' })); } catch {}
              try { ws.close(); } catch {}
              onEvent(safeEvent({ phase: 'auth-failed', errorCode: 'AUTH_FAILED', message: '인증 실패' }));
              finalize({ ok: false, reason: 'auth-failed' });
              return;
            }

            authed = true;
            clearTimeout(authTimer);
            encKey = Buffer.from(crypto.hkdfSync('sha256', secret, nonce, 'void-sync-v1', 32));
            onEvent(safeEvent({ phase: 'auth-ok', message: '인증 성공 — 전송 시작' }));
            await sendManifestAndFiles(ws, encKey, manifestData, onEvent);
            return;
          }

          // 인증 이후에는 모든 프레임이 암호화된 바이너리 — 여기서 클라이언트가
          // 보낼 수 있는 건 최종 import-result 뿐이다.
          const frame = decryptFrame(encKey, data);
          if (frame.type !== 0x01) throw new Error('UNEXPECTED_FRAME_TYPE');
          const msg = decodeJson(frame.payload);
          if (msg.v !== 1) throw new Error('VERSION_MISMATCH');

          if (msg.type === 'import-result') {
            onEvent(safeEvent({ phase: 'done', message: '가져오기 완료 보고 수신' }));
            finalize({ ok: true, importResult: msg });
            try { ws.close(); } catch {}
          } else if (msg.type === 'error') {
            onEvent(safeEvent({ phase: 'error', errorCode: msg.code, message: '가져오기 측 오류: ' + (msg.code || '') }));
            finalize({ ok: false, reason: msg.code || 'client-error' });
            try { ws.close(); } catch {}
          }
        } catch (err) {
          clearTimeout(authTimer);
          const code = (err && err.message === 'VERSION_MISMATCH') ? 'VERSION_MISMATCH' : 'PROTOCOL_ERROR';
          onEvent(safeEvent({ phase: 'error', errorCode: code, message: code === 'VERSION_MISMATCH' ? '프로토콜 버전 불일치' : '프로토콜 오류' }));
          finalize({ ok: false, reason: code });
          try { ws.close(); } catch {}
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimer);
        if (!settledResult) finalize({ ok: false, reason: 'closed-early' });
      });
      ws.on('error', () => {
        clearTimeout(authTimer);
        if (!settledResult) finalize({ ok: false, reason: 'ws-error' });
      });
    });

    server.on('error', (err) => rejectSetup(err));

    server.listen(0, chosenIp, () => {
      const port = server.address().port;
      secret = crypto.randomBytes(16);
      const code = buildPairingCode({ host: chosenIp, port, secret });
      if (!code) { rejectSetup(new Error('페어링 코드 생성 실패')); return; }

      ttlTimer = setTimeout(() => {
        if (!handled) {
          onEvent(safeEvent({ phase: 'expired', message: '5분 내에 연결이 없어 만료되었습니다.' }));
          finalize({ ok: false, reason: 'expired' });
        }
      }, 5 * 60 * 1000);

      resolveSetup({ code, port, manifestData, result: resultPromise });
    });
  });
}

// ── Import: ws 클라이언트 ─────────────────────────────────────
async function startImportClient({ host, port, secret, family }, onEvent) {
  const WebSocket = require('ws');
  const hostForUrl = family === 6 ? `[${host}]` : host;
  const url = `ws://${hostForUrl}:${port}`;

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve({ ok: false, reason: 'connect-failed' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(result);
    };

    const connectTimer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      finish({ ok: false, reason: 'connect-timeout' });
    }, 10000);

    let encKey = null;
    let sessionStates = null; // manifest 도착 후 채워짐
    let currentFile = null;   // { discard, sessionIndex, rel, dest, stream, hash, mode }

    const openFile = (sessionIndex, rel, size, mode) => {
      const st = sessionStates && sessionStates[sessionIndex];
      if (!st || st.aborted) { currentFile = { discard: true }; return; }

      const resolved = resolveSafeDest(st.stagingDir, rel);
      if (!resolved) {
        st.skippedUnsafe.push({ rel, reason: '건너뜀: 안전하지 않은 경로' });
        currentFile = { discard: true };
        return;
      }
      try {
        // MEDIUM 3 fix: 스테이징 디렉토리 트리도 0700으로 — lib/storage.js:16의
        // mkdirSync 관례와 동일하게 그룹/기타 접근을 애초에 차단한다.
        fs.mkdirSync(path.dirname(resolved.dest), { recursive: true, mode: 0o700 });
        // MEDIUM 3 fix: 기본 umask(흔히 세계-읽기 가능)로 잠깐이라도 열리는
        // TOCTOU 창을 없애기 위해 생성 시점부터 0600으로 연다 — 해시 검증
        // 통과 후에 매니페스트가 선언한 실제 mode로 다시 chmod한다.
        const stream = fs.createWriteStream(resolved.dest, { mode: 0o600 });
        currentFile = { discard: false, sessionIndex, rel: resolved.safeRel, dest: resolved.dest, stream, hash: crypto.createHash('sha256'), mode };
      } catch {
        st.failedFiles.push({ rel, reason: '쓰기 실패' });
        currentFile = { discard: true };
      }
    };

    const writeChunk = (buf) => {
      if (!currentFile || currentFile.discard) return;
      currentFile.stream.write(buf);
      currentFile.hash.update(buf);
    };

    const closeFile = (sha256Expected) => {
      if (!currentFile) return;
      if (currentFile.discard) { currentFile = null; return; }
      const st = sessionStates[currentFile.sessionIndex];
      currentFile.stream.end();
      const actual = currentFile.hash.digest('hex');
      if (actual !== sha256Expected) {
        st.failedFiles.push({ rel: currentFile.rel, reason: 'sha256 불일치' });
        // MEDIUM 3 fix: 무결성 검증에 실패한 파일은 스테이징에도 남기지 않는다
        // (이전엔 실패로만 "기록"하고 파일은 그대로 둬서, 이 세션 전체가 그대로
        // 최종 위치로 swap-in 되면 손상/위조된 파일까지 함께 반영될 수 있었다).
        try { fs.rmSync(currentFile.dest, { force: true }); } catch {}
        // 자격증명 저장소 성격상 부분 반영은 허용하지 않는다 — 파일 하나라도
        // 해시가 안 맞으면 이 세션 전체를 실패로 처리한다(finalizeAll 참고).
        st.hashMismatch = true;
      } else {
        try { fs.chmodSync(currentFile.dest, currentFile.mode || 0o600); } catch {}
      }
      currentFile = null;
    };

    // 진행 도중(파일 스트리밍 중) 연결이 끊기면 미완성 스테이징 디렉토리를 지우고
    // 기존 로컬 configDir은 손대지 않는다 — 세션 하나가 중단됐다고 전체 가져오기를
    // 중단하지 않고, 다른 세션들의 최종 결과에는 영향 없이 이 세션만 실패로 남긴다.
    const abortIncomplete = (reason) => {
      if (!sessionStates) return;
      for (const st of sessionStates) {
        if (st.finalized) continue;
        st.aborted = true;
        if (st.stagingDir) {
          try { fs.rmSync(st.stagingDir, { recursive: true, force: true }); } catch {}
        }
      }
    };

    // CRITICAL fix: name/toolCommand는 원격이 보낸 매니페스트에서 그대로 온다 —
    // resolveSessionConfigDir(toolCommand, name)이 검증 없이 이 값들로
    // path.join(os.homedir(), `.${tool}-${name}`)을 만들기 때문에, 예를 들어
    // name = '../../../../../../tmp/pwned' 이면 임의 디렉토리를 .bak-*로
    // rename 시키고 그 자리에 공격자 콘텐츠를 채워 넣는(임의 디렉토리 클로버링)
    // 공격이 가능했다. per-file safeRelPath/resolveSafeDest는 rel(파일 경로)만
    // 검사할 뿐 세션명 자체는 절대 보지 않으므로 별도 검증이 필요하다.
    // lib/sessions.js:185, lib/assistant.js:15와 동일한 규칙으로 name과
    // toolCommand를 둘 다 검증하고, 실패한 세션은 경로를 아예 만들지 않은 채
    // "안전하지 않은 세션 이름"으로 건너뛴다(다른 세션은 계속 진행).
    const isValidSessionIdentity = (name, toolCommand) =>
      typeof name === 'string' && SESSION_NAME_RE.test(name) &&
      typeof toolCommand === 'string' && SESSION_NAME_RE.test(toolCommand) &&
      KNOWN_TOOL_COMMANDS.includes(toolCommand);

    const initSessionStates = (manifest) => {
      return manifest.sessions.map(s => {
        const rawName = typeof s.name === 'string' ? s.name : '';
        const rawTool = typeof s.toolCommand === 'string' ? s.toolCommand.toLowerCase() : '';

        if (!isValidSessionIdentity(rawName, rawTool)) {
          // resolveSessionConfigDir()를 호출하지 않는다 — 검증에 실패한 이름/
          // toolCommand로는 애초에 어떤 경로도 만들지 않는다.
          return {
            meta: { name: rawName || '(unnamed)', toolCommand: rawTool || '(unknown)', createdAt: s.createdAt },
            stagingDir: null, localConfigDir: null,
            failedFiles: [], skippedUnsafe: [],
            aborted: true, finalized: false, hashMismatch: false,
            invalidReason: '안전하지 않은 세션 이름',
          };
        }

        const toolCommand = rawTool;
        const localConfigDir = resolveSessionConfigDir(toolCommand, rawName);
        const stagingDir = `${localConfigDir}.incoming-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
        return {
          meta: { name: rawName, toolCommand, createdAt: s.createdAt },
          stagingDir, localConfigDir,
          failedFiles: [], skippedUnsafe: [],
          aborted: false, finalized: false, hashMismatch: false,
        };
      });
    };

    const finalizeAll = () => {
      const results = [];
      for (const st of sessionStates) {
        if (st.aborted) {
          results.push({ name: st.meta.name, status: 'skipped-error', reason: st.invalidReason || '전송 중단됨' });
          st.finalized = true;
          continue;
        }
        if (st.hashMismatch) {
          // MEDIUM 3 fix: 파일 중 하나라도 해시 검증에 실패하면 세션 전체를
          // 실패로 처리한다 — 부분적으로만 검증된 자격증명 디렉토리를 그대로
          // swap-in 하지 않는다. 스테이징만 지우고 기존 localConfigDir은
          // 손대지 않는다.
          try { fs.rmSync(st.stagingDir, { recursive: true, force: true }); } catch {}
          results.push({ name: st.meta.name, status: 'skipped-error', reason: '파일 무결성 검증 실패 (sha256 불일치)' });
          st.finalized = true;
          continue;
        }
        try {
          const existed = fs.existsSync(st.localConfigDir);
          let status = 'imported';
          let backupPath;
          if (existed) {
            backupPath = `${st.localConfigDir}.bak-${Date.now()}`;
            fs.renameSync(st.localConfigDir, backupPath);
            status = 'backed-up-and-overwritten';
          }
          try {
            fs.renameSync(st.stagingDir, st.localConfigDir);
          } catch (renameErr) {
            // MEDIUM 2 fix: 두 번째 rename(스테이징 → 실제 위치)이 실패하면,
            // 이미 백업으로 옮겨둔 기존 디렉토리를 원위치로 복구한다 — 그렇지
            // 않으면 사용자의 실제 세션이 .bak-*로만 남고 sessions.json은
            // 사라진 경로를 가리키는 고아 상태가 된다.
            if (backupPath) {
              try { fs.renameSync(backupPath, st.localConfigDir); } catch {}
            }
            throw renameErr;
          }
          saveSession({
            name: st.meta.name, toolCommand: st.meta.toolCommand,
            configDir: st.localConfigDir, created_at: st.meta.createdAt,
            imported_at: fmtNow(),
          });
          const skipped = [...st.skippedUnsafe, ...st.failedFiles];
          results.push({ name: st.meta.name, status, backupPath, skipped });
        } catch (err) {
          try { fs.rmSync(st.stagingDir, { recursive: true, force: true }); } catch {}
          results.push({ name: st.meta.name, status: 'skipped-error', reason: (err && err.message) || '알 수 없는 오류' });
        }
        st.finalized = true;
      }
      return results;
    };

    ws.on('open', () => {
      onEvent(safeEvent({ phase: 'connected', message: '연결됨 — 인증 대기 중' }));
    });

    ws.on('message', async (data) => {
      try {
        if (!encKey) {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.v !== 1) { finish({ ok: false, reason: 'version-mismatch' }); try { ws.close(); } catch {} return; }

          if (msg.type === 'challenge') {
            const nonce = Buffer.from(msg.nonce, 'base64');
            const proof = crypto.createHmac('sha256', secret).update(nonce).digest('hex');
            ws.send(JSON.stringify({ type: 'auth', v: 1, proof }));
            encKey = Buffer.from(crypto.hkdfSync('sha256', secret, nonce, 'void-sync-v1', 32));
            return;
          }
          if (msg.type === 'error') {
            onEvent(safeEvent({ phase: 'error', errorCode: msg.code, message: '인증 실패' }));
            finish({ ok: false, reason: msg.code || 'auth-failed' });
            try { ws.close(); } catch {}
          }
          return;
        }

        const frame = decryptFrame(encKey, data);
        if (frame.type === 0x02) { writeChunk(frame.payload); return; }
        if (frame.type !== 0x01) return;

        const msg = decodeJson(frame.payload);
        if (msg.v !== 1) throw new Error('VERSION_MISMATCH');

        if (msg.type === 'manifest') {
          // MEDIUM 4 fix: 인증까지 마친 상대라도 매니페스트 내용 자체가
          // buildExportManifest()로 만들어졌다는 보장은 없다(손상되었거나
          // 변조된 peer가 과도한 세션/파일 수·용량을 선언해 디스크를 고갈시킬
          // 수 있음) — 스테이징을 시작하기 전에 상한을 강제한다.
          const sessionsArr = Array.isArray(msg.sessions) ? msg.sessions : null;
          const totalBytesDeclared = typeof msg.totalBytes === 'number' ? msg.totalBytes : Infinity;
          const withinCaps = sessionsArr &&
            sessionsArr.length <= MAX_MANIFEST_SESSIONS &&
            sessionsArr.every(s => Array.isArray(s.files) && s.files.length <= MAX_FILES_PER_SESSION) &&
            totalBytesDeclared <= MAX_MANIFEST_TOTAL_BYTES;

          if (!withinCaps) {
            onEvent(safeEvent({ phase: 'error', errorCode: 'MANIFEST_TOO_LARGE', message: '매니페스트가 허용 범위를 초과해 거부했습니다.' }));
            finish({ ok: false, reason: 'MANIFEST_TOO_LARGE' });
            try { ws.close(); } catch {}
            return;
          }

          sessionStates = initSessionStates(msg);
          const fileCount = msg.sessions.reduce((n, s) => n + s.files.length, 0);
          onEvent(safeEvent({ phase: 'manifest-received', fileCount, byteCount: msg.totalBytes, message: `${msg.sessions.length}개 세션, ${fileCount}개 파일 수신 예정` }));
        } else if (msg.type === 'file-start') {
          openFile(msg.sessionIndex, msg.rel, msg.size, msg.mode);
        } else if (msg.type === 'file-end') {
          closeFile(msg.sha256);
          onEvent(safeEvent({ phase: 'file-received', rel: msg.rel }));
        } else if (msg.type === 'done') {
          const results = finalizeAll();
          onEvent(safeEvent({ phase: 'finalized', message: '로컬 반영 완료' }));
          await sendControlFrame(ws, encKey, { type: 'import-result', v: 1, ok: true, sessions: results });
          finish({ ok: true, sessions: results });
          try { ws.close(); } catch {}
        } else if (msg.type === 'error') {
          onEvent(safeEvent({ phase: 'error', errorCode: msg.code, message: '내보내기 측 오류' }));
          finish({ ok: false, reason: msg.code || 'export-error' });
          try { ws.close(); } catch {}
        }
      } catch (err) {
        const code = (err && err.message === 'VERSION_MISMATCH') ? 'VERSION_MISMATCH' : 'DECRYPT_FAILED';
        abortIncomplete(code);
        onEvent(safeEvent({ phase: 'error', errorCode: code, message: code === 'VERSION_MISMATCH' ? '프로토콜 버전 불일치' : '복호화 실패' }));
        finish({ ok: false, reason: code });
        try { ws.close(); } catch {}
      }
    });

    ws.on('error', () => {
      if (!settled) {
        abortIncomplete('ws-error');
        finish({ ok: false, reason: 'ws-error' });
      }
    });
    ws.on('close', () => {
      if (!settled) {
        abortIncomplete('closed-early');
        finish({ ok: false, reason: 'closed-early' });
      }
    });
  });
}

// ── UI 흐름 ───────────────────────────────────────────────────

function statusLabel(status) {
  if (status === 'imported') return '가져옴';
  if (status === 'backed-up-and-overwritten') return '백업 후 덮어씀';
  if (status === 'skipped-error') return '건너뜀 (오류)';
  return status || '알 수 없음';
}

async function runExportFlow(config, c) {
  const { menu, message, liveScrollableMessage } = require('./ui');

  if (!isAvailable()) {
    await message('ws 모듈을 찾을 수 없습니다 (내부 의존성 오류).');
    return;
  }

  const sessions = getSessions();
  if (sessions.length === 0) {
    await message('내보낼 세션이 없습니다.');
    return;
  }

  const ifaces = listInterfaces();
  const auto = pickAutoInterface(ifaces);
  const items = [];
  if (auto) items.push({ key: '1', label: `자동: ${auto.address} (${auto.iface})`, _addr: auto.address });
  ifaces.forEach((i) => {
    items.push({ key: String(items.length + 1), label: `${i.iface}  ${i.address}  (${i.family})`, _addr: i.address });
  });

  if (items.length === 0) {
    await message('내보내기에 사용할 네트워크 인터페이스를 찾지 못했습니다.\n\nVPN/LAN에 연결되어 있는지 확인하세요.');
    return;
  }

  const ifSel = await menu('내보내기 — 네트워크 인터페이스 선택', items, { back: true });
  if (!ifSel) return;
  const chosenIp = ifSel._addr;

  // onEvent는 서버 생성 시점부터 실제 콜백으로 넘겨야 한다 — 연결이 오는 순간부터
  // 이벤트가 발생할 수 있으므로, 화면(handle)이 아직 없을 때는 그냥 버퍼(events)에만
  // 쌓아두고, liveScrollableMessage가 열린 뒤에는 매번 다시 그린다. setup.code/
  // setup.port/setup.manifestData는 startExportServer의 listen 콜백(동기적으로
  // resolveSetup을 호출) 이전에는 onEvent가 호출될 수 없으므로 참조 시점에는 항상
  // 채워져 있다.
  let setup = null;
  const events = [];
  let handle = null;
  const renderLines = (extra) => {
    const fileCount = setup ? setup.manifestData.sessions.reduce((n, s) => n + s.files.length, 0) : 0;
    const lines = [
      c.signal + '페어링 코드' + c.RESET,
      '',
      '  ' + c.text + (setup ? setup.code : '생성 중...') + c.RESET,
      '',
      '  선택한 주소: ' + c.muted2 + chosenIp + (setup ? ':' + setup.port : '') + c.RESET,
      setup ? ('  세션: ' + c.muted2 + setup.manifestData.totalSessions + '개, 파일 ' + fileCount + '개' +
        (setup.manifestData.skippedSymlinks > 0 ? ` (심볼릭 링크 ${setup.manifestData.skippedSymlinks}개 건너뜀)` : '') + c.RESET) : '',
      '',
      c.muted2 + '  방화벽에서 인바운드 연결 허용 요청이 뜨면 허용해주세요 (최초 1회).' + c.RESET,
      c.muted2 + '  토큰 연결은 동기화되지 않습니다.' + c.RESET,
      c.muted + '  5분 내에 가져오기가 연결되지 않으면 만료됩니다.' + c.RESET,
      '',
      ...events.map(e => '  ' + (e.message || '')),
    ];
    if (extra) lines.push('', extra);
    return lines.join('\n');
  };

  const onEvent = (fields) => {
    events.push(fields);
    if (handle) handle.setLines(renderLines());
  };

  try {
    setup = await startExportServer(chosenIp, sessions, onEvent);
  } catch (err) {
    await message('서버 시작 실패: ' + ((err && err.message) || err));
    return;
  }

  handle = liveScrollableMessage('내보내기 — 대기 중', renderLines());

  const result = await setup.result;

  const finalNote = result.ok
    ? c.signal + '✓ 전송 완료' + c.RESET
    : c.warn + '전송 실패/만료: ' + (result.reason || '') + c.RESET;
  handle.setLines(renderLines(finalNote));
  handle.setStatus('Enter를 눌러 닫기');
  await handle.done;
}

async function runImportFlow(config, c) {
  const { menu, message, input, liveScrollableMessage } = require('./ui');

  if (!isAvailable()) {
    await message('ws 모듈을 찾을 수 없습니다 (내부 의존성 오류).');
    return;
  }

  let parsed = null;
  while (!parsed) {
    const raw = await input('페어링 코드 입력: ', true);
    if (raw === null) return;
    parsed = parsePairingCode(raw);
    if (!parsed) {
      const retry = await menu('코드를 확인할 수 없습니다', [
        { key: '1', label: '다시 입력' },
      ], { back: true });
      if (!retry) return;
    }
  }

  const events = [];
  let handle = null;
  const renderLines = (extra) => {
    const lines = [c.signal + '가져오기 진행 중' + c.RESET, '', ...events.map(e => '  ' + (e.message || ''))];
    if (extra) lines.push('', extra);
    return lines.join('\n');
  };
  const onEvent = (fields) => {
    events.push(fields);
    if (handle) handle.setLines(renderLines());
  };

  handle = liveScrollableMessage('가져오기', renderLines());

  const result = await startImportClient(parsed, onEvent);

  const summaryLines = [c.signal + '가져오기 결과' + c.RESET, ''];
  if (result.ok && Array.isArray(result.sessions)) {
    for (const s of result.sessions) {
      summaryLines.push(`  ${s.name}: ${statusLabel(s.status)}${s.reason ? ' (' + s.reason + ')' : ''}`);
      if (s.skipped && s.skipped.length > 0) {
        for (const sk of s.skipped) summaryLines.push('    - ' + (sk.rel || '') + ': ' + (sk.reason || ''));
      }
    }
  } else {
    summaryLines.push('  ' + c.warn + '가져오기 실패: ' + (result.reason || '알 수 없는 오류') + c.RESET);
  }
  handle.setLines(summaryLines.join('\n'));
  handle.setStatus('Enter를 눌러 닫기');
  await handle.done;
}

async function syncMenu(config, c) {
  const { menu, message } = require('./ui');

  if (!isAvailable()) {
    await message(
      c.warn + 'ws 모듈을 사용할 수 없습니다.' + c.RESET + '\n\n' +
      c.muted + '  세션 동기화 기능을 쓰려면 ws 패키지가 필요합니다.' + c.RESET
    );
    return;
  }

  while (true) {
    const sel = await menu('세션 동기화 (Sync)', [
      { key: '1', label: '내보내기 (Export)', desc: '이 기기의 세션을 다른 void에 전송' },
      { key: '2', label: '가져오기 (Import)', desc: '페어링 코드로 세션 수신' },
    ], { back: true });
    if (!sel) return;

    if (sel.key === '1') await runExportFlow(config, c);
    else if (sel.key === '2') await runImportFlow(config, c);
  }
}

module.exports = {
  isAvailable,
  syncMenu,
  // 아래는 순수 함수/저수준 API — 자체 테스트 및 (필요 시) 다른 모듈 재사용을 위해 노출.
  buildPairingCode, parsePairingCode,
  base32Encode, base32Decode,
  listInterfaces, pickAutoInterface,
  safeRelPath, resolveSafeDest,
  startExportServer, startImportClient,
  encryptFrame, decryptFrame,
};
