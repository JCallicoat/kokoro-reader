#!/bin/sh
# Build the store package (the same zip goes to AMO and the Chrome Web Store).
# Repository-only files (store assets, docs for maintainers, git files) are left out.
set -e
cd "$(dirname "$0")"
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
out="web-ext-artifacts/kokoro-reader-$version.zip"
mkdir -p web-ext-artifacts
rm -f "$out"
zip -qr "$out" . \
  -x '.*' -x '*/.*' \
  -x 'web-ext-artifacts/*' -x 'store-assets/*' \
  -x 'build.sh' -x 'SIGNING.md' -x 'icons/icon.svg'
echo "Built $out"
