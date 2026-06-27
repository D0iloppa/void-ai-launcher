#!/usr/bin/env bash
# VOID//ai-launcher — 설치 스크립트
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BIN="/usr/local/bin/void"
NODE_MIN=18
NONINTERACTIVE="${VOID_BUILD_NONINTERACTIVE:-0}"
NPM_CACHE_DIR="${VOID_NPM_CACHE_DIR:-${TMPDIR:-/tmp}/void-npm-cache}"
REQUIRED_PACKAGES=(
  "@anthropic-ai/sdk"
  "@google/generative-ai"
  "node-pty"
  "openai"
)

# ── ANSI ─────────────────────────────────────────────────
G='\033[38;2;0;230;118m'   # signal green
W='\033[0;37m'              # white/text
M='\033[38;2;106;138;106m' # muted
Y='\033[38;2;251;191;36m'  # warn/yellow
R='\033[0;31m'              # red/error
B='\033[1m'                 # bold
RST='\033[0m'

ok()   { echo -e "  ${G}✓${RST} $1"; }
step() { echo -e "\n${G}${B}──${RST}${B} $1${RST}"; }
warn() { echo -e "  ${Y}⚠${RST}  $1"; }
err()  { echo -e "  ${R}✗${RST}  $1"; exit 1; }

should_prompt() {
  [[ "$NONINTERACTIVE" != "1" && -t 0 ]]
}

ensure_sudo() {
  if [ -w "/usr/local/bin" ]; then
    return
  fi

  step "sudo 권한 확인"
  if should_prompt; then
    sudo -v
  else
    sudo -n -v
  fi
  ok "sudo 권한 확인 완료"
}

# ── 헤더 ─────────────────────────────────────────────────
echo -e ""
echo -e "${G}${B}┌── VOID//ai-launcher ─ 설치 스크립트 ──────────┐${RST}"
echo -e "${G}${B}│${RST}  cmd_generator.sh                              ${G}${B}│${RST}"
echo -e "${G}${B}└────────────────────────────────────────────────┘${RST}"
echo -e ""

# ── 1. Node.js 확인 ──────────────────────────────────────
step "Node.js 확인"

if ! command -v node &>/dev/null; then
  err "Node.js 를 찾을 수 없습니다.\n     설치: https://nodejs.org  또는  nvm install --lts"
fi

NODE_BIN="$(command -v node)"
NODE_VER="$(node -e "console.log(process.versions.node.split('.')[0])")"

if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
  err "Node.js v${NODE_MIN}+ 필요 (현재: v${NODE_VER})"
fi

ok "Node.js v$(node --version | tr -d v)  →  ${M}${NODE_BIN}${RST}"

# nvm 경로 감지 안내
if echo "$NODE_BIN" | grep -q ".nvm"; then
  warn "nvm 경로 감지됨. ${G}sudo void${RST}${Y} 사용 시 PATH 문제를 wrapper 스크립트로 해결합니다.${RST}"
fi

ensure_sudo

# ── 2. npm 의존성 ─────────────────────────────────────────
step "의존성 설치"

cd "$SCRIPT_DIR"
npm_config_cache="$NPM_CACHE_DIR" npm install --silent
ok "js-yaml 설치 완료"

# ── 3. 런타임 의존성 보강 ──────────────────────────────────
step "런타임 의존성 설치"
npm_config_cache="$NPM_CACHE_DIR" npm install --no-save --silent "${REQUIRED_PACKAGES[@]}"
ok "Claude / Codex / Gemini / Wrapper 의존성 설치 완료"

# ── 4. 실행 권한 ──────────────────────────────────────────
step "실행 권한 설정"
chmod +x "$SCRIPT_DIR/launcher.js"
ok "launcher.js +x"

# ── 5. void 명령어 설치 ───────────────────────────────────
step "void 명령어 설치  →  ${INSTALL_BIN}"

# symlink 대신 wrapper script 사용:
# nvm node는 sudo PATH에 없을 수 있으므로 절대 경로를 wrapper에 기록
WRAPPER_CONTENT="#!/usr/bin/env bash
export _VOID_BIN=\"${INSTALL_BIN}\"
exec \"${NODE_BIN}\" \"${SCRIPT_DIR}/launcher.js\" \"\$@\""

if [ -w "/usr/local/bin" ]; then
  echo "$WRAPPER_CONTENT" > "$INSTALL_BIN"
  chmod +x "$INSTALL_BIN"
else
  echo "$WRAPPER_CONTENT" | sudo tee "$INSTALL_BIN" > /dev/null
  sudo chmod +x "$INSTALL_BIN"
fi

ok "void 설치됨  →  ${INSTALL_BIN}"

# ── 6. 확인 ──────────────────────────────────────────────
step "설치 확인"

if command -v void &>/dev/null; then
  ok "which void → $(command -v void)"
else
  warn "'void' 를 PATH 에서 찾을 수 없습니다."
  echo -e "  ${M}터미널을 재시작하거나:  source ~/.bashrc  /  source ~/.zshrc${RST}"
fi

# ── 완료 메시지 ───────────────────────────────────────────
echo ""
echo -e "${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
echo -e "${G}${B}  VOID//ai-launcher 설치 완료${RST}"
echo -e "${G}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
echo ""
echo -e "  ${G}void${RST}                    메인 메뉴"
echo -e "  ${G}void --help${RST}             도움말 보기"
echo ""
echo -e "  ${M}sudo void 도 동일하게 동작합니다.${RST}"
echo ""
