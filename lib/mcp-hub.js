'use strict';

// ── void MCP hub ──────────────────────────────────────────
// Two roles in one file:
//   1. A pure library (mailbox path helpers + shell-command builder) required
//      by wrapper.js and panel.mjs. Requiring this module NEVER touches the
//      optional @modelcontextprotocol/sdk, so it is always safe to load.
//   2. A standalone hub process (`node lib/mcp-hub.js --sock <sock>`) that
//      exposes send_message / check_mailbox / list_targets over local HTTP.
//      The SDK is required lazily inside runHub(); if it is missing the process
//      exits quietly and the caller falls back to the chat-runner mailbox only.

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── shared mailbox layout ─────────────────────────────────
function mailboxDir(sock)      { return path.join(os.tmpdir(), 'void-mailbox-' + sock); }
function mailboxFile(sock, idx) { return path.join(mailboxDir(sock), String(idx) + '.jsonl'); }

function ensureMailbox(sock, idx) {
  const dir = mailboxDir(sock);
  fs.mkdirSync(dir, { recursive: true });
  const f = mailboxFile(sock, idx);
  if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  return f;
}

function appendMessage(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Read all messages then truncate the file (drain semantics for MCP consumers).
function readAndDrain(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const msgs = raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  try { fs.writeFileSync(file, ''); } catch {}
  return msgs;
}

// Window indexes that currently have a mailbox file (= registered receivers).
function mailboxWindows(sock) {
  try {
    return fs.readdirSync(mailboxDir(sock))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  } catch { return []; }
}

// ── shell-command builder (pure, no SDK) ──────────────────
function shq(a) { return "'" + String(a).replace(/'/g, "'\\''") + "'"; }

// Build a bash script that self-resolves the window index + hub port and execs
// the tool with the voidhub MCP server injected (claude/codex only). Returns
// null when the tool is unsupported (e.g. agy). The caller wraps the returned
// string with `bash -c`.
//
// The port is read from `<mboxDir>/hub.port` at exec time (bounded wait), not
// baked in by the caller: the hub loads its SDK lazily (~seconds on slow
// filesystems), so it starts in parallel with the tmux session. If the port
// never appears the tool still launches, just without MCP (graceful fallback).
function buildMcpExec(tool, sock, mboxDir) {
  const cmd = (tool.command || '').toLowerCase();

  const host = 'http://127.0.0.1:';
  let mcpTokens;
  if (cmd === 'claude') {
    // JSON arg with $PORT and $IDX interpolated (broken out of single quotes)
    const json = `'{"mcpServers":{"voidhub":{"type":"http","url":"${host}'"$PORT"'/mcp?window='"$IDX"'"}}}'`;
    mcpTokens = `--mcp-config ${json}`;
  } else if (cmd === 'codex') {
    const val = `'mcp_servers.voidhub.url="${host}'"$PORT"'/mcp?window='"$IDX"'"'`;
    mcpTokens = `-c ${val}`;
  } else {
    return null;
  }

  const toolArgs = (tool.args || []).map(shq).join(' ');
  const argsSuffix = toolArgs ? ' ' + toolArgs : '';
  const envExec = `env -u TMUX -u TMUX_PANE -u TMUX_PLUGIN_MANAGER_PATH ${shq(tool.command)}`;
  const portFile = shq(path.join(mboxDir, 'hub.port'));

  // mcpTokens go AFTER the tool's own args: claude's --mcp-config is variadic
  // and would otherwise swallow any following positional arguments.
  return (
    `IDX=$(tmux -L ${shq(sock)} display-message -p '#{window_index}'); ` +
    `PORT=''; ` +
    `for i in $(seq 1 100); do PORT=$(cat ${portFile} 2>/dev/null); [ -n "$PORT" ] && break; sleep 0.1; done; ` +
    `if [ -n "$PORT" ]; then exec ${envExec}${argsSuffix} ${mcpTokens}; ` +
    `else exec ${envExec}${argsSuffix}; fi`
  );
}

module.exports = {
  mailboxDir, mailboxFile, ensureMailbox, appendMessage, readAndDrain,
  mailboxWindows, buildMcpExec,
};

// ── standalone hub process ────────────────────────────────
function runHub() {
  const args = process.argv.slice(2);
  const si = args.indexOf('--sock');
  const sock = si >= 0 ? args[si + 1] : null;
  if (!sock) process.exit(1);

  let McpServer, StreamableHTTPServerTransport, z;
  try {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
    z = require('zod');
  } catch {
    process.exit(3); // SDK unavailable → graceful: caller runs mailbox-only
  }

  const http = require('http');
  const { spawnSync } = require('child_process');

  const dir = mailboxDir(sock);
  fs.mkdirSync(dir, { recursive: true });

  function buildServer(window) {
    const server = new McpServer({ name: 'voidhub', version: '1.0.0' });

    server.registerTool('send_message', {
      description: 'Send a message to another void tab, identified by its window index (see list_targets).',
      inputSchema: {
        target: z.string().describe('target window index'),
        text:   z.string().describe('message body'),
      },
    }, async ({ target, text }) => {
      ensureMailbox(sock, target);
      appendMessage(mailboxFile(sock, target), { from: window, text, ts: Date.now() });
      return { content: [{ type: 'text', text: `sent to window ${target}` }] };
    });

    server.registerTool('check_mailbox', {
      description: 'Read and clear this tab\'s incoming messages.',
      inputSchema: {},
    }, async () => {
      const msgs = readAndDrain(mailboxFile(sock, window));
      return { content: [{ type: 'text', text: msgs.length ? JSON.stringify(msgs) : 'no messages' }] };
    });

    server.registerTool('list_targets', {
      description: 'List void tabs and whether each can receive messages.',
      inputSchema: {},
    }, async () => {
      const r = spawnSync('tmux', ['-L', sock, 'list-windows', '-F', '#{window_index}|#{window_name}'], { encoding: 'utf8' });
      const rows = (r.stdout || '').trim().split('\n').filter(Boolean).map(l => {
        const [idx, name] = l.split('|');
        return { window: idx, name: name || '?', canReceive: fs.existsSync(mailboxFile(sock, idx)) };
      });
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    });

    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const window = u.searchParams.get('window') || '0';
      ensureMailbox(sock, window); // first connection registers this window
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = buildServer(window);
      res.on('close', () => { try { transport.close(); } catch {} try { server.close(); } catch {} });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      try { res.statusCode = 500; res.end(); } catch {}
    }
  });

  httpServer.listen(0, '127.0.0.1', () => {
    const port = httpServer.address().port;
    fs.writeFileSync(path.join(dir, 'hub.port'), String(port));
  });

  const shutdown = () => { try { httpServer.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) runHub();
