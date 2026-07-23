'use strict';

// void-notify — 채널 등록(api_key) 암호화 프리미티브.
//
// lib/sync.js의 AES-256-GCM 프레임(encryptFrame/decryptFrame, L502-522)과 같은 알고리즘·같은
// randomBytes(12) IV 규약을 그대로 쓰지만, sync.js는 세션마다 HKDF로 새로 파생되는 임시 키인 반면
// 여기는 "영속" 키다 — void-notify 채널의 api_key는 프로세스 재시작/재부팅을 넘어 계속 복호화할 수
// 있어야 하므로, 키 자체를 storageDir()/void-notify.key 에 한 번 생성해 파일로 영속시키고(0o600),
// 프로세스 수명 동안 모듈 전역에 캐시한다. sync.js처럼 프레임에 type 바이트를 넣지 않는다 — 이건
// 두 프로세스 간 와이어 프로토콜이 아니라 단일 프로세스가 자기 DB에 저장한 값을 나중에 자기가
// 다시 읽는 용도라 타입 태깅이 필요 없다.
//
// 포맷: base64(iv[12] || tag[16] || ciphertext) — 헤더 없음.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { storageDir } = require('./storage');

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey = null; // 프로세스 수명 캐시 — getOrCreateKey() 가 채운다

function keyPath() {
  return path.join(storageDir(), 'void-notify.key');
}

// 키 파일이 있으면 읽어 캐시하고, 없으면 새로 생성해 0o600으로 기록한다. 두 경로 모두
// 결과를 cachedKey에 남겨 이후 호출은 파일 I/O 없이 재사용한다.
function getOrCreateKey() {
  if (cachedKey) return cachedKey;
  const p = keyPath();
  try {
    const buf = fs.readFileSync(p);
    if (buf.length !== KEY_BYTES) {
      throw new Error(`voidNotifyCrypto: key file at ${p} has unexpected length ${buf.length} (expected ${KEY_BYTES})`);
    }
    cachedKey = buf;
    return cachedKey;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // ENOENT 이외(권한/손상 등)는 조용히 넘기지 않는다
    const buf = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(p, buf, { mode: 0o600 });
    cachedKey = buf;
    return cachedKey;
  }
}

function encryptSecret(plaintext) {
  if (plaintext == null) throw new Error('voidNotifyCrypto.encryptSecret: plaintext 가 필요합니다');
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// 인증 태그 검증 실패 시 decipher.final()이 던진다 — 그대로 전파한다(깨진/변조된 값을 조용히
// 빈 문자열 등으로 흘려보내지 않기 위함).
function decryptSecret(blob) {
  if (blob == null) throw new Error('voidNotifyCrypto.decryptSecret: blob 이 필요합니다');
  const key = getOrCreateKey();
  const buf = Buffer.from(String(blob), 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('voidNotifyCrypto.decryptSecret: blob 이 너무 짧습니다');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { keyPath, getOrCreateKey, encryptSecret, decryptSecret };
