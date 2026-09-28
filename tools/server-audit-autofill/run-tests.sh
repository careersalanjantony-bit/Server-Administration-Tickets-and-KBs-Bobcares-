#!/usr/bin/env bash
# Runs both suites. The browser suite skips itself if Playwright is missing.
set -euo pipefail
cd "$(dirname "$0")"

echo "== parser tests =="
node tests/parser.test.js

echo
echo "== content-script browser tests =="
NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null || echo /usr/lib/node_modules)}" \
  node tests/content.e2e.test.js
