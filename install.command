#!/bin/zsh
set -e
cd "${0:A:h}"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org/ and run this file again."
  read "?Press Return to close."
  exit 1
fi

echo "Installing WeChat FastBridge. This is free."
npm install
npm run setup

echo "Finished. Restart Codex, then follow docs/SETUP.md to turn on Accessibility."
read "?Press Return to close."
