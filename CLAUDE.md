# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

`void` (`void-ai-launcher`) is a Node.js CLI that presents an interactive TUI menu to launch AI tools (Claude Code, Codex, agy, etc.) in normal mode, **anonymous mode** (isolated temp `$HOME`), or **named-session mode** (isolated `CLAUDE_CONFIG_DIR` / `CODEX_HOME`). It wraps child processes in a framed terminal UI using `node-pty` (falls back to plain `spawnSync` when unavailable).

## Commands

```bash
node launcher.js        # run interactively
npm start               # same
npm run check           # syntax-check all JS files (node --check)
npm run build           # rebuild shell wrapper via cmd_generator.sh
```

Global install makes `void` available as a system command. Direct invocation: `void [tool] [args] [--anon]`, `void prompt`, `void tokens`, `void sessions`, `void host`, `void --help`.

## Architecture

**`launcher.js`** — entry point and menu tree. Handles `--sudo` re-exec, CLI arg dispatch (`handleArgs`), and the full interactive menu hierarchy: main → advanced → config/sessions/tokens/prompt/terminal.

**`lib/`** — all feature modules:

| File | Responsibility |
|------|---------------|
| `runner.js` | `runTool` / `runCommandLine` / `runHostShell` — resolves session profile, sets env vars, calls wrapper or falls back to spawnSync |
| `wrapper.js` | node-pty framed terminal. `runWrapped` (single process), `runWrappedShell` (tabbed shell with Ctrl+A prefix keybindings). Uses DECSLRM + DECVSSM escape sequences to confine PTY output inside border margins |
| `ui.js` | All TUI rendering: box/frame drawing, CJK-aware column width, raw-mode keypress loop, `menu()` / `homeMenu()` / `message()` / `input()` |
| `sessions.js` | tmux session management + named CLI sessions (create/delete per tool) |
| `storage.js` | JSON persistence in `~/.config/void-launcher/` (XDG fallback chain): `last.json`, `history.json`, `sessions.json` |
| `config.js` | Thin shim over `configDb.js`; `getToken` / `getAllTokens` (API keys per service/alias) |
| `configDb.js` | SQLite-backed config store (dJinn/`better-sqlite3`, `config.djinn.db`) — tools list, theme, settings, API tokens. One-time migration from legacy `config.json`/`config.yml` on first run |
| `theme.js` | Loads built-in color themes from `themes/` and applies overrides from `configDb.js` |
| `tokens.js` | Interactive token management UI |
| `prompt.js` | Direct Anthropic/OpenAI/Google prompt mode (uses optional SDK deps) |
| `extTokens.js` | External token export command UI |
| `assistant.js` | Personal Assistant profiles — isolated `uv` Python venv + `vendor/void-assistant` session per profile |
| `cliPreflight.js` | Detects/installs AI tool CLIs (`claude`/`codex`/`agy`) before launch |
| `miniShell.js` | Ephemeral raw-mode shell overlay (e.g. token-issuing terminal from the Tokens menu) |
| `usageDb.js` | SQLite-backed usage cache + rate-limit backoff windows (`usage-cache.djinn.db`) |
| `usageMeter.js` | Fetches Claude/Codex usage (OAuth/backend API → RPC → hidden-PTY scrape fallback tiers) |
| `usageWarmup.js` | Background polling that keeps `usageMeter.js`'s cache warm |
| `sync.js` | Syncs named-session profiles between two void installs over WebSocket (LAN/VPN, no relay) — pairing-code Export/Import, AES-256-GCM framed transfer |
| `graphLayer.js` | Shared dJinn Graph Catalog bootstrap (`initVoidGraphLayer`) factored out of `aggregator.js` — per-call closure over db/graph state, used by both the aggregator stack and the void-context stack |
| `voidContext.js` | void-context graph accessors (`putContext`/`getContext`/`listContexts`/`findRecentContexts`/`putTaskContext`/`getTaskContext`/`listTaskContext`) — schema authority for a 2-level task-context graph in its own DB file. Auto-wired into `launcher.js`'s `launchTool`: named-session launches upsert a context node (`task_id`/`named_session` = session name, `provider` mapped from the tool command via `voidContextAutoRecord.js`, `resumes` incremented per launch) and append an `exit` task-context entry after the tool process exits. Normal/anonymous launches record nothing. The whole hook is fail-open (wrapped in try/catch) — any void-context/dJinn failure is silently swallowed and never affects the launch |
| `voidContextAutoRecord.js` | Pure decision logic backing the auto-record hook above — `mapProviderFromCommand` (claude→anthropic, codex→openai, anything else incl. agy→null), `nextResumes`, and `computeContextUpdate` (returns `null` to signal "skip recording" when the tool command has no provider mapping). No dJinn/graph dependency, so it's unit-testable in isolation |
| `voidContextMcp.js` | Thin stdio MCP entry point (`node lib/voidContextMcp.js`) that serves the void-context graph via dJinn's built-in MCP (`serveMcp`) |

**void-context**: a separate dJinn DB, `void-context.djinn.db` (repo root, gitignored), initialized by the `postinstall` script (`scripts/init-void-context.js`) and exposed to MCP clients via `.mcp.json` (`node lib/voidContextMcp.js`). Namespace `void_context` (underscore — `GraphDriver`'s `NS_RE` rejects hyphens). Level-2 nodes are contexts (`node_key = task_id`); a reserved `_schema` node documents the field layout and is filtered out of listings.

**Config storage**: tools list + theme + settings + API tokens are stored in a SQLite DB (`lib/configDb.js`, via dJinn) at `~/.config/void-launcher/config.djinn.db`. Legacy `config.json`/`config.yml` at the repo root are migrated in-place (renamed to `.migrated`) on first run and are no longer the source of truth. Tool entries: `name`, `command`, `args[]`, optional `anonymous_args[]`. Settings: `anonymous_home_prefix`, `wrapper_hpad`, `wrapper_vpad`. Edit tools/theme/settings through the interactive menu (or `configDb.setTools`/`setTheme`/`setSettings`), not by hand-editing a YAML file.

## Key behaviors

**Anonymous mode**: creates a temp dir via `mkdtempSync`, sets `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` on the child env. Cleaned up after tool exits (not on process exit signal — cleanup runs in `runTool` after `await`).

**Named sessions**: `CLAUDE_CONFIG_DIR=~/.claude-<name>` for claude, `CODEX_HOME=~/.codex-<name>` for codex. Session metadata (name, toolCommand, configDir, created_at) stored in `storage.js`.

**Wrapper frame**: `wrapper.js` uses ANSI scroll region (`\x1b[top;botr`) + left/right margin (`\x1b[?69h` + `\x1b[left;rights`) to constrain PTY output. `wrapper_hpad`/`wrapper_vpad` (from `configDb.getSettings()`) control the padding between border and content. `runWrappedShell` adds a Ctrl+A prefix-key multiplexer (h/l tabs, c new shell, x close, 1-9 jump, `:` command mode).

**Menu navigation**: arrow keys move selection, left/right cycle options on combo rows, Enter/hotkey confirms, `0`/Esc goes back. Home screen has a two-column layout (logo + links box side by side, menu box below) that degrades to compact mode below 88 cols or 24 rows.

**Storage location**: `~/.config/void-launcher/` (or `$XDG_CONFIG_HOME/void-launcher/`); falls back to `.void-launcher/` in cwd, then tmpdir.

## Dependencies

- `js-yaml` — required, parses the legacy `config.yml` during one-time migration to `configDb.js`
- `node-pty` — optional, enables the framed wrapper UI; falls back to raw spawnSync without it
- `ws` — required, WebSocket server/client used by `lib/sync.js` for the session-sync Export/Import flow
- `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` — optional, used by `prompt.js`
- `@d0iloppa/djinn` (`vendor/dJinn` submodule) and its `better-sqlite3` dependency — mandatory, installed by a `preinstall` script (`scripts/install-djinn.js`) from a committed vendor tgz, with a submodule-build fallback
