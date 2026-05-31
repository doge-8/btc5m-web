#!/bin/bash
# Data collector launch script (with auto-restart)
#
# Usage:
#   ./collect.sh              # default 60-day retention
#   ./collect.sh 90           # 90-day retention
#
# Behavior:
#   - Launches data-collector.ts to continuously collect data from 6 markets
#   - Auto-restarts 5 seconds after a process crash
#   - Ctrl+C exits gracefully (no further restart)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Retention days (optional argument)
RETENTION_DAYS="${1:-60}"
export COLLECTOR_RETENTION_DAYS="$RETENTION_DAYS"

# Ensure node_modules exists
if [ ! -d "node_modules" ]; then
  echo "[Collect] node_modules not found, running npm install..."
  npm install
fi

# Ensure the data directory exists
mkdir -p backtest-data/collector

echo "════════════════════════════════════════════"
echo "  Polymarket multi-market data collector"
echo "  Retention days: $RETENTION_DAYS"
echo "  Data directory: backtest-data/collector/"
echo "  Ctrl+C to exit"
echo "════════════════════════════════════════════"
echo ""

# Catch Ctrl+C for a clean exit
SHOULD_RESTART=true
trap 'SHOULD_RESTART=false; echo ""; echo "[Collect] Exit signal received, stopping..."' INT TERM

# Main loop: auto-restart
while $SHOULD_RESTART; do
  npm run collect || true
  if $SHOULD_RESTART; then
    echo ""
    echo "[Collect] Process exited ($(date '+%Y-%m-%d %H:%M:%S')), auto-restarting in 5 seconds..."
    sleep 5
  fi
done

echo "[Collect] Stopped"
