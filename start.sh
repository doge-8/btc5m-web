#!/bin/bash
set -e

cd "$(dirname "$0")"

# Check whether .env exists
if [ ! -f .env ]; then
  echo "No .env file found. Please copy .env.example first and fill in the config:"
  echo "  cp .env.example .env"
  echo "  Then edit .env and fill in POLYMARKET_PRIVATE_KEY and POLYMARKET_PROXY_ADDRESS"
  exit 1
fi

# Auto-install Node.js (Linux only; macOS usually already has it)
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Linux" ]; then
    echo "Node.js not detected, auto-installing Node.js 20..."
    if ! command -v curl >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y curl
    fi
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v yum >/dev/null 2>&1; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo yum install -y nodejs
    else
      echo "Unable to identify the package manager. Please install Node.js 20+ manually and retry"
      exit 1
    fi
    echo "Node.js installation complete: $(node -v)"
  else
    echo "Node.js or npm not found. Please install Node.js 20+ first (visit https://nodejs.org)"
    exit 1
  fi
fi

# Install dependencies (on first run, or when package.json/lock is newer than node_modules)
NEED_INSTALL=0
if [ ! -d node_modules ]; then
  NEED_INSTALL=1
elif [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Dependency updates detected..."
  NEED_INSTALL=1
fi
if [ $NEED_INSTALL -eq 1 ]; then
  echo "Installing dependencies..."
  npm install
  # Update the node_modules timestamp so it won't reinstall next time
  touch node_modules
fi

# When the port is taken, no longer kill the old process; let server.ts auto-try 3457-3465
if lsof -ti:3456 > /dev/null 2>&1; then
  echo "Port 3456 is already in use; server will automatically try the next available port (see startup log below)"
fi

echo "Starting BTC 5m order book monitor..."
APP_MODE=$(grep -E '^APP_MODE=' .env | tail -n1 | cut -d= -f2 | tr -d '\r' | tr -d '"')
if [ -z "$APP_MODE" ]; then
  APP_MODE="full"
fi
echo "Run mode: $APP_MODE"
echo "Press Ctrl+C to exit"
echo ""

# Clean up background child processes on exit (e.g. the subshell below that opens the browser asynchronously)
# Note: do not trap INT/TERM, otherwise bash handles it first and the signal won't reach the tsx/node process
trap 'kill -- -$$ 2>/dev/null' EXIT

# Open the browser automatically once the service is ready
# Key: use the .port file written by the server to confirm the port of this startup (avoids opening an old server instance by mistake)
# First record the .port mtime before startup, then read once .port is refreshed (≠ old mtime)
if [ "$APP_MODE" != "headless" ] && [ "$(uname -s)" = "Darwin" ]; then
  OLD_PORT_MTIME=""
  if [ -f .port ]; then
    OLD_PORT_MTIME=$(stat -f %m .port 2>/dev/null || echo "")
  fi
  (
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      sleep 1
      if [ -f .port ]; then
        NEW_MTIME=$(stat -f %m .port 2>/dev/null || echo "")
        # The file was rewritten by this startup (mtime changed) and the service responds
        if [ "$NEW_MTIME" != "$OLD_PORT_MTIME" ]; then
          PORT=$(cat .port 2>/dev/null | tr -d '[:space:]')
          if [ -n "$PORT" ] && curl -sf -m 1 "http://localhost:$PORT/api/state" > /dev/null 2>&1; then
            open "http://localhost:$PORT" >/dev/null 2>&1 || true
            exit 0
          fi
        fi
      fi
    done
  ) &
fi

# Use exec so node/tsx directly replaces the bash process (PID unchanged, one less hop, more reliable signaling)
exec npx tsx ./server.ts
