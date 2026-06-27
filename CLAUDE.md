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
| `config.js` | `config.json` token store (API keys per service/alias); `getToken` / `getAllTokens` |
| `theme.js` | Loads built-in color themes (`green-black`, `red-void`, etc.) and applies `config.yml` overrides |
| `tokens.js` | Interactive token management UI |
| `prompt.js` | Direct Anthropic/OpenAI/Google prompt mode (uses optional SDK deps) |
| `extTokens.js` | External token export command UI |

**`config.yml`** — tools list + theme + settings. Only file to edit when adding a new AI tool. Tool entries: `name`, `command`, `args[]`, optional `anonymous_args[]`. Settings: `anonymous_home_prefix`, `wrapper_hpad`, `wrapper_vpad`.

## Key behaviors

**Anonymous mode**: creates a temp dir via `mkdtempSync`, sets `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` on the child env. Cleaned up after tool exits (not on process exit signal — cleanup runs in `runTool` after `await`).

**Named sessions**: `CLAUDE_CONFIG_DIR=~/.claude-<name>` for claude, `CODEX_HOME=~/.codex-<name>` for codex. Session metadata (name, toolCommand, configDir, created_at) stored in `storage.js`.

**Wrapper frame**: `wrapper.js` uses ANSI scroll region (`\x1b[top;botr`) + left/right margin (`\x1b[?69h` + `\x1b[left;rights`) to constrain PTY output. `wrapper_hpad`/`wrapper_vpad` in config.yml control the padding between border and content. `runWrappedShell` adds a Ctrl+A prefix-key multiplexer (h/l tabs, c new shell, x close, 1-9 jump, `:` command mode).

**Menu navigation**: arrow keys move selection, left/right cycle options on combo rows, Enter/hotkey confirms, `0`/Esc goes back. Home screen has a two-column layout (logo + links box side by side, menu box below) that degrades to compact mode below 88 cols or 24 rows.

**Storage location**: `~/.config/void-launcher/` (or `$XDG_CONFIG_HOME/void-launcher/`); falls back to `.void-launcher/` in cwd, then tmpdir.

## Dependencies

- `js-yaml` — required, parses `config.yml`
- `node-pty` — optional, enables the framed wrapper UI; falls back to raw spawnSync without it
- `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` — optional, used by `prompt.js`
