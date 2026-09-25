#!/bin/bash
# Double-click this on Mac (or run `./start.sh` in a terminal), or run it on
# any Linux server. It checks for Node.js, installs dependencies only if
# they're missing, and starts the app.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed on this machine."
  echo "Install it from https://nodejs.org (LTS version) and run this script again."
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Dependencies not found — installing (only needs to happen once)..."
  npm install
fi

echo ""
echo "Starting Tesla Cast..."
echo ""
node server/index.js
