#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
for bundle in "dist/Telnyx Contact Center-darwin-$(uname -m)/Telnyx Contact Center.app" "dist/Telnyx Contact Center-darwin-x64/Telnyx Contact Center.app"; do
  if [[ -x "$bundle/Contents/MacOS/Telnyx Contact Center" ]]; then
    exec "$bundle/Contents/MacOS/Telnyx Contact Center"
  fi
done
if [[ ! -x node_modules/.bin/electron ]]; then
  echo 'Contact Center Desktop needs installed dependencies (npm ci in this folder).'
  echo 'See README.md in this folder for setup instructions.'
  read -r -p 'Press Enter to close. '
  exit 1
fi
if [[ -n "${CC_DESKTOP_CONFIG:-}" ]]; then
  exec ./node_modules/.bin/electron . "--config=$CC_DESKTOP_CONFIG"
elif [[ -f private/config.json ]]; then
  exec ./node_modules/.bin/electron . "--config=$PWD/private/config.json"
else
  exec ./node_modules/.bin/electron .
fi
