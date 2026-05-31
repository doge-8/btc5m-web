#!/bin/bash
# Polymarket VPS SSH tunnel management (autossh auto-reconnect)
#
# Usage:
#   ./tunnel.sh        foreground start (default; Ctrl+C to exit = close tunnel; output shown directly)
#   ./tunnel.sh bg     background start (tunnel keeps running after closing the terminal, log at /tmp/pm-tunnel.log)
#   ./tunnel.sh down   close the background tunnel
#   ./tunnel.sh status check running status
#   ./tunnel.sh logs   tail the background log
#
# Multiple accounts: edit the PORTS array below and add more ports

# ── Config ─────────────────────────────────────────────
PEM="$HOME/Desktop/arl.pem"
HOST=ubuntu@34.249.106.114
PORTS=(3556 3557 3558 3559 3560 3561 3562)    # 6 accounts

# ── Internal ─────────────────────────────────────────────
# LOG generated from the script filename (avoids multiple scripts sharing one log file)
SCRIPT_NAME=$(basename "$0" .sh)
LOG="/tmp/${SCRIPT_NAME}.log"
TAG="autossh-pm-${HOST//[@.]/_}"  # use host as the identifier, for pkill / pgrep

# Assemble port-forwarding arguments
PORT_ARGS=""
for p in "${PORTS[@]}"; do
  PORT_ARGS="$PORT_ARGS -L $p:localhost:$p"
done

cmd="${1:-up}"

# Common: check dependencies + config
check_prereq() {
  if ! command -v autossh >/dev/null 2>&1; then
    echo "❌ autossh not installed, install it first:"
    echo "   brew install autossh"
    exit 1
  fi
  if [ ! -f "$PEM" ]; then
    echo "❌ pem file does not exist: $PEM"
    exit 1
  fi
}

case "$cmd" in
  up|fg)
    # Foreground run: Ctrl+C closes the tunnel directly, output shown in real time
    if pgrep -f "autossh.*$HOST" >/dev/null 2>&1; then
      echo "⚠ Already running in the background pid=$(pgrep -f "autossh.*$HOST" | head -1)"
      echo "  Run ./tunnel.sh down first, then restart in foreground; or ./tunnel.sh logs to view the background log"
      exit 1
    fi
    check_prereq
    echo "✓ Starting tunnel (foreground mode, Ctrl+C to exit)"
    echo "  HOST: $HOST"
    echo "  Ports: ${PORTS[*]}"
    echo ""
    # No -f: foreground run; no log file, straight to stdout
    exec autossh -M 0 -N \
      -i "$PEM" \
      $PORT_ARGS \
      "$HOST" \
      -o "ServerAliveInterval=30" \
      -o "ServerAliveCountMax=3" \
      -o "ExitOnForwardFailure=yes" \
      -o "TCPKeepAlive=yes" \
      -o "StrictHostKeyChecking=no" \
      -o "UserKnownHostsFile=/dev/null"
    ;;

  bg)
    # Background run: closing the terminal has no effect, log written to file
    if pgrep -f "autossh.*$HOST" >/dev/null 2>&1; then
      echo "✓ Already running (pid=$(pgrep -f "autossh.*$HOST" | tr '\n' ' '))"
      exit 0
    fi
    check_prereq
    AUTOSSH_LOGFILE="$LOG" \
    autossh -M 0 -f -N \
      -i "$PEM" \
      $PORT_ARGS \
      "$HOST" \
      -E "$LOG" \
      -o "ServerAliveInterval=30" \
      -o "ServerAliveCountMax=3" \
      -o "ExitOnForwardFailure=yes" \
      -o "TCPKeepAlive=yes" \
      -o "StrictHostKeyChecking=no" \
      -o "UserKnownHostsFile=/dev/null"
    sleep 1
    pid=$(pgrep -f "autossh.*$HOST" | head -1)
    if [ -n "$pid" ]; then
      echo "✓ Tunnel started (background) pid=$pid"
      echo "  Local ports: ${PORTS[*]}"
      echo "  Log: $LOG (./tunnel.sh logs to view)"
    else
      echo "⚠ No process found after autossh started; it may have failed immediately, see $LOG"
    fi
    ;;

  down)
    if pgrep -f "autossh.*$HOST" >/dev/null 2>&1; then
      pkill -f "autossh.*$HOST"
      pkill -f "ssh.*$HOST" 2>/dev/null
      sleep 0.3
      echo "✓ Tunnel closed"
    else
      echo "Not running"
    fi
    ;;

  status)
    pid=$(pgrep -f "autossh.*$HOST" | head -1)
    if [ -n "$pid" ]; then
      echo "✓ Running pid=$pid"
      echo "  Ports: ${PORTS[*]}"
      # Test whether each port is actually reachable
      for p in "${PORTS[@]}"; do
        if curl -sf -m 2 "http://localhost:$p/api/state" >/dev/null 2>&1; then
          echo "  $p: ✓ reachable"
        else
          echo "  $p: ✗ unreachable (tunnel up but remote server not started?)"
        fi
      done
    else
      echo "✗ Not running"
    fi
    ;;

  logs)
    if [ -f "$LOG" ]; then
      tail -f "$LOG"
    else
      echo "No log yet (tunnel has not run)"
    fi
    ;;

  *)
    echo "Usage: $0 {up|bg|down|status|logs}"
    echo "  up      foreground start (default; Ctrl+C to exit = close tunnel)"
    echo "  bg      background start (closing the terminal has no effect)"
    echo "  down    close the background tunnel"
    echo "  status  check running status + port connectivity"
    echo "  logs    tail the background log"
    exit 1
    ;;
esac
