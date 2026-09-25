#!/bin/sh
# Package the extension as an .xpi (a zip by another name).
#
# For everyday use you do not need this — about:debugging loads the folder
# directly. Build it when you want to hand the file to someone else, and get it
# signed at addons.mozilla.org (Tools → Submit a New Add-on → "On your own")
# if it needs to survive a browser restart on a release Firefox.
set -eu
cd "$(dirname "$0")"
out="${1:-s4-shift-autofill.xpi}"
rm -f "$out"
zip -r -q -FS "$out" \
  manifest.json background.js content ui icons \
  -x '*.DS_Store' 'tests/*'
echo "built $out ($(wc -c < "$out") bytes)"
