'use strict';

/*
 * mailbox.js — void-to-void mail store (Phase A).
 *
 * Pure filesystem mailbox: each message is one markdown file with a small
 * hand-rolled YAML-ish frontmatter header, dropped into the recipient's
 * inbox directory under registry.js's MAIL_ROOT/inbox/<id>/. No dJinn, no
 * locking — messages are write-once, read-many, and deletes are plain
 * unlinks, so plain fs calls are sufficient.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { INBOX_DIR } = require('./registry');

function inboxDir(id) {
  const dir = path.join(INBOX_DIR, String(id));
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return dir;
}

function genMsgId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── Frontmatter (hand-rolled, robust to garbling) ───────────

function escapeValue(v) {
  return String(v == null ? '' : v).replace(/\r?\n/g, ' ');
}

function serialize({ id, from, fromLabel, to, timestamp, read }, body) {
  const lines = [
    '---',
    `id: ${escapeValue(id)}`,
    `from: ${escapeValue(from)}`,
    `fromLabel: ${escapeValue(fromLabel)}`,
    `to: ${escapeValue(to)}`,
    `timestamp: ${escapeValue(timestamp)}`,
    `read: ${read ? 'true' : 'false'}`,
    '---',
    body == null ? '' : String(body),
  ];
  return lines.join('\n');
}

// Fails soft: a missing/garbled header just yields default fields and the
// whole file content becomes the body.
function parse(raw) {
  const out = { id: '', from: '', fromLabel: '', to: '', timestamp: '', read: false, body: '' };
  if (typeof raw !== 'string') return out;

  if (raw.startsWith('---')) {
    const rest = raw.slice(3);
    const endIdx = rest.indexOf('\n---');
    if (endIdx !== -1) {
      const header = rest.slice(0, endIdx).replace(/^\n/, '');
      let body = rest.slice(endIdx + 4);
      if (body.startsWith('\n')) body = body.slice(1);
      for (const line of header.split('\n')) {
        const m = /^([a-zA-Z]+):\s?(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        const val = m[2];
        if (key === 'read') out.read = val.trim() === 'true';
        else if (key in out) out[key] = val;
      }
      out.body = body;
      return out;
    }
  }
  // No recognizable frontmatter — treat whole file as body.
  out.body = raw;
  return out;
}

function preview(body, maxLen = 60) {
  const firstLine = String(body || '').split('\n').find(l => l.trim().length > 0) || '';
  const collapsed = firstLine.trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen - 1) + '…' : collapsed;
}

function writeMessage(targetId, { from, fromLabel, to, body }) {
  const dir = inboxDir(targetId);
  const id = genMsgId();
  const timestamp = new Date().toISOString();
  const file = path.join(dir, `${Date.now()}-${id}.md`);
  const content = serialize({ id, from, fromLabel, to, timestamp, read: false }, body);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function sendTo(targetId, body, { registry } = {}) {
  const reg = registry || require('./registry');
  const self = reg.selfIdentity();
  return writeMessage(targetId, { from: self.id, fromLabel: self.label, to: targetId, body });
}

function broadcast(body, { registry } = {}) {
  const reg = registry || require('./registry');
  const self = reg.selfIdentity();
  const peers = reg.listPeers({ includeSelf: false });
  let count = 0;
  for (const peer of peers) {
    try {
      writeMessage(peer.id, { from: self.id, fromLabel: self.label, to: '*', body });
      count++;
    } catch {}
  }
  return count;
}

function listInbox(id) {
  const dir = inboxDir(id);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }

  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = parse(raw);
      out.push({
        file: full,
        id: parsed.id,
        from: parsed.from,
        fromLabel: parsed.fromLabel,
        to: parsed.to,
        timestamp: parsed.timestamp,
        read: parsed.read,
        body: parsed.body,
        preview: preview(parsed.body),
      });
    } catch {}
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.timestamp) || 0;
    const tb = Date.parse(b.timestamp) || 0;
    return tb - ta;
  });
  return out;
}

function markReadOne(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parse(raw);
    const content = serialize({ ...parsed, read: true }, parsed.body);
    fs.writeFileSync(file, content, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function markRead(files) {
  let count = 0;
  for (const f of files || []) { if (markReadOne(f)) count++; }
  return count;
}

function deleteMessages(files) {
  let count = 0;
  for (const f of files || []) {
    try { fs.unlinkSync(f); count++; } catch {}
  }
  return count;
}

function cleanup(id) {
  const dir = inboxDir(id);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return 0; }
  return deleteMessages(files.map(f => path.join(dir, f)));
}

function unreadCount(id) {
  return listInbox(id).filter(m => !m.read).length;
}

function totalCount(id) {
  return listInbox(id).length;
}

module.exports = {
  inboxDir,
  sendTo,
  broadcast,
  listInbox,
  markRead,
  markReadOne,
  deleteMessages,
  cleanup,
  unreadCount,
  totalCount,
  // exported for the smoke test / advanced callers
  parse,
  serialize,
};
