#!/usr/bin/env bash
# VOID//ai-launcher — 설치 스크립트
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BIN="/usr/local/bin/void"
NODE_MIN=18

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

# ── 2. npm 의존성 ─────────────────────────────────────────
step "의존성 설치"

cd "$SCRIPT_DIR"
npm install --silent
ok "js-yaml 설치 완료"

# ── 3. 선택적 의존성 ──────────────────────────────────────
echo ""
echo -e "  ${M}선택적 의존성 (Prompt 모드):${RST}"
echo -e "  ${M}설치하지 않아도 나머지 기능은 모두 동작합니다.${RST}"
echo ""

read -rp "  @anthropic-ai/sdk 설치? (Claude API) [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  npm install --save-optional @anthropic-ai/sdk --silent && ok "@anthropic-ai/sdk 설치됨"
fi

read -rp "  openai 설치? (GPT API) [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  npm install --save-optional openai --silent && ok "openai 설치됨"
fi

# ── 4. 실행 권한 ──────────────────────────────────────────
step "실행 권한 설정"
chmod +x "$SCRIPT_DIR/launcher.js"
ok "launcher.js +x"

# ── 5. void 명령어 설치 ───────────────────────────────────
step "void 명령어 설치  →  ${INSTALL_BIN}"

# symlink 대신 wrapper script 사용:
# nvm node는 sudo PATH에 없을 수 있으므로 절대 경로를 wrapper에 기록
WRAPPER_CONTENT="#!/usr/bin/env bash
exec \"${NODE_BIN}\" \"${SCRIPT_DIR}/launcher.js\" \"\$@\""

if [ -w "/usr/local/bin" ]; then
  echo "$WRAPPER_CONTENT" > "$INSTALL_BIN"
  chmod +x "$INSTALL_BIN"
else
  echo -e "  ${Y}sudo 권한 필요${RST}"
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
echo -e "  ${G}void claude${RST}             CLAUDE CODE 바로 실행"
echo -e "  ${G}void claude --anon${RST}      익명 모드"
echo -e "  ${G}void prompt${RST}             API 직접 호출"
echo -e "  ${G}void tokens${RST}             토큰 관리"
echo -e "  ${G}void sessions${RST}           세션 관리 (tmux)"
echo ""
echo -e "  ${M}sudo void 도 동일하게 동작합니다.${RST}"
echo ""
