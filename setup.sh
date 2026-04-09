#!/usr/bin/env bash
set -euo pipefail

# ── ParentSync Setup Script ─────────────────────────────────────────
# Idempotent — safe to run multiple times. Handles partial/failed runs.
# ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

step=0
total=6

progress() {
  step=$((step + 1))
  echo -e "\n${CYAN}[$step/$total]${NC} $1"
}

ok()   { echo -e "  ${GREEN}✔${NC} $1"; }
skip() { echo -e "  ${YELLOW}—${NC} $1 (already done)"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✖${NC} $1"; exit 1; }

# ── 1. Check prerequisites ──────────────────────────────────────────

progress "Checking prerequisites"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="${NODE_VER#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js v18+ required (found $NODE_VER). Please upgrade: https://nodejs.org"
  fi
else
  fail "Node.js not found. Please install v18+: https://nodejs.org"
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm not found. It should come with Node.js."
fi

# Google Chrome (optional but recommended)
CHROME_FOUND=false
for chrome_path in \
  "/usr/bin/google-chrome" \
  "/usr/bin/google-chrome-stable" \
  "/usr/bin/chromium-browser" \
  "/usr/bin/chromium" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
  if [ -x "$chrome_path" ] 2>/dev/null || [ -f "$chrome_path" ] 2>/dev/null; then
    CHROME_FOUND=true
    ok "Google Chrome found at $chrome_path"
    break
  fi
done

if [ "$CHROME_FOUND" = false ]; then
  warn "Google Chrome not found. WhatsApp Web integration requires Chrome."
fi

# ── 2. Install root dependencies ────────────────────────────────────

progress "Installing root dependencies (Electron + build tools)"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  # Check if node_modules is up to date with package.json
  if [ "node_modules/.package-lock.json" -nt "package.json" ]; then
    skip "Root node_modules up to date"
  else
    npm install --no-audit --no-fund 2>&1 | tail -1
    ok "Root dependencies installed"
  fi
else
  npm install --no-audit --no-fund 2>&1 | tail -1
  ok "Root dependencies installed"
fi

# ── 3. Install backend dependencies ─────────────────────────────────

progress "Installing backend dependencies"

if [ -d "backend/node_modules" ] && [ -f "backend/node_modules/.package-lock.json" ]; then
  if [ "backend/node_modules/.package-lock.json" -nt "backend/package.json" ]; then
    skip "Backend node_modules up to date"
  else
    (cd backend && npm install --no-audit --no-fund 2>&1 | tail -1)
    ok "Backend dependencies installed"
  fi
else
  (cd backend && npm install --no-audit --no-fund 2>&1 | tail -1)
  ok "Backend dependencies installed"
fi

# ── 4. Install frontend dependencies ────────────────────────────────

progress "Installing frontend dependencies"

if [ -d "frontend/node_modules" ] && [ -f "frontend/node_modules/.package-lock.json" ]; then
  if [ "frontend/node_modules/.package-lock.json" -nt "frontend/package.json" ]; then
    skip "Frontend node_modules up to date"
  else
    (cd frontend && npm install --no-audit --no-fund 2>&1 | tail -1)
    ok "Frontend dependencies installed"
  fi
else
  (cd frontend && npm install --no-audit --no-fund 2>&1 | tail -1)
  ok "Frontend dependencies installed"
fi

# ── 5. Configure backend .env ────────────────────────────────────────

progress "Configuring backend environment"

ENV_FILE="backend/.env"
ENV_TEMPLATE="backend/.env.example"

# Create .env.example if it doesn't exist (template for new setups)
if [ ! -f "$ENV_TEMPLATE" ]; then
  cat > "$ENV_TEMPLATE" <<'ENVEOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=./parentsync.sqlite
FRONTEND_URL=http://localhost:5173
ENVEOF
  ok "Created $ENV_TEMPLATE"
fi

if [ -f "$ENV_FILE" ]; then
  skip ".env exists"
else
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  ok "Created $ENV_FILE from template"
fi
echo -e "  Configure OpenRouter and Google OAuth credentials via Settings UI or ${CYAN}POST /api/settings${NC}"

# ── 6. Build all (backend + frontend + Electron) ────────────────────

progress "Building project"

BACKEND_BUILT=false
FRONTEND_BUILT=false
ELECTRON_BUILT=false

# Check if backend dist exists and is up to date
if [ -f "backend/dist/main.js" ] && [ -z "$(find backend/src -newer backend/dist/main.js -name '*.ts' 2>/dev/null | head -1)" ]; then
  skip "Backend build up to date"
  BACKEND_BUILT=true
fi

# Check if frontend dist exists and is up to date
if [ -f "frontend/dist/index.html" ] && [ -z "$(find frontend/src \( -name '*.tsx' -o -name '*.ts' -o -name '*.scss' \) -newer frontend/dist/index.html 2>/dev/null | head -1)" ]; then
  skip "Frontend build up to date"
  FRONTEND_BUILT=true
fi

# Check if electron dist exists and is up to date
if [ -f "electron/dist/main.js" ] && [ -z "$(find electron -maxdepth 1 -name '*.ts' -newer electron/dist/main.js 2>/dev/null | head -1)" ]; then
  skip "Electron build up to date"
  ELECTRON_BUILT=true
fi

if [ "$BACKEND_BUILT" = false ]; then
  echo "  Building backend..."
  (cd backend && npm run build 2>&1 | tail -1)
  ok "Backend built"
fi

if [ "$FRONTEND_BUILT" = false ]; then
  echo "  Building frontend..."
  (cd frontend && npm run build 2>&1 | tail -1)
  ok "Frontend built"
fi

if [ "$ELECTRON_BUILT" = false ]; then
  echo "  Building Electron..."
  npx tsc -p electron/tsconfig.json 2>&1
  ok "Electron built"
fi

# ── Done ─────────────────────────────────────────────────────────────

echo -e "\n${GREEN}━━━ Setup complete! ━━━${NC}\n"
echo -e "To start the desktop app:"
echo -e "  ${CYAN}npm run electron:dev${NC}     # Development (hot-reload)"
echo -e "  ${CYAN}npm run electron:start${NC}   # Production"
echo ""
echo -e "To start in browser mode:"
echo -e "  ${CYAN}cd backend && npm run start:dev${NC}   # Terminal 1"
echo -e "  ${CYAN}cd frontend && npm run dev${NC}        # Terminal 2"
echo ""

# Remind about config
echo -e "${YELLOW}⚠  Configure OpenRouter and Google OAuth credentials in the Settings page${NC}"
echo -e "   Google credentials: ${CYAN}https://console.cloud.google.com/apis/credentials${NC}\n"
