#!/usr/bin/env bash
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$ROOT_DIR/test-reports"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
REPORT_FILE="$REPORT_DIR/report-$TIMESTAMP.txt"
EXIT_CODE=0

mkdir -p "$REPORT_DIR"

# Colors (disabled when piped)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; RED=''; CYAN=''; BOLD=''; RESET=''
fi

print_header() {
  echo ""
  echo -e "${CYAN}${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${CYAN}${BOLD}  $1${RESET}"
  echo -e "${CYAN}${BOLD}════════════════════════════════════════${RESET}"
  echo ""
}

run_suite() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local outfile="$REPORT_DIR/${name// /_}.log"

  print_header "$name"

  cd "$dir" || { echo "Directory not found: $dir"; return 1; }

  eval "$cmd" 2>&1 | tee "$outfile"
  local code=${PIPESTATUS[0]}

  if [ $code -eq 0 ]; then
    echo -e "\n${GREEN}${BOLD}✔ $name — PASSED${RESET}\n"
    echo "✔ $name — PASSED" >> "$REPORT_FILE"
  else
    echo -e "\n${RED}${BOLD}✘ $name — FAILED (exit $code)${RESET}\n"
    echo "✘ $name — FAILED (exit $code)" >> "$REPORT_FILE"
    echo "  See: $outfile" >> "$REPORT_FILE"
    EXIT_CODE=1
  fi

  return $code
}

# ── Report header ──
{
  echo "ParentSync Test Report"
  echo "======================"
  echo "Date: $(date)"
  echo "Node: $(node -v)"
  echo ""
  echo "Results:"
} > "$REPORT_FILE"

# ── 1. Backend Unit Tests ──
run_suite "Backend Unit Tests" "$ROOT_DIR/backend" "npx jest --coverage --verbose --no-cache"

# ── 2. Backend E2E Tests ──
# Only run automated e2e tests (exclude tests requiring real browser/APIs/shared state)
AUTOMATED_E2E="test/(api-integration|app|security|settings)\\.e2e-spec\\.ts"
run_suite "Backend E2E Tests" "$ROOT_DIR/backend" "npx jest --config test/jest-e2e.json --verbose --no-cache --testPathPatterns='$AUTOMATED_E2E'"

# ── 3. Frontend Tests ──
run_suite "Frontend Tests" "$ROOT_DIR/frontend" "npx vitest run --reporter=verbose"

# ── Summary ──
print_header "Summary"

echo "" >> "$REPORT_FILE"
echo "──────────────────" >> "$REPORT_FILE"

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All test suites passed.${RESET}"
  echo "All test suites passed." >> "$REPORT_FILE"
else
  echo -e "${RED}${BOLD}Some test suites failed. See report for details.${RESET}"
  echo "Some test suites failed." >> "$REPORT_FILE"

  # Append stack traces from failed suites
  echo "" >> "$REPORT_FILE"
  echo "Failed suite logs:" >> "$REPORT_FILE"
  for logfile in "$REPORT_DIR"/*.log; do
    [ -f "$logfile" ] || continue
    if grep -q "FAIL\|FAILED\|✘\|×\|Error:" "$logfile" 2>/dev/null; then
      echo "" >> "$REPORT_FILE"
      echo "── $(basename "$logfile") ──" >> "$REPORT_FILE"
      # Extract failure blocks (lines around FAIL/Error with context)
      grep -A 20 "FAIL\|● \|Error:\|✘\|×" "$logfile" >> "$REPORT_FILE" 2>/dev/null
    fi
  done
fi

echo ""
echo -e "Report saved to: ${BOLD}$REPORT_FILE${RESET}"
echo ""

exit $EXIT_CODE
