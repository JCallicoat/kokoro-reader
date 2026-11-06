#!/bin/sh
# Try the extension in development: Firefox (flatpak) via web-ext first, then
# Chromium with a throwaway profile once Firefox is closed.
set -e

cd "$(dirname "$0")"

npx web-ext run --source-dir . --firefox=flatpak:org.mozilla.firefox --start-url https://www.lipsum.com/

rm -rf /tmp/kokoro-reader-chromium
chromium --user-data-dir=/tmp/kokoro-reader-chromium --load-extension="$PWD" -- https://www.lipsum.com/
