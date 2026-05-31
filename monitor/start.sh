#!/bin/bash
# Start the Polymarket multi-account monitor page
# Default port 8080; edit the MONITOR_PORT environment variable to change it
cd "$(dirname "$0")"
exec npx tsx ./monitor-server.ts
