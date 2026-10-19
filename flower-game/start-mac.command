#!/bin/bash
# Double-click to start Petal Arena on a Mac.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet. Opening nodejs.org - install the LTS version, then double-click this file again."
  open https://nodejs.org
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing game files for the first time..."
  npm install
fi

echo "Starting the game... (close this window or press Ctrl+C to stop the server)"
(sleep 2; open http://localhost:3000) &
npm start
