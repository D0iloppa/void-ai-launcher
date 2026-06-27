# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

`ai-launcher` is a small Node.js CLI that presents an interactive menu to launch AI tools (Claude Code, Codex, agy, etc.) in either normal mode or **anonymous mode**. Anonymous mode spins up a temporary `$HOME` directory via `fs.mkdtempSync`, runs the tool inside it, then deletes it on exit — isolating credentials and history from the real user profile.

## Running

```bash
node launcher.js        # or
npm start
```

If installed globally via `npm install -g .`, it is available as the `ai` command.

`fzf` is used for the selection menu when available; falls back to a numbered readline prompt otherwise.

## Architecture

Everything lives in two files:

- **`launcher.js`** — all logic: fzf detection, menu selection (fzf or readline fallback), anonymous-mode HOME setup/cleanup, and `spawnSync` launch of the chosen tool.
- **`config.yml`** — declares tools and settings. Each tool entry has `name`, `command`, `args[]`, and an optional `anonymous_args[]` override used only in anonymous mode. `settings.fzf_height` and `settings.anonymous_home_prefix` control UI and temp-dir behavior.

Adding a new AI tool means adding an entry to `config.yml` only — no code changes needed.

## Key behaviors

- Anonymous mode sets `env.HOME` to the temp dir before spawning; the tool inherits this via the `env` object passed to `spawnSync`.
- `process.on('exit' | 'SIGINT' | 'SIGTERM')` hooks ensure the temp dir is always removed.
- `anonymous_args` in config lets you pass tool-specific flags (e.g. `--no-config`) only in anonymous mode; falls back to `args` when not set.
