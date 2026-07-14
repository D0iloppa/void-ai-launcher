#!/usr/bin/env bash
# VOID//ai-launcher — macOS / Linux installer
# Usage: ./scripts/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
NODE_MIN=18

G=$'\033[38;2;0;230;118m'; Y=$'\033[38;2;251;191;36m'
R=$'\033[0;31m'; B=$'\033[1m'; RST=$'\033[0m'

step() { printf '\n%s%s──%s%s %s%s\n' "$G" "$B" "$RST" "$B" "$1" "$RST"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$RST" "$1"; }
warn() { printf '  %s⚠%s  %s\n' "$Y" "$RST" "$1"; }
die()  { printf '  %s✗%s  %s\n' "$R" "$RST" "$1" >&2; exit 1; }

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$ver" -ge "$NODE_MIN" ]
}

install_node_macos() {
  if command -v brew >/dev/null 2>&1; then
    warn "Node.js ${NODE_MIN}+ 미검출 — Homebrew로 설치합니다: brew install node"
    brew install node
  else
    die "Node.js가 없고 Homebrew도 없습니다. https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요."
  fi
}

install_node_linux() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    warn "Node.js ${NODE_MIN}+ 미검출 — nvm으로 LTS를 설치합니다."
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm install --lts
  else
    die "Node.js가 없습니다. https://nodejs.org 또는 nvm(https://github.com/nvm-sh/nvm)으로 설치한 뒤 다시 실행하세요."
  fi
}

step 'Node.js 확인'
if node_version_ok; then
  ok "Node.js $(node -v) 확인됨"
else
  case "$(uname -s)" in
    Darwin) install_node_macos ;;
    Linux)  install_node_linux ;;
    *) die "지원하지 않는 OS: $(uname -s)" ;;
  esac
  node_version_ok || die "Node.js 설치 후에도 버전 확인 실패. 새 셸을 열고 다시 시도하세요."
  ok "Node.js $(node -v) 설치 확인됨"
fi

step 'VOID//ai-launcher 설치'
exec node "$ROOT_DIR/cmd_generator.js" "$@"
